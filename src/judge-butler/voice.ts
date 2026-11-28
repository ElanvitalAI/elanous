// 판정 집사 — voice (LOOP-AGENT §1 ⑤ 목소리 · 대표 11-27 «새 개념 루프 에이전트는 말할 수 있나»).
//
// S: a loop agent that cannot be talked to cannot be handed work, asked «why», or corrected (LOOP-AGENT §4 왜 바꾸나).
// C: the els channel (`loop:<id>` · PR #40282) is not landed; the body must stay LLM 0 and every action must stay a closed
//    L1 command — a voice must never become free-form shell.
// Q: how does a mail to the butler (from 대표 · OP · JUD · coordinators · hands) become one budget-capped LLM turn that answers
//    as the butler, with evidence ids, and whose decisions run only through the body?
// A: `VoiceInbox` is the adapter (mail today: `mailVoiceInbox` in live.ts; the els channel plugs in as another inbox with no
//    change here). `voiceTurn()` builds the context (soul ⊕ goal/KPI ⊕ recent cases/lessons ⊕ state ⊕ facts for the cells/HOLDs
//    the message names), makes ONE call through `VoiceLlm` (the federation's configured coordinator LLM in live; a fake in
//    tests), parses {reply, actions[]}, runs each action through `VoiceCommands` (sign = done-when gate · explain · propose-narrow ·
//    expire-due · escalate · demote = L0 seats only); anything else is refused as «권한 밖» and escalated to JUD. Over the hourly
//    budget (goal card voice.per_hour_max) or with no LLM, it folds to a deterministic facts reply ⊕ escalation. Every turn is a
//    `voice` case in memory.
import type { Hold } from '../hold-ledger/hold-ledger.js';
import type { CellIn, Verdict } from './done-when.js';
import { BUTLER_DEMOTERS, BUTLER_LEVELS, BUTLER_SEAT, BUTLER_SUPERVISOR, type ButlerLevel, type ButlerMemory, type Case } from './memory.js';

export interface VoiceMessage { readonly id: number | string; readonly from: string; readonly body: string; readonly at: string; readonly channel: string }
/** The input adapter: mail today, the els channel (`loop:judge-butler`) later — the agent never knows which. */
export interface VoiceInbox {
  pending(nowMs: number): VoiceMessage[];
  reply(msg: VoiceMessage, text: string, refs: readonly string[]): number | string | null;
}
export interface VoiceLlm { complete(system: string, user: string): Promise<{ text: string; model: string }> }

export interface VoiceState {
  readonly now: Date;
  readonly level: ButlerLevel;
  readonly cells: readonly CellIn[];
  readonly verdicts: ReadonlyMap<string, Verdict>;
  readonly holds: readonly Hold[];
  readonly frozenHands: number;
  readonly judgeQueue: { count: number; medianWaitMin: number | null; ready?: number };
}

export type VoiceAction =
  | { cmd: 'sign'; cell: string } | { cmd: 'explain'; cell: string } | { cmd: 'propose-narrow'; hold: string }
  | { cmd: 'expire-due' } | { cmd: 'escalate'; to: string; why: string } | { cmd: 'demote'; to: string; why?: string };
/** The closed L1 command set the voice may use — each returns one line with its evidence id. */
export interface VoiceCommands {
  sign(cell: string): Promise<{ ok: boolean; line: string; ref?: string }>;
  explain(cell: string): string;
  proposeNarrow(hold: string, from: string): { ok: boolean; line: string; ref?: string };
  expireDue(): { line: string; refs: string[] };
  escalate(to: 'JUD' | 'OP', why: string, msg: VoiceMessage): { line: string; ref?: string };
  demote(to: ButlerLevel, by: string, why: string): { ok: boolean; line: string };
}

