// ── CONTEXT-BUDGET-ROTATION (0.3.34) — 세션 교대(회전) ──
//
// 압축이 더 이상 줄일 게 없는 세션(no-op 연속)은 같은 기록을 계속 끌고 다닌다.
// 교대 = 현 세션을 HANDOFF 문서로 요약해 새 세션을 만들고 그 요약 1건을 첫
// system 행으로 시드하는 것. 사람 user 행 원문·앵커·system 행 보존 계약(#39491)은
// 그대로: 마스킹은 compaction→model-input 경계에서 redactSecretText 1회뿐이고
// 원장(저장소) 원문은 무변경이다.

import { appendMessage, createSession, loadSession, type SerializedMessage } from './index.js';
import { estimateTokens } from '../tokens.js';
import { redactSecretText } from '../debug/secret-redaction.js';
import { getCompactSystemPrompt, compactConversation } from '../compact/summarize.js';
import { resolveSummarizerModel } from '../compact/provider.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import {
  CONTEXT_HANDOFF_MAX_TOKENS,
  CONTEXT_ROTATION_NO_OP_STREAK,
  CONTEXT_ROTATION_TURN_CAP,
  measureRecordTokens,
  shouldRotate,
} from './context-budget.js';

// ── no-op 연속 카운터(auto-state 패턴: src/compact/auto-state.ts recordNoOpBackoff 참고) ──
const noOpStreaks = new Map<string, number>();

/** no-op compaction 1회 기록 — 연속 카운터 증가. */
export function recordNoOpRotation(sessionId: string): void {
  noOpStreaks.set(sessionId, (noOpStreaks.get(sessionId) ?? 0) + 1);
}

/** 교대 성사 후 카운터 초기화. */
export function clearRotationStreak(sessionId: string): void {
  noOpStreaks.delete(sessionId);
}

export function getNoOpRotationStreak(sessionId: string): number {
  return noOpStreaks.get(sessionId) ?? 0;
}

/** 시험용 상태 초기화. */
export function resetRotationStateForTest(): void {
  noOpStreaks.clear();
  rotatedAwaySessions.clear();
}

// ── 교대 완료 세션(auto-state) — 한 세션은 한 번만 교대한다(두 번째 HANDOFF 는 같은 기록 중복 시드). ──
const rotatedAwaySessions = new Set<string>();

// ── HANDOFF 작성 ──

/** 요약기 주입점 — 기본은 compactConversation 재사용(COMPACT_SYSTEM_PROMPT 그대로). */
export type RotationSummarizeFn = (
  history: LLMMessage[],
  opts: { systemPrompt: string; model?: string },
) => Promise<string>;

async function defaultSummarize(history: LLMMessage[], opts: { systemPrompt: string; model?: string }): Promise<string> {
  const result = await compactConversation(history, opts.model ? { model: opts.model } : {});
  return result.summary;
}

/** 감사행(tool · goalInterim) 제외 — compact-session isAuditRow 와 동일 기준. */
function isAuditRow(m: SerializedMessage): boolean {
  return m.role === 'tool' || m.goalInterim === true;
}

/** §4-4② — 기계 우편 행은 [seat-mail …] 한 줄 스텁으로(compact-session stubMailRow 와 동형). */
function stubMailRow(m: SerializedMessage): SerializedMessage {
  const from = m.from;
  if (!from || from.kind === 'human') return m;
  const firstLine = m.content.split('\n', 1)[0] ?? '';
  const stub = `[seat-mail ${from.msgId ?? '(unnumbered)'} from ${from.seat ?? from.kind}] ${firstLine}`;
  return { ...m, content: stub };
}

/** 행 → LLM 와이어. 마스킹 경계: 이 지점에서 redactSecretText 1회(원장 무변경). */
function toMaskedLLMMessage(m: SerializedMessage): LLMMessage {
  const stubbed = stubMailRow(m);
  const role: LLMMessage['role'] = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
  return { role, content: redactSecretText(stubbed.content) };
}

export interface BuildHandoffOpts {
  modelId?: string;
  summarizerModel?: string;
  summarizeFn?: RotationSummarizeFn;
  root?: string;
}

