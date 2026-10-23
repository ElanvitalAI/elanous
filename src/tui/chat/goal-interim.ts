// ── 골 중간 답 접기 `goal-interim` (TUI-GOAL-INTERIM-QUIET 조각 2 · 2026-10-22 · 대표 «대화 연결이 이상하다») ──────
//
// 🚨 무엇을 푸는가: 골 하나를 도는 동안 작은 단계마다 턴이 끝나고(«…아직 못 했습니다»·«…하겠습니다»),
//   goal-continue / child-complete 내부 턴이 다시 열린다. 그 사이 «못 했다» 문단이 대화에 단계 수만큼 쌓이고
//   (n8n 세션 10-22 22:4x), next TUI 는 내부 턴 입력을 «나: [골 이어가기] …» 로 사람 발화처럼 그렸다.
// ⭐ 이 모듈은 «그리는 층»의 판정만 한다(순수):
//   ① 내부 턴 입력 글(우리 포매터가 만든 접두)을 알아본다 → 사람 머리(«나:»·«❯») 대신 «↻ 자동 재개(<origin>)».
//   ② 내부 이어가기 턴 «바로 앞» 답이 중간 보고(못 했다·약속)면 한 줄 «· 진행 — <첫 줄> (접힘)» 로 접는다.
//      마지막 답(골 끝·막힘)은 접지 않는다 → 미완 목록 문단은 한 번만 남는다.
// ⛔ 세션 기록·모델 입력은 그대로다(화면만 접는다). 판정이 애매하면 접지 않는다(정보를 숨기지 않는 쪽).
//
// 세 얼굴:
//   관측 = debug.log('tui.goal-interim', 'folded' | 'kept', { surface:'classic', origin, reason, lines }) ·
//          next 는 턴 끝마다 접힘 수가 바뀌면 'folded' { surface:'next', folded, internal } (src/tui/entry.ts)
//   인지 = 다음 턴이 내부 이어가기인가 ∧ 앞 답이 중간 보고 꼴인가 ∧ (classic) 그 줄들이 아직 제자리인가
//   힐링 = 앞 문단을 한 줄로 접는다 · 줄이 움직였으면(버퍼 잘림·끼워 넣은 에코) 접지 않고 'kept' 사유를 남긴다

import { debug } from '../../debug/log.js';
import { classifyReplyTail, replyTailFromLines } from '../../chat/goal-continue-verdict.js';
import type { InternalTurnOrigin } from '../../chat/internal-turn-origin.js';

/** 내부 턴 입력 접두 — goal-continue.ts `formatGoalContinuePrompt` · agent-wake.ts `formatAgentWakePrompt` ·
 *  seat-autowake.ts `formatSeatAutowakePrompt` 와 같아야 한다(goal-interim.test.ts 가 세 포매터를 문다). */
const INTERNAL_TURN_TEXT_PREFIXES: ReadonlyArray<{ prefix: string; origin: InternalTurnOrigin }> = [
  { prefix: '[골 이어가기] ', origin: 'goal-continue' },
  { prefix: '[자동 재개] 위임 끝: ', origin: 'child-complete' },
  { prefix: '[자동 재개] 남은 일: ', origin: 'autowake' },
];

/** 이 글이 우리가 연 내부 턴의 입력이면 그 출처, 아니면 null(사람 글). */
export function internalTurnOriginOfText(text: string): InternalTurnOrigin | null {
  const head = text.trimStart();
  for (const { prefix, origin } of INTERNAL_TURN_TEXT_PREFIXES) if (head.startsWith(prefix)) return origin;
  return null;
}

/** 앞 답을 접는 이어가기 출처 — 같은 골을 «이어서» 도는 턴만(goal-continue · child-complete).
 *  autowake(«남은 일: 우편·큐»)·예약·우편 깨움은 새 일이라 앞 답을 건드리지 않는다(입력 줄 머리만 바꾼다). */
