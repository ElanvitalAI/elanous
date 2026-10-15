// 🪪 L1 시작 부트 — 새 세션 첫 턴 앞에 «자리 부트 카드»를 자동으로 싣는다 (TUI-SESSION-BOOT · 2026-10-14).
//
// S: `~/elanous-hq/seats/OP` 에서 TUI 를 다시 띄우면 미읽은 우편·HANDOFF·예약을 모른 채 시작했고,
//    사람이 `eln seat boot OP` 를 손으로 돌려 붙여 넣어야 했다(PLAN-tui-self-awareness §A L1).
// A: 대화마다 «한 번» 카드를 만들어(대화 시작 스냅샷) 그 대화의 매 턴 preamble 에 같은 문면으로 싣는다.
//    - 자리 판정: cwd 의 `/seats/<자리>` → `COORD_ID` 순. 둘 다 없거나 `seat-state/<자리>` 가 없으면 주입 0.
//    - 재료: `cli/seat-cli.ts` 의 `collectSeatBootSections`·`renderSeatBootCard`(contextNow 절은 생략 —
//      턴 경로에서 컨텍스트 버스를 읽지 않는다).
//    - 대시보드의 ACP sessionId 는 TUI 수명 내내 같다 ⇒ `/session new`·`/session clear` 는
//      `startSeatBootConversation` 으로 카드 캐시를 비워 «새 대화 = 새 카드»를 만든다.
// 관측: `dashboard.seat-boot` card-injected / card-skipped / conversation-start.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { collectSeatBootSections, renderSeatBootCard } from '../cli/seat-cli.js';
import { defaultMsgStorePath } from '../msg/msg-store.js';

export interface SeatDetection {
  seat: string;
  source: 'cwd' | 'coord-id';
}

const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/;

/** cwd 의 `/seats/<자리>` → `COORD_ID` 순으로 자리를 판정한다. 못 하면 null. */
export function detectSeat(cwd: string, env: NodeJS.ProcessEnv = process.env): SeatDetection | null {
  const fromCwd = SEAT_IN_PATH.exec(cwd)?.[1]?.toUpperCase();
  if (fromCwd && SEAT_ID.test(fromCwd)) return { seat: fromCwd, source: 'cwd' };
  const coord = env.COORD_ID?.trim().toUpperCase();
  if (coord && SEAT_ID.test(coord)) return { seat: coord, source: 'coord-id' };
  return null;
}

export interface SeatBootDeps {
  home?: string;
  msgPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

// 대화마다 한 장(작업 디렉터리별). 대시보드는 한 번에 한 대화이고 ACP sessionId 가 수명 내내 같으므로
// 세션 id 가 아니라 «대화 ⊕ cwd» 가 키다. 비우는 자리는 `startSeatBootConversation`(새 대화) 뿐 — 축출 없음.
// 첫 화면 한 줄(`describeSeatBoot`)과 턴 카드가 «같은 스냅샷»을 본다.
interface CardEntry { messages: LLMMessage[]; observed: Record<string, unknown> }
const cardCache = new Map<string, CardEntry>();

export function resetSeatBootCacheForTest(): void {
  cardCache.clear();
}

function buildCardMessages(cwd: string, deps: SeatBootDeps): { messages: LLMMessage[]; observed: Record<string, unknown> } {
  const detection = detectSeat(cwd, deps.env ?? process.env);
  if (!detection) return { messages: [], observed: { reason: 'no-seat' } };
  const home = deps.home ?? homedir();
  const seatDir = join(home, 'elanous-hq', 'seat-state', detection.seat);
  let isSeatDir = false;
  try { isSeatDir = statSync(seatDir).isDirectory(); } catch { /* absent */ }
  if (!isSeatDir) return { messages: [], observed: { reason: 'no-seat-state', seat: detection.seat, source: detection.source } };
  const { sections, unread } = collectSeatBootSections(detection.seat, { home, msgPath: deps.msgPath ?? defaultMsgStorePath() });
  const card = renderSeatBootCard(detection.seat, sections, null);
  const at = (deps.now?.() ?? new Date()).toISOString();
  const content =
    `## 자리 부트 카드 — 너는 이 작업 디렉터리의 ${detection.seat} 자리에서 일한다\n` +
    `(판정: ${detection.source === 'cwd' ? `cwd 의 /seats/${detection.seat}` : 'COORD_ID'} · 세션 시작 스냅샷 ${at} · 이후 바뀐 값은 다시 조회하라)\n` +
    `사람이 다른 일을 먼저 시키지 않았다면, 첫 답에서 자리와 안 읽은 우편 수를 짚고 처리할 일을 제안하라.\n\n` +
    card;
  return {
    messages: [{ role: 'system', content }],
    observed: { seat: detection.seat, source: detection.source, unread, chars: content.length },
  };
}

function conversationCard(cwd: string, deps: SeatBootDeps, sessionId?: string): CardEntry {
  const cached = cardCache.get(cwd);
  if (cached) return cached;
  let entry: CardEntry = { messages: [], observed: {} };
  try {
    entry = buildCardMessages(cwd, deps);
    debug.log('dashboard.seat-boot', entry.messages.length ? 'card-injected' : 'card-skipped', {
      cwd,
      sessionId: sessionId ?? null,
      ...entry.observed,
    });
  } catch (err) {
    // 부트 카드가 턴을 막지 않는다 — 실패는 관측만.
    debug.log('dashboard.seat-boot', 'card-skipped', { cwd, reason: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  cardCache.set(cwd, entry);
  return entry;
}

/** 이 대화의 자리 부트 카드(system 메시지 0~1개). 대화마다 «처음 한 번»만 만들고 같은 대화는 같은 문면을 돌려준다. */
export function buildSeatBootSystemMessages(ctx: { cwd: string; sessionId?: string }, deps: SeatBootDeps = {}): LLMMessage[] {
  return conversationCard(ctx.cwd, deps, ctx.sessionId).messages;
}

/** 첫 화면 한 줄용 — 자리면 {자리, 안 읽은 우편 수}. 턴 카드와 같은 스냅샷이다. */
export function describeSeatBoot(cwd: string, deps: SeatBootDeps = {}): { seat: string; unread: number | null } | null {
  const entry = conversationCard(cwd, deps);
  if (!entry.messages.length) return null;
  return { seat: String(entry.observed.seat), unread: (entry.observed.unread as number | null) ?? null };
}

/** 새 대화의 시작(부팅 새 세션 · `/session new` · `/session clear`) — (부팅이 아니면) 카드 캐시를 비워
 *  다음 턴에 새 카드를 만든다. 부팅은 «첫» 대화라, 그 전에 유휴 getPreamble·첫 화면이 만든 카드가 곧 이 대화의 카드다. */
export function startSeatBootConversation(opts: { reason: 'boot' | 'session-new' | 'session-clear' }): void {
  if (opts.reason !== 'boot') cardCache.clear();
  debug.log('dashboard.seat-boot', 'conversation-start', { reason: opts.reason });
}