const VOICE_RIGHTS = `혼자 할 수 있는 행동(이 JSON 명령만 · 다른 것은 실행되지 않는다):
- {"cmd":"sign","cell":"<칸>"} — 완료 조건(같은 head 영수 · focused exit 0 · 시험 우주 E4 증거)을 채운 칸만. 아니면 거절된다.
- {"cmd":"explain","cell":"<칸>"} — 그 칸의 판정 사실을 답에 붙인다.
- {"cmd":"propose-narrow","hold":"H-n"} — HOLD 주인에게 좁히기 제안(HOLD 변경 자체는 주인·JUD 몫).
- {"cmd":"expire-due"} — 만료·해제 조건 충족 HOLD 걷기.
- {"cmd":"escalate","to":"JUD|OP","why":"…"} — 권한 밖(기준 변경·HOLD 신설/해제·보안 4종 → JUD · 우선순위·영역 밖 → OP).
- {"cmd":"demote","to":"L1|shadow|off|live"} — 보낸 이가 JUD·OP·CLAUDE-OP·CEO 일 때만.
하지 않는 것: 기준 낮추기 · 증거 없는 서명 · 보안 4종 칸 서명 · HOLD 신설·넓히기·해제 · 셸 실행.`;

export function cellsNamed(text: string, cells: readonly CellIn[]): CellIn[] {
  const tokens = new Set(text.toUpperCase().split(/[^A-Z0-9_.-]+/u).filter(Boolean));
  return cells.filter(c => tokens.has(c.id.toUpperCase()));
}
export function holdsNamed(text: string, holds: readonly Hold[]): Hold[] {
  const ids = new Set([...text.toUpperCase().matchAll(/\bH-\d{1,6}\b/gu)].map(m => m[0]));
  return holds.filter(h => ids.has(h.id));
}
const verdictLine = (c: CellIn, v: Verdict | undefined): string =>
  `${c.id} [${c.status}${c.owner ? ` · ${c.owner}` : ''}] ${v ? `${v.kind}: ${v.why}` : c.status === 'green' ? `green by ${c.updatedBy ?? '?'}` : 'not judged (no merged PR in evidence)'}`;

export function buildVoicePrompt(input: { soulText: string; goalText: string; msg: VoiceMessage; state: VoiceState; cases: readonly Case[]; lessons: readonly { cell: string; text: string }[]; knowhow?: string }): { system: string; user: string } {
  const { state, msg } = input;
  const active = state.holds.filter(h => h.state === 'active' && Date.parse(h.expiresAt) > state.now.getTime());
  const named = cellsNamed(msg.body, state.cells);
  const namedHolds = holdsNamed(msg.body, state.holds);
  const system = [
    input.soulText.trim(),
    '## 목표 카드', input.goalText.trim() || '(기본값)',
    '## 권한', VOICE_RIGHTS,
    '## 답 형식', '오직 JSON 한 덩어리: {"reply":"<한국어 답 · 판정 집사로서 · 증거 id(칸·PR·HOLD·case) 포함 · 5줄 이하>","actions":[<위 명령 0개 이상>]}. 권한 밖이면 reply 에 그렇다고 말하고 escalate 를 넣는다.',
    '## 사실 규칙', '칸·HOLD 에 대한 사실은 «말한 칸의 판정 사실»·«말한 HOLD»·«지금» 절에 적힌 것만이다. `missing:` 뒤에 적힌 항목은 모두 «빠진 것»이다 — 채워졌다고 쓰지 마라. 모르면 모른다고 하고 explain 을 넣는다.',
  ].join('\n\n');
  const user = [
    `## 지금 (${state.now.toISOString()}) · 수준 ${state.level}`,
    `판정 대기 ${state.judgeQueue.count} · 중앙 대기 ${state.judgeQueue.medianWaitMin ?? '?'}분 · 묶인 손 ${state.frozenHands} · 활성 HOLD ${active.length}: ${active.map(h => `${h.id}(${h.owner} · ${h.cells.join(',')} · ~${h.expiresAt.slice(11, 16)}Z · 해제 ${h.unlock})`).join(' ') || '없음'}`,
    named.length ? `## 말한 칸의 판정 사실\n${named.map(c => verdictLine(c, state.verdicts.get(c.id))).join('\n')}` : '',
    namedHolds.length ? `## 말한 HOLD\n${namedHolds.map(h => `${h.id} ${h.state} · 주인 ${h.owner} · ${h.cells.join(',')} · 만료 ${h.expiresAt} · 해제 ${h.unlock} · 사유 ${h.reason}`).join('\n')}` : '',
    `## 최근 기억(사건)\n${input.cases.slice(-10).map(c => `${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 120)}`).join('\n') || '없음'}`,
    input.knowhow ? `## 노하우 팩 (loop-agents/judge-butler/knowhow)\n${input.knowhow}` : '',
    input.lessons.length ? `## 교훈\n${input.lessons.slice(-5).map(l => `${l.cell}: ${l.text.slice(0, 140)}`).join('\n')}` : '',
    `## 받은 말 (${msg.channel} #${msg.id} · 보낸 이 ${msg.from})\n${msg.body.slice(0, 2_000)}`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Lenient: the first {...} block; bad JSON → the whole text is the reply, no actions. */
export function parseVoice(text: string): { reply: string; actions: VoiceAction[] } {
  const m = /\{[\s\S]*\}/u.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { reply?: unknown; actions?: unknown };
      const actions = Array.isArray(j.actions) ? j.actions.filter((a): a is VoiceAction => !!a && typeof a === 'object' && typeof (a as { cmd?: unknown }).cmd === 'string') : [];
      if (typeof j.reply === 'string') return { reply: j.reply.trim(), actions };
    } catch { /* fall through */ }
  }
  return { reply: text.trim(), actions: [] };
}

