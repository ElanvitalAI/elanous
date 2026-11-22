/**
 * POST-TURN-LESSON-REVIEW · SIGNAL-TRIGGERED-LESSON-CAPTURE (0.3.33 · ROSTER-0333-60 #1)
 * — 원장 신호가 도착하는 즉시 교훈 후보를 잡는 배선.
 *
 * - 왜: 신호 발화부 3종(write-gate 사람 교정 · review-result-capture must-fix · friction 같은 꼴)이
 *   LessonLedger/FrictionLedger 와 단절돼 있었다(2026-11-22 조사 · `grep memory.signal.batch src/` = 0건).
 *   포착 게이트는 사람 CLI(`eln lesson`) + 일일 cron(0 3 * * *)뿐 — «10턴 주기 검토 대신 원장 신호» 완료선의 반대편.
 * - 무엇을: \`emitLessonSignal\` 하나로 ① friction 원장 행 즉시 기록(kind 매핑: 사람 교정→ceo-correction ·
 *   리뷰/반복→hand-step|repeat-question) ② lessonId 를 아는 신호는 \`LessonLedger.recur\` 로 발생 수 즉시 반영.
 *   memory-lifecycle 그래프의 \`events: [memory.signal.batch]\` 트리거가 기다리던 발화부이기도 하다(관측 로그 동반).
 * - fail-soft: 원장 오류는 관측 로그만 남기고 예외를 던지지 않는다 — 신호 배선이 호출자(교정·리뷰 회수 경로)를
 *   무너뜨리면 안 된다. 비밀 노트는 FrictionLedger.record 의 SECRET_PATTERNS 가 이미 거부한다.
 */
import { debug } from '../debug/log.js';
import { FrictionLedger, type FrictionActor, type FrictionKind } from './friction-ledger.js';
import { LessonLedger, type LessonLedgerOptions } from './lesson-ledger.js';

export const LESSON_SIGNAL_KINDS = ['human-correction', 'review-mustfix', 'repeat-error-2'] as const;
export type LessonSignalKind = (typeof LESSON_SIGNAL_KINDS)[number];

/** 신호 종류 → friction kind (MEMORY-SIGNALS §2-2 표 · ceo-correction 읔 사람 교정 전용). */
const KIND_BY_SIGNAL: Record<LessonSignalKind, FrictionKind> = {
  'human-correction': 'ceo-correction',
  'review-mustfix': 'hand-step',
  'repeat-error-2': 'repeat-question',
};

export interface LessonSignalInput {
  kind: LessonSignalKind;
  actor: FrictionActor;
  /** 같은 꼴 식별자 — MEMORY-SIGNALS §2-2 signature 규칙(review:rule:pattern · mail:kind:topic · tool:name:errClass). */
  signature: string;
  /** 출처 참조(우편 id · PR-헤드 · 캡슐 핸들 등) — 원장 행에 남는다. */
  ref: string;
  note?: string;
}

export interface LessonSignalOptions extends LessonLedgerOptions {
  /** 이 신호가 기존 교훈에 대응하면 그 id — recur 로 발생 수를 즉시 올린다. */
  lessonId?: string;
}

export interface LessonSignalOutcome {
  /** friction 원장에 기록된 행 수(0 = 기록 못 함 — 관측 로그 참조). */
  recorded: number;
  /** lessonId 를 알고 recur 까지 성공했으면 true. */
  recurred: boolean;
}

function emit(event: string, data: Record<string, unknown>): void {
  try { debug.log('memory.signal', event, data); } catch { /* fail-soft */ }
}

/**
 * 원장 신호 하나를 교훈 후보로 즉시 잡는다 — 던지지 않는다(완료선: CLI·cron 없이 원장만으로 포착).
 * memory-lifecycle 그래프가 \`events: [memory.signal.batch]\` 로 기다리는 발화이므로 관측 로그도 남긴다.
 */
export function emitLessonSignal(options: LessonSignalOptions, input: LessonSignalInput): LessonSignalOutcome {
  const outcome: LessonSignalOutcome = { recorded: 0, recurred: false };
  try {
    const row = new FrictionLedger(options).record({
      actor: input.actor, kind: KIND_BY_SIGNAL[input.kind], signature: input.signature, note: input.note, ref: input.ref,
    });
    outcome.recorded = 1;
    emit('lesson-candidate', { kind: input.kind, signature: row.signature, ref: input.ref, frictionId: row.id, actor: row.actor });
  } catch (error) {
    emit('lesson-candidate-failed', { kind: input.kind, signature: input.signature, ref: input.ref, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
    return outcome;
  }
  if (options.lessonId === undefined) return outcome;
  try {
    new LessonLedger(options).recur(options.lessonId, { source: input.ref, note: `signal ${input.kind} · ${input.signature}`, by: input.actor === 'person' ? 'person' : input.actor });
    outcome.recurred = true;
    emit('lesson-recurred', { lessonId: options.lessonId, kind: input.kind, signature: input.signature, ref: input.ref });
  } catch (error) {
    emit('lesson-recur-failed', { lessonId: options.lessonId, kind: input.kind, signature: input.signature, ref: input.ref, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
  }
  return outcome;
}
