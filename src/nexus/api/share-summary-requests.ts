import { createHash, randomUUID } from 'node:crypto';
import { listAbsorbScraps } from '../../intake-plane/items.js';
import type { NexusEvent } from '../state/state.js';
import type { MembersApi } from '../members/members-api.js';
import type { MemberEvent, MemberEventStore } from './member-event-store.js';
import { debug } from '../../debug/log.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SCRAP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE = '/v1/scraps/summary-requests';
const REQUESTED = 'scrap.summary.requested';
const RESULT = 'scrap.summary.result';
const CLAIMED = 'scrap.summary.claimed';
const SUMMARY_REQUESTS_PER_HOUR = 30;
const GENERATION_LEASE_MS = 5 * 60_000;
const requestTurns = new Map<string, Promise<void>>();

/** The member API verifies app Bearer sessions at /v1/members/owner without an appSlug. */
export async function resolveVerifiedShareSummaryOwner(request: Request, membersApi: MembersApi): Promise<{ memberId: string } | null> {
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await membersApi.handle(new Request(new URL('/v1/members/owner', request.url), { headers }), 'share-summary-requests');
    if (!response?.ok) return null;
    const owner: unknown = await response.json();
    if (!owner || typeof owner !== 'object') return null;
    const memberId = (owner as { memberId?: unknown }).memberId;
    return typeof memberId === 'string' && memberId ? { memberId } : null;
  } catch { return null; }
}

async function serializeRequest<T>(requestId: string, action: () => Promise<T>): Promise<T> {
  const previous = requestTurns.get(requestId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => turn);
  requestTurns.set(requestId, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (requestTurns.get(requestId) === queued) requestTurns.delete(requestId);
  }
}

export interface SummaryScrap {
  readonly id: string;
  readonly status: 'new' | 'extracting' | 'absorbed' | 'failed';
  readonly card?: { readonly title: string; readonly points: readonly (string | undefined)[] };
  readonly extractedBody?: string;
  readonly failure?: { readonly reason: string };
}

export interface ShareSummaryRequestOptions {
  /** This identity comes from a verified member session, never the JSON body. */
  readonly ownerForRequest: (request: Request) => Promise<string | null> | string | null;
  readonly getScrap: (memberId: string, scrapId: string) => Promise<SummaryScrap | null> | SummaryScrap | null;
  readonly events: MemberEventStore;
  /** Production uses the configured operating LLM; simulations inject a fake response. */
  readonly generateSummary?: (scrap: SummaryScrap) => Promise<string>;
  readonly now?: () => Date;
  /** Shorter only in deterministic lease tests. */
  readonly generationHeartbeatMs?: number;
}

function absorbScrap(instanceRoot: string, memberId: string, scrapId: string): SummaryScrap | null {
  const item = listAbsorbScraps(instanceRoot, memberId).find(row => row.id === scrapId);
  if (!item?.absorb) return null;
  return { id: item.id, status: item.absorb.status, card: item.absorb.card,
    extractedBody: item.absorb.extractedBody, failure: item.absorb.failure };
}

/** Uses the same configured provider path as other Nexus LLM calls. */
export async function generateOperatingShareSummary(scrap: SummaryScrap): Promise<string> {
  const llm = await import('../../llm.js');
  const source = scrap.extractedBody?.trim() || [scrap.card?.title, ...(scrap.card?.points ?? [])].filter(Boolean).join('\n');
  if (!source) throw new Error('summary source unavailable');
  const result = await llm.streamLLM([
    { role: 'user', content: `다음 기사/메모 원문을 한국어로 새로 요약해 주세요. 핵심 사실 3문장 이내로 쓰고 댓글 UI·정책·광고 문구는 제외하세요. 원문에 없는 사실은 추가하지 마세요.\n\n${source}` },
  ], () => {}, { maxTokens: 400, temperature: 0 });
  const summary = result.trim();
  if (!summary) throw new Error('empty generated summary');
  return summary;
}