/** Channel action token (PR #40331 contract: /^[A-Za-z0-9._:=-]{1,120}$/) — what the body executed, recorded by the channel as a ref. */
export const actionToken = (verb: string, arg = ''): string => `${verb}${arg ? `:${arg}` : ''}`.replace(/[^A-Za-z0-9._:=-]/gu, '_').slice(0, 120);

export async function runVoiceActions(actions: readonly VoiceAction[], msg: VoiceMessage, cmds: VoiceCommands): Promise<{ lines: string[]; refs: string[]; escalated: boolean; tokens: string[] }> {
  const lines: string[] = []; const refs: string[] = []; const tokens: string[] = []; let escalated = false;
  for (const a of actions.slice(0, 6)) {
    switch (a.cmd) {
      case 'sign': { const r = await cmds.sign(String(a.cell ?? '')); lines.push(r.line); if (r.ref) refs.push(r.ref); tokens.push(actionToken(r.ok ? 'sign' : 'sign-refused', String(a.cell ?? ''))); break; }
      case 'explain': lines.push(cmds.explain(String(a.cell ?? ''))); tokens.push(actionToken('explain', String(a.cell ?? ''))); break;
      case 'propose-narrow': { const r = cmds.proposeNarrow(String(a.hold ?? ''), msg.from); lines.push(r.line); if (r.ref) refs.push(r.ref); tokens.push(actionToken(r.ok ? 'propose-narrow' : 'propose-refused', String(a.hold ?? ''))); break; }
      case 'expire-due': { const r = cmds.expireDue(); lines.push(r.line); refs.push(...r.refs); tokens.push(actionToken('expire-due', String(r.refs.length))); break; }
      case 'escalate': {
        const to = String(a.to ?? '').toUpperCase() === 'OP' ? 'OP' : 'JUD';
        const r = cmds.escalate(to, String(a.why ?? '').slice(0, 300) || '판단 요청', msg); lines.push(r.line); if (r.ref) refs.push(r.ref); tokens.push(actionToken('escalate', to)); escalated = true; break;
      }
      case 'demote': {
        const to = String(a.to ?? '') as ButlerLevel;
        if (!(BUTLER_LEVELS as readonly string[]).includes(to)) { lines.push(`demote ${a.to}: 없는 수준`); break; }
        const r = cmds.demote(to, msg.from, a.why ?? `voice #${msg.id}`); lines.push(r.line); tokens.push(actionToken(r.ok ? 'demote' : 'demote-refused', to)); break;
      }
      default: {
        const r = cmds.escalate('JUD', `권한 밖 명령 ${JSON.stringify(a).slice(0, 120)} (보낸 이 ${msg.from})`, msg);
        lines.push(`권한 밖 명령 ${String((a as { cmd?: unknown }).cmd).slice(0, 20)} 실행 안 함 → JUD: ${r.line}`); if (r.ref) refs.push(r.ref); tokens.push(actionToken('refused', String((a as { cmd?: unknown }).cmd)), actionToken('escalate', 'JUD')); escalated = true;
      }
    }
  }
  return { lines, refs, escalated, tokens };
}

