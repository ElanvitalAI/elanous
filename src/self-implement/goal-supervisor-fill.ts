import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractGoalDocSections } from './goal-doc/section.js';

export interface SupervisorGoalFillEvidence {
  round: number;
  command: string;
  reviewVerdict: 'pass' | 'warn' | 'fail';
  /** ⭐ 게이트 로그에서 **실제로 읽은** fail 수. 기대값이 아니다(리뷰 must-fix). */
  observedFail: number;
  /** 실패 귀속 baseline이 실제 실행됐을 때만 있는 행. PASS에서는 실행하지 않는다. */
  baselineLine?: string;
  /** ⭐ **원천 그대로** — 독립 검사기가 writer 의 파싱 결과가 아니라 **로그를 직접** 다시 읽는다. */
  gateLog: string;
}

export interface SupervisorGoalFillInput {
  path: string;
  round: number;
  gate: { passed: boolean; log?: string; testStepExecuted?: boolean; scopeReason?: string };
  review?: { verdict: 'pass' | 'warn' | 'fail' };
  /** An external checker, deliberately separate from this writer/parser. */
  independentlyCheck: (document: string, evidence: SupervisorGoalFillEvidence) => Promise<boolean>;
  wiring?: 'wired' | 'unwired';
  observeDeficit?: (observation: SupervisorGoalDeficit) => void;
}

export interface SupervisorGoalDeficit {
  evidenceId: string;
  kind: 'unmeasured' | 'unwired' | 'unverified';
  previousEvidence: string;
  round: number;
  gateLog?: string;
  /** Decision branch, without gate log or goal text. */
  reason?: 'missing-section' | 'missing-invariant-slot' | 'missing-signal-slot' | 'gate-evidence-unverified' | 'review-unavailable' | 'goal-unwired' | 'slot-format' | 'authored-signal-command-mismatch' | 'independent-check-failed';
  inputSummary?: { gatePassed: boolean; hasGateLog: boolean; hasReview: boolean; invariantSlot: boolean; signalSlot: boolean };
  gateLogRef?: string;
}

export type SupervisorGoalFillResult = 'filled' | 'already-filled' | 'not-applicable' | 'unverifiable' | 'rejected';

const UNVERIFIABLE = 'UNVERIFIABLE';

interface VerifiedGateEvidence {
  command: string;
  observedFail: number;
  baselineLine?: string;
}

/**
 * ⛔ **로그가 스스로 모순이면 채우지 않는다.** 종전 판은 ⓐ `[test] PASS` 접두와 명령 모양만 보고
 * ⓑ PASS 로그의 fail 수를 읽지 않아 `[test] PASS ... 5 fail`도 채울 수 있었다.
 * ⇒ PASS의 실제 0 fail 요약을 필수로 읽는다. 실패 귀속용 baseline은 실행된 경우에만
 *   원문을 검증하며, PASS에서 측정하지 않은 baseline 0건을 만들어 적지 않는다.
 */
function verifiedGateEvidence(gate: SupervisorGoalFillInput['gate']): VerifiedGateEvidence | undefined {
  if (!gate.passed || !gate.log) return undefined;
  const test = gate.log.match(/^\[test\]\s+PASS\s+(.+?)\s*(?:—|$)/m);
  if (!test?.[1]) return undefined;
  const command = test[1].trim();
  if (!/^bun\s+test(?:\s|$)/.test(command)) return undefined;

  // ⭐ 요약 줄에서 **관측된** fail 수를 읽는다. 못 읽으면 판정 불가다(0 으로 가정하지 않는다).
  const testLine = gate.log.split('\n').find((line) => /^\[test\]\s+PASS\b/.test(line));
  const failMatch = testLine?.match(/(\d+)\s+fail\b/);
  if (!failMatch) return undefined;
  const observedFail = Number(failMatch[1]);
  if (observedFail !== 0) return undefined;   // PASS 라고 적혀 있어도 fail 이 있으면 모순이다

  // PASS 자체가 test 0 fail의 측정값이다. 실패 귀속 baseline은 PASS에서 실행되지 않는다.
  // 행이 있다면 실제 값을 검증하고, 잘못된/모순된 행은 조용히 무시하지 않는다.
  const rawBaseline = gate.log.split('\n').find((line) => line.startsWith('[gate-baseline]'));
  const baseline = gate.log.match(/^\[gate-baseline\]\s+introduced=(\d+),\s*preexisting=(\d+),\s*unknown=(\d+),\s*precondition-unmet=(\d+).*$/m);
  if (rawBaseline && !baseline) return undefined;
  if (baseline?.slice(1, 5).some((count) => count !== '0')) return undefined;
  return { command, observedFail, ...(baseline ? { baselineLine: baseline[0].trim() } : {}) };
}

