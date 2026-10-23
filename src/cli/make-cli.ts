import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { judge } from '../llm/judge-layer.js';
import { runPluginMake } from './plugin-cli.js';
import { workflowRun } from './workflow.js';

export type MakeKind = 'plugin' | 'workflow';

/** A cell the route ruled out, together with the evidence that ruled it out. */
export type MakeExclusion = { kind: MakeKind; reason: string };

/** A classify-judge answer. It only counts when the judge supplied BOTH
 *  rationales: a bare `{"kind":"workflow"}` carries no reason and no exclusion
 *  ground, so the route treats it as an unanswered (unmeasured) request. */
export type MakeJudgeVerdict = { kind: MakeKind; reason: string; excluded: string };

/** What the production `cli.make/route` path judged for one natural-language request. */
export type MakeRouteEvidence = {
  request: string;
  /** Selected cell, or null when the request carries no usable evidence. */
  kind: MakeKind | null;
  /** Which arm produced `kind`. */
  decidedBy: 'request-evidence' | 'classify-judge' | 'none';
  /** false means "unmeasured": no rationale existed for any cell. */
  measured: boolean;
  /** Why the selected cell won. Never empty; a judge row quotes the judge's own reason verbatim. */
  reason: string;
  /** Phrases from the request that support the selected cell. A judge-decided row
   *  carries a `judge:<kind>` marker instead: the request had no phrases to cite. */
  signals: string[];
  /** Every cell that was not selected, with the reason it was excluded. */
  excluded: MakeExclusion[];
};

type JudgeCall = (args: { prompt: string; provider: string; model: string }) => Promise<{ text: string }>;

type MakeDeps = {
  /** Test-only classify transport: only ever throws, so it can never deliver an answer. */
  judgeCall?: JudgeCall;
  pluginMake?: (request: string) => Promise<void>;
  workflowMake?: (request: string) => Promise<number>;
};

const CELL_LABEL: Record<MakeKind, string> = { plugin: '플러그인', workflow: '워크플로' };

const OTHER_CELL: Record<MakeKind, MakeKind> = { plugin: 'workflow', workflow: 'plugin' };

/** A request that names a cell explicitly outranks every softer signal. */
const NAMED_CELL_WORDS: Record<MakeKind, readonly string[]> = {
  plugin: ['플러그인', 'plugin'],
  workflow: ['워크플로', 'workflow'],
};

/** Signal words that must not fire when every occurrence lives inside a longer
 *  compound: `메일` inside `이메일` is an email-domain word, not a mailing task,
 *  so '이메일 파싱 API' must not reach the workflow cell through it. */
const COMPOUND_GUARDS: ReadonlyArray<{ word: string; inside: string }> = [
  { word: '메일', inside: '이메일' },
  { word: '로드', inside: '업로드' },
];

/** Request phrases that point at each cell. Workflow is the upper cell: a workflow
 *  may use a connector, so its signals win over connector signals.
 *
 *  판정 기준(위에서 아래로):
 *  1. 이름 지목 — '플러그인/plugin', '워크플로/workflow' 가 직접 나오면 그 칸.
 *  2. 합성어 가드 — 신호 단어가 더 긴 합성어 안에만 있으면(예: '메일' ⊂ '이메일')
 *     그 단어는 신호로 치지 않는다. '이메일 파싱 API' 는 이메일 도메인 처리
 *     요청이지 메일 발송 워크플로가 아니다.
 *  3. 가드를 통과한 신호가 한쪽에만 있으면 그 칸을 채택한다.
 *  4. 양쪽에 신호가 남아 있으면(충돌) 상위 칸 워크플로가 하위 칸 플러그인을
 *     흡수한다 — 워크플로는 커넥터를 부품으로 쓸 수 있지만 그 반대는 안 된다. */