export interface VoiceDeps {
  readonly memory: ButlerMemory;
  readonly llm: VoiceLlm | null;
  readonly cmds: VoiceCommands;
  readonly soulText: string;
  readonly goalText: string;
  readonly perHourMax: number;
  /** LOOP-AGENT v2 shell: the knowhow pack items relevant to this message (whole items · bounded). */
  readonly knowhow?: (query: string) => string;
}
export interface VoiceResult { readonly msg: VoiceMessage; readonly folded: boolean; readonly reply: string; readonly refs: string[]; readonly model: string | null; readonly escalated: boolean; readonly actions: string[] }

/** Deterministic answer when the voice is folded (over budget · L1 · no LLM · LLM error): the facts ⊕ escalation to JUD. */
export function foldedReply(msg: VoiceMessage, state: VoiceState, why: string, cmds: VoiceCommands): { reply: string; refs: string[] } {
  const named = cellsNamed(msg.body, state.cells).map(c => verdictLine(c, state.verdicts.get(c.id)));
  const holds = holdsNamed(msg.body, state.holds).map(h => `${h.id} ${h.state} · ${h.owner} · ${h.cells.join(',')} · 만료 ${h.expiresAt.slice(0, 16)}Z`);
  const esc = cmds.escalate('JUD', `판정 집사 목소리 접힘(${why}) — ${msg.from} #${msg.id} 판단 요청: ${msg.body.slice(0, 160)}`, msg);
  return { reply: [`[판정 집사 · 목소리 접힘: ${why}]`, ...named, ...holds, `판단이 필요한 부분은 JUD 로 올렸다 — ${esc.line}`].join('\n'), refs: esc.ref ? [esc.ref] : [] };
}

/** One voice turn for one message (budget-checked by the caller via `voiceBudgetOk`). */
export async function voiceTurn(msg: VoiceMessage, state: VoiceState, deps: VoiceDeps, budgetOk: boolean): Promise<VoiceResult> {
  const mem = deps.memory;
  let folded = false; let reply = ''; let refs: string[] = []; let model: string | null = null; let escalated = false; let actions: string[] = [];
  const why = state.level !== 'live' ? `수준 ${state.level}` : !deps.llm ? 'LLM 없음' : !budgetOk ? `예산 초과(${deps.perHourMax}/h)` : null;
  if (why) { folded = true; ({ reply, refs } = foldedReply(msg, state, why, deps.cmds)); escalated = true; actions = [actionToken('escalate', 'JUD')]; }
  else {
    const prompt = buildVoicePrompt({ soulText: deps.soulText, goalText: deps.goalText, msg, state, cases: mem.cases(30), lessons: mem.lessons(10), knowhow: deps.knowhow?.(msg.body) ?? '' });
    try {
      const out = await deps.llm!.complete(prompt.system, prompt.user);
      model = out.model;
      const parsed = parseVoice(out.text);
      const acted = await runVoiceActions(parsed.actions, msg, deps.cmds);
      escalated = acted.escalated; refs = acted.refs; actions = acted.tokens;
      reply = [parsed.reply || '(빈 답)', ...(acted.lines.length ? [`— 행동: ${acted.lines.join(' · ')}`] : [])].join('\n');
    } catch (e) {
      folded = true; ({ reply, refs } = foldedReply(msg, state, `LLM 오류 ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`, deps.cmds)); escalated = true; actions = [actionToken('escalate', 'JUD')];
    }
  }
  const caseRefs = [`${msg.channel}:${msg.id}`, ...refs];
  reply = `${reply}\n— 근거: ${caseRefs.join(' ')} · 판정 집사(${BUTLER_SEAT} · L0 ${BUTLER_SUPERVISOR})`;
  mem.appendCase({ at: state.now.toISOString(), kind: 'voice', subject: `${msg.channel}#${msg.id}`, why: reply.slice(0, 400), refs: caseRefs,
    decidedBy: BUTLER_SEAT, supervisedBy: BUTLER_SUPERVISOR, extra: { from: msg.from, folded, model, escalated, actions } });
  return { msg, folded, reply, refs: caseRefs, model, escalated, actions };
}

export const voiceBudgetOk = (turns: readonly number[], nowMs: number, perHourMax: number): boolean => turns.filter(t => nowMs - t < 3_600_000).length < perHourMax;
export const mayDemote = (by: string): boolean => BUTLER_DEMOTERS.has(by.trim().toUpperCase());