function section(document: string, heading: string): { start: number; end: number; body: string } | undefined {
  return extractGoalDocSections(document, {
    search: 'substring',
    heading,
    endHeading: '\n## ',
  })[0];
}

/**
 * ⛔ **두 절은 서로 다른 것을 말한다** — 같은 문자열을 양쪽에 넣으면 무엇도 검증하지 않는다(리뷰 must-fix).
 *   `불변식` = 이 골이 **지켜야 할 조건** · `판정 신호` = 그것을 **어떻게 관측하나**.
 * ⛔ 그리고 **기대값이 아니라 관측값**을 적는다 — 종전 판은 로그를 안 읽고 `기대 — fail 0` 을 박았다.
 */
function invariantReplacement(evidence: SupervisorGoalFillEvidence): string {
  return `- filled-by: supervisor@round-${evidence.round}\n  조건 — ${evidence.command} 가 실패 없이 끝난다\n  이 라운드에서 관측됨 — fail ${evidence.observedFail}\n  근거 — round-${evidence.round} gate [test] PASS ${evidence.command} · ${evidence.baselineLine ?? 'baseline not run (test PASS)'}`;
}

function signalReplacement(evidence: SupervisorGoalFillEvidence): string {
  return `- filled-by: supervisor@round-${evidence.round}\n  관측 — \`${evidence.command}\` 요약 줄의 fail 수\n  이번 라운드 관측값 — fail ${evidence.observedFail}\n  근거 — round-${evidence.round} review ${evidence.reviewVerdict} · ${evidence.baselineLine ?? 'baseline not run (test PASS)'}`;
}

function replaceUnverifiableSlot(body: string, filled: string): string | undefined {
  const slot = /^- UNVERIFIABLE(?:[ \t]*:[^\r\n]*)?[ \t]*$/m;
  return slot.test(body) ? body.replace(slot, filled) : undefined;
}

/**
 * Fill an empty invariant and either an empty signal or append an observation to an authored signal. Gate evidence is accepted only when
 * its logged test command and PASS status agree; baseline contradictions keep
 * the original document queued and byte-identical.
 */
