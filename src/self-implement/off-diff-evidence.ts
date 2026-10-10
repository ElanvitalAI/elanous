// ── diff 밖 이행 증거 파싱 (S3 · 2026-07-29) ──────────────────────────────────

import { requirePosixShellCommand } from '../platform/default-shell.js';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { resolveRunIdentity } from '../harness/harness-space.js';
//
// ⛔ **왜 필요한가** — 리뷰어의 증거 채널은 워크트리 diff 하나다(`seams.ts` 의 `reviewDiff`).
// 그래서 자식이 **diff 로 드러나지 않는 이행**(명령을 돌려 확인한 결과·라이브 관측)을 했을 때
// 그것을 **증명할 방법이 없다.** 리뷰어는 매 라운드 같은 지적을 반복하고, 예산이 그것을
// *"같은 지적 반복"* 으로 읽어 UNCONVERGEABLE 을 낸다.
// 실측(2026-07-29): 그렇게 죽은 런 2개. 한 번은 자식이 **이미 이행한 것** 때문에 죽었다.
//
// ⚠️ **첫 시도가 실패한 이유**(`#5920` 리뷰 must-fix) — 프롬프트에 *"PR 본문 수정 같은 diff 밖
// 이행을 보고하라"* 를 넣었는데, 바로 앞 줄이 *"git/PR 조작 금지"* 였다. **자기모순**이다.
// ⇒ 이 모듈의 계약은 **보고는 하되 행위는 금지**다. 자식은 자기가 **확인한 것**을 말할 뿐,
//    PR·git 을 조작하지 않는다. 조작이 필요한 수용기준은 애초에 **자식의 몫이 아니다.**
//
// ⚠️ 그리고 **버린 것을 세어 남긴다**(`#5920` 리뷰 must-fix ②) — 종전 구현은 `verify` 없는 항목을
// 오케스트레이터 도달 **전에** 버려 관측값이 항상 0이었다(Goodhart). 파싱은 **분류**만 하고,
// 버릴지는 소비자가 정한다.

/** 자식이 주장하는 diff 밖 이행 한 건. `verify` 는 그것을 확인하는 명령/질의다. */
interface OffDiffEvidenceItem {
  readonly claim: string;
  readonly verify: string;
  /** 바로 다음 `RESULT:` 줄이 있으면 그 명령의 판정 결과. */
  readonly result?: string;
}

export interface OffDiffEvidenceParse {
  /** `claim` 과 `verify` 를 둘 다 가진 항목 — 리뷰어에게 전달할 수 있다. */
  readonly items: readonly OffDiffEvidenceItem[];
  /** `verify` 가 비어 전달 불가한 항목 수. ⛔ 0 과 "잰 적 없음" 을 섞지 않으려면 항상 센다.
   *  ⚠️ `discardedEmptyClaim` 과 **독립**이다 — 한 줄이 둘 다 비면 두 수가 모두 오른다.
   *  따라서 두 수의 합은 버린 줄 수가 아니다(겹침 허용). */
  readonly discardedMissingVerify: number;
  /** `claim` 이 비어 전달 불가한 항목 수. `discardedMissingVerify` 와 **독립**이다. */
  readonly discardedEmptyClaim: number;
  /** 모든 `EVIDENCE:` 줄 중 바로 다음 `RESULT:` 줄이 없는 수. 유효 항목만 세지 않는다. */
  readonly missingResult: number;
  /** 바로 앞 줄이 `EVIDENCE:` 가 아닌 `RESULT:` 줄 수. */
  readonly orphanResult: number;
  /** ★ `I-23` — **앵커에 실제로 걸린 `EVIDENCE:` 줄 수**. ⛔ 관측의 `evidenceStringCount` 는
   *  `/EVIDENCE/gi`(낱말을 아무 데서나 센다 — 산문·프롬프트 반향 포함)라 **충전율의 분모가 아니다**.
   *  실측: 140라운드에서 낱말 535 ↔ 앵커 304 ⇒ 낱말로 나누면 56%, 앵커로 나누면 98%(`F3`). */
  readonly anchoredEvidence: number;
  /** ★ `RESULT:` 가 상한(`MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS`)을 넘어 **잘린** 항목 수.
   *  ⛔ 이것이 없으면 *"상한이 부족한가"* 를 **물을 수가 없다** — 절단은 문자열 안 마커로만 남고
   *  조회되지 않는다. 뮤테이션 출력처럼 긴 결과를 실을 때 이 수가 곧 **계약 압력**이다. */
  readonly truncatedResult: number;
}

