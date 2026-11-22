/** Six axes from 내부 문서 `ELN-SEAT-RUNTIME-OP-REPLACEMENT`. */
export const OP_WORLD_AXES = [
  'decomposition',
  'blockerDiscovery',
  'landingJudgment',
  'reportQuality',
  'proactivity',
  'robustness',
] as const;

export type OpWorldAxis = typeof OP_WORLD_AXES[number];

export interface OpWorldScoringScene {
  id: string;
  checks: readonly {
    axis: OpWorldAxis;
    pass: boolean;
    reason: string;
  }[];
}

export function scoreOpWorld(scenes: readonly OpWorldScoringScene[]) {
  const axes = Object.fromEntries(
    OP_WORLD_AXES.map(axis => [axis, { passed: 0, measured: 0, percent: null as number | null }]),
  ) as Record<OpWorldAxis, { passed: number; measured: number; percent: number | null }>;
  const failedScenes = [];
  const unevaluatedScenes = [];
  const sceneIds = new Set<string>();

  for (const scene of scenes) {
    if (sceneIds.has(scene.id)) throw new Error(`Duplicate scoring scene: ${scene.id}`);
    sceneIds.add(scene.id);
    if (!scene.checks.length) unevaluatedScenes.push(scene.id);
    const failedChecks = [];
    for (const check of scene.checks) {
      const count = axes[check.axis];
      count.measured++;
      if (check.pass) count.passed++;
      else failedChecks.push({ axis: check.axis, reason: check.reason });
    }
    if (failedChecks.length) failedScenes.push({ id: scene.id, checks: failedChecks });
  }
  for (const axis of OP_WORLD_AXES) {
    const count = axes[axis];
    if (count.measured) count.percent = 100 * count.passed / count.measured;
  }

  return { sceneCount: scenes.length, axes, failedScenes, unevaluatedScenes };
}

export interface OpWorldDecisionEvidence {
  id: string;
  source: 'decision-ledger' | 'op-mail';
  time: string;
  body: string;
}