/** 세션 기록 → HANDOFF 문서(≤ CONTEXT_HANDOFF_MAX_TOKENS). */
export async function buildHandoff(sessionId: string, opts: BuildHandoffOpts = {}): Promise<string> {
  const loaded = loadSession(sessionId, opts.root);
  if (!loaded) throw new Error(`session not found: ${sessionId}`);
  const history = loaded.messages
    .filter(m => !isAuditRow(m))
    .map(toMaskedLLMMessage);
  const model = resolveSummarizerModel(opts.modelId, opts.summarizerModel);
  const summarize = opts.summarizeFn ?? defaultSummarize;
  const summary = await summarize(history, { systemPrompt: getCompactSystemPrompt(), ...(model ? { model } : {}) });
  // 문서측 경계 1회: 요약이 자격값을 되살려도 문서에서 가린다.
  let doc = redactSecretText(summary);
  if (estimateTokens(doc) > CONTEXT_HANDOFF_MAX_TOKENS) {
    // 2K 상한 — 글자 수로 비례 자른 뒤 토큰 상한 이하로 수렴시킨다.
    const maxChars = CONTEXT_HANDOFF_MAX_TOKENS * 4;
    doc = doc.length > maxChars ? `${doc.slice(0, maxChars)}\n…` : doc;
    while (estimateTokens(doc) > CONTEXT_HANDOFF_MAX_TOKENS && doc.length > 0) {
      doc = doc.slice(0, Math.floor(doc.length * 0.9));
    }
    doc = doc.trimEnd();
  }
  return doc;
}

// ── 교대 실행 ──

export interface RotationAttemptOpts {
  sessionId: string;
  /** 진행 턴 중(true)이면 절대 교대하지 않는다 — 세션 스왑은 턴 경계에서만. */
  turnInFlight: boolean;
  turnCount?: number;
  lastHumanTurnAnswered?: boolean;
  modelId?: string;
  summarizerModel?: string;
  summarizeFn?: RotationSummarizeFn;
  root?: string;
}

export interface RotationAttemptResult {
  rotated: boolean;
  reason: string;
  newSessionId?: string;
  handoffTokens?: number;
}

function isHumanRow(m: SerializedMessage): boolean {
  return m.role === 'user' && (!m.from || m.from.kind === 'human');
}

export async function attemptSessionRotation(opts: RotationAttemptOpts): Promise<RotationAttemptResult> {
  // 진행 턴 중 교대 금지 — 훅은 streak 기록만 하고 교체는 하지 않는다.
  if (opts.turnInFlight) return { rotated: false, reason: 'turn-in-flight' };
  // 한 세션은 한 번만 교대 — 이미 교대한 세션의 재시도는 기각한다.
  if (rotatedAwaySessions.has(opts.sessionId)) return { rotated: false, reason: 'already-rotated' };
  try {
    const loaded = loadSession(opts.sessionId, opts.root);
    if (!loaded) return { rotated: false, reason: 'session-not-found' };
    const convo = loaded.messages.filter(m => !isAuditRow(m));
    const streak = getNoOpRotationStreak(opts.sessionId);
    const turnCount = opts.turnCount ?? convo.filter(isHumanRow).length;
    const lastHumanTurnAnswered = opts.lastHumanTurnAnswered
      ?? (convo.length === 0 || convo[convo.length - 1]!.role !== 'user' || !isHumanRow(convo[convo.length - 1]!));
    if (!shouldRotate({ noOpStreak: streak, turnCount, turnInFlight: false, lastHumanTurnAnswered })) {
      return {
        rotated: false,
        reason: lastHumanTurnAnswered
          ? (streak < CONTEXT_ROTATION_NO_OP_STREAK && turnCount < CONTEXT_ROTATION_TURN_CAP ? 'below-threshold' : 'turn-cap')
          : 'human-turn-open',
      };
    }
    const doc = await buildHandoff(opts.sessionId, opts);
    const meta = createSession({ title: `Handoff from ${opts.sessionId.slice(0, 8)}`, ...(opts.modelId ? { model: opts.modelId } : {}) }, opts.root);
    appendMessage(meta.id, { role: 'system', content: doc, ts: new Date().toISOString() }, opts.root);
    const handoffTokens = estimateTokens(doc);
    clearRotationStreak(opts.sessionId);
    rotatedAwaySessions.add(opts.sessionId);
    debug.log('session.rotation', 'rotated', {
      from: opts.sessionId, to: meta.id, handoffTokens,
      recordTokens: measureRecordTokens(convo),
    }, { level: 'info' });
    return { rotated: true, reason: 'rotated', newSessionId: meta.id, handoffTokens };
  } catch (error) {
    debug.log('session.rotation', 'error', {
      sessionId: opts.sessionId,
      error: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
    return { rotated: false, reason: 'error' };
  }
}