/** 자식 출력에 실리는 줄 형식. `EVIDENCE: <무엇을 확인했나> || <재현 명령>` 다음에 `RESULT: <판정>`을 둔다. */
const EVIDENCE_LINE = /^\s*EVIDENCE:\s*(.*)$/i;
const RESULT_LINE = /^\s*RESULT:\s*(.*)$/i;
export const REQUIRED_EVIDENCE_COMMAND_SEPARATOR = '||';
export const MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS = 500;

function capResult(result: string): { text: string; truncated: boolean } {
  if (result.length <= MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS) return { text: result, truncated: false };
  const marker = ` [RESULT truncated: ${result.length} chars]`;
  return { text: `${result.slice(0, Math.max(0, MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS - marker.length))}${marker}`, truncated: true };
}

/**
 * 자식의 최종 요약에서 `EVIDENCE:` 줄을 골라 분류한다. **순수**.
 *
 * ⭐ 자식의 반환 계약(`{ ok, summary }`)을 **바꾸지 않는다** — 요약은 이미 오케스트레이터에
 * 돌아오므로, 새 필드를 만들면 `ok` 의 의미(`changed && !timedOut`)와 얽혀 빈 워크트리에
 * claim 만 남기는 경로가 생긴다(`#5920` 리뷰 must-fix ①). 그 경로를 아예 만들지 않는다.
 */
export function parseOffDiffEvidence(summary: string): OffDiffEvidenceParse {
  const items: OffDiffEvidenceItem[] = [];
  let discardedMissingVerify = 0;
  let discardedEmptyClaim = 0;
  let missingResult = 0;
  let orphanResult = 0;
  let truncatedResult = 0;
  let anchoredEvidence = 0;
  const lines = summary.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const evidence = raw.match(EVIDENCE_LINE);
    if (!evidence) {
      if (raw.match(RESULT_LINE) && !lines[index - 1]?.match(EVIDENCE_LINE)) orphanResult++;
      continue;
    }
    anchoredEvidence++;
    const body = (evidence[1] ?? '').trim();
    const separator = body.indexOf(REQUIRED_EVIDENCE_COMMAND_SEPARATOR);
    const claim = (separator >= 0 ? body.slice(0, separator) : body).trim();
    const verify = separator >= 0 ? body.slice(separator + REQUIRED_EVIDENCE_COMMAND_SEPARATOR.length).trim() : '';
    const resultMatch = lines[index + 1]?.match(RESULT_LINE);
    const rawResult = resultMatch ? (resultMatch[1] ?? '').trim() : '';
    const capped = rawResult ? capResult(rawResult) : undefined;
    if (capped?.truncated) truncatedResult++;
    const result = capped?.text;
    // ⛔ 빈 `RESULT:` 는 **결과가 없는 것**이다(리뷰 should-fix) — 줄만 있고 내용이 비면
    //   `result` 에도 안 실리므로, 여기서 안 세면 결손 관측이 **거짓 음성**이 된다.
    if (!result) missingResult++;
    // ⛔ 두 결손을 **독립으로** 센다(리뷰 must-fix) — 한 줄이 둘 다 비면 둘 다 오른다.
    if (!claim) discardedEmptyClaim++;
    if (!verify) discardedMissingVerify++;
    if (!claim || !verify) continue;
    items.push({ claim, verify, ...(result ? { result } : {}) });
  }
  return { items, discardedMissingVerify, discardedEmptyClaim, missingResult, orphanResult, truncatedResult, anchoredEvidence };
}