export async function fillUnverifiableGoalSlots(input: SupervisorGoalFillInput): Promise<SupervisorGoalFillResult> {
  const original = readFileSync(input.path, 'utf8');
  const invariant = section(original, '## 불변식');
  const signals = section(original, '## 판정 신호');
  const invariantSlot = Boolean(invariant && /^- UNVERIFIABLE(?:[ \t]*:[^\r\n]*)?[ \t]*$/m.test(invariant.body));
  const signalSlot = Boolean(signals && /^- UNVERIFIABLE(?:[ \t]*:[^\r\n]*)?[ \t]*$/m.test(signals.body));
  const gateEvidence = verifiedGateEvidence(input.gate);
  const deficit = (reason: NonNullable<SupervisorGoalDeficit['reason']>): void => input.observeDeficit?.({
    evidenceId: createHash('sha256').update(JSON.stringify([input.path, input.round, original])).digest('hex').slice(0, 16),
    kind: !gateEvidence || !input.review ? 'unmeasured' : input.wiring === 'unwired' ? 'unwired' : 'unverified',
    previousEvidence: original,
    round: input.round,
    ...(input.gate.log !== undefined ? { gateLog: input.gate.log } : {}),
    reason,
    inputSummary: { gatePassed: input.gate.passed, hasGateLog: Boolean(input.gate.log), hasReview: Boolean(input.review), invariantSlot, signalSlot },
    ...(input.gate.log ? { gateLogRef: `sha256:${createHash('sha256').update(input.gate.log).digest('hex').slice(0, 16)}` } : {}),
  });
  if (!invariant || !signals) {
    // A sectionless goal has no slot the supervisor can measure or repair.
    // Report a deficit only when a present section contains an actual slot.
    if (invariantSlot || signalSlot) deficit('missing-section');
    return 'unverifiable';
  }
  if (!invariantSlot && !signalSlot && !invariant.body.includes(UNVERIFIABLE) && !signals.body.includes(UNVERIFIABLE)
    && input.wiring !== 'unwired') return 'already-filled';
  if (!invariantSlot) { deficit('missing-invariant-slot'); return 'unverifiable'; }
  if (!signalSlot && !signals.body.trim()) { deficit('missing-signal-slot'); return 'unverifiable'; }
  // A docs-only PASS has no test measurement to put into the authored slots.
  // Trust the gate's structured scope, never a free-text log line, and leave the goal unchanged.
  if (input.gate.passed && input.gate.testStepExecuted === false && input.gate.scopeReason === 'docs-only'
    && input.wiring !== 'unwired') {
    return 'not-applicable';
  }
  if (!gateEvidence) { deficit('gate-evidence-unverified'); return 'unverifiable'; }
  if (!input.review) { deficit('review-unavailable'); return 'unverifiable'; }
  if (input.wiring === 'unwired') { deficit('goal-unwired'); return 'unverifiable'; }
  // The authored completion signal must name the test we actually measured.
  if (!signalSlot) {
    const authoredCommand = signals.body.match(/^\s*- Condition:\s*(bun test\s+[^\r\n]+?)(?:\s+를 실행한다)?\s*$/m)?.[1]?.trim();
    if (!authoredCommand || authoredCommand !== gateEvidence.command) {
      deficit('authored-signal-command-mismatch'); return 'unverifiable';
    }
  }

  const evidence: SupervisorGoalFillEvidence = {
    round: input.round,
    command: gateEvidence.command,
    reviewVerdict: input.review.verdict,
    observedFail: gateEvidence.observedFail,
    ...(gateEvidence.baselineLine ? { baselineLine: gateEvidence.baselineLine } : {}),
    gateLog: input.gate.log ?? '',
  };
  const invariantBody = replaceUnverifiableSlot(invariant.body, invariantReplacement(evidence));
  const signalBody = signalSlot ? replaceUnverifiableSlot(signals.body, signalReplacement(evidence))
    : `${signals.body.replace(/\s*$/, '')}\n${signalReplacement(evidence)}\n`;
  if (invariantBody === undefined || signalBody === undefined) { deficit('slot-format'); return 'unverifiable'; }
  const candidate = `${original.slice(0, invariant.start)}## 불변식${invariantBody}${original.slice(invariant.end, signals.start)}## 판정 신호${signalBody}${original.slice(signals.end)}`;
  if (!await input.independentlyCheck(candidate, evidence)) { deficit('independent-check-failed'); return 'rejected'; }

  const temporary = join(dirname(input.path), `.${Math.random().toString(16).slice(2)}.goal-fill.tmp`);
  try {
    writeFileSync(temporary, candidate, { flag: 'wx' });
    renameSync(temporary, input.path);
    return 'filled';
  } catch (error) {
    try { writeFileSync(input.path, original); } catch { /* preserve original best-effort */ }
    throw error;
  }
}
