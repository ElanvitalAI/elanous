import { createHmac, timingSafeEqual } from 'node:crypto';

export type HookProvider = 'linear' | 'asana';
export interface ExternalTask {
  eventId: string;
  title: string;
  description?: string;
  external: { provider: HookProvider; ref: string; url?: string };
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
  if (!equalSignature(raw, secret, headers.get(provider === 'linear' ? 'linear-signature' : 'x-hook-signature')))
    return { ok: false, reason: 'bad-signature' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'invalid-body' }; }
  const body = object(parsed);
  if (!body) return { ok: false, reason: 'invalid-body' };
  if (provider === 'linear') {
    const timestamp = body.webhookTimestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > 60_000)
      return { ok: false, reason: 'stale' };
    // Linear 은 실패 응답이 쌓이면 웹훅을 꺼 버린다 — 서명이 맞는 «대상 아닌» 이벤트(댓글·수정 등)는
    // 거절하지 않고 받아서 버린다. 지금 태스크로 만드는 것은 이슈 생성뿐이다.
    if (body.type !== 'Issue' || body.action !== 'create')
      return { ok: true, body, eventIds: [], ignored: `${String(body.type)}:${String(body.action)}` };
    const eventId = text(headers.get('linear-delivery')) ?? (text(body.webhookId) && text(body.createdAt) ? `${body.webhookId}:${body.createdAt}` : undefined);
    if (!eventId || !object(body.data) || !text(object(body.data)?.id) || !text(object(body.data)?.title))
      return { ok: false, reason: 'invalid-body' };
    return { ok: true, body, eventIds: [eventId] };
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
    return { eventId, title, ...(text(issue?.description) ? { description: text(issue?.description) } : {}),
      external: { provider, ref, ...(text(issue?.url) ? { url: text(issue?.url) } : {}) } };
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
