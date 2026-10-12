/**
 * 전제 다섯 되짚기 — premise-review 카드 순수 계산(FLEX-RFC §A-③).
 *
 * P1 골 · P2 자(판정 시험) · P3 범위(대상 경로) · P4 쪼갬 · P5 환경.
 * ⛔ LLM 없이 잴 수 있는 둘만 판정한다 — P3(범위) · P2(preexisting 자).
 * ⛔ unknown 은 «맞다(ok)»가 아니다 — 못 잰 전제는 ok 로 지어내지 않는다.
 */

import type { FlexSignalsInput } from './flex-signals.js';

/** 못 잰 근거의 표기 — P1·P4·P5 는 이 값으로 unknown 으로만 나간다. */
const UNMEASURED = '못 잼';

export type PremiseKey = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type PremiseVerdict = 'ok' | 'wrong' | 'unknown';

export interface PremiseFinding {
  premise: PremiseKey;
  verdict: PremiseVerdict;
  evidence: string;
}

/** `computeFlexSignals` 와 같은 꼴의 값 객체 + 카드가 가리킬 run 식별자와 P3 판정의 경계. */
export interface PremiseReviewInput extends FlexSignalsInput {
  runId: string;
  /** 이 골이 선언한 대상 경로 — 없으면 P3 는 unknown(경계를 못 잼). */
  targetPaths?: readonly string[] | undefined;
}

export interface PremiseReviewCard {
  runId: string;
  findings: PremiseFinding[];
  /** wrong 이 있을 때만 «가장 좁은 것» 하나 — wrong 이 없으면 undefined. */
  proposal: PremiseFinding | undefined;
}

/** 최신 라운드의 실패 id 목록 — `gateFailedIdsByRound` 의 마지막 칸이 최신(`computeFlexSignals` 와 같은 순서). */
function latestFailingIds(input: FlexSignalsInput): readonly string[] | undefined {
  const latest = input.gateFailedIdsByRound.length === 0
    ? undefined
    : input.gateFailedIdsByRound[input.gateFailedIdsByRound.length - 1];
  return latest !== undefined && latest.length > 0 ? latest : undefined;
}

/**
 * 게이트 실패 id — 생산자(orchestrator 의 roundSummaryEntries.failedIds)와 P3 파서가 «같은 꼴»을 쓰도록
 * 둘 다 이 함수 짝을 거친다. 꼴: `${name}@${file ?? '?'} (${attribution})`.
 */
export function formatGateFailedId(failure: { name: string; file?: string | undefined; attribution: string }): string {
  return `${failure.name}@${failure.file ?? '?'} (${failure.attribution})`;
}

/**
 * 실패 id 에서 시험 파일을 뽑는다 — `name@` 접두와 ` (귀속)` 접미를 뗀다. 이름에 `@` 가 섞여도
 * (`user@example.com`·`@scope/pkg`)·경로에 `@`(`src/@scope/x.ts`)가 있어도 가른다: 경로 안의 `@` 는
 * 세그먼트 머리(맨 앞 또는 `/` 바로 뒤)에만 온다. 그래서 «공백 없고 · 확장자로 끝나고 · 안의 `@` 가 전부
 * 세그먼트 머리인» 후보를 처음 주는 `@` 가 구분자다. 그런 `@` 가 없거나 파일이 `?`·빈 값이면 undefined
 * (못 잼) — fail-closed. 남는 모호함: 이름이 `/` 로 끝나면(`a/@src/x.ts`) 구분자를 경로로 읽는다.
 */
export function gateFailedIdFile(id: string): string | undefined {
  const withoutAttribution = id.replace(/\s*\([^)]*\)\s*$/, '');
  for (let at = withoutAttribution.indexOf('@'); at >= 0; at = withoutAttribution.indexOf('@', at + 1)) {
    const file = withoutAttribution.slice(at + 1);
    if (file === '' || file === '?' || /\s/.test(file)) continue;
    if (!/\.[A-Za-z0-9]+$/.test(file)) continue;
    if (/[^/]@/.test(file)) continue;
    return file;
  }
  return undefined;
}

/**
 * 시험 파일 → 짝 소스. `dir/x.test.ts` → `dir/x.ts`(같은 폴더). 시험 전용 폴더(`test/`·`__tests__/`)의 시험은
 * 짝을 추측하지 않는다(undefined · fail-closed). 시험 꼴이 아닌 파일은 그 자신이 소스다.
 */
