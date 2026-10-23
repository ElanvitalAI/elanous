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
// 관측: `dashboard.seat-boot` card-injected / card-skipped / conversation-start / memory-recall(직전 인계 회상 한 줄).

import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import { debug, redactSecretText } from '../debug/log.js';
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

/** 자리(무인) TUI 판정 — `detectSeat` ⊕ `~/elanous-hq/seat-state/<자리>` 가 실재(부트 카드와 같은 기준).
 *  TUI 라우팅(TUI-H1-SEAT-GOALLOOP)이 «자리면 운영 지시를 goal loop 로» 가를 때 쓴다. 자리가 아니면 null(사람 대화 TUI) · 조회 실패는 throw. */
export function detectSeatTui(
  cwd: string,
  deps: { home?: string; env?: NodeJS.ProcessEnv; stat?: (path: string) => { isDirectory(): boolean } } = {},
): SeatDetection | null {
  const detection = detectSeat(cwd, deps.env ?? process.env);
  if (!detection) return null;
  try {
    return (deps.stat ?? statSync)(join(deps.home ?? homedir(), 'elanous-hq', 'seat-state', detection.seat)).isDirectory() ? detection : null;
  } catch (error) {
    // «없다»(ENOENT·ENOTDIR)만 «자리 아님»이다. 권한 오류 등 조회 실패는 던진다 — 호출부(bridge)가 seatKnown:false 로 남긴다.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
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

/** 🧭 의도 승격 흐름(TUI-SELFIMPLEMENT-UNDERUSE-MEASURE · 대표 10-22 «확인도 결국 하다 보면 원인이 나오고 자연스럽게
 *  구현이 나오게끔») — 10-22 prod 자리 세션 셋(UX GLM i57ey0 · UX Luna 7x2rxn · OPT Luna 7d3o49)은 노출된 SelfImplement·
 *  tasks hand 를 한 번도 안 불렀다. 끊긴 자리 = 처방까지 세우고 «다음 턴에 SelfImplement 로 발사»·«TA 발사 보류 · 재점검
 *  예약» 으로 턴을 닫거나, 구현을 자리에서 Edit 로 직접 했다(격리 실물 전: SelfImplement 0 · Edit/Write 직접).
 *  자리 카드에 실어 «자리 대화의 매 턴» 이 같은 흐름을 본다(사람 대화 TUI 에는 안 실린다). */
export const SEAT_INTENT_ESCALATION_FLOW =
  '## 일의 흐름 — 확인에서 구현 골까지 한 흐름\n' +
  '확인 → 원인 발견 → 조사 → 처방 확정 → 구현 골 넘기기 를 «이 턴 안에서» 잇는다. 확인·조사 지시도 원인을 찾으면 여기서 멈추지 않는다.\n' +
  '- 원인과 처방이 섰으면 «다음 턴에»·«보고 뒤에»·«재점검 예약» 으로 미루지 말고 바로 구현 골로 넘긴다 — TUI 에서는 SelfImplement 도구(자리 규칙이 손 발사를 정했으면 `eln tasks hand`). 넘긴 뒤 보고는 한 줄.\n' +
  '- 자리에서 기능·수정·여러 파일 구현을 Edit/Write 로 직접 하지 않는다 — 한 줄 설정·문서·오타만 예외.\n' +
  '- 원인이 없으면 «원인 없음 · 근거(무엇을 봤나)» 한 줄로 끝낸다. 넘기지 못하면(권한·선행 조건) 막힌 이유와 필요한 판단 하나를 적는다.';

/** 🧠 직전 인계 회상 한 줄(TUI-SEAT-MEMORY-RECALL · COMPARE ④ · 대표 «메모리»).
 *  S: 10-22 prod 자리 세션 셋(UX GLM · UX Luna · OPT Luna)이 memory_recall·self_recall 을 한 번도 안 불렀다 — 기억 도구가
 *     «있는데 안 씀». codex 는 AGENTS.md 를, Claude Code 는 자동 메모리를 턴 머리에 스스로 싣는다.
 *  A: 소스를 «하나»로 잰다 — `seat-state/<자리>/HANDOFF-*.md` 중 mtime 이 가장 최근인 손 인계. 없으면 줄 없음
 *     (`HANDOFF.md` 는 자동 갱신 카드이고 카드 «HANDOFF» 절이 이미 제목을 싣는다 — 본문은 싣지 않는 그 계약을 지킨다).
 *     memory_recall·self_recall 은 자리 구분 없는 전역 원장(surface_events·knowledge.db)이라 «이 자리의 직전 인계»를
 *     못 고르고, 우편 결정은 원장 질의가 필요하다 — 자리마다 이미 있는 HANDOFF 가 가장 작은 1급 소스다.
 *     손 인계(HANDOFF-*.md)는 카드 어디에도 안 실렸다 — 그 제목·첫 줄이 여기 실린다.
 *  줄 = 머리말 · 파일 · 갱신 시각 · 제목 · 첫 본문 줄 · 전문 경로 · 더 넓은 회상 도구. 상한 `SEAT_MEMORY_RECALL_MAX_CHARS`.
 *  실패는 줄 없음(fail-soft) — 카드·턴을 막지 않는다. */
export const SEAT_MEMORY_RECALL_PREFIX = '🧠 직전 인계 회상:';
export const SEAT_MEMORY_RECALL_MAX_CHARS = 360;
const RECALL_READ_BYTES = 16_384;
/** 발췌(제목 — 첫 줄)에 남길 최소 글자 — 이보다 모자라면 전문 경로를 짧은 꼴로 바꾼다. */
const RECALL_MIN_EXCERPT = 60;
/** 줄에 싣는 파일명 최대 글자. */
const RECALL_MAX_NAME = 80;

interface SeatMemoryRecall { line: string | null; source: string | null }

/** 제어 문자·줄 구분자 — 하나라도 섞이면 «한 줄» 계약이 깨진다(파일명·경로·본문 모두). */
const LINE_BREAKING = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
/** 셸 문자 — 카드 HANDOFF 절과 같은 안전 규칙. 본문 줄뿐 아니라 파일명·경로에도 적용한다(r4). */
const SHELL_CHARS = /[`$;|<>]/;
const oneLine = (text: string): string => redactSecretText(text.replace(new RegExp(LINE_BREAKING.source, 'g'), ' ').replace(/\s+/g, ' ').trim());

/** 앞 `RECALL_READ_BYTES` 만 읽는다 — 큰 인계 파일도 턴 시작을 막지 않는다. */
function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(RECALL_READ_BYTES);
    const n = readSync(fd, buf, 0, RECALL_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

function newestHandoff(seatDir: string): { path: string; mtime: Date } | null {
  if (LINE_BREAKING.test(seatDir)) return null;
  const pick = (names: string[]): { path: string; mtime: Date } | null => {
    let best: { path: string; mtime: Date } | null = null;
    for (const name of names) {
      const path = join(seatDir, name);
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue; // 디렉터리·링크는 건너뛴다
        if (!best || st.mtimeMs > best.mtime.getTime()) best = { path, mtime: st.mtime };
      } catch { /* 사라진 후보 — 건너뛴다 */ }
    }
    return best;
  };
  // 제어 문자가 든 파일명은 후보에서 뺀다 — 이름·경로를 줄에 그대로 싣기 때문이다.
  // 파일명은 안전 문자만(영숫자 · . _ -) — 셸 문자·제어 문자가 든 이름은 후보에서 뺀다(이름을 줄에 그대로 싣는다).
  return pick(readdirSync(seatDir).filter((name) => /^HANDOFF-[A-Za-z0-9._-]+\.md$/.test(name)));
}

/** 자리의 직전 인계 회상 한 줄. 소스가 없거나 읽을 수 없으면 `line: null`.
 *  카드 HANDOFF 절과 같은 안전 규칙 — 셸 문자(`` ` `` `$` `;` `|` `<` `>`)가 든 줄은 싣지 않는다 · 비밀은 가린다. */
function buildSeatMemoryRecall(seatDir: string): SeatMemoryRecall {
  const found = newestHandoff(seatDir);
  if (!found) return { line: null, source: null };
  const raw = readHead(found.path).split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((line) => line.trim()).filter((line) => line && !/[`$;|<>]/.test(line));
  const title = raw.find((line) => /^#{1,6}\s/.test(line))?.replace(/^#{1,6}\s*/, '') ?? '';
  const first = raw.find((line) => !/^#{1,6}\s/.test(line))?.replace(/^[-*]\s*/, '') ?? '';
  const excerpt = oneLine([title, first].filter(Boolean).join(' — '));
  if (!excerpt) return { line: null, source: found.path };
  const fullName = found.path.slice(seatDir.length + 1);
  // 파일명은 머리에 한 번만, 길면 앞 RECALL_MAX_NAME 자로 자른다 — 이름 길이가 발췌를 밀어내지 않는다.
  const name = fullName.length > RECALL_MAX_NAME ? `${fullName.slice(0, RECALL_MAX_NAME - 1)}…` : fullName;
  const head = `${SEAT_MEMORY_RECALL_PREFIX} ${name}(갱신 ${found.mtime.toISOString()}) `;
  // 경로가 길어 발췌 자리가 모자라면 전문 경로 대신 «자리 폴더(seat-state/<자리>/)»만 가리킨다 — 줄을 버리지 않는다.
  const tools = ' · 더 넓게는 self_recall·memory_recall';
  // 경로·자리 폴더 이름에 셸 문자가 있으면 싣지 않는다(본문 줄과 같은 규칙) · 비밀은 가린다.
  const pathSafe = !SHELL_CHARS.test(found.path);
  const seatName = basename(seatDir);
  const seatSafe = !SHELL_CHARS.test(seatName);
  const fullTail = pathSafe ? ` · 전문 ${redactSecretText(found.path)}${tools}` : '';
  const shortTail = seatSafe
    ? ` · 전문은 seat-state/${redactSecretText(seatName).slice(0, 64)}/ 의 같은 파일${tools}`
    : ` · 전문은 이 자리 seat-state 폴더의 같은 파일${tools}`;
  const tail = fullTail && SEAT_MEMORY_RECALL_MAX_CHARS - head.length - fullTail.length >= RECALL_MIN_EXCERPT ? fullTail : shortTail;
  // 머리(≤ ~130)·짧은 꼬리(≤ ~120)의 상한 덕에 발췌 자리는 늘 남는다 — 아래는 상수가 바뀔 때의 안전망.
  const room = SEAT_MEMORY_RECALL_MAX_CHARS - head.length - tail.length;
  if (room < 8) return { line: null, source: found.path };
  const body = excerpt.length > room ? `${excerpt.slice(0, room - 1)}…` : excerpt;
  return { line: `${head}${body}${tail}`, source: found.path };
}

function seatMemoryRecallLine(seatDir: string): string | null {
  let recall: SeatMemoryRecall = { line: null, source: null };
  let failed = false;
  try { recall = buildSeatMemoryRecall(seatDir); }
  catch { failed = true; }
  debug.log('dashboard.seat-boot', 'memory-recall', {
    source: recall.source,
    chars: recall.line?.length ?? 0,
    hit: recall.line !== null,
    ...(failed ? { reason: 'error' } : {}),
  });
  return recall.line;
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
  const recall = seatMemoryRecallLine(seatDir);
  const content =
    `## 자리 부트 카드 — 너는 이 작업 디렉터리의 ${detection.seat} 자리에서 일한다\n` +
    `(판정: ${detection.source === 'cwd' ? `cwd 의 /seats/${detection.seat}` : 'COORD_ID'} · 세션 시작 스냅샷 ${at} · 이후 바뀐 값은 다시 조회하라)\n` +
    `사람이 다른 일을 먼저 시키지 않았다면, 첫 답에서 자리 이름·'자리 역할' 절의 역할·안 읽은 우편 수를 각각 명시하고 처리할 일을 제안하라. 역할이 미관측이면 추측하지 말고 미관측이라고 말하라.\n` +
    (recall ? `${recall}\n` : '') +
    '\n' +
    `${SEAT_INTENT_ESCALATION_FLOW}\n\n` +
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
    // 🧭 이 대화에 «확인 → … → 구현 골 넘기기» 흐름을 실었다 — 단계·근거·다음 행동(넘김 도구). 대화마다 한 번.
    if (entry.messages.length) {
      debug.log('dashboard.seat-boot', 'intent.escalate', {
        stage: 'guidance',
        evidence: { seat: entry.observed.seat, source: entry.observed.source },
        next: ['SelfImplement', 'eln tasks hand'],
        sessionId: sessionId ?? null,
      });
    }
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
