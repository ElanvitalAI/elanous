// ── diff 밖 이행 증거 파싱 (S3 · 2026-07-29) ──────────────────────────────────

import { requirePosixShellCommand } from '../platform/default-shell.js';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { linkWorktreeDependencies } from '../git-fs/worktree.js';
import { runGitCommand } from '../git-fs/runner.js';
import { parseSafeDecisionSignalCommand } from './decision-signal-press.js';
import { debug } from '../debug/log.js';
import { narrowerEvidenceCommand } from './evidence-command-budget.js';
import { resolveRunIdentity } from '../harness/harness-space.js';
import { authoredSignalCommandFromGoal } from './goal-doc/section.js';
import { TDD_GREEN_TAG, TDD_RED_TAG, type TddRecordTag } from './tdd-evidence-tags.js';
export { TDD_GREEN_TAG, TDD_RED_TAG } from './tdd-evidence-tags.js';
export type { TddRecordTag } from './tdd-evidence-tags.js';
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
  const evidence = harvestEvidenceLines(transcript);
  const observedTests = observedBunTestCommands(transcript);
  const testOutput = observedTests
    .map(({ command, result }) => `[child-test-output] command=${command}\n[child-test-result] ${result}`);
  debug.log('self-implement.tdd-evidence', 'child-output-harvest', {
    testOutputs: testOutput.length,
    commands: observedTests.map(({ command }) => command),
    evidenceGreenTags: (evidence.match(/\[tdd-green\]/gu) ?? []).length,
  });
  return {
    summary: `${meta.bootReason ? `[부팅 실패] ${meta.bootReason}\n\n` : ''}${tailWithOmissionMarker(transcript, 2000)}\n\n${tail}`,
    evidenceTranscript: [evidence, ...testOutput].filter(Boolean).join('\n'),
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
  /** Command required by the authored goal, even if a diagnostic substitute ran. */
  readonly command: string;
  /** Command actually run; absent when the timeout budget stopped execution. */
  readonly executedCommand?: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  /** EVIDENCE-WIRING-EXEMPT — `bun test` writes its «N pass / 0 fail» summary to stderr. */
  readonly stderr: string;
  readonly durationMs: number;
  /** A narrower smoke check diagnoses the timeout but cannot prove the original requirement. */
  readonly substitutedFor?: string;
}