export function pairedSourceOf(file: string): string | undefined {
  const normalized = file.replace(/^\.\//, '');
  const testMatch = /^(.*)\.test\.([cm]?[jt]sx?)$/.exec(normalized);
  if (!testMatch) return normalized;
  if (/(^|\/)(test|tests|__tests__)\//.test(normalized)) return undefined;
  return `${testMatch[1]}.${testMatch[2]}`;
}

function insideTargets(path: string, targets: readonly string[]): boolean {
  return targets.some((target) => {
    const t = target.replace(/^\.\//, '').replace(/\/+$/, '');
    return path === t || path.startsWith(`${t}/`);
  });
}

/** P2 자 — 판정 시험이 base 에서도 실패(preexisting)면 wrong. 귀속을 못 잼·하나라도 unknown 이면 unknown. */
function judgeP2(input: PremiseReviewInput): PremiseFinding {
  const attributions = input.failureAttributions;
  if (attributions === undefined || attributions.length === 0) {
    return { premise: 'P2', verdict: 'unknown', evidence: UNMEASURED };
  }
  const preexistingIndex = attributions.indexOf('preexisting');
  if (preexistingIndex >= 0) {
    const latest = latestFailingIds(input);
    const evidence = latest !== undefined && preexistingIndex < latest.length
      ? latest[preexistingIndex]!
      : 'preexisting';
    return { premise: 'P2', verdict: 'wrong', evidence };
  }
  if (attributions.includes('unknown')) {
    return { premise: 'P2', verdict: 'unknown', evidence: UNMEASURED };
  }
  return { premise: 'P2', verdict: 'ok', evidence: `preexisting 0/${attributions.length}` };
}

/**
 * P3 범위 — 실패 시험 파일을 짝 소스로 옮겨 대상 경로와 견준다. 짝지은 소스(또는 시험 파일 자체)가
 * 대상 경로 안이면 in · 짝은 지었는데 밖이면 wrong(그 시험 파일을 근거로). 파일을 못 읽거나 짝을 못 지은
 * 실패가 하나라도 있고 wrong 이 없으면 unknown — 추측으로 ok 를 만들지 않는다.
 */
function judgeP3(input: PremiseReviewInput): PremiseFinding {
  const latest = latestFailingIds(input);
  const targets = input.targetPaths;
  if (latest === undefined) return { premise: 'P3', verdict: 'unknown', evidence: UNMEASURED };
  if (targets === undefined || targets.length === 0) return { premise: 'P3', verdict: 'unknown', evidence: UNMEASURED };
  let unmeasured: string | undefined;
  for (const id of latest) {
    const file = gateFailedIdFile(id);
    if (file === undefined) { unmeasured ??= `${UNMEASURED}: 실패 파일 없음 (${id})`; continue; }
    if (insideTargets(file, targets)) continue;
    const source = pairedSourceOf(file);
    if (source === undefined) { unmeasured ??= `${UNMEASURED}: 짝 소스 없음 (${file})`; continue; }
    if (!insideTargets(source, targets)) return { premise: 'P3', verdict: 'wrong', evidence: file };
  }
  if (unmeasured !== undefined) return { premise: 'P3', verdict: 'unknown', evidence: unmeasured };
  return { premise: 'P3', verdict: 'ok', evidence: `failing files all inside target paths (${latest.length})` };
}

/**
 * wrong 이 여럿이면 «가장 좁은 것» 하나만 제안한다(RFC §A-③ — F6 카드 → F7 조치). 좁음 = 수정 폭:
 * P2 자가 가장 좁다(판정 자만 고친다 · 골을 안 건드린다) → P5 환경(재무대) → P4 쪼갬 → P3 범위(경계를 넓힌다)
 * → P1 골(요구 자체를 바꾼다)이 가장 넓다. findings 배열 순서에 우연히 맡기지 않고 이 rank 로 고른다.
 */
const NARROWEST_FIRST: readonly PremiseKey[] = ['P2', 'P5', 'P4', 'P3', 'P1'];

export function narrowestWrong(findings: readonly PremiseFinding[]): PremiseFinding | undefined {
  for (const premise of NARROWEST_FIRST) {
    const wrong = findings.find((finding) => finding.premise === premise && finding.verdict === 'wrong');
    if (wrong !== undefined) return wrong;
  }
  return undefined;
}

/** 전제 다섯을 되짚어 카드를 세운다 — 순수 계산, LLM 을 부르지 않는다. */
export function buildPremiseCard(input: PremiseReviewInput): PremiseReviewCard {
  const findings: PremiseFinding[] = [
    { premise: 'P1', verdict: 'unknown', evidence: UNMEASURED },
    judgeP2(input),
    judgeP3(input),
    { premise: 'P4', verdict: 'unknown', evidence: UNMEASURED },
    { premise: 'P5', verdict: 'unknown', evidence: UNMEASURED },
  ];
  return { runId: input.runId, findings, proposal: narrowestWrong(findings) };
}
