import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { debug } from '../debug/log.js';
import { EventLedger } from './event-ledger.js';
import type { ExternalTaskEvent, TaskConnector } from './types.js';

export function verifyLinearWebhook({ rawBody, signature, secret, now = Date.now(), toleranceMs = 60_000 }: {
  rawBody: string | Uint8Array; signature: string; secret: string; now?: number; toleranceMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => {
    debug.log('connector.linear', 'verify-failed', { traceId: randomUUID(), reason });
    return { ok: false, reason };
  };
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return fail('invalid-signature');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return fail('invalid-signature');
  }
  try {
    const body = JSON.parse(Buffer.from(rawBody).toString('utf8')) as { webhookTimestamp?: unknown };
    const timestamp = body.webhookTimestamp;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || !Number.isFinite(now) || !Number.isFinite(toleranceMs) || toleranceMs < 0 || Math.abs(now - timestamp) > toleranceMs) {
      return fail('timestamp-outside-window');
    }
  } catch {
    return fail('invalid-body');
  }
  return { ok: true };
}

const PRIORITY_RANK: Record<NonNullable<ExternalTaskEvent['priority']> | 'none', number> = { urgent: 0, high: 1, medium: 2, none: 2, low: 3 };

function priorityOf(value: unknown): ExternalTaskEvent['priority'] {
  switch (value) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'low';
    default: return null;
  }
}

function asIssue(value: unknown): { id: string; identifier: string; title: string; description?: string | null; url?: string | null; priority: number; updatedAt: string } | null {
  if (!value || typeof value !== 'object') return null;
  const issue = value as Record<string, unknown>;
  if (typeof issue.id !== 'string' || typeof issue.identifier !== 'string' || typeof issue.title !== 'string' || typeof issue.updatedAt !== 'string') return null;
  if (issue.description != null && typeof issue.description !== 'string') return null;
  if (issue.url != null && typeof issue.url !== 'string') return null;
  if (typeof issue.priority !== 'number' || !Number.isInteger(issue.priority) || !Number.isFinite(Date.parse(issue.updatedAt))) return null;
  return issue as ReturnType<typeof asIssue>;
}

export function isLinearProjectionEcho(event: ExternalTaskEvent, ledger: EventLedger): boolean {
  return event.provider === 'linear' && ledger.seenOutgoingChange('linear', event.ref, event.occurredAt);
}

export function parseLinearWebhook(body: unknown, deliveryId: string, ledger?: EventLedger): ExternalTaskEvent | null {
  if (!deliveryId || !body || typeof body !== 'object') return null;
  const payload = body as Record<string, unknown>;
  if (payload.type !== 'Issue' || (payload.action !== 'create' && payload.action !== 'update')) return null;
  const issue = asIssue(payload.data);
  if (!issue) return null;
  const event: ExternalTaskEvent = {
    provider: 'linear', eventId: deliveryId, kind: payload.action === 'create' ? 'created' : 'updated',
    ref: issue.id, identifier: issue.identifier, title: issue.title, body: issue.description ?? '',
    url: issue.url ?? '', priority: priorityOf(issue.priority), occurredAt: issue.updatedAt,
  };
  return isLinearProjectionEcho(event, ledger ?? new EventLedger()) ? null : event;
}

export async function fetchLinearIssues({ apiKey, teamKey, labelOrPrefix, since, fetch: fetchFn = fetch, ledger }: {
  apiKey: string; teamKey: string; labelOrPrefix?: string; since?: string; fetch?: typeof fetch; ledger?: EventLedger;
}): Promise<ExternalTaskEvent[]> {
  const query = `query ConnectorIssues($teamKey: String!, $after: String) {
    issues(filter: { team: { key: { eq: $teamKey } } }, first: 100, after: $after) {
      nodes { id identifier title description url priority updatedAt state { type } labels { nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const events: ExternalTaskEvent[] = [];
  const echoLedger = ledger ?? new EventLedger();
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    let response: Response;
    try {
      response = await fetchFn('https://api.linear.app/graphql', {
        method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { teamKey, after } }),
      });
    } catch {
      throw new Error('Linear GraphQL request failed');
    }
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
    let result: {
      errors?: unknown[];
      data?: { issues?: { nodes?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } };
    };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new Error('Linear GraphQL invalid JSON response');
    }
    if (result.errors?.length || !Array.isArray(result.data?.issues?.nodes)) throw new Error('Linear GraphQL returned errors or missing issues');
    for (const node of result.data.issues.nodes) {
      const issue = asIssue(node);
      if (!issue || (since && issue.updatedAt < since) ||
          ['completed', 'canceled', 'duplicate'].includes((node.state as { type?: string } | undefined)?.type ?? '')) continue;
      if (labelOrPrefix && !issue.title.startsWith(labelOrPrefix) &&
          !(node.labels as { nodes?: Array<{ name: string }> } | undefined)?.nodes?.some(label => label.name === labelOrPrefix)) continue;
      const event: ExternalTaskEvent = { provider: 'linear', eventId: `${issue.id}:${issue.updatedAt}`, kind: 'updated',
        ref: issue.id, identifier: issue.identifier, title: issue.title, body: issue.description ?? '',
        url: issue.url ?? '', priority: priorityOf(issue.priority), occurredAt: issue.updatedAt };
      if (!isLinearProjectionEcho(event, echoLedger)) events.push(event);
    }
    const page = result.data.issues.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('Linear GraphQL pagination cursor missing or repeated');
    after = page?.hasNextPage ? page.endCursor : null;
    if (after) cursors.add(after);
  } while (after);
  // Tasks tie-break on creation order and Urgent maps to high, so an Urgent issue must be created before a High one.
  return events.sort((a, b) => PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none']);
}

export function toTaskRequest(event: ExternalTaskEvent): {
  title: string; description: string; priority: 'high' | 'medium' | 'low';
  external: { provider: 'linear'; ref: string; url?: string; team?: string };
} {
  const fullTitle = `${event.identifier ? `${event.identifier} ` : ''}${event.title}`;
  const title = fullTitle.length > 80 ? `${fullTitle.slice(0, 79)}…` : fullTitle;
  const description = event.priority === 'urgent'
    ? `원래 우선순위: Urgent${event.body ? `\n\n${event.body}` : ''}`
    : event.body;
  const team = event.identifier?.includes('-') ? event.identifier.slice(0, event.identifier.lastIndexOf('-')) : undefined;
  return { title, description,
    priority: event.priority === 'urgent' ? 'high' : event.priority ?? 'medium',
    external: { provider: 'linear', ref: event.ref, ...(event.url ? { url: event.url } : {}), ...(team ? { team } : {}) } };
}

export const linearConnector: TaskConnector = {
  provider: 'linear', verify: verifyLinearWebhook, parse: parseLinearWebhook,
  idempotencyKey: event => event.eventId,
};