function seoulDate(iso: string): string | undefined {
  const instant = Date.parse(iso);
  if (!Number.isFinite(instant)) return undefined;
  return new Date(instant + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * #39377 terra r4 mustFix ③: 원장 timestamp 의 날짜 기준도 우편(seoulDate) 과 같은
 * 서울 기준으로 정규화한다. 오프셋·UTC 표기가 있으면 그 순간의 서울 날짜로 변환해
 * 서울 자정 전후의 UTC 기록이 잘못 분류되지 않게 하고, 무오프셋 표기는 기록된 달력
 * 날짜(서울 현지 기준)를 그대로 쓴다(연도 없는 표기는 localDate 의 연도를 빌린다).
 */
function ledgerSeoulDate(time: string, localDate: string): string | undefined {
  const withYear = /^\d{4}-/.test(time) ? time : `${localDate.slice(0, 5)}${time}`;
  const iso = withYear.replace(' ', 'T');
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? seoulDate(iso) : iso.slice(0, 10);
}

/**
 * The OP ledger uses three layouts: timestamp / OP / body, timestamp / decision
 * ID / body, and decision ID / timestamp / authority / body. Keep line-based
 * evidence IDs so repeated topics and records at the same minute stay distinct.
 */
export function parseOpWorldAnswerKey(
  decisionTsv: string,
  outboundMail: unknown,
  localDate: string,
): OpWorldDecisionEvidence[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('Expected an ISO calendar date');
  if (!Array.isArray(outboundMail)) throw new Error('Expected a JSON array of seat messages');
  const evidence: OpWorldDecisionEvidence[] = [];
  const ids = new Set<string>();

  for (const [lineIndex, line] of decisionTsv.split(/\r?\n/).entries()) {
    const fields = line.split('\t');
    const timestampIndex = fields.slice(0, 2).findIndex(field => /^(?:\d{4}-)?\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(field));
    if (timestampIndex === -1) continue;
    const time = fields[timestampIndex]!;
    const date = ledgerSeoulDate(time, localDate);
    if (date !== localDate) continue;
    const id = `decision-ledger:${lineIndex + 1}`;
    evidence.push({ id, source: 'decision-ledger', time, body: line });
  }

  for (const record of outboundMail) {
    if (!record || record.from !== 'OP' || typeof record.createdAt !== 'string'
      || typeof record.body !== 'string' || !/^\d+$/.test(String(record.id))
      || seoulDate(record.createdAt) !== localDate) continue;
    const id = `op-mail:${record.id}`;
    if (ids.has(id)) continue;
    ids.add(id);
    evidence.push({ id, source: 'op-mail', time: record.createdAt, body: record.body });
  }
  return evidence;
}

export interface OpWorldDecisionComparison {
  decisionId: string;
  sceneId: string;
  expectedDisposition: string;
  observedDisposition: string | null;
}

/** Pair source records with simulated dispositions using evaluator-supplied judgments. */
export function compareOpWorldAnswerKey(
  answerKey: readonly OpWorldDecisionEvidence[],
  comparisons: readonly OpWorldDecisionComparison[],
) {
  const byId = new Map(answerKey.map(evidence => [evidence.id, evidence]));
  if (byId.size !== answerKey.length) throw new Error('Duplicate OP answer key record ID');
  const pairedIds = new Set<string>();
  const paired = comparisons.map(comparison => {
    const evidence = byId.get(comparison.decisionId);
    if (!evidence) throw new Error(`OP answer key record not found: ${comparison.decisionId}`);
    if (pairedIds.has(evidence.id)) throw new Error(`OP answer key record compared twice: ${evidence.id}`);
    pairedIds.add(evidence.id);
    return {
      ...comparison,
      source: evidence.source,
      time: evidence.time,
      matched: comparison.observedDisposition === null
        ? null : comparison.expectedDisposition === comparison.observedDisposition,
    };
  });
  const summarize = (source?: OpWorldDecisionEvidence['source']) => {
    const available = source ? answerKey.filter(evidence => evidence.source === source) : answerKey;
    const candidates = source ? paired.filter(result => result.source === source) : paired;
    const matched = candidates.filter(result => result.matched === true).length;
    const mismatched = candidates.filter(result => result.matched === false).length;
    const observed = matched + mismatched;
    return {
      eligible: available.length, observed, matched, mismatched,
      // #39377 shouldFix c: unobserved 는 짝은 맺었지만 observedDisposition 이 null 인 기록
      // (미응답·상충) 이다. 정답키와 아예 짝을 맺지 못한 기록은 아래 unpaired 에서 센다.
      unobserved: candidates.length - observed,
      observedMatchPercent: observed ? 100 * matched / observed : null,
      evidenceCoveragePercent: available.length ? 100 * observed / available.length : null,
    };
  };
  const decisionLedger = summarize('decision-ledger');
  const outboundMail = summarize('op-mail');
  return {
    sourceCounts: { decisionLedger: decisionLedger.eligible, outboundMail: outboundMail.eligible },
    ...summarize(),
    bySource: { decisionLedger, outboundMail },
    unpaired: answerKey.filter(evidence => !pairedIds.has(evidence.id)).map(evidence => evidence.id),
    paired,
  };
}

/**
 * #39377 terra mustFix ①: 정답키 없는 기본 그래프 실행의 판단 비교. 재현 사례의 내장
 * 기대 처분(op-world-replay.js)을 관측 처분과 짝지어 오답·미응답을 그대로 센다.
 */
export function compareOpWorldBuiltInDispositions(
  comparisons: readonly OpWorldDecisionComparison[],
) {
  const paired = comparisons.map(comparison => ({
    ...comparison,
    matched: comparison.observedDisposition === null
      ? null : comparison.expectedDisposition === comparison.observedDisposition,
  }));
  const matched = paired.filter(row => row.matched === true).length;
  const mismatched = paired.filter(row => row.matched === false).length;
  const observed = matched + mismatched;
  return {
    eligible: comparisons.length,
    observed,
    matched,
    mismatched,
    unobserved: paired.length - observed,
    observedMatchPercent: observed ? 100 * matched / observed : null,
    evidenceCoveragePercent: comparisons.length ? 100 * observed / comparisons.length : null,
    paired,
  };
}
