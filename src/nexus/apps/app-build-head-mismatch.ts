// RAIL-STALE-TUI-HEAD — a TUI/CLI process pins its code head at start; the local nexus
// bridge pins its own head at nexus start. After a rail update restarts only nexus,
// the two differ and the bridge refuses. That refusal used to be an anonymous 403 →
// BUILD_AUTHORITY_REFUSED (11-17 MVP-B incident: 0.12s failure, no log naming the cause).
// This module is the one place that names the cause on both sides of the bridge.
import { debug } from '../../debug/log.js';

export const SOURCE_HEAD_MISMATCH_ERROR = 'source-head-mismatch';
/** Heads are not secret but stay short in bodies, logs and status lines (RAIL-STALE-TUI-HEAD spec: 12 chars). */
export const SOURCE_HEAD_DISPLAY_CHARS = 12;
export const BUILD_SOURCE_HEAD_STALE = 'BUILD_SOURCE_HEAD_STALE';
// Same bound the bridge uses for its other control envelopes (MAX_CONTROL_BYTES there).
const MAX_MISMATCH_BODY_BYTES = 8 * 1024;

export function shortSourceHead(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/u.test(value) ? value.slice(0, SOURCE_HEAD_DISPLAY_CHARS) : 'unknown';
}

/** Which side of the bridge is behind the installed `current` version.
 * `tui` — the installed version moved past this process; `nexus` — this process is the installed
 * version and nexus is not; `unknown` — no installed head to judge by (checkout or unreadable). */
export type StaleSide = 'tui' | 'nexus' | 'unknown';

export function staleSideOf(runningHead: unknown, nexusHead: unknown, installedHead: unknown): StaleSide {
  const installed = shortSourceHead(installedHead);
  if (installed === 'unknown') return 'unknown';
  if (installed !== shortSourceHead(runningHead)) return 'tui';
  return installed !== shortSourceHead(nexusHead) ? 'nexus' : 'unknown';
}

/** User-facing cause and fix, in the words the seat sees in the TUI. Never prescribes a TUI
 * restart unless the installed version shows the TUI is the old side. */
export function staleSourceHeadMessage(runningHead: unknown, nexusHead: unknown, installedHead?: unknown): string {
  const tui = shortSourceHead(runningHead);
  const nexus = shortSourceHead(nexusHead);
  switch (staleSideOf(runningHead, nexusHead, installedHead)) {
    case 'tui': return `설치본이 갱신됨 · 이 TUI 는 옛 판(head ${tui}) · 재기동 필요 (새 판 ${shortSourceHead(installedHead)})`;
    case 'nexus': return `nexus 가 옛 판(head ${nexus}) · 이 TUI 는 설치본 판(head ${tui}) · nexus 재기동 필요`;
    default: return `판 불일치 · 이 TUI(head ${tui}) ≠ nexus(head ${nexus}) · 설치본 판과 다른 쪽을 재기동`;
  }
}

/** Typed error: `message` stays the machine code so BUILD_[A-Z_]+ filters keep it intact. */
export class BuildSourceHeadStaleError extends Error {
  readonly code = BUILD_SOURCE_HEAD_STALE;
  readonly userMessage: string;
  readonly side: StaleSide;
  constructor(readonly runningHead: string, readonly nexusHead: string, installedHead?: string) {
    super(BUILD_SOURCE_HEAD_STALE);
    this.name = 'BuildSourceHeadStaleError';
    this.side = staleSideOf(runningHead, nexusHead, installedHead);
    this.userMessage = staleSourceHeadMessage(runningHead, nexusHead, installedHead);
  }
}

/** Bridge side: 409 Conflict (not 401/403 — auth already passed; the two sides disagree on code). */
export function sourceHeadMismatchResponse(nexusHead: string, requestHead: string | null,
  log: (data: Record<string, unknown>) => void = data => debug.log('app-build', 'head-mismatch', data, { level: 'warn' })): Response {
  const expectedHead = shortSourceHead(nexusHead);
  const gotHead = shortSourceHead(requestHead);
  try { log({ side: 'nexus-bridge', expectedHead, gotHead }); } catch { /* observation must not change the answer */ }
  return Response.json({ error: SOURCE_HEAD_MISMATCH_ERROR, expectedHead, gotHead }, {
    status: 409, headers: { 'cache-control': 'no-store' },
  });
}

async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader(); if (!reader) return undefined;
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_MISMATCH_BODY_BYTES) { await reader.cancel().catch(() => {}); return undefined; }
    parts.push(part.value);
  } } finally { try { reader.releaseLock(); } catch { /* cancelled */ } }
  return Buffer.concat(parts).toString('utf8');
}

/** Caller side: a 409 naming the mismatch becomes the typed error; anything else returns undefined
 * so the caller keeps its existing refusal (auth 401/403 paths unchanged). Consumes the body only on 409.
 * `installedHead` (the installed `current` commit) decides which side the message tells to restart. */
export async function readSourceHeadMismatch(response: Response, runningHead: string, options: {
  installedHead?: () => string | undefined;
  log?: (data: Record<string, unknown>) => void;
} = {}): Promise<BuildSourceHeadStaleError | undefined> {
  if (response.status !== 409) return undefined;
  let value: Record<string, unknown> = {};
  try {
    const text = await boundedText(response); if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { return undefined; }
  if (value.error !== SOURCE_HEAD_MISMATCH_ERROR) return undefined;
  const nexusHead = shortSourceHead(value.expectedHead);
  let installedHead: string | undefined;
  try { installedHead = options.installedHead?.(); } catch { /* unknown side */ }
  const error = new BuildSourceHeadStaleError(shortSourceHead(runningHead), nexusHead,
    installedHead ? shortSourceHead(installedHead) : undefined);
  const log = options.log ?? (data => debug.log('app-build', 'head-mismatch', data, { level: 'warn' }));
  try {
    log({ side: 'client', tuiHead: error.runningHead, nexusHead, installedHead: shortSourceHead(installedHead),
      staleSide: error.side, message: error.userMessage });
  } catch { /* best effort */ }
  return error;
}