const CELL_WORDS: Record<MakeKind, readonly string[]> = {
  plugin: [
    '읽', '파싱', 'parse', '불러', 'load', '로드', '열어', '변환', 'convert', '추출', 'extract',
    '연동', '연결', '커넥터', 'connector', '스킬', 'skill', '도구', 'tool', 'api', '조회',
    'ocr', 'hwp', 'pdf', 'xlsx', 'docx', 'csv', 'json', '이미지', '사진', '엑셀', '워드',
    '번역', 'translate', '검색', 'search',
  ],
  workflow: [
    '매일', '매주', '매월', '매년', '매시간', '매번', '정기', '주기적', '스케줄', 'schedule',
    'cron', '크론', '반복', 'daily', 'weekly', 'hourly', 'every ',
    '올려', '올리', '게시', '발행', '포스팅', '업로드', 'upload', '배포', 'deploy', 'publish',
    '보내', '전송', 'send', '알림', 'notify', '메일',
    '하고 나서', '그다음', '순서대로', '단계별', '파이프라인', 'pipeline', '자동화', 'automation',
    '자동으로', '일괄', 'batch', '모아', '수집해서', '시리즈',
  ],
};

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function matchWords(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const word of words) {
    if (!text.includes(word)) continue;
    const guarded = COMPOUND_GUARDS.some(
      g => g.word === word && countOccurrences(text, g.inside) >= countOccurrences(text, word),
    );
    if (!guarded) hits.push(word);
  }
  return hits;
}

/** Deterministic judgement over the request text: picks a cell and says why it won
 *  and why the sibling cell lost. Runs before any model call, so the route always
 *  has a rationale to report. */
function evidenceFromRequest(request: string): MakeRouteEvidence {
  const text = request.toLowerCase();
  const pluginWords = matchWords(text, CELL_WORDS.plugin);
  const workflowWords = matchWords(text, CELL_WORDS.workflow);
  const namedPlugin = matchWords(text, NAMED_CELL_WORDS.plugin);
  const namedWorkflow = matchWords(text, NAMED_CELL_WORDS.workflow);
  const named: MakeKind | null = namedPlugin.length && !namedWorkflow.length
    ? 'plugin'
    : namedWorkflow.length && !namedPlugin.length ? 'workflow' : null;

  let kind: MakeKind | null = null;
  let reason: string;
  let signals: string[] = [];

  if (named) {
    kind = named;
    signals = named === 'plugin' ? namedPlugin : namedWorkflow;
    reason = `요청이 ${CELL_LABEL[named]} 칸을 이름으로 지목(${signals.join(', ')}) — 명시 지목이 최상위 근거`;
  } else if (workflowWords.length) {
    kind = 'workflow';
    signals = workflowWords;
    reason = `반복·게시·시퀀스 신호(${workflowWords.join(', ')}) — 상위 칸 워크플로 채택`;
  } else if (pluginWords.length) {
    kind = 'plugin';
    signals = pluginWords;
    reason = `커넥터·역량·형식 신호(${pluginWords.join(', ')}) — 하위 칸 플러그인 채택`;
  } else {
    reason = '필수 근거 없음 — 요청에서 플러그인·워크플로 신호를 찾지 못했다';
  }

  const excluded: MakeExclusion[] = [];
  if (kind === 'workflow') {
    excluded.push({
      kind: 'plugin',
      reason: [
        named === 'workflow'
          ? `요청이 워크플로를 이름으로 지목(${namedWorkflow.join(', ')})`
          : `반복·게시·시퀀스 신호(${workflowWords.join(', ')})`,
        pluginWords.length
          ? `플러그인 신호(${pluginWords.join(', ')})는 커넥터 단품이라 상위 칸에 흡수`
          : '플러그인 신호 0건',
      ].join(' · '),
    });
  } else if (kind === 'plugin') {
    excluded.push({
      kind: 'workflow',
      reason: [
        named === 'plugin'
          ? `요청이 플러그인을 이름으로 지목(${namedPlugin.join(', ')})`
          : `커넥터·역량 신호(${pluginWords.join(', ')})`,
        workflowWords.length
          ? `워크플로 신호(${workflowWords.join(', ')})가 있으나 단품 칸이 채택`
          : '워크플로 신호 0건',
      ].join(' · '),
    });
  } else {
    excluded.push(
      { kind: 'plugin', reason: '플러그인 신호 0건 — 필수 근거 없음' },
      { kind: 'workflow', reason: '워크플로 신호 0건 — 필수 근거 없음' },
    );
  }

  return {
    request,
    kind,
    decidedBy: kind ? 'request-evidence' : 'none',
    measured: kind !== null,
    reason,
    signals,
    excluded,
  };
}