function authoredSignalCommand(goal: string): string | undefined {
  const command = authoredSignalCommandFromGoal(goal);
  if (!command) return undefined;
  // Goal-authored signals run as one explicit command. Reject shell composition and
  // substitutions; keep the accepted executable set aligned with goal-author's contract.
  if (/[\r\n;|&<>`$()]/u.test(command) || /\b(?:sudo|eval|exec)\b/u.test(command)) return undefined;
  const match = command.match(/^([A-Za-z0-9_./~-]+)\s+(.+)$/u);
  if (!match) return undefined;
  const executable = match[1]!.split('/').at(-1);
  if (!new Set(['eln','bun','git','gh','rg','test','npm','pnpm','yarn','node','python','python3','pytest','make','cargo','go','curl','jq','sqlite3','grep','sed','awk','cat','find','docker','kubectl']).has(executable!)) return undefined;
  if (executable === 'test' && !/^(?:-f|-e)\s+[^\s]+$/u.test(match[2]!)) return undefined;
  return command;
}

export function authoredSignalExecution(goal: string, checks: readonly RequiredEvidenceCheckRun[]): { command: string; exitCode: number | null; stdout: string; stderr: string } | undefined {
  const command = authoredSignalCommand(goal);
  const run = command ? checks.find((check) => check.command === command) : undefined;
  return run ? { command: run.command, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr } : undefined;
}

type EvidenceCommandRunner = (command: string, cwd: string) => Pick<ReturnType<typeof spawnSync>, 'status' | 'stdout' | 'stderr' | 'error'>;

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
  const noWiring = goalDeclaresNoWiring(goal);
  return items.map((item) => {
    // EVIDENCE-WIRING-EXEMPT — a goal whose boundary says «no wiring / pure function only» cannot show a caller in its diff.
    if (item.tag === 'wiring' && noWiring) return { ...item, coveredByLimitation: NO_WIRING_LIMITATION };
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

/** EVIDENCE-WIRING-EXEMPT — the goal itself rules wiring out: «배선 0», «배선·부작용 0», «순수 함수만», «no wiring», «pure function only». */
const NO_WIRING_MARKER = /배선\s*(?:[·⋅,/]\s*부작용\s*)?0(?![\d.])|배선\s*없음|순수\s*함수만|\bno wiring\b|\bpure functions? only\b/iu;
const NO_WIRING_LIMITATION = 'goal boundary declares no wiring (pure function only)';
export function goalDeclaresNoWiring(goal: string): boolean {
  return NO_WIRING_MARKER.test(goal);
}

/** A `bun test` check that ran its tests and failed none: rc 0 ⊕ «N pass» (N ≥ 1) ⊕ «0 fail» in its output. */
function bunTestCheckPassed(run: RequiredEvidenceCheckRun): boolean {
  if (run.substitutedFor || run.exitCode !== 0 || !/(?:^|[\s;&|(])bun\s+(?:run\s+)?test\b/.test(run.executedCommand ?? run.command)) return false;
  const output = `${run.stdout}\n${run.stderr}`;
  return /(?:^|\n)\s*[1-9]\d*\s+pass\b/.test(output) && /(?:^|\n)\s*0\s+fail\b/.test(output);
}

/** EVIDENCE-WIRING-EXEMPT — settle what the child's tags left uncovered with what the harness measured itself:
 *  a requirement whose own `|| bun test …` check passed (tests ran, 0 fail) is covered by that check; a commandless
 *  [preservation] is covered when the changed-file gate was measured and passed (the existing tests still hold).
 *  Anything else stays uncovered — no wording is interpreted. */
export function settleUncoveredEvidence(
  uncovered: readonly string[],
  measured: { checks?: readonly RequiredEvidenceCheckRun[]; required?: readonly RequiredEvidenceItem[]; gatePassed?: boolean },
): { uncovered: string[]; coveredByCheck: string[]; coveredByGate: string[] } {
  const passedTags = new Set((measured.checks ?? []).filter(bunTestCheckPassed).map(({ tag }) => tag));
  const withCommand = new Set((measured.required ?? []).filter(({ verifyCommand }) => verifyCommand).map(({ tag }) => tag));
  const coveredByCheck = uncovered.filter((tag) => passedTags.has(tag));
  const coveredByGate = measured.gatePassed === true
    ? uncovered.filter((tag) => tag === 'preservation' && !passedTags.has(tag) && !withCommand.has(tag))
    : [];
  const settled = new Set([...coveredByCheck, ...coveredByGate]);
  return { uncovered: uncovered.filter((tag) => !settled.has(tag)), coveredByCheck, coveredByGate };
}

/** 골 작성자가 요구 줄에 명시한 셸 체크를 하니스 worktree에서 관측한다. `bun test` 체크의 통과는
 *  settleUncoveredEvidence 가 그 요구의 덮임으로 받는다(EVIDENCE-WIRING-EXEMPT).
 *  단독 호출에 timeoutCounts/headCommit을 주지 않으면 재시도 예산이 없다. 실제 라운드 호출자는
 *  run 단위 createRequiredEvidenceBudget을 써야 HEAD 미확인 때도 임시 예산이 적용된다. */
export function runRequiredEvidenceChecks(goal: string, cwd: string, runId?: string, options: {
  timeoutCounts?: Map<string, number>;
  headCommit?: string;
  run?: EvidenceCommandRunner;
} = {}): RequiredEvidenceCheckRun[] {
  const identity = resolveRunIdentity({ explicit: runId });
  const checks = requiredEvidenceFromGoal(goal).flatMap(({ tag, verifyCommand }) => verifyCommand ? [{ tag, command: verifyCommand }] : []);
  const signalCommand = authoredSignalCommand(goal);
  if (signalCommand && !checks.some(({ command }) => command === signalCommand)) checks.push({ tag: 'authored-signal', command: signalCommand });
  // Direct callers without a measured HEAD have no stable revision identity;
  // the run-owned wrapper supplies a temporary identity when appropriate.
  const timeoutCounts = options.headCommit ? options.timeoutCounts : undefined;
  const budgetKey = (command: string) => `${options.headCommit ?? ''}\0${command}`;
  const runs = checks.map(({ tag, command }) => {
    const startedAt = Date.now();
    const priorTimeouts = timeoutCounts?.get(budgetKey(command)) ?? 0;
    const replacement = priorTimeouts >= 2 ? narrowerEvidenceCommand(command, cwd) : null;
    const executedCommand = replacement ?? command;
    const replacementTimeouts = replacement ? (timeoutCounts?.get(budgetKey(replacement)) ?? 0) : 0;
    if (priorTimeouts >= 2 && (!replacement || replacementTimeouts >= 2)) {
      try { debug.log('self-implement.evidence', 'command-budget-stop', { runId: identity.runId, command, replacement, timeoutCount: priorTimeouts, replacementTimeoutCount: replacementTimeouts }); } catch { /* observation is fail-soft */ }
      return { tag, command, exitCode: null, stdout: '', stderr: 'Evidence command timed out twice; no further identical test run was attempted.', durationMs: 0 };
    }
    if (replacement) {
      try { debug.log('self-implement.evidence', 'command-budget-switch', { runId: identity.runId, from: command, to: replacement, timeoutCount: priorTimeouts }); } catch { /* observation is fail-soft */ }
    }
    const result = options.run?.(executedCommand, cwd)
      ?? spawnSync(requirePosixShellCommand('/bin/sh'), ['-c', executedCommand], { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    const timedOut = result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT';
    if (timedOut && timeoutCounts) timeoutCounts.set(budgetKey(executedCommand), (timeoutCounts.get(budgetKey(executedCommand)) ?? 0) + 1);
    return {
      tag,
      command,
      executedCommand,
      exitCode: result.status,
      stdout: tailWithOmissionMarker(typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '', MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS),
      stderr: tailWithOmissionMarker(typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8') ?? '', MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS),
      durationMs: Date.now() - startedAt,
      ...(replacement ? { substitutedFor: command } : {}),
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

/** One self-implement run owns this state; a changed HEAD starts a fresh budget. */
export function createRequiredEvidenceBudget(options: { run?: EvidenceCommandRunner } = {}): (
  goal: string, cwd: string, runId: string | undefined, headCommit: string | undefined,
) => RequiredEvidenceCheckRun[] {
  let previousHead: string | undefined;
  const timeoutCounts = new Map<string, number>();
  // This closure is created once per self-implement run. Its unresolved key
  // bounds repeats within that run without pooling with another run or SHA.
  const unresolvedRunHead = 'unresolved-head-within-this-run';
  return (goal, cwd, runId, headCommit) => {
    if (previousHead !== headCommit) {
      timeoutCounts.clear();
      previousHead = headCommit;
    }
    return runRequiredEvidenceChecks(goal, cwd, runId, { timeoutCounts, headCommit: headCommit ?? unresolvedRunHead, run: options.run });
  };
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

// ── TDD 를 로직으로 (S4 · 대표 10-26 20:5x «쪼개기·TDD 가 로직에 박혀 있나») ──────
//
// ⛔ **왜 필요한가** — 조각 골(device-first)은 «검증 계획(TDD)» 문면만 조립하고, 사후 판정은
// 증거 명령이 덮였는지만 본다(required-evidence-uncovered). ⇒ 자식이 **시험을 먼저 쓰고 구현 전에
// RED 를 확인했는지**를 검사하는 경로가 전혀 없다. TDD 가 문면 요청으로만 존재한다.
// ⇒ 오케스트레이터가 **첫 조각 커밋에 피처 시험·구현 전 실행 RED 기록**을 요구하고
//   **구현 뒤 같은 명령의 GREEN 기록**을 요구한다. 판정은 기존 태그 동등 문법과 같다:
//   자식은 `EVIDENCE: [tdd-red] … || <명령>` ⊕ `RESULT: <실패>` ·
//   `EVIDENCE: [tdd-green] … || <같은 명령>` ⊕ `RESULT: <통과>` 를 남긴다.

/** 자식이 남겨야 하는 TDD 증거 태그. ⛔ 판정은 **태그 동등**이다(해석 금지). */
/** 골 문서의 «검증 계획(TDD)» 절 형식(완료 경계 증거 명령이 골 문서가 아니라 조각 계획에 박혀 있다). */
const TDD_PLAN_HEADING = /^#{2,3}\s*검증\s*계획\s*\(TDD\)\s*$/iu;
const TDD_RED_PLAN_PREFIX = /^[-*]\s*③\s*먼저\s*쓸\s*시험\(RED\)\s*:\s*/u;
const TDD_GREEN_PLAN_PREFIX = /^[-*]\s*④\s*GREEN\s*뒤\s*같은\s*명령\s*:\s*/u;
/** device-first 조각 계획의 한 줄 형식 — «피처 시험 bun test <경로>» 를 같은 명령으로 잡는다. 경로 토큰 경계([\\w./-]) 로 조사·역따옴표를 삼키지 않는다. */
const TDD_PLAN_INLINE = /(?:--test-)?bun(?:x)?\s+test\s+(?:src|test)\/[\w./-]+/iu;
/** `RESULT:` 한 줄이 통과 기록인가 — 기존 bun test 판정 문법(`0 fail`)과 같은 신호. */
const TDD_PASS_RESULT = /(?:^|\s)0\s+fail/iu;

export interface TddPlan {
  readonly planned: boolean;
  /** ③ 먼저 쓸 시험(RED) 문면(앞뒤 공백만 정리). */
  readonly redStage: string | undefined;
  /** ④ GREEN 뒤 같은 명령(예: `bun test <대상>.test.ts`). */
  readonly greenCommand: string | undefined;
}

/** 골 문서에서 «검증 계획(TDD)» 절을 읽는다. **순수** — 절이 없으면 `planned: false`(추측 금지). */
export function tddPlanFromGoal(goal: string): TddPlan {
  const lines = goal.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => TDD_PLAN_HEADING.test(line.trim()));
  if (headingIndex >= 0) {
    const section: string[] = [];
    for (const line of lines.slice(headingIndex + 1)) {
      const text = line.trim();
      // ⛔ 다음 절 제목(`#`·`###` 도 절이다)에서 멈춘다 — requiredEvidenceFromGoal 과 같은 규율.
      if (/^#{1,6}\s/.test(text)) break;
      section.push(text);
    }
    const redStage = section.find((line) => TDD_RED_PLAN_PREFIX.test(line))
      ?.replace(TDD_RED_PLAN_PREFIX, '').trim() || undefined;
    const greenBody = section.find((line) => TDD_GREEN_PLAN_PREFIX.test(line))
      ?.replace(TDD_GREEN_PLAN_PREFIX, '').trim();
    const greenCommand = greenBody ? TDD_PLAN_INLINE.exec(greenBody)?.[0]?.trim() : undefined;
    return { planned: true, redStage, greenCommand: greenCommand || undefined };
  }
  // device-first 조각 계획의 한 줄 형식 — «검증 계획(TDD): … 피처 시험 bun test <경로> …».
  const inlineLine = lines.find((line) => /검증\s*계획\s*\(TDD\)\s*:\s*\S/u.test(line) && TDD_PLAN_INLINE.test(line));
  const greenCommand = inlineLine ? TDD_PLAN_INLINE.exec(inlineLine)?.[0]?.trim() : undefined;
  if (!greenCommand) return { planned: false, redStage: undefined, greenCommand: undefined };
  return { planned: true, redStage: undefined, greenCommand };
}

export interface TddEvidenceRecord {
  readonly tag: TddRecordTag;
  /** 자식이 남긴 `EVIDENCE: [tag] …` 한 건(태그를 떼지 않는다). */
  readonly claim: string;
  /** 재현 명령. 없으면 기록이 아니다(기존 파서 규율과 같다). */
  readonly verify: string | undefined;
  /** 바로 다음 `RESULT:` 줄 — RED 는 실패 기록, GREEN 은 통과 기록이어야 한다. */
  readonly result: string | undefined;
  readonly observed: boolean;
}

export interface TddEvidenceJudgment {
  readonly planned: boolean;
  readonly red: TddEvidenceRecord;
  readonly green: TddEvidenceRecord;
  /** RED·GREEN 이 **같은 증거 명령**인가 — «GREEN 뒤 같은 명령» 계약의 판정. */
  readonly sameCommand: boolean;
  /** 결손 태그(관측·수리 지시의 원천). */
  readonly missing: readonly TddRecordTag[];
  /** 계획이 있는데 결손이 있다 — 오케스트레이터가 수리 라운드를 돌린다. */
  readonly needsRepair: boolean;
}

/** 자식 기록 한 건의 태그를 뗀다 — coverRequiredEvidence 와 같은 문법. */
function tddClaimTag(claim: string): string | undefined {
  return claim.match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() || undefined;
}

/** 태그 하나에 대한 자식 기록을 판정한다. RED 는 실패 기록(`0 fail` 없음), GREEN 은 통과 기록이다. */
function tddRecordFromItems(items: readonly OffDiffEvidenceParse['items'][number][], tag: TddRecordTag): TddEvidenceRecord {
  const item = items.find((candidate) => tddClaimTag(candidate.claim) === tag);
  if (!item) return { tag, claim: '', verify: undefined, result: undefined, observed: false };
  const verify = item.verify.trim() || undefined;
  const result = item.result?.trim() || undefined;
  const resultPasses = result !== undefined && TDD_PASS_RESULT.test(result);
  const observed = tag === TDD_RED_TAG
    ? verify !== undefined && result !== undefined && !resultPasses
    : verify !== undefined && result !== undefined && resultPasses;
  return { tag, claim: item.claim, verify, result, observed };
}

/**
 * ★ TDD 를 로직으로 판정한다. **순수**.
 *
 * 판정은 셋이다: ① 골이 «검증 계획(TDD)» 을 계획했는가 ② 자식이 [tdd-red] RED 기록(구현 전 실패)을
 * 남겼는가 ③ [tdd-green] GREEN 기록(구현 뒤 **같은 명령** 통과)을 남겼는가. 셋째는 문면이 아니라
 * **명령 동등**으로 판정한다 — RED 의 명령과 GREEN 의 명령이 문자열로 같아야 한다.
 */
export function judgeTddEvidence(goal: string, evidence: OffDiffEvidenceParse): TddEvidenceJudgment {
  const plan = tddPlanFromGoal(goal);
  const red = tddRecordFromItems(evidence.items, TDD_RED_TAG);
  const green = tddRecordFromItems(evidence.items, TDD_GREEN_TAG);
  const sameCommand = red.verify !== undefined && red.verify === green.verify;
  const missing: TddRecordTag[] = [];
  if (!red.observed) missing.push(TDD_RED_TAG);
  if (!green.observed || (red.verify !== undefined && green.verify !== undefined && !sameCommand)) missing.push(TDD_GREEN_TAG);
  return {
    planned: plan.planned,
    red,
    green,
    sameCommand,
    missing,
    needsRepair: plan.planned && missing.length > 0,
  };
}

/** Tagged evidence와 별도로 수신할 수 있는 실제 child test 결과의 형식. */
export interface ObservedBunTestCommand {
  readonly command: string;
  /** 제한된 원문 판정 요약(도구 블록 안의 pass/fail 수). */
  readonly result: string;
  readonly passed: boolean;
  readonly source: 'child' | 'harness-base' | 'harness-head';
}

/** 도구 출력과 바로 붙은 Bun 시험 명령·결과만 받아 적는다. 산문·다른 도구 결과는 근거가 아니다. */
export function observedBunTestCommands(transcript: string): ObservedBunTestCommand[] {
  const harvested: ObservedBunTestCommand[] = [];
  const harvestedRecords = transcript.split(/\r?\n/);
  for (let i = 0; i < harvestedRecords.length; i += 1) {
    const output = harvestedRecords[i]?.match(/^\[(child|harness-base|harness-head)-test-output\] command=(.+)$/u);
    const command = output?.[2]?.trim();
    const result = harvestedRecords[i + 1]?.match(/^\[(?:child|harness-base|harness-head)-test-result\] (.+)$/u)?.[1]?.trim();
    if (command && result && /^bun\s+test(?:\s|$)/u.test(command)) {
      const counts = testCounts(result);
      if (counts) harvested.push({ command, result: `${counts.pass} pass · ${counts.fail} fail`, passed: counts.pass > 0 && counts.fail === 0,
        source: output?.[1] === 'harness-base' ? 'harness-base' : output?.[1] === 'harness-head' ? 'harness-head' : 'child' });
    }
  }
  const normalized = transcript
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"');
  const blocks = normalized.split(/(?=⏺\s+Bash\()/u);
  for (const block of blocks) {
    const command = block.match(/⏺\s+Bash\(\s*\{\s*"command"\s*:\s*"([^"\n]+)"/u)?.[1]?.trim();
    if (!command || !/^bun\s+test(?:\s|$)/u.test(command)) continue;
    const resultStart = block.indexOf('↳');
    if (resultStart < 0) continue;
    const nextToolStart = block.indexOf('\n⏺ ', resultStart);
    const result = block.slice(resultStart, nextToolStart < 0 ? undefined : nextToolStart);
    const counts = testCounts(result);
    if (counts) {
      harvested.push({ command, result: `${counts.pass} pass · ${counts.fail} fail`, passed: counts.pass > 0 && counts.fail === 0, source: 'child' });
    }
  }
  return harvested;
}

function testCounts(result: string): { pass: number; fail: number } | undefined {
  const pass = result.match(/\b(\d+)\s+pass\b/iu)?.[1];
  const fail = result.match(/\b(\d+)\s+fail\b/iu)?.[1];
  return pass !== undefined && fail !== undefined ? { pass: Number(pass), fail: Number(fail) } : undefined;
}

export interface TddBaseHeadTestResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly command: string;
  readonly baseResult?: string;
  readonly headResult?: string;
  readonly transcript?: string;
}

/** Accepts RED only when the exact changed test fails on base and passes on the implemented head. */
export function assessTddBaseHeadTest(input: {
  readonly command: string;
  readonly baseExitCode: number;
  readonly baseOutput: string;
  readonly headExitCode: number;
  readonly headOutput: string;
}): TddBaseHeadTestResult {
  const base = testCounts(input.baseOutput);
  if (input.baseExitCode === 0 || !base || base.fail === 0) {
    return { accepted: false, reason: 'base-test-did-not-prove-red', command: input.command,
      ...(base ? { baseResult: `${base.pass} pass · ${base.fail} fail` } : {}) };
  }
  const head = testCounts(input.headOutput);
  if (input.headExitCode !== 0 || !head || head.pass === 0 || head.fail !== 0) {
    return { accepted: false, reason: 'head-test-did-not-pass', command: input.command,
      baseResult: `${base.pass} pass · ${base.fail} fail`, ...(head ? { headResult: `${head.pass} pass · ${head.fail} fail` } : {}) };
  }
  const baseResult = `${base.pass} pass · ${base.fail} fail`;
  const headResult = `${head.pass} pass · ${head.fail} fail`;
  return {
    accepted: true, reason: 'base-red-head-green', command: input.command, baseResult, headResult,
    transcript: [
      `[harness-base-test-output] command=${input.command}`,
      `[harness-base-test-result] ${baseResult}`,
      `[harness-head-test-output] command=${input.command}`,
      `[harness-head-test-result] ${headResult}`,
    ].join('\n'),
  };
}

const TDD_TEST_PATH = /(?:^|\/)\S+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TDD_BASE_TEST_TIMEOUT_MS = 180_000;

/** Runs the goal's planned Bun test twice: overlay the changed test on its exact base, then run on head. */
export function runTddBaseHeadTest(input: { readonly cwd: string; readonly baseSha: string; readonly goal: string }): TddBaseHeadTestResult {
  const command = tddPlanFromGoal(input.goal).greenCommand;
  if (!command) return { accepted: false, reason: 'planned-test-command-missing', command: '' };
  const safe = parseSafeDecisionSignalCommand(command);
  if (!safe || 'reason' in safe || safe.executable !== 'bun' || safe.args[0] !== 'test') {
    return { accepted: false, reason: 'planned-command-not-safe-bun-test', command };
  }
  const targetArgs = safe.args.slice(1).filter((arg) => !arg.startsWith('-') && arg !== '--');
  if (!targetArgs.length || targetArgs.some((arg) => arg === '.' || arg === './')) {
    return { accepted: false, reason: 'planned-command-not-targeted', command };
  }
  const diff = runGitCommand(input.cwd, ['diff', '--name-only', '-z', input.baseSha, '--'], { encoding: 'utf8', timeout: 20_000 });
  const untracked = runGitCommand(input.cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 20_000 });
  if (diff.status !== 0 || untracked.status !== 0) return { accepted: false, reason: 'changed-test-files-unmeasured', command };
  const changedPaths = [...new Set([...(diff.stdout ?? '').split('\0'), ...(untracked.stdout ?? '').split('\0')].filter(Boolean))];
  const targetTests = changedPaths.filter((path) => TDD_TEST_PATH.test(path) && targetArgs.some((arg) => {
    const normalized = arg.replace(/^\.\//u, '');
    return path === normalized || path.startsWith(`${normalized.replace(/\/$/u, '')}/`);
  }));
  if (!targetTests.length) return { accepted: false, reason: 'no-changed-test-file-matches-planned-command', command };
  const root = resolve(input.cwd);
  for (const path of targetTests) {
    const source = resolve(root, path);
    if (!source.startsWith(`${root}${sep}`) || !existsSync(source) || !lstatSync(source).isFile()) {
      return { accepted: false, reason: 'changed-test-file-unavailable', command };
    }
  }
  for (const path of ['bun.lock', 'package.json']) {
    const baseFile = runGitCommand(input.cwd, ['show', `${input.baseSha}:${path}`], { encoding: 'utf8', timeout: 20_000 });
    const headFile = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined;
    if (baseFile.status !== 0 || headFile === undefined || baseFile.stdout !== headFile) {
      return { accepted: false, reason: `dependency-input-changed:${path}`, command };
    }
  }
  const baselineDir = mkdtempSync(join(tmpdir(), 'elanous-tdd-base-'));
  let attached = false;
  try {
    const add = runGitCommand(input.cwd, ['worktree', 'add', '--detach', baselineDir, input.baseSha], { encoding: 'utf8', timeout: 60_000 });
    if (add.status !== 0) return { accepted: false, reason: 'base-worktree-unavailable', command };
    attached = true;
    linkWorktreeDependencies(input.cwd, baselineDir, ['node_modules']);
    if (!existsSync(join(baselineDir, 'node_modules'))) return { accepted: false, reason: 'base-dependencies-unavailable', command };
    for (const path of targetTests) {
      const target = resolve(baselineDir, path);
      if (!target.startsWith(`${resolve(baselineDir)}${sep}`)) return { accepted: false, reason: 'changed-test-path-unsafe', command };
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, path), target);
    }
    const run = (cwd: string) => {
      const result = spawnSync(safe.executable, [...safe.args], {
        cwd, encoding: 'utf8', timeout: TDD_BASE_TEST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      });
      if (result.error || result.status === null) return { status: 1, output: '' };
      return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
    };
    const baseRun = run(baselineDir);
    const baseCounts = testCounts(baseRun.output);
    if (baseRun.status === 0 || !baseCounts || baseCounts.fail === 0) {
      return { accepted: false, reason: 'base-test-did-not-prove-red', command,
        ...(baseCounts ? { baseResult: `${baseCounts.pass} pass · ${baseCounts.fail} fail` } : {}) };
    }
    const headRun = run(root);
    return assessTddBaseHeadTest({ command, baseExitCode: baseRun.status, baseOutput: baseRun.output,
      headExitCode: headRun.status, headOutput: headRun.output });
  } catch (error) {
    return { accepted: false, reason: `base-test-unmeasured:${error instanceof Error ? error.message : String(error)}`,
      command };
  } finally {
    if (attached) runGitCommand(input.cwd, ['worktree', 'remove', '--force', baselineDir], { encoding: 'utf8', timeout: 60_000 });
    rmSync(baselineDir, { recursive: true, force: true });
  }
}

