// 흡수 원장 HTTP 입구 — PWA intake 첫 입구(RFC-pwa-intake-front-door A3 `absorb`)가 원장에 넣고 추적한다.
//   POST /v1/intake-ledger/items      { items: [{url?, text?, title?}], source?: 'pwa' } → ingest 와 같은 수 ⊕ ids
//   GET  /v1/intake-ledger/items/:id  상태 · 산출(노트) — ⛔ 원문(`text`)은 싣지 않는다(PWA 칸은 user-private)
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { ingestIntakeItems, intakeItemId, loadIntakeLedger, type RawIntakeItem } from '../../intake-plane/items.js';

const MAX_ITEMS = 50;
const MAX_TEXT = 20_000;

export interface IntakeLedgerDeps { readonly root?: () => string; readonly now?: () => string }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function rawOf(v: unknown): RawIntakeItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === 'string' && /^https?:\/\//.test(o.url.trim()) ? o.url.trim() : undefined;
  const text = typeof o.text === 'string' && o.text.trim() ? o.text.slice(0, MAX_TEXT) : undefined;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.slice(0, 300) : undefined;
  if (!url && !text) return null;
  return { ...(url ? { url } : {}), ...(text ? { text } : {}), ...(title ? { title } : {}) };
}

/** POST /v1/intake-ledger/items — 입력원은 `pwa` 로 고정한다(부르는 쪽이 입력원을 사칭하지 못하게). */
export async function handleIntakeLedgerPost(req: Request, deps: IntakeLedgerDeps = {}): Promise<Response> {
  let body: { items?: unknown };
  try { body = await req.json() as typeof body; } catch { return json({ error: 'invalid-json' }, 400); }
  if (!Array.isArray(body?.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    return json({ error: 'invalid-items', reason: `items must be 1..${MAX_ITEMS}` }, 400);
  }
  const raws = body.items.map(rawOf);
  if (raws.some((r) => r === null)) return json({ error: 'invalid-items', reason: 'each item needs an http(s) url or text' }, 400);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const root = (deps.root ?? effectiveInstanceRoot)();
  const res = ingestIntakeItems(root, 'pwa', raws as RawIntakeItem[], now);
  const ids = (raws as RawIntakeItem[]).map((r) => intakeItemId('pwa', r));
  debug.log('intake.http', 'items-posted', { count: raws.length, added: res.added, merged: res.merged, seen: res.seen });
  return json({ ids, added: res.added, merged: res.merged, seen: res.seen, skipped: res.skipped });
}

/** GET /v1/intake-ledger/items/:id — 추적(queued → absorbed/routed · 노트). */
export function handleIntakeLedgerGet(id: string, deps: IntakeLedgerDeps = {}): Response {
  if (!/^[0-9a-f]{8,64}$/.test(id)) return json({ error: 'invalid-id' }, 400);
  const item = loadIntakeLedger((deps.root ?? effectiveInstanceRoot)()).items.get(id);
  if (!item) return json({ error: 'not-found', id }, 404);
  return json({
    id: item.id, status: item.status, sources: item.sources, kind: item.kind, privacy: item.privacy,
    ...(item.url ? { url: item.url } : {}), ...(item.title ? { title: item.title } : {}),
    observedAt: item.observedAt, lastSeenAt: item.lastSeenAt, outputs: item.outputs,
  });
}
