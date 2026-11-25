// ── 조건 감시 `commitment/condition-watch` (COND-WATCH · 11-25 · MAIL-HANDLING-DESIGN-1125 ⑤) ─────────────────
//
// S 11-25 OP 의 깨움 62 중 57 이 «회신 수거»였다 — OP 가 손에게 «회신해 달라»를 쓰고 우편마다 약속 ⊕ 깨우개를 걸었다.
// C 그 회신 대부분은 원장(PR 머지 · PREGATE-GREEN 영수 · 칸 상태 · 자리 유휴)에 이미 남는 사실을 사람이 다시 말한 것이다.
// Q 어떻게 «회신»이 아니라 «결과»를 기다리나?
// A 보내는 이가 기다리는 결과를 조건으로 적는다(`--watch pregate-receipt:40062`). 시스템이 원장을 싸게 재고(fs 이벤트 ⊕
//   1/분 이하 폴링 · 뜨거운 길 DB 폴링 0) 조건이 차면 약속을 근거 줄과 함께 스스로 닫고 주인을 한 번 깨운다. 만료도 한 번.
//   받는 이의 우편 꼬리에는 «회신 불필요 — <결과>를 내면 끝» 이 붙는다.
//
// 세 얼굴:
//   관측 = commitment.watch.armed|satisfied|expired {kind} (self-timer-watch.ts) ⊕ Board 줄(watchBoardLine)
//   판단 근거 = 깨우개 칸의 evidence(탐침이 돌려준 원장 줄 — 영수 경로 · 칸 상태 · 우편 id)
//   수복과 인계 = 충족 → CommitmentLedger.markDone(evidence) ⊕ 주인 notice 1통 · 만료 → expired notice 1통(다시 걸거나 묻는다)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatWaitCondition, parseWaitCondition, WATCH_KINDS, type WaitCondition, type WakerRecord } from '../msg/self-timer-watch.js';

/** The awaited outcome in words — the recipient's mail footer names it. */
export function describeWatch(c: WaitCondition): string {
  switch (c.kind) {
    case 'pregate-receipt': return `a pregate GREEN receipt for PR #${c.pr}${c.head ? ` at ${c.head}` : ''}`;
    case 'pr-merged': return `PR #${c.pr} merged`;
    case 'review': return `a review result on PR #${c.pr}`;
    case 'cell-status': return c.owner ? `checklist cell ${c.cell} owned by ${c.owner}` : `checklist cell ${c.cell} at ${c.status}`;
    case 'seat-idle': return `${c.seat} idle (work finished)`;
    case 'file': return `the file ${c.path}`;
    case 'mail-from': return `any mail from ${c.seat}`;
    case 'mail-reply': return `a reply to mail #${c.message}`;
    case 'time': return formatWaitCondition(c);
  }
}

export const WATCH_FOOTER_MARK = '— no reply needed —';

/** Mail footer for a watched post. `mail-from` IS a reply-wait, so it keeps asking for one. */
export function watchFooter(c: WaitCondition): string {
  if (c.kind === 'mail-from' || c.kind === 'mail-reply') return `\n\n— reply expected: ${describeWatch(c)} (watch ${formatWaitCondition(c)})`;
  return `\n\n${WATCH_FOOTER_MARK} produce ${describeWatch(c)}; the sender is watching for it (watch ${formatWaitCondition(c)})`;
}

/** Parse a `--watch` value and refuse timers/reply ids (those are not outcomes). Throws on a bad condition. */
export function parseWatch(raw: string, cwd?: string): WaitCondition {
  const c = parseWaitCondition(raw, cwd);
  if (!WATCH_KINDS.has(c.kind)) throw new Error(`--watch needs an outcome condition (pr-merged · pregate-receipt · cell-status · seat-idle · file-exists · mail-from), not ${c.kind}`);
  return c;
}

/** Body with the footer appended once (an idempotent retry of the same post stays byte-identical). */
export function withWatchFooter(body: string, c: WaitCondition): string {
  const footer = watchFooter(c);
  return body.endsWith(footer) ? body : `${body}${footer}`;
}

// ── 자동 제안(구조 필드만 · 본문 정규식 0) ─────────────────────────────────────────────────────

/** Kinds / ref tags that state «I await a pregate receipt». */
const PREGATE_TAGS: ReadonlySet<string> = new Set(['pregate', 'receipt', 'pregate-receipt', '영수', '영수증']);

export interface WatchSuggestInput {
  readonly kind?: string | undefined;
  readonly refs?: readonly string[] | undefined;
  readonly waitForPr?: number | undefined;
}

/**
 * Suggest a watch from STRUCTURED fields: a PR (waitForPr, or a `pr:<N>` ref) ⊕ a pregate intent (kind, or a
 * `pregate`/`await:pregate` ref) → `pregate-receipt:<N>`. Nothing else is inferred — a plain reply-wait stays the fallback.
 */
export function suggestWatch(input: WatchSuggestInput): string | null {
  const refs = (input.refs ?? []).map((r) => r.trim().toLowerCase());
  let pr = input.waitForPr;
  if (pr === undefined) {
    for (const r of refs) {
      const v = r.startsWith('pr:') ? r.slice(3).replace(/^#/, '') : null;
      if (v !== null && /^[1-9]\d{0,7}$/.test(v)) { pr = Number(v); break; }
    }
  }
  if (pr === undefined) return null;
  const tags = [input.kind?.trim().toLowerCase() ?? '', ...refs.map((r) => r.startsWith('await:') ? r.slice('await:'.length) : r)];
  return tags.some((t) => PREGATE_TAGS.has(t)) ? `pregate-receipt:${pr}` : null;
}

// ── Board 줄 ─────────────────────────────────────────────────────────────────────────────

export interface WatchBoardCounts { watchesOpen: number; satisfiedLastHour: number; replyWaits: number }

/** Count from the waker files (one small JSON per seat) — the on-demand board reads it, never a hot path. */
export function watchBoardCounts(wakers: readonly WakerRecord[], nowMs: number): WatchBoardCounts {
  let watchesOpen = 0, satisfiedLastHour = 0, replyWaits = 0;
  for (const w of wakers) {
    let kind: WaitCondition['kind'];
    try { kind = parseWaitCondition(w.condition).kind; } catch { continue; }
    if (w.status === 'armed' && kind === 'mail-reply') replyWaits++;
    if (!w.autoClose) continue;
    if (w.status === 'armed') watchesOpen++;
    if (w.status === 'fired' && w.closedAt && nowMs - Date.parse(w.closedAt) <= 3_600_000) satisfiedLastHour++;
  }
  return { watchesOpen, satisfiedLastHour, replyWaits };
}

export function watchBoardLine(c: WatchBoardCounts): string {
  return `👁 Watches open ${c.watchesOpen} · satisfied/h ${c.satisfiedLastHour} · reply-waits ${c.replyWaits}`;
}

/** Every seat's waker records under `root` (unreadable files are skipped). */
export function readAllWakers(root: string): WakerRecord[] {
  if (!existsSync(root)) return [];
  const out: WakerRecord[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(root, name), 'utf8')) as { wakers?: WakerRecord[] };
      if (Array.isArray(parsed.wakers)) out.push(...parsed.wakers);
    } catch { /* a half-written file reads next time */ }
  }
  return out;
}