/** Production scrap adapter; the authenticated member namespace is checked by the intake ledger. */
export function createAbsorbShareSummaryRequestApi(input: {
  readonly instanceRoot: string;
  readonly ownerForRequest: ShareSummaryRequestOptions['ownerForRequest'];
  readonly events: MemberEventStore;
  readonly now?: () => Date;
  readonly generateSummary?: ShareSummaryRequestOptions['generateSummary'];
}): (request: Request) => Promise<Response | undefined> {
  return createShareSummaryRequestApi({
    ...input,
    getScrap: (memberId, scrapId) => absorbScrap(input.instanceRoot, memberId, scrapId),
    generateSummary: input.generateSummary ?? generateOperatingShareSummary,
  });
}

interface SummaryRequestEvent extends MemberEvent {
  readonly type: typeof REQUESTED;
  readonly requestId: string;
  readonly scrapId: string;
  readonly at: string;
}

interface SummaryResultEvent extends MemberEvent {
  readonly type: typeof RESULT;
  readonly requestId: string;
  readonly scrapId: string;
  readonly status: 'ready' | 'failed';
  readonly summary?: string;
  readonly summarySource?: 'generated' | 'stored-card';
  readonly error?: string;
  readonly at: string;
}

function resolvedSummarySource(result: SummaryResultEvent): 'generated' | 'stored-card' | undefined {
  if (result.status !== 'ready') return undefined;
  return result.summarySource === 'generated' ? 'generated' : 'stored-card';
}