const FOLDING_ORIGINS: ReadonlySet<InternalTurnOrigin> = new Set(['goal-continue', 'child-complete']);
function isFoldingOrigin(origin: InternalTurnOrigin | null | undefined): boolean {
  return origin != null && FOLDING_ORIGINS.has(origin);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** 답이 아닌 줄(턴 상태·도구·배너) — goal-continue 의 NON_REPLY 와 같은 뜻. */
const NON_REPLY_LINE = /^\s*(?:✔ 완료|✘ 실패|응답 완료|응답 중|라우팅:|󰧑|⚙️|도구:|나:|↻ 자동 재개|⏰|⏸|⏹|❯|[─━]{3,})/u;

/** 미완 고백 — «못 했다 / 보고할 수 없다 / 아직 안 됐다» ⊕ 영어. */
const INCOMPLETE_RE = new RegExp([
  '못\\s?했',
  '하지\\s?못(?:했|함|하였)',
  '(?:완료|끝내|마치|만들|보고하)지\\s?못',
  '보고할\\s?수\\s?없',
  '아직\\s?(?:안\\s?(?:됐|되었|끝)|없습니다|미완)',
  "couldn['’]t",
  'could not',
  "was(?:n['’]t| not) able",
  'unable to',
  'not (?:yet )?(?:done|finished|completed?)\\b',
].join('|'), 'iu');

export type InterimVerdict =
  | { interim: true; reason: 'incomplete' | 'pledge'; summary: string }
  | { interim: false; reason: 'no-reply' | 'final' };

/** 답 줄(색 코드 포함 가능)이 «중간 보고»인가 — 미완 고백 또는 약속으로 끝난 답. */
export function classifyInterimReply(lines: readonly string[]): InterimVerdict {
  const plain = lines.map((l) => l.replace(ANSI, '').trim()).filter((l) => l && !NON_REPLY_LINE.test(l));
  if (plain.length === 0) return { interim: false, reason: 'no-reply' };
  const summary = plain[0]!.replace(/^엘라누스:\s*/u, '');
  // 끝 문장만 본다 — 중간의 «X 는 못 했지만 Y 는 끝냈다» 한 구절로 결과 답을 접지 않는다(goal-continue 와 같은 규칙).
  const tail = replyTailFromLines(lines);
  const last = tail ? (tail.split(/(?<=[.!?。？])\s+/u).filter(Boolean).at(-1) ?? tail) : '';
  if (INCOMPLETE_RE.test(last)) return { interim: true, reason: 'incomplete', summary };
  if (classifyReplyTail(tail).pledge) return { interim: true, reason: 'pledge', summary };
  return { interim: false, reason: 'final' };
}

const SUMMARY_CHARS = 60;
/** 접힌 한 줄 — «· 진행 — <첫 줄> (접힘)». */
export function formatInterimFoldLine(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const cut = [...flat].length > SUMMARY_CHARS ? `${[...flat].slice(0, SUMMARY_CHARS).join('')}…` : flat;
  return `· 진행 — ${cut} (접힘)`;
}

// ── next: 세션 메시지 위의 그리기 계획(순수) ─────────────────────────────────────────────

export type InterimDisplay =
  | { kind: 'internal-input'; origin: InternalTurnOrigin }
  | { kind: 'folded'; line: string };

/** 메시지 인덱스 → 그리기 바꿈. 내부 턴 입력은 출처 한 줄, 그 «바로 앞» 중간 보고 답은 한 줄로 접는다. */
export function planInterimDisplay(messages: ReadonlyArray<{ role: string; content?: unknown }>): Map<number, InterimDisplay> {
  const plan = new Map<number, InterimDisplay>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const origin = internalTurnOriginOfText(m.content);
    if (!origin) continue;
    plan.set(i, { kind: 'internal-input', origin });
    if (!isFoldingOrigin(origin)) continue;
    // 앞 사람/내부 입력 뒤의 마지막 답 하나만 — 도구 블록은 그대로 둔다.
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]!;
      if (prev.role === 'user') break;
      if (prev.role !== 'assistant' || typeof prev.content !== 'string') continue;
      const verdict = classifyInterimReply(prev.content.split('\n'));
      if (verdict.interim) plan.set(j, { kind: 'folded', line: formatInterimFoldLine(verdict.summary) });
      break;
    }
  }
  return plan;
}