/**
 * 자식 프롬프트에 실을 안내. ⛔ **행위를 부르지 않는다** — `featurePrompt` 의 범위 제한
 * (*"git commit/push/PR/브랜치 조작 금지"*)과 충돌하면 자식이 멈춘다(실측: 그래서 런이 죽었다).
 */
export const OFF_DIFF_EVIDENCE_PROMPT = [
  '- diff 에 안 남는 확인을 했다면(예: 명령을 돌려 동작을 봤다) 마지막에 두 줄씩 남겨라:',
  '  `EVIDENCE: <무엇을 확인했나> || <그것을 재현하는 명령>`',
  '  예: `EVIDENCE: 추가한 focused 테스트가 통과했다 || bun test src/self-implement/off-diff-evidence.test.ts`',
  '  `RESULT: <그 명령을 돌린 결과 한 줄 — 요약 줄이나 판정 줄을 그대로>`',
  `  ⚠️ \`RESULT:\` 는 반드시 바로 앞 \`EVIDENCE:\` 의 결과만 적어라. 결과는 한 줄로 ${MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS}자 이하로 적고, 더 길면 잘렸다고 밝혀라.`,
  '  ⚠️ **보고만 하는 것이다** — 위 범위 제한은 그대로다(git/PR/브랜치 조작 금지).',
  '  ⚠️ 확인 명령을 못 적겠으면 그 줄을 **쓰지 마라**. 확인할 수 없는 주장은 증거가 아니다.',
].join('\n');

/** 수확본 상한. ⛔ 꼬리 2000자와 **다른 예산**이다 — 이것은 사람이 읽는 요약이 아니라 **파서 입력**이다. */
export const MAX_HARVESTED_EVIDENCE_CHARS = 4000;

/** 꼬리만 전달할 때 상한·앞부분 결손을 함께 남긴다. 상한 안이면 원문을 바꾸지 않는다. */
export function tailWithOmissionMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let kept = Math.max(0, maxChars);
  for (;;) {
    const omitted = text.length - kept;
    const marker = `[상한 ${maxChars}자 — 앞부분 ${omitted}자 생략]`;
    const nextKept = Math.max(0, maxChars - marker.length);
    if (nextKept === kept) return `${marker}${text.slice(-kept)}`;
    kept = nextKept;
  }
}

/**
 * ★ `I-9`/`RUN-T6` 수리 — 자식 화면 **전체**에서 `EVIDENCE:`(⊕ 바로 뒤 `RESULT:`) 줄만 수확한다. **순수**.
 *
 * ⛔ **왜 필요한가**: `impl.summary` 는 `transcript.slice(-2000)`(화면 꼬리)이고, 파서도 PR 본문도
 * **그것만** 본다. ⇒ 자식이 tsc·뮤테이션을 **먼저** 돌리고 다른 작업을 이어가면 그 출력이 **창 밖으로
 * 밀려** 증거가 파서에 **도달조차 못 한다**. 실측: `run-f9f1c778` 이 반복된 must-fix 둘(`tsc 근거` ·
 * `뮤테이션 출력` · 둘 다 *"보고문에 없다"*)로 `UNCONVERGEABLE` 사망했고 **구현은 옳았다**.
 *
 * ⛔ **짝을 만들어 내지 않는다** — 원본에서 `RESULT:` 가 `EVIDENCE:` **바로 다음 줄**일 때만 함께
 * 가져간다. 아니면 `EVIDENCE:` 만 가져간다(필터가 없던 인접을 **발명하면** 파서가 거짓 쌍을 본다).
 * ⛔ 상한 초과 시 **뒤(최신)를 남긴다** — 마지막 라운드의 증거가 판정 대상이다.
 */