export async function classifyMakeRequest(request: string, call?: JudgeCall): Promise<MakeJudgeVerdict | null> {
  if (!request.trim()) return null;
  const result = await judge<MakeJudgeVerdict>({
    site: 'cli.make',
    ...(call ? { call } : {}),
    prompt: `Classify this request for an Elanous creator. Choose "plugin" for a reusable connector, integration, skill, or capability (including reading a file format). Choose "workflow" for a sequence of jobs, recurring schedule, automation, or publishing task, even when it uses a connector. Respond with JSON only, exactly {"kind":"plugin"|"workflow","reason":"<한 문장: 이 칸을 고른 근거>","excluded":"<한 문장: 다른 칸을 뺀 근거>"}. Return {"kind":"unclear"} when you cannot decide. An answer missing either rationale field is rejected as unmeasured. Do not execute the request.\nRequest: ${JSON.stringify(request)}`,
    schema: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const kind = (value as { kind?: unknown }).kind;
      if (kind !== 'plugin' && kind !== 'workflow') return null;
      const reason = (value as { reason?: unknown }).reason;
      const excluded = (value as { excluded?: unknown }).excluded;
      if (typeof reason !== 'string' || !reason.trim()) return null;
      if (typeof excluded !== 'string' || !excluded.trim()) return null;
      return { kind, reason: reason.trim(), excluded: excluded.trim() };
    },
  });
  return result.ok ? result.value : null;
}

/** Production judgement path for `elanous make`: request evidence first, the
 *  classify judge only when the request carries no evidence at all. A judge
 *  answer without both rationales is reported as unmeasured, never as success;
 *  `skipJudge` leaves the judge uncalled so --route-only dumps stay
 *  deterministic (no model call, no dispatch). */
export async function routeMakeRequest(
  request: string,
  opts: { call?: JudgeCall; skipJudge?: boolean } = {},
): Promise<MakeRouteEvidence> {
  const evidence = evidenceFromRequest(request);
  if (evidence.measured) return evidence;

  let verdict: MakeJudgeVerdict | null = null;
  let note: string;
  if (opts.skipJudge) {
    note = '판정기 호출 생략(증거 전용 경로)';
  } else {
    try {
      verdict = await classifyMakeRequest(request, opts.call);
      note = verdict
        ? `classify judge 가 ${CELL_LABEL[verdict.kind]} 를 근거와 함께 반환`
        : 'classify judge 가 근거 있는 판정을 반환하지 않음';
    } catch (err) {
      note = `classify judge 호출 실패(${err instanceof Error ? err.message : String(err)})`;
    }
  }

  if (!verdict) {
    return { ...evidence, decidedBy: 'none', measured: false, reason: `${evidence.reason} · ${note}` };
  }
  const other = OTHER_CELL[verdict.kind];
  return {
    request,
    kind: verdict.kind,
    decidedBy: 'classify-judge',
    measured: true,
    reason: `요청 근거 없음(플러그인·워크플로 신호 0건) → ${note} — ${CELL_LABEL[verdict.kind]} 칸 채택 · 판정기 근거: ${verdict.reason}`,
    signals: [`judge:${verdict.kind}`],
    excluded: [{ kind: other, reason: `요청 근거 없음 · 판정기 배제 근거: ${verdict.excluded}` }],
  };
}

export function registerMakeCommand(program: Command, deps: MakeDeps = {}): void {
  program.command('make <request>')
    .description('Classify a one-line request and make a plugin or build a workflow')
    .option('--route-only', 'print the cli.make/route evidence JSON and exit — no judge call, no plugin or workflow dispatch')
    .action(async (request: string, opts: { routeOnly?: boolean }) => {
      const evidence = await routeMakeRequest(request, {
        ...(deps.judgeCall ? { call: deps.judgeCall } : {}),
        ...(opts.routeOnly ? { skipJudge: true } : {}),
      });
      debug.log('cli.make', 'route', evidence);
      if (!evidence.measured) {
        debug.log('cli.make', 'route-unmeasured', {
          request: evidence.request,
          reason: evidence.reason,
          excluded: evidence.excluded,
        });
      }
      if (opts.routeOnly) {
        console.log(JSON.stringify(evidence));
        return;
      }
      if (!evidence.kind) {
        console.log('플러그인(커넥터·스킬)을 만들까요, 워크플로(잡)를 만들까요?');
        process.exitCode = 1;
        return;
      }
      if (evidence.kind === 'plugin') await (deps.pluginMake ?? runPluginMake)(request);
      else process.exitCode = await (deps.workflowMake ?? ((text: string) => workflowRun('build-workflow', text)))(request);
    });
}