export function shareSummaryNexusEvent(value: MemberEvent): NexusEvent | null {
  if (value.type !== RESULT || typeof value.memberId !== 'string'
    || typeof value.requestId !== 'string' || typeof value.scrapId !== 'string'
    || (value.status !== 'ready' && value.status !== 'failed')
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  return { ts: Date.parse(value.at), kind: RESULT, memberId: value.memberId,
    detail: { requestId: value.requestId, scrapId: value.scrapId, status: value.status,
      ...(resolvedSummarySource(value as SummaryResultEvent)
        ? { summarySource: resolvedSummarySource(value as SummaryResultEvent) } : {}) } };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function requestIdFor(memberId: string, key: string): string {
  return `sum_${createHash('sha256').update(JSON.stringify([memberId, key])).digest('hex').slice(0, 32)}`;
}

async function resultFor(scrap: SummaryScrap, request: SummaryRequestEvent, at: string,
  generateSummary?: ShareSummaryRequestOptions['generateSummary']): Promise<SummaryResultEvent | null> {
  if (scrap.status === 'failed') {
    return { type: RESULT, memberId: request.memberId, requestId: request.requestId,
      scrapId: request.scrapId, status: 'failed', error: scrap.failure?.reason ?? 'summary-unavailable', at };
  }
  if (scrap.status !== 'absorbed' || !scrap.card) return null;
  const storedSummary = [scrap.card.title, ...scrap.card.points]
    .filter((part): part is string => typeof part === 'string')
    .map(part => part.trim()).filter(Boolean).join('\n');
  if (!storedSummary) return null;
  let summary = storedSummary;
  let summarySource: SummaryResultEvent['summarySource'] = 'stored-card';
  if (generateSummary) {
    try {
      const generated = (await generateSummary(scrap)).trim();
      if (!generated) throw new Error('empty generated summary');
      summary = generated;
      summarySource = 'generated';
    } catch {
      debug.log('scrap.summary', 'generation-fallback', { requestId: request.requestId,
        scrapId: request.scrapId, reason: 'llm-unavailable' }, { level: 'warn' });
    }
  }
  return { type: RESULT, memberId: request.memberId, requestId: request.requestId,
    scrapId: request.scrapId, status: 'ready', summary, summarySource, at };
}

async function settleSummaryRequest(events: MemberEventStore, request: SummaryRequestEvent, scrap: SummaryScrap,
  at: string, generateSummary?: ShareSummaryRequestOptions['generateSummary'],
  now: () => Date = () => new Date(), heartbeatMs = 60_000): Promise<SummaryResultEvent | null> {
  const results = await events.query({ memberId: request.memberId, type: RESULT }) as SummaryResultEvent[];
  const prior = results.find(row => row.requestId === request.requestId);
  if (prior) return prior;
  if (scrap.status !== 'absorbed' && scrap.status !== 'failed') return null;
  const claimId = randomUUID();
  const claimAt = (timestamp: string) => events.claimPendingEvent!({ type: CLAIMED, memberId: request.memberId,
    requestId: request.requestId, claimId, at: timestamp }, { resultType: RESULT, key: 'requestId',
    now, leaseMs: GENERATION_LEASE_MS });
  if (events.claimPendingEvent) {
    const claim = await claimAt(at);
    if (claim === 'busy') return null;
    if (claim === 'settled') {
      const settled = await events.query({ memberId: request.memberId, type: RESULT }) as SummaryResultEvent[];
      return settled.find(row => row.requestId === request.requestId) ?? null;
    }
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing = Promise.resolve();
  let lostClaim = false;
  if (events.claimPendingEvent) {
    heartbeat = setInterval(() => {
      renewing = renewing.then(async () => {
        if (lostClaim) return;
        try {
          const renewed = await claimAt(now().toISOString());
          if (renewed !== 'renewed') lostClaim = true;
        } catch { lostClaim = true; }
      });
    }, heartbeatMs);
    heartbeat.unref?.();
  }
  let result: SummaryResultEvent | null;
  try { result = await resultFor(scrap, request, at, generateSummary); }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    await renewing;
  }
  if (!result || lostClaim) return null;
  if (events.appendClaimedResult) {
    const saved = await events.appendClaimedResult(result, { claimType: CLAIMED, key: 'requestId', claimId,
      now, leaseMs: GENERATION_LEASE_MS });
    return saved.status === 'appended' ? result : saved.status === 'existing' ? saved.event as SummaryResultEvent : null;
  }
  await events.append(result);
  return result;
}

/** Called by the producing scrap route after it durably writes an absorbed or failed state. */
export async function publishAbsorbShareSummaryResults(input: {
  readonly instanceRoot: string;
  readonly events: MemberEventStore;
  readonly memberId: string;
  readonly scrapId: string;
  readonly now?: () => Date;
  readonly generateSummary?: ShareSummaryRequestOptions['generateSummary'];
}): Promise<void> {
  const scrap = absorbScrap(input.instanceRoot, input.memberId, input.scrapId);
  if (!scrap || (scrap.status !== 'absorbed' && scrap.status !== 'failed')) return;
  const requests = await input.events.query({ memberId: input.memberId, type: REQUESTED }) as SummaryRequestEvent[];
  for (const request of requests.filter(row => row.scrapId === input.scrapId)) {
    await serializeRequest(request.requestId, async () => {
      await settleSummaryRequest(input.events, request, scrap, (input.now ?? (() => new Date()))().toISOString(),
        input.generateSummary ?? generateOperatingShareSummary, input.now);
    });
  }
}

/**
 * iOS share follow-up contract:
 * POST /v1/scraps/summary-requests {scrapId}, with Idempotency-Key → 201 ready or 202 pending;
 * GET /v1/scraps/summary-requests/:requestId → current status and result;
 * /v1/events?topics=scrap.summary.result → member-scoped completion notification.
 * The result event is durable so a client can poll after missing the live event.
 */
export function createShareSummaryRequestApi(options: ShareSummaryRequestOptions): (request: Request) => Promise<Response | undefined> {
  const now = () => (options.now ?? (() => new Date()))().toISOString();

  async function requested(memberId: string): Promise<SummaryRequestEvent[]> {
    return await options.events.query({ memberId, type: REQUESTED }) as SummaryRequestEvent[];
  }

  async function settled(memberId: string, requestId: string): Promise<SummaryResultEvent | null> {
    const rows = await options.events.query({ memberId, type: RESULT }) as SummaryResultEvent[];
    return rows.find(row => row.requestId === requestId) ?? null;
  }

  async function refresh(request: SummaryRequestEvent): Promise<SummaryResultEvent | null> {
    const prior = await settled(request.memberId, request.requestId);
    if (prior) return prior;
    const scrap = await options.getScrap(request.memberId, request.scrapId);
    if (!scrap || scrap.id !== request.scrapId) return null;
    return settleSummaryRequest(options.events, request, scrap, now(), options.generateSummary,
      options.now, options.generationHeartbeatMs);
  }

  function publicStatus(request: SummaryRequestEvent, result: SummaryResultEvent | null) {
    return { requestId: request.requestId, scrapId: request.scrapId,
      status: result?.status ?? 'pending',
      ...(result?.summary ? { summary: result.summary } : {}),
      ...(result && resolvedSummarySource(result) ? { summarySource: resolvedSummarySource(result) } : {}),
      ...(result?.error ? { error: result.error } : {}),
      requestedAt: request.at, ...(result ? { completedAt: result.at } : {}) };
  }

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return undefined;
    if (request.method !== 'POST' && request.method !== 'GET') return response({ error: 'method-not-allowed' }, 405);
    const memberId = await options.ownerForRequest(request);
    if (!memberId) return response({ error: 'unauthorized' }, 401);

    if (request.method === 'POST') {
      if (path !== BASE) return response({ error: 'not-found' }, 404);
      const key = request.headers.get('idempotency-key')?.trim() ?? '';
      if (!KEY.test(key)) return response({ error: 'idempotency-key-required' }, 400);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: 'invalid-json' }, 400); }
      const scrapId = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).scrapId : undefined;
      if (typeof scrapId !== 'string' || !SCRAP_ID.test(scrapId)) return response({ error: 'invalid-scrap-id' }, 400);
      const requestId = requestIdFor(memberId, key);
      // One member's new requests share a turn; the production event journal also reserves
      // capacity under a file lock so another server process cannot race past the cap.
      return serializeRequest(`summary-member:${memberId}`, async () => serializeRequest(requestId, async () => {
        const memberRequests = await requested(memberId);
        let previous = memberRequests.find(row => row.requestId === requestId);
        if (previous && previous.scrapId !== scrapId) return response({ error: 'idempotency-conflict' }, 409);
        if (previous) {
          const result = await refresh(previous);
          return response(publicStatus(previous, result));
        }
        const scrap = await options.getScrap(memberId, scrapId);
        if (!scrap || scrap.id !== scrapId) return response({ error: 'scrap-not-found' }, 404);
        let record: SummaryRequestEvent = previous ?? {
          type: REQUESTED, memberId, requestId, scrapId, at: now(),
        };
        if (!previous) {
          const since = new Date(Date.parse(record.at) - 3_600_000).toISOString();
          if (options.events.reserveUniqueEvent) {
            const reservation = await options.events.reserveUniqueEvent(record, {
              type: REQUESTED, key: 'requestId', since, max: SUMMARY_REQUESTS_PER_HOUR,
            });
            if (reservation.status === 'limited') return response({ error: 'summary-rate-limit' }, 429);
            if (reservation.status === 'existing') {
              previous = reservation.event as SummaryRequestEvent;
              if (previous.scrapId !== scrapId) return response({ error: 'idempotency-conflict' }, 409);
              record = previous;
              const result = await refresh(previous);
              return response(publicStatus(previous, result));
            }
          } else {
            const used = memberRequests.filter(row => Number.isFinite(Date.parse(row.at))
              && Date.parse(row.at) >= Date.parse(since)).length;
            if (used >= SUMMARY_REQUESTS_PER_HOUR) return response({ error: 'summary-rate-limit' }, 429);
            await options.events.append(record);
          }
        }
        const result = await refresh(record);
        return response(publicStatus(record, result), previous ? 200 : result ? 201 : 202);
      }));
    }

    const requestId = path.slice(BASE.length + 1);
    if (!/^sum_[a-f0-9]{32}$/.test(requestId)) return response({ error: 'not-found' }, 404);
    return serializeRequest(requestId, async () => {
      const record = (await requested(memberId)).find(row => row.requestId === requestId);
      if (!record) return response({ error: 'not-found' }, 404);
      return response(publicStatus(record, await refresh(record)));
    });
  };
}