export function harvestEvidenceLines(transcript: string, maxChars = MAX_HARVESTED_EVIDENCE_CHARS): string {
  const lines = transcript.split(/\r?\n/);
  // ⛔ **레코드 단위**로 모은다(리뷰 1R) — 줄 단위로 자르면 쌍이 갈려 **고아 `RESULT` 가 남고**
  //    파서가 `orphanResult` 를 올린다(있지도 않은 결손을 만든다).
  const records: string[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!EVIDENCE_LINE.test(raw)) continue;
    const next = lines[index + 1];
    records.push(next !== undefined && RESULT_LINE.test(next) ? `${raw}\n${next}` : raw);
  }
  if (!records.length) return '';
  const joined = records.join('\n');
  if (joined.length <= maxChars) return joined;

  // 뒤(최신)부터 **레코드 통째로** 담는다. 표지까지 합쳐 상한 안에 들어가게 예산을 먼저 뗀다.
  const marker = (dropped: number): string => `[수확 상한 ${maxChars}자 — 앞부분 ${dropped}레코드 생략]`;
  const budget = Math.max(0, maxChars - marker(records.length).length - 1);
  const tail: string[] = [];
  let size = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i] as string;
    if (size + record.length + 1 > budget) break;
    tail.unshift(record);
    size += record.length + 1;
  }
  // ⛔ **최신 하나가 예산보다 커도 버리지 않는다**(리뷰 1R must-fix) — 그것이 판정 대상이다.
  //    `EVIDENCE:` 줄은 온전히 두고 뒤를 잘라 잘린 사실을 표기한다.
  if (!tail.length) {
    const newest = records[records.length - 1] as string;
    const [evidenceLine, resultLine] = newest.split('\n');
    const head = marker(records.length - 1);
    // ⛔⭐ `EVIDENCE:` 줄은 **절대 자르지 않는다** — 그 줄이 곧 **재현 명령**이라 중간을 자르면
    //    판정자에게 **변조된 명령**이 간다. 생략 표지도 지우지 않는다(조용한 절단 금지).
    //    ⇒ 상한을 넘는 경우는 **오직 하나**: `표지 + EVIDENCE 줄` 자체가 상한보다 클 때다.
    const base = `${head}\n${evidenceLine}`;
    if (resultLine === undefined) return base;
    const full = `${base}\n${resultLine}`;
    if (full.length <= maxChars) return full;
    const note = `\n[RESULT 절단 — 원본 ${resultLine.length}자]`;
    const room = maxChars - base.length - 1 - note.length;
    // ⛔⭐ 접두(`RESULT: `)를 못 살릴 만큼 좁으면 **자르지 않고 생략 단계로 내려간다** — 접두가 깨지면
    //    `R`·`RESUL` 같은 비문이 되고 파서가 그 줄을 **결손(`missingResult`)으로 오판**한다(리뷰 6R).
    const prefix = resultLine.match(/^\s*RESULT:\s*/i)?.[0] ?? '';
    if (room > prefix.length) return `${base}\n${resultLine.slice(0, room)}${note}`;
    const omitted = `${base}\n[RESULT 생략 — 상한 초과]`;
    return omitted.length <= maxChars ? omitted : base;
  }
  return `${marker(records.length - tail.length)}\n${tail.join('\n')}`;
}

/** 수확본을 관측에 실을 때 「없다」·「잘렸다」·「안 쟀다」를 가르는 값.
 *  ⛔ `unmeasured` 는 **이 함수가 내지 않는다** — 필드를 안 실은 관측(옛 행)이 그 뜻이다. */
export type HarvestedEvidenceStatus = 'empty' | 'complete' | 'truncated';

export interface HarvestedEvidenceObservation {
  readonly harvestedEvidenceStatus: HarvestedEvidenceStatus;
  /** 관측에 실은 레코드 수(생략 표지 줄은 세지 않는다). */
  readonly harvestedEvidenceKept: number;
  /** 수확 대상 레코드 수 = kept + 앞부분 생략. empty 는 둘 다 0. */
  readonly harvestedEvidenceTotal: number;
  /** PR 본문에 싣는 것과 **같은** 수확 문자열. empty 면 키 자체가 없다(빈 문자열과 잘림을 섞지 않는다). */
  readonly harvestedEvidence?: string;
}

