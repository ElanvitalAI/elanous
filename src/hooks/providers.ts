import { createHmac, timingSafeEqual } from 'node:crypto';

export type HookProvider = 'linear' | 'asana' | 'github';
export const PUBLIC_GITHUB_REPO = 'ElanvitalAI/elanous';
/** Links to documentation and reproductions are not spam signals. */
export function isGithubSpamText(value: string): boolean {
  return /\b(?:casino|crypto giveaway|free money|seo backlinks|airdrop)\b/i.test(value);
}
export interface ExternalTask {
  eventId: string;
  title: string;
  description?: string;
  external: { provider: HookProvider; ref: string; url?: string };
  /** Linear issue assignee ID, resolved by the configured seat mapping; events.routes takes precedence. */
  assigneeId?: string;
  /** L14: an opened PR/issue on the public repository — shadow intake only, never dispatched to seats. */
  github?: { repository: string; number: number; type: 'pull_request' | 'issue'; spamSignal?: boolean };
}
export type Verification = { ok: true; body: unknown; eventIds: string[]; ignored?: string } | { ok: false; reason: 'bad-signature' | 'stale' | 'invalid-body' };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function equalSignature(raw: Buffer, secret: string, signature: string | null): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
export function asanaEventId(event: unknown): string | undefined {
  const row = object(event);
  const gid = text(object(row?.resource)?.gid);
  const action = text(row?.action);
  const created = text(row?.created_at);
  return gid && action && created ? `${gid}:${action}:${created}` : undefined;
}

export function verifyWebhook(provider: HookProvider, raw: Buffer, headers: Headers, secret: string, now = Date.now()): Verification {
  const signature = headers.get(provider === 'linear' ? 'linear-signature' : provider === 'github' ? 'x-hub-signature-256' : 'x-hook-signature');
  const digest = provider === 'github' ? (signature?.startsWith('sha256=') ? signature.slice(7) : null) : signature;
  if (!equalSignature(raw, secret, digest))
    return { ok: false, reason: 'bad-signature' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'invalid-body' }; }
  const body = object(parsed);
  if (!body) return { ok: false, reason: 'invalid-body' };
  if (provider === 'linear') {
    const timestamp = body.webhookTimestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > 60_000)
      return { ok: false, reason: 'stale' };
    // Acknowledge signed, out-of-scope events so Linear does not disable the webhook.
    const previous = object(body.updatedFrom);
    const relevantUpdate = body.action === 'update' && previous &&
      ('assigneeId' in previous || 'stateId' in previous);
    if (body.type !== 'Issue' || (body.action !== 'create' && !relevantUpdate))
      return { ok: true, body, eventIds: [], ignored: `${String(body.type)}:${String(body.action)}` };
    const eventId = text(headers.get('linear-delivery')) ?? (text(body.webhookId) && text(body.createdAt) ? `${body.webhookId}:${body.createdAt}` : undefined);
    if (!eventId || !object(body.data) || !text(object(body.data)?.id) || !text(object(body.data)?.title))
      return { ok: false, reason: 'invalid-body' };
    return { ok: true, body, eventIds: [eventId] };
  }
  if (provider === 'github' && object(body.repository)?.full_name === PUBLIC_GITHUB_REPO) {
    // L14: the public repository's newly opened PRs/issues go to the shadow intake (no seat dispatch, no outside writes).
    const kind = headers.get('x-github-event');
    if (!['pull_request', 'issues'].includes(kind ?? '') || body.action !== 'opened')
      return { ok: true, body, eventIds: [], ignored: `${kind ?? 'unknown'}:${String(body.action)}` };
    const item = object(body[kind === 'pull_request' ? 'pull_request' : 'issue']);
    const delivery = headers.get('x-github-delivery');
    if (!delivery || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(delivery) || !Number.isSafeInteger(body.number) ||
        (body.number as number) < 1 || !item || item.number !== body.number || !text(item.title) ||
        !text(item.html_url) || !text(object(item.user)?.login) ||
        item.html_url !== `https://github.com/${PUBLIC_GITHUB_REPO}/${kind === 'pull_request' ? 'pull' : 'issues'}/${body.number}`)
      return { ok: false, reason: 'invalid-body' };
    return { ok: true, body: { ...body, githubEvent: kind, publicIntake: true }, eventIds: [delivery] };
  }
  if (provider === 'github') {
    const event = headers.get('x-github-event');
    const action = text(body.action);
    if (!((event === 'pull_request' && action === 'review_requested') ||
      (event === 'check_run' && action === 'completed' && object(body.check_run)?.conclusion === 'failure') ||
      (event === 'check_suite' && action === 'completed' && object(body.check_suite)?.conclusion === 'failure')))
      return { ok: true, body, eventIds: [], ignored: `${String(event)}:${String(action)}` };
    const delivery = text(headers.get('x-github-delivery'));
    const resource = object(event === 'pull_request' ? body.pull_request : event === 'check_run' ? body.check_run : body.check_suite);
    if (!delivery || !resource || typeof resource.id !== 'number' ||
      !(text(resource.html_url) ?? text(resource.details_url) ?? text(object(body.repository)?.html_url)))
      return { ok: false, reason: 'invalid-body' };
    return { ok: true, body: { ...body, githubEvent: event }, eventIds: [delivery] };
  }
  if (!Array.isArray(body.events)) return { ok: false, reason: 'invalid-body' };
  const ids = body.events.map(asanaEventId);
  if (ids.some(id => !id)) return { ok: false, reason: 'invalid-body' };
  return { ok: true, body, eventIds: ids as string[] };
}