/** 계획의 접힌 답 수 ⊕ 내부 입력 줄 수 — next 관측용. */
export function countInterimDisplay(plan: ReadonlyMap<number, InterimDisplay>): { folded: number; internal: number } {
  let folded = 0;
  let internal = 0;
  for (const d of plan.values()) { if (d.kind === 'folded') folded += 1; else internal += 1; }
  return { folded, internal };
}

// ── classic: 화면 줄(chatLines) 위의 접기 상태 ──────────────────────────────────────────

export interface ClassicInterimFoldDeps {
  /** 접어도 되는 때인가 — 대시보드는 «끼워 넣은 사람 에코가 없다»를 넘긴다(줄 위치가 확실할 때만). */
  canFold?: () => boolean;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export interface ClassicInterimFold {
  /** 턴이 끝났다 — 이번 턴의 «마지막 답 블록» 시작(스트림 applier 의 assistantStart)부터 끝까지를 사본으로 잡는다.
   *  도구·라우팅 줄은 그 앞이라 접히지 않는다(next 가 답 메시지만 접는 것과 같다). */
  noteTurnEnded(chatLines: readonly string[], start: number): void;
  /** 사람이 턴을 열었다 — 잡아 둔 답을 놓는다(사람 턴 앞 답은 접지 않는다). */
  noteHumanTurn(): void;
  /** 내부 이어가기 턴이 막 열린다 — 잡아 둔 앞 답이 중간 보고면 그 자리를 한 줄로 바꾼다. */
  foldBeforeInternalTurn(chatLines: string[], origin: InternalTurnOrigin, style?: (line: string) => string): { folded: boolean; reason: string };
}

export function createClassicInterimFold(deps: ClassicInterimFoldDeps = {}): ClassicInterimFold {
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  let last: { start: number; lines: string[] } | null = null;
  const kept = (origin: InternalTurnOrigin, reason: string, extra: Record<string, unknown> = {}) => {
    log('tui.goal-interim', 'kept', { surface: 'classic', origin, reason, ...extra });
    return { folded: false, reason };
  };
  return {
    noteTurnEnded(chatLines, start) {
      const from = Math.max(0, Math.min(start, chatLines.length));
      last = { start: from, lines: chatLines.slice(from) };
    },
    noteHumanTurn() { last = null; },
    foldBeforeInternalTurn(chatLines, origin, style = (l) => l) {
      const snap = last;
      last = null;
      if (!isFoldingOrigin(origin)) return kept(origin, 'not-continuation');
      if (!snap || snap.lines.length === 0) return kept(origin, 'no-previous-reply');
      if (deps.canFold && !deps.canFold()) return kept(origin, 'lines-unstable');
      // 그 줄들이 아직 제자리인가 — 버퍼 앞이 잘렸거나 무엇이 끼어들었으면 위치를 믿지 않는다.
      const here = chatLines.slice(snap.start, snap.start + snap.lines.length);
      if (here.length !== snap.lines.length || here.some((line, k) => line !== snap.lines[k])) return kept(origin, 'lines-moved');
      const verdict = classifyInterimReply(snap.lines);
      if (!verdict.interim) return kept(origin, verdict.reason);
      const line = formatInterimFoldLine(verdict.summary);
      chatLines.splice(snap.start, snap.lines.length, style(`  ${line}`));
      log('tui.goal-interim', 'folded', { surface: 'classic', origin, reason: verdict.reason, lines: snap.lines.length });
      return { folded: true, reason: verdict.reason };
    },
  };
}