const HARVEST_OMISSION_LINE = /^\[수확 상한 \d+자 — 앞부분 (\d+)레코드 생략\]$/;
const HARVEST_RESULT_CUT = /\[RESULT (절단|생략)/;

/**
 * ★ 수확본 → 관측 필드. **순수**.
 *
 * ⛔ 수확 규칙을 다시 적용하지 않는다 — 인자 `harvested` 가 곧 PR 본문이 싣는 문자열이다
 *    (`harvestedForPr` / `harvestEvidenceLines`). 둘이 갈리면 로그와 PR 이 다른 말을 한다.
 * ⛔ 「없다」(`empty`)와 「잘렸다」(`truncated`)와 「안 쟀다」(필드 부재)를 같은 값으로 만들지 않는다.
 */
export function harvestedEvidenceObservation(harvested: string | undefined): HarvestedEvidenceObservation {
  if (!harvested?.trim()) {
    return { harvestedEvidenceStatus: 'empty', harvestedEvidenceKept: 0, harvestedEvidenceTotal: 0 };
  }
  const lines = harvested.split(/\r?\n/);
  const omission = lines[0]?.match(HARVEST_OMISSION_LINE);
  const dropped = omission ? Number(omission[1]) : 0;
  let kept = 0;
  let resultCut = false;
  for (const line of lines) {
    if (EVIDENCE_LINE.test(line)) kept++;
    if (HARVEST_RESULT_CUT.test(line)) resultCut = true;
  }
  const truncated = dropped > 0 || resultCut;
  return {
    harvestedEvidenceStatus: truncated ? 'truncated' : 'complete',
    harvestedEvidenceKept: kept,
    harvestedEvidenceTotal: kept + dropped,
    harvestedEvidence: harvested,
  };
}

/**
 * ★ 자식 실행 결과 → 보고 두 칸. **순수**. PTY·spawnSync **두 갈래가 이 함수 하나를 쓴다** —
 * 갈래마다 조립하면 *"한쪽만 정직해진다"*(이 파일의 종전 주석이 경고하던 그것).
 * ⛔ `summary`(사람이 읽는 꼬리)와 `evidenceTranscript`(파서 입력)는 **다른 예산**이다.
 */
export function buildImplementReport(
  transcript: string,
  meta: { bootReason?: string; changed: boolean; toolCalls: number; reached: boolean; timedOut: boolean; ptyId?: string },
): { summary: string; evidenceTranscript: string } {
  const tail = `[변경: ${meta.changed ? 'yes' : 'none'} · 툴콜 ${meta.toolCalls} · 완료 ${meta.reached} · 타임아웃 ${meta.timedOut}${meta.ptyId ? ` · PTY ${meta.ptyId}` : ''}]`;
  return {
    summary: `${meta.bootReason ? `[부팅 실패] ${meta.bootReason}\n\n` : ''}${tailWithOmissionMarker(transcript, 2000)}\n\n${tail}`,
    evidenceTranscript: harvestEvidenceLines(transcript),
  };
}

/** 골이 *"무엇에 대해"* 증거를 요구하는지 적는 자리. ⛔ 이 제목이 없으면 요구 0 이다(추측하지 않는다).
 *  ⛔ export 하지 않는다 — 밖에 소비자가 없다(죽은 공개 표면은 계약처럼 읽힌다). */
const REQUIRED_EVIDENCE_HEADING = '## REQUIRED EVIDENCE';
const AUTHOR_LIMITATIONS_HEADING = '## 답하지 못하는 것';

/** ⛔ export 하지 않는다 — 밖에서 import 하는 곳이 없고, 반환·인자 타입으로 추론된다.
 *  (오늘 같은 계열 지적 두 번째: 죽은 공개 표면은 계약처럼 읽힌다.) */
interface RequiredEvidenceItem {
  /** 판정 신호. **태그 동등**으로만 대조한다(해석 금지). */
  readonly tag: string;
  /** 골에 적힌 줄(앞뒤 공백만 정리). ⛔ 프롬프트는 **낱말을 재작성하지 않는다** — 들여쓰기는 한다.
   *  ⚠️ 설명(`무엇`)을 **따로 필드로 두지 않는다** — 소비처가 없는 필드는 계약처럼 읽힌다.
   *  파싱 때 **비었는지만** 본다(빈 요구 = 채울 수 없는 계약). */
  readonly raw: string;
  /** 사람이 골의 요구 줄에 명시한 하니스 관측용 셸 명령. */
  readonly verifyCommand?: string;
  /** 유일한 요구 설명과 정확히 일치한 Author limitation 원문. 요구는 지우지 않고 선언 근거만 남긴다. */
  readonly coveredByLimitation?: string;
}

interface RequiredEvidenceLimitation {
  readonly value: string;
  readonly raw: string;
}

/** 자연어 유사도는 추측하지 않는다. 공백·대소문자 차이만 같은 선언으로 취급한다. */
function normalizeLimitationText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Author limitation은 정확히 producer의 `## 답하지 못하는 것` 절 본문에서만 읽는다. 요구 설명 전체와
 * 정확히 같은 선언만 후속 비교 후보가 되므로, 예시·인용·부분 문구·여러 요구에 공통인 모호한 선언은 덮을 수 없다.
 */
function requiredEvidenceLimitations(goal: string): readonly RequiredEvidenceLimitation[] {
  const limitations: RequiredEvidenceLimitation[] = [];
  let inAuthorLimitations = false;
  for (const line of goal.split(/\r?\n/)) {
    if (/^\s*#{1,6}\s/.test(line)) {
      inAuthorLimitations = line.trim().toLowerCase() === AUTHOR_LIMITATIONS_HEADING.toLowerCase();
      continue;
    }
    if (!inAuthorLimitations) continue;
    const match = line.match(/^\s*-\s*Author limitation:\s*(.+?)\s*$/i);
    const value = (match?.[1] ?? '').trim();
    if (value) limitations.push({ value, raw: line.trim() });
  }
  return limitations;
}

/** 골이 명시한 limitation 수. 요구 0과 limitation 부재를 리뷰 출력에서 구분하는 순수 관측값이다. */
export function authorLimitationCountFromGoal(goal: string): number {
  return requiredEvidenceLimitations(goal).length;
}

/** ⛔ export 하지 않는다 — 밖에서 import 하는 곳이 없고 `runRequiredEvidenceChecks` 의 반환 타입으로
 *  추론된다. 위 두 타입과 같은 규율이다(죽은 공개 표면은 계약처럼 읽힌다 · 리뷰 must-fix). */
interface RequiredEvidenceCheckRun {
  readonly tag: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly durationMs: number;
}

/**
 * ★ `I-24` / `RUN-T6` — 골에서 **요구된 증거**를 읽는다. **순수**.
 *
 * ⛔ **왜 태그인가**: `RUN-T6` 은 자식이 증거를 **안 써서**가 아니라 **골이 요구한 것에 대해 안 써서**
 * 죽었다(그 라운드도 `kept 2 · missingResult 0` — 썼다, 다른 것에 대해). 그런데 *"이 요구를 만족하는
 * 증거인가"* 를 **문면으로 판정하면 반드시 휴리스틱**이 되고 그것은 Goodhart 다(`[S]` `GOAL-S3`).
 * ⇒ **관측 가능한 신호 하나로 못 박는다**: 골이 `- [tag] 무엇` 으로 이름을 주고, 자식은
 * `EVIDENCE: [tag] …` 로 **같은 태그**를 단다. 매칭은 **문자열 동등**이지 해석이 아니다.
 *
 * 형식: `## REQUIRED EVIDENCE` 아래 `- [tag] 설명` 줄들. 제목이 없으면 **빈 배열**(추측 금지).
 */
export function requiredEvidenceFromGoal(goal: string): RequiredEvidenceItem[] {
  const lines = goal.split(/\r?\n/);
  // ⛔ `startsWith` 가 아니라 **줄 전체 일치** — `## REQUIRED EVIDENCE NOTES` 같은 **다른 제목**을
  //   계약으로 오인하면 *"제목이 없으면 요구 0"* 이 깨진다(리뷰 1R).
  // ⚠️ 다만 **대소문자·주변 공백은 관대**하다(`## required evidence` 도 받는다) — 그것은 *"다른 제목"*
  //   이 아니라 **같은 제목의 표기 차이**이고, 여기서 엄격하면 골 저작자가 조용히 요구 0 을 얻는다.
  const start = lines.findIndex((line) => line.trim().toUpperCase() === REQUIRED_EVIDENCE_HEADING);
  if (start < 0) return [];
  const items: RequiredEvidenceItem[] = [];
  const limitations = requiredEvidenceLimitations(goal);
  const seen = new Set<string>();
  for (const raw of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(raw)) break;                   // ⛔ 다음 절에서 멈춘다(`#`·`###` 도 절이다)
    // ⚠️ 받는 형태를 여기 적는다(테스트가 고정한다): 불릿은 `-` 또는 `*`, 대괄호 앞 공백은 선택.
    //    ⛔ 넓히려는 게 아니라 **마크다운 표기 차이**를 흡수하는 것이다 — 저작자가 `*` 를 썼다고
    //    조용히 요구 0 이 되면 그게 더 나쁘다(제목 관대함과 같은 판단).
    const m = raw.match(/^\s*[-*]\s*\[([^\]]+)\]\s*(.*)$/);
    if (!m) continue;
    const tag = (m[1] ?? '').trim();
    const what = (m[2] ?? '').trim();
    const separator = what.indexOf(REQUIRED_EVIDENCE_COMMAND_SEPARATOR);
    const description = (separator >= 0 ? what.slice(0, separator) : what).trim();
    // ⛔ 태그만 있고 **무엇인지 없는 줄은 요구가 아니다** — 빈 요구는 자식이 채울 수 없고
    //   `missingEvidence` 만 늘려 **채울 수 없는 계약**이 된다(리뷰 1R).
    if (!tag || !description || seen.has(tag)) continue;   // ⛔ 중복 태그는 하나로(요구 수가 부풀지 않게)
    seen.add(tag);
    const verifyCommand = separator >= 0 ? what.slice(separator + REQUIRED_EVIDENCE_COMMAND_SEPARATOR.length).trim() : '';
    // ⚠️ `raw` 는 **저작자가 쓴 낱말을 재작성하지 않는다**는 뜻이다 — 앞뒤 공백 정리와 프롬프트
    //   들여쓰기는 한다(바이트 동일이 계약이면 렌더링을 못 한다 · 리뷰 2R 에 대한 내 정정).
    items.push({ tag, raw: raw.trim(), ...(verifyCommand ? { verifyCommand } : {}) });
  }
  return items.map((item) => {
    const description = item.raw.replace(/^\s*[-*]\s*\[[^\]]+\]\s*/, '').split(REQUIRED_EVIDENCE_COMMAND_SEPARATOR, 1)[0]?.trim() ?? '';
    const normalizedDescription = normalizeLimitationText(description);
    const matchingRequirements = items.filter((candidate) => normalizeLimitationText(
      candidate.raw.replace(/^\s*[-*]\s*\[[^\]]+\]\s*/, '').split(REQUIRED_EVIDENCE_COMMAND_SEPARATOR, 1)[0]?.trim() ?? '',
    ) === normalizedDescription);
    const matchingLimitations = limitations.filter((candidate) => normalizeLimitationText(candidate.value) === normalizedDescription);
    const limitation = matchingRequirements.length === 1 && matchingLimitations.length === 1 ? matchingLimitations[0] : undefined;
    return { ...item, ...(limitation ? { coveredByLimitation: limitation.raw } : {}) };
  });
}