function normalizeTddTestCommand(command: string): string {
  return command.trim().replace(/\\"/g, '"').replace(/["']/g, '').replace(/\s+/g, ' ')
    .replace(/\bbun\s+test\s+--\s+/u, 'bun test ');
}

/** 실제 같은 시험의 fail→pass 도구 출력을 RED 원장 기록으로 수확한다. 산문 요약은 받지 않는다. */
export function receiveObservedTddRed(input: {
  readonly goal: string;
  readonly judgment: TddEvidenceJudgment;
  readonly transcript: string;
  readonly resultParsed: boolean;
}): { readonly transcript: string; readonly accepted: boolean; readonly reason: string; readonly command?: string; readonly result?: string; readonly source?: ObservedBunTestCommand['source'] } {
  const { judgment } = input;
  if (!input.resultParsed) return { transcript: input.transcript, accepted: false, reason: 'child-result-unparsed' };
  if (!judgment.planned) return { transcript: input.transcript, accepted: false, reason: 'tdd-plan-missing' };
  if (judgment.red.observed) return { transcript: input.transcript, accepted: false, reason: 'red-already-recorded' };
  const planned = tddPlanFromGoal(input.goal).greenCommand;
  if (!planned) return { transcript: input.transcript, accepted: false, reason: 'planned-test-command-missing' };
  const expected = normalizeTddTestCommand(planned);
  const observed = observedBunTestCommands(input.transcript)
    .filter(({ command }) => normalizeTddTestCommand(command) === expected);
  const failedIndex = observed.findIndex(({ passed }) => !passed);
  if (failedIndex < 0) return { transcript: input.transcript, accepted: false, reason: 'no-matching-failing-test-output' };
  // RED is only accepted as the earlier half of a same-command fail→pass sequence.
  const passedAfter = observed.slice(failedIndex + 1).find(({ passed }) => passed);
  if (!passedAfter) return { transcript: input.transcript, accepted: false, reason: 'no-later-matching-passing-test-output' };
  const matching = observed[failedIndex]!;
  const claim = matching.source === 'harness-base' ? 'planned test failed on base before implementation' : 'observed planned test failure before later pass';
  const record = `EVIDENCE: [tdd-red] ${claim} || ${planned}\nRESULT: ${matching.result}`;
  return { transcript: `${input.transcript.trimEnd()}\n${record}`, accepted: true,
    reason: 'matching-test-failure-recorded', command: matching.command, result: matching.result, source: matching.source };
}

