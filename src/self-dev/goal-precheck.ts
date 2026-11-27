/**
 * GOAL-PRECHECK-BEFORE-IMPL (0.3.38 · 대표 11-27 12:2x «구현 전 골 요구사항 다시 보기»).
 *
 * S: 저작된 골은 곧장 발사됐다. 골이 정책과 어긋나도(완료선을 잴 명령이 없음 · 완료선 밖 의무 · 증거 칸에 RED 요구)
 *    자식이 1~2라운드를 태운 뒤에야 abandoned 로 드러났다(11-27 TA 스프린트: 버려진 런 8 중 골 문면 원인 6).
 * C: 발사 «전»에 골을 정책 팩과 대조하는 단계가 없었다.
 * A: precheckGoalDocument — 결정론 린트(LLM 0). 사소한 것은 고쳐서(fixed) 내고, 고칠 수 없으면 needs-rewrite 와 이유를 낸다.
 *    결과는 골 문서 머리 절 «## 사전 검토(GOAL-PRECHECK)» 로 남고, needs-rewrite 면 발사하지 않는다.
 *
 * 세 얼굴: 관측 = 골 문서의 사전 검토 절 ⊕ ask-launch 관측(goal-precheck) · 판단 근거 = 아래 검사 표(정책 팩 줄과 같은 말) ·
 *          수복과 인계 = 사소한 것 자동 수리 · 나머지는 needs-rewrite 이유로 저작자(사람·저작기)에게.
 */
import { linesOutsideFencedCode } from '../self-implement/goal-author.js';

export type GoalPrecheckVerdict = 'pass' | 'fixed' | 'needs-rewrite';

export interface GoalPrecheckResult {
  readonly verdict: GoalPrecheckVerdict;
  /** needs-rewrite 이유(사람이 고칠 것). */
  readonly reasons: readonly string[];
  /** 자동으로 고친 것. */
  readonly fixes: readonly string[];
  /** 수리 반영 문서(수리가 없으면 입력 그대로). */
  readonly document: string;
}

/** 한 골이 한 번에 만질 대상 경로 상한 — 넘으면 CORE/엣지로 쪼갤 골이다. */
export const GOAL_PRECHECK_MAX_TARGET_PATHS = 8;

const EVIDENCE_COMMAND = /\bbun\s+test\b|--test=|\bbun\s+bin\/elanous\.mjs\b|\bbun\s+run\s+\S+/u;
const OUT_OF_DONE_WHEN_DUTY = /(?:카탈로그|catalog)[^\n]*(?:등록|register)[^\n]*(?:한다|하라|해야)/iu;
const EVIDENCE_CELL_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-E4\b|E4 sim\/test-universe evidence/u;
const CELL_KIND_LINE = /^\s*-\s*CellKind\s*:\s*(evidence|implement)\s*$/imu;
const DUTY_NOTE = '(참고 — GOAL-PRECHECK: 칸 완료선 밖 의무라 요구가 아니다)';
const BUDGET_LINE = /^\s*(?:-\s*)?검증\s*예산\s*:/u;
export const BUDGET_NOTE = '(예산은 실행 순서·호스트 안내일 뿐 — 완료선·증거 명령은 모두 실행한다 · 미실행은 완료가 아니다)';
const TARGET_LINE = /^\s*(?:-\s*)?대상\s*경로\s*:\s*(.+)$/mu;

function targetPaths(document: string): string[] {
  const line = TARGET_LINE.exec(document)?.[1] ?? '';
  return line.split(/[·,]/u).map((part) => part.trim().replace(/^`|`$/gu, '')).filter((part) => /[\w-]+\/[\w./-]+|\.[cm]?[jt]sx?$|\.md$/u.test(part));
}