/** 골 작성자가 요구 줄에 명시한 셸 체크만 하니스 worktree에서 관측한다. 결과는 판정에 연결하지 않는다. */
export function runRequiredEvidenceChecks(goal: string, cwd: string, runId?: string): RequiredEvidenceCheckRun[] {
  const identity = resolveRunIdentity({ explicit: runId });
  const checks = requiredEvidenceFromGoal(goal).flatMap(({ tag, verifyCommand }) => verifyCommand ? [{ tag, command: verifyCommand }] : []);
  const runs = checks.map(({ tag, command }) => {
    const startedAt = Date.now();
    const result = spawnSync(requirePosixShellCommand('/bin/sh'), ['-c', command], { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    return {
      tag,
      command,
      exitCode: result.status,
      stdout: tailWithOmissionMarker(result.stdout ?? '', MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS),
      durationMs: Date.now() - startedAt,
    };
  });
  const observation = { count: runs.length, runs };
  Object.defineProperty(observation, 'runId', { value: identity.runId });
  Object.defineProperty(observation, 'toJSON', {
    value: () => ({ ...observation, runId: identity.runId }),
  });
  debug.log('self-implement', 'required-evidence-check-run', observation);
  return runs;
}

/** 자식 프롬프트에 실을 요구 목록. 요구가 없으면 **아무 줄도 안 붙인다**(빈 계약을 만들지 않는다). */
export function renderRequiredEvidencePrompt(items: readonly RequiredEvidenceItem[]): string[] {
  if (!items.length) return [];
  return [
    '',
    '⛔ **이 골이 이름으로 요구한 증거** — 각 항목마다 **그 태그를 달아** 두 줄을 남겨라:',
    // ⛔ 저작자가 고른 **낱말을 재작성하지 않는다**(들여쓰기만 붙인다).
    ...items.flatMap(({ tag, raw }) => [`  ${raw}`, `      ⇒ \`EVIDENCE: [${tag}] <무엇을 확인했나> || <재현 명령>\` ⊕ \`RESULT: <출력>\``]),
    '  ⚠️ 태그는 **대괄호까지 그대로** 써라 — 판정이 태그 동등으로 이뤄진다(해석이 아니다).',
  ];
}

/** 안 덮인 필수 증거만 자식에게 재요청한다. 판정은 coverRequiredEvidence의 태그 동등 규칙을 따른다. */
export function formatUncoveredEvidenceFeedback(uncovered: readonly string[]): string {
  return [
    `필수 증거가 아직 안 덮였습니다: ${uncovered.map((tag) => `[${tag}]`).join(', ')}`,
    ...uncovered.map((tag) => `- [${tag}]에 쓸 줄 꼴:\n  EVIDENCE: [${tag}] <확인한 내용> || <재현 명령>\n  RESULT: <그 명령의 실제 결과>`),
    '확인한 결과만 보고하고, git/PR 조작은 하지 마라.',
  ].join('\n');
}

/** 요구 ↔ 자식이 남긴 증거의 **태그 동등** 대조. ⛔ 문면 해석 금지.
 * 선언 덮임은 별도 값이다. 기존 `covered`/`missing`은 실제 증거 태그 기준으로 보존한다. */
export function coverRequiredEvidence(
  required: readonly RequiredEvidenceItem[],
  items: readonly OffDiffEvidenceItem[],
): { covered: string[]; missing: string[]; coveredByLimitation: string[]; uncovered: string[]; coveredByLimitationCount: number; uncoveredCount: number } {
  const written = new Set<string>();
  for (const { claim } of items) {
    const m = claim.match(/^\s*\[([^\]]+)\]/);
    if (m?.[1]) written.add(m[1].trim());
  }
  const covered = required.filter(({ tag }) => written.has(tag)).map(({ tag }) => tag);
  const missing = required.filter(({ tag }) => !written.has(tag)).map(({ tag }) => tag);
  const coveredByLimitation = required.filter(({ coveredByLimitation }) => coveredByLimitation !== undefined).map(({ tag }) => tag);
  const uncovered = required.filter(({ tag, coveredByLimitation }) => !written.has(tag) && coveredByLimitation === undefined).map(({ tag }) => tag);
  return {
    covered,
    missing,
    coveredByLimitation,
    uncovered,
    coveredByLimitationCount: coveredByLimitation.length,
    uncoveredCount: uncovered.length,
  };
}