export function toExternalTask(provider: HookProvider, body: unknown): ExternalTask {
  const row = object(body);
  if (!row) throw new Error('invalid hook body');
  if (provider === 'linear') {
    const issue = object(row.data);
    const ref = text(issue?.id);
    const title = text(issue?.title);
    const eventId = text(row.eventId) ?? (text(row.webhookId) && text(row.createdAt) ? `${row.webhookId}:${row.createdAt}` : undefined);
    if (!ref || !title || !eventId) throw new Error('invalid linear issue');
    const assigneeId = text(issue?.assigneeId) ?? text(object(issue?.assignee)?.id);
    return { eventId, title, ...(text(issue?.description) ? { description: text(issue?.description) } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      external: { provider, ref, ...(text(issue?.url) ? { url: text(issue?.url) } : {}) } };
  }
  if (provider === 'github' && row.publicIntake === true) {
    const type = row.githubEvent === 'pull_request' ? 'pull_request' : 'issue';
    const item = object(type === 'pull_request' ? row.pull_request : row.issue);
    const number = row.number;
    const eventId = text(row.eventId);
    if (!Number.isSafeInteger(number) || !item || !eventId || !text(item.title) || !text(item.html_url))
      throw new Error('invalid github event');
    return { eventId, title: item.title as string,
      external: { provider, ref: `${PUBLIC_GITHUB_REPO}#${number}`, url: item.html_url as string },
      github: { repository: PUBLIC_GITHUB_REPO, number: number as number, type,
        spamSignal: typeof item.body === 'string' && isGithubSpamText(item.body) } };
  }
  if (provider === 'github') {
    const event = text(row.githubEvent);
    const resource = object(event === 'pull_request' ? row.pull_request : event === 'check_run' ? row.check_run : row.check_suite);
    const ref = resource?.id;
    const eventId = text(row.eventId);
    const url = text(resource?.html_url) ?? text(resource?.details_url) ?? text(object(row.repository)?.html_url);
    if (typeof ref !== 'number' || !eventId || !url) throw new Error('invalid github event');
    const title = event === 'pull_request' ? `PR review requested: ${text(resource?.title) ?? url}`
      : `Check failed: ${text(resource?.name) ?? text(resource?.head_branch) ?? url}`;
    return { eventId, title, external: { provider, ref: String(ref), url } };
  }
  const event = object(row.event);
  const task = object(row.task);
  const ref = text(object(event?.resource)?.gid);
  const eventId = asanaEventId(event);
  if (!ref || !eventId) throw new Error('invalid asana event');
  return { eventId, title: text(task?.name) ?? `Asana task ${ref}`,
    ...(text(task?.notes) ? { description: text(task?.notes) } : {}),
    external: { provider, ref, ...(text(task?.permalink_url) ? { url: text(task?.permalink_url) } : {}) } };
}