/** Pure: check a goal document against the policy pack; trivial issues are repaired in the returned document. */
export function precheckGoalDocument(document: string, input: { readonly targetPaths?: readonly string[] } = {}): GoalPrecheckResult {
  const reasons: string[] = [];
  const fixes: string[] = [];
  let next = document;
  const outside = linesOutsideFencedCode(document).map((line) => line.text);
  const outsideText = outside.join('\n');

  // The launch preflight already parsed and blocked on missing target paths; reuse its paths when given.
  const paths = input.targetPaths ? [...input.targetPaths] : targetPaths(document);
  if (paths.length === 0 && !input.targetPaths) reasons.push('대상 경로가 없다 — «대상 경로: <파일> · <시험 파일>» 첫 줄이 필요하다');
  else if (paths.length > GOAL_PRECHECK_MAX_TARGET_PATHS) reasons.push(`대상 경로 ${paths.length}개 > ${GOAL_PRECHECK_MAX_TARGET_PATHS} — CORE 먼저 한 골로 쪼개고 나머지는 FU 칸으로`);

  // A done-when that exists but cannot be measured is a rewrite; a document with no done-when section at all is the
  // authorer's other contracts' business (canonical-structure lint), not this check's.
  const hasDoneWhen = outside.some((line) => /^(?:완료선\s*:|##\s*(?:REQUIRED EVIDENCE|ACCEPTANCE CRITERIA)\b)/u.test(line.trim()));
  if (hasDoneWhen && !EVIDENCE_COMMAND.test(document)) reasons.push('완료선을 잴 명령이 없다 — 집중 시험(bun test <파일>) 또는 시험 우주(--test=<dir>) 명령을 완료선에 적는다');

  // Idempotent: a line already marked by a previous precheck is not marked again (TA-GP3 sim found the double mark).
  const duty = outside.find((line) => OUT_OF_DONE_WHEN_DUTY.test(line) && !line.includes(DUTY_NOTE));
  if (duty !== undefined) {
    next = next.split('\n').map((line) => line === duty ? `${line} ${DUTY_NOTE}` : line).join('\n');
    fixes.push('완료선 밖 «카탈로그 등록» 의무를 참고로 표시');
  }

  // A «검증 예산» line read as permission to skip the done-when/evidence commands made the elaboration step weaken the
  // fixed layer (11-27 preflight: parked on «미실행을 사유만 기록» ×3). The budget only paces runs; it never waives them.
  // The authorer's contract section writes it as «### 검증 예산» + «- 원격 1 · pregate 1»; a five-field ask carries it as a line
  // (inside the verbatim fence when authored). One note, outside any fence, where the elaboration step reads it.
  if (/검증\s*예산/u.test(document) && !document.includes(BUDGET_NOTE)) {
    const lines = next.split('\n');
    const heading = outside.find((line) => /^#{2,6}\s*검증\s*예산\s*$/u.test(line.trim()));
    const budgetLine = outside.find((line) => BUDGET_LINE.test(line));
    if (heading !== undefined) lines.splice(lines.indexOf(heading) + 1, 0, `- ${BUDGET_NOTE}`);
    else if (budgetLine !== undefined) lines[lines.indexOf(budgetLine)] = `${budgetLine} ${BUDGET_NOTE}`;
    else lines.push('', `검증 예산 해석(GOAL-PRECHECK): ${BUDGET_NOTE}`);
    next = lines.join('\n');
    fixes.push('«검증 예산» 에 «완료선·증거 명령은 모두 실행» 명시');
  }

  if (EVIDENCE_CELL_ID.test(outsideText) && !CELL_KIND_LINE.test(document)) {
    const lines = next.split('\n');
    const at = lines.findIndex((line) => /^\s*-\s*GoalType\s*:/u.test(line));
    lines.splice(at >= 0 ? at + 1 : Math.min(1, lines.length), 0, '- CellKind: evidence');
    next = lines.join('\n');
    fixes.push('E4 증거 칸인데 CellKind 줄이 없어 «- CellKind: evidence» 기입(TDD RED 면제)');
  }

  const verdict: GoalPrecheckVerdict = reasons.length > 0 ? 'needs-rewrite' : fixes.length > 0 ? 'fixed' : 'pass';
  return { verdict, reasons, fixes, document: next };
}

/** The record block written into the goal document (before its first heading). */
export function serializeGoalPrecheck(result: GoalPrecheckResult): string {
  return [
    '## 사전 검토(GOAL-PRECHECK)',
    `- 판정: ${result.verdict}`,
    ...(result.reasons.length ? result.reasons.map((reason) => `- 다시 쓸 것: ${reason}`) : []),
    ...(result.fixes.length ? result.fixes.map((fix) => `- 자동 수리: ${fix}`) : []),
    '',
    '',
  ].join('\n');
}

/** Insert the record before the first heading outside fenced code (same rule as the launch decomposition record). */
export function recordGoalPrecheck(document: string, result: GoalPrecheckResult): string {
  const block = serializeGoalPrecheck(result);
  const heading = linesOutsideFencedCode(document).find((line) => /^#{1,6} /u.test(line.text));
  if (heading === undefined) return `${block}${document}`;
  return `${document.slice(0, heading.start)}${block}${document.slice(heading.start)}`;
}