/** 실제 자식 도구 결과를 계획된 동일 TDD 명령과 대조해 green 원장 레코드로 수신한다. */
export function receiveObservedTddGreen(input: {
  readonly goal: string;
  readonly judgment: TddEvidenceJudgment;
  readonly transcript: string;
  readonly resultParsed: boolean;
}): { readonly transcript: string; readonly accepted: boolean; readonly reason: string; readonly command?: string; readonly result?: string; readonly source?: ObservedBunTestCommand['source'] } {
  const { judgment } = input;
  if (!input.resultParsed) return { transcript: input.transcript, accepted: false, reason: 'child-result-unparsed' };
  if (!judgment.planned || !judgment.red.observed || !judgment.red.verify) {
    return { transcript: input.transcript, accepted: false, reason: 'red-or-plan-missing' };
  }
  if (judgment.green.observed && judgment.sameCommand) {
    return { transcript: input.transcript, accepted: false, reason: 'green-already-recorded' };
  }
  const expected = normalizeTddTestCommand(judgment.red.verify);
  const planned = tddPlanFromGoal(input.goal).greenCommand;
  const observed = observedBunTestCommands(input.transcript);
  const matching = observed.filter(({ command }) => normalizeTddTestCommand(command) === expected
    && (!planned || normalizeTddTestCommand(command) === normalizeTddTestCommand(planned))).at(-1);
  if (!matching || !matching.passed) return {
    transcript: input.transcript, accepted: false,
    reason: matching ? 'latest-matching-test-failed' : observed.length ? 'passing-test-command-mismatch' : 'no-adjacent-passing-bun-test',
    ...(observed[observed.length - 1] ? { command: observed[observed.length - 1]?.command, result: observed[observed.length - 1]?.result } : {}),
  };
  const claim = matching.source === 'harness-head' ? 'planned test passed on implemented head' : 'observed planned test passed';
  const record = `EVIDENCE: [tdd-green] ${claim} || ${judgment.red.verify}\nRESULT: ${matching.result}`;
  return { transcript: `${input.transcript.trimEnd()}\n${record}`, accepted: true, reason: 'matching-test-output-recorded',
    command: matching.command, result: matching.result, source: matching.source };
}
