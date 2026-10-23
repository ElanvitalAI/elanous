import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { registerMakeCommand, routeMakeRequest, type MakeKind, type MakeRouteEvidence } from './make-cli.js';

const QUESTION = '플러그인(커넥터·스킬)을 만들까요, 워크플로(잡)를 만들까요?';

/** One row of the independent expectation matrix: written from the request text
 *  and the cell definitions, never from the route's own output. Both token lists
 *  are per-row, so a constant reason or a constant exclusion reason written into
 *  the code cannot satisfy them across rows. */
type MatrixRow = {
  id: number;
  request: string;
  kind: MakeKind | null;
  signals: string[];
  reasonIncludes: string[];
  excludedReasonIncludes: string[];
  excludedReasonExcludes?: string[];
};

const MATRIX: MatrixRow[] = [
  { id: 1, request: '노션에 매일 아침 요약 올려 줘', kind: 'workflow', signals: ['매일', '올려'], reasonIncludes: ['매일', '올려', '워크플로'], excludedReasonIncludes: ['매일', '올려', '플러그인 신호 0건'] },
  { id: 2, request: '매주 금요일 주간 리포트 메일 보내기', kind: 'workflow', signals: ['매주', '메일', '보내'], reasonIncludes: ['매주', '메일', '보내', '워크플로'], excludedReasonIncludes: ['매주', '메일', '보내', '플러그인 신호 0건'] },
  { id: 3, request: '블로그에 새 글 발행 자동화', kind: 'workflow', signals: ['발행', '자동화'], reasonIncludes: ['발행', '자동화', '워크플로'], excludedReasonIncludes: ['발행', '자동화', '플러그인 신호 0건'] },
  { id: 4, request: '매시간 환율 수집해서 슬랙 알림', kind: 'workflow', signals: ['매시간', '수집해서', '알림'], reasonIncludes: ['매시간', '수집해서', '알림', '워크플로'], excludedReasonIncludes: ['매시간', '수집해서', '알림', '플러그인 신호 0건'] },
  { id: 5, request: '유튜브 스크립트 초안 쓰고 그다음 음성 합성', kind: 'workflow', signals: ['그다음'], reasonIncludes: ['그다음', '워크플로'], excludedReasonIncludes: ['그다음', '플러그인 신호 0건'] },
  { id: 6, request: '매월 정산 리포트 만들어서 구글 시트에 올리기', kind: 'workflow', signals: ['매월', '올리'], reasonIncludes: ['매월', '올리', '워크플로'], excludedReasonIncludes: ['매월', '올리', '플러그인 신호 0건'] },
  { id: 7, request: 'cron 으로 새벽 3시 백업 돌리기', kind: 'workflow', signals: ['cron'], reasonIncludes: ['cron', '워크플로'], excludedReasonIncludes: ['cron', '플러그인 신호 0건'] },
  { id: 8, request: '이미지 생성하고 업로드까지 한 번에', kind: 'workflow', signals: ['업로드'], reasonIncludes: ['업로드', '워크플로'], excludedReasonIncludes: ['업로드', '이미지', '흡수'], excludedReasonExcludes: ['플러그인 신호(로드'] },
  { id: 9, request: '데일리 뉴스 브리핑 정기 발송', kind: 'workflow', signals: ['정기'], reasonIncludes: ['정기', '워크플로'], excludedReasonIncludes: ['정기', '플러그인 신호 0건'] },
  { id: 10, request: '발행 파이프라인 구축', kind: 'workflow', signals: ['발행', '파이프라인'], reasonIncludes: ['발행', '파이프라인', '워크플로'], excludedReasonIncludes: ['발행', '파이프라인', '플러그인 신호 0건'] },
  { id: 11, request: '여러 개 영상 일괄 배포', kind: 'workflow', signals: ['일괄', '배포'], reasonIncludes: ['일괄', '배포', '워크플로'], excludedReasonIncludes: ['일괄', '배포', '플러그인 신호 0건'] },
  { id: 12, request: '주기적으로 사이트 상태 점검 알림', kind: 'workflow', signals: ['주기적', '알림'], reasonIncludes: ['주기적', '알림', '워크플로'], excludedReasonIncludes: ['주기적', '알림', '플러그인 신호 0건'] },
  { id: 13, request: '매일 아침 캘린더 보고 메시지 전송', kind: 'workflow', signals: ['매일', '전송'], reasonIncludes: ['매일', '전송', '워크플로'], excludedReasonIncludes: ['매일', '전송', '플러그인 신호 0건'] },
  { id: 14, request: '한글 파일 모아서 압축 배포', kind: 'workflow', signals: ['모아', '배포'], reasonIncludes: ['모아', '배포', '워크플로'], excludedReasonIncludes: ['모아', '배포', '플러그인 신호 0건'] },
  { id: 15, request: '시리즈 콘텐츠 스케줄 관리', kind: 'workflow', signals: ['시리즈', '스케줄'], reasonIncludes: ['시리즈', '스케줄', '워크플로'], excludedReasonIncludes: ['시리즈', '스케줄', '플러그인 신호 0건'] },
  { id: 16, request: '매번 같은 형식으로 문서 발행', kind: 'workflow', signals: ['매번', '발행'], reasonIncludes: ['매번', '발행', '워크플로'], excludedReasonIncludes: ['매번', '발행', '플러그인 신호 0건'] },
  { id: 17, request: 'hwp 읽는 기능', kind: 'plugin', signals: ['읽', 'hwp'], reasonIncludes: ['읽', 'hwp', '플러그인'], excludedReasonIncludes: ['읽', 'hwp', '워크플로 신호 0건'] },
  { id: 18, request: 'PDF 파싱하는 플러그인', kind: 'plugin', signals: ['플러그인'], reasonIncludes: ['이름으로 지목', '플러그인'], excludedReasonIncludes: ['이름으로 지목', '워크플로 신호 0건'] },
  { id: 19, request: '엑셀 파일 불러와서 표로 보여 주기', kind: 'plugin', signals: ['엑셀', '불러'], reasonIncludes: ['엑셀', '불러', '플러그인'], excludedReasonIncludes: ['엑셀', '불러', '워크플로 신호 0건'] },
  { id: 20, request: '노션 연동 커넥터', kind: 'plugin', signals: ['연동', '커넥터'], reasonIncludes: ['연동', '커넥터', '플러그인'], excludedReasonIncludes: ['연동', '커넥터', '워크플로 신호 0건'] },
  { id: 21, request: '이미지에서 글자 추출 OCR', kind: 'plugin', signals: ['이미지', '추출'], reasonIncludes: ['이미지', '추출', '플러그인'], excludedReasonIncludes: ['이미지', '추출', '워크플로 신호 0건'] },
  { id: 22, request: '번역해 주는 도구', kind: 'plugin', signals: ['번역', '도구'], reasonIncludes: ['번역', '도구', '플러그인'], excludedReasonIncludes: ['번역', '도구', '워크플로 신호 0건'] },
  { id: 23, request: 'CSV 변환 스킬', kind: 'plugin', signals: ['csv', '변환', '스킬'], reasonIncludes: ['csv', '변환', '스킬', '플러그인'], excludedReasonIncludes: ['변환', '스킬', '워크플로 신호 0건'] },
  { id: 24, request: '구글 드라이브 연결', kind: 'plugin', signals: ['연결'], reasonIncludes: ['연결', '플러그인'], excludedReasonIncludes: ['연결', '워크플로 신호 0건'] },
  { id: 25, request: '사진 태그 읽기 api', kind: 'plugin', signals: ['사진', '읽'], reasonIncludes: ['사진', '읽', 'api', '플러그인'], excludedReasonIncludes: ['사진', '읽', 'api', '워크플로 신호 0건'] },
  { id: 26, request: '워드 문서에서 표 추출', kind: 'plugin', signals: ['워드', '추출'], reasonIncludes: ['워드', '추출', '플러그인'], excludedReasonIncludes: ['워드', '추출', '워크플로 신호 0건'] },
  { id: 27, request: '검색 기능 연결', kind: 'plugin', signals: ['검색', '연결'], reasonIncludes: ['검색', '연결', '플러그인'], excludedReasonIncludes: ['검색', '연결', '워크플로 신호 0건'] },
  { id: 28, request: 'json 을 표로 변환', kind: 'plugin', signals: ['json', '변환'], reasonIncludes: ['json', '변환', '플러그인'], excludedReasonIncludes: ['json', '변환', '워크플로 신호 0건'] },
  { id: 29, request: '무언가 해 줘', kind: null, signals: [], reasonIncludes: ['필수 근거 없음'], excludedReasonIncludes: ['0건', '필수 근거 없음'] },
  { id: 30, request: '이 일 좀 처리해 줘, 워크플로 쪽으로', kind: 'workflow', signals: ['워크플로'], reasonIncludes: ['이름으로 지목', '워크플로'], excludedReasonIncludes: ['이름으로 지목', '플러그인 신호 0건'] },
];

/** Conflict and misclassification rows for the two judgement rules the route
 *  changed: the compound guard ('메일' ⊂ '이메일' must not steer '이메일 파싱 API'
 *  into the workflow cell) and the upper-cell absorption (a genuine both-sides
 *  request goes to the workflow cell with the plugin signals cited as absorbed). */
const CONFLICT_MATRIX: MatrixRow[] = [
  { id: 31, request: '이메일 파싱 API', kind: 'plugin', signals: ['파싱', 'api'], reasonIncludes: ['파싱', 'api', '플러그인'], excludedReasonIncludes: ['파싱', 'api', '워크플로 신호 0건'] },
  { id: 32, request: '이메일 주소에서 도메인 추출', kind: 'plugin', signals: ['추출'], reasonIncludes: ['추출', '플러그인'], excludedReasonIncludes: ['추출', '워크플로 신호 0건'] },
  { id: 33, request: '이메일로 초대장 보내기', kind: 'workflow', signals: ['보내'], reasonIncludes: ['보내', '워크플로'], excludedReasonIncludes: ['보내', '플러그인 신호 0건'] },
  { id: 34, request: '매일 PDF 읽어서 노션에 올려 줘', kind: 'workflow', signals: ['매일', '올려'], reasonIncludes: ['매일', '올려', '워크플로'], excludedReasonIncludes: ['매일', '올려', 'pdf', '읽', '흡수'] },
  { id: 35, request: '번역 결과를 매시간 트위터에 게시', kind: 'workflow', signals: ['매시간', '게시'], reasonIncludes: ['매시간', '게시', '워크플로'], excludedReasonIncludes: ['매시간', '게시', '번역', '흡수'] },
  { id: 36, request: '이메일 파싱한 결과 매일 올려 줘', kind: 'workflow', signals: ['매일', '올려'], reasonIncludes: ['매일', '올려', '워크플로'], excludedReasonIncludes: ['매일', '올려', '파싱', '흡수'] },
];

type RunTranscript = {
  calls: Array<{ kind: string; request: string }>;
  lines: string[];
  exitCode: number;
  evidence: MakeRouteEvidence;
  judgeCalls: number;
};

/** Drive the production `elanous make <request>` command. Only the two execution
 *  targets are spied; the judge transport only ever throws (no answer is ever
 *  delivered), so every verdict must come from the production route itself. */
async function run(request: string): Promise<RunTranscript> {
  const calls: Array<{ kind: string; request: string }> = [];
  const lines: string[] = [];
  const sinks = debug.status();
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  let judgeCalls = 0;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  debug.setFileEnabled(false);
  debug.setDiagEnabled(true);
  debug.clear();
  try {
    const program = new Command();
    registerMakeCommand(program, {
      judgeCall: async () => {
        judgeCalls += 1;
        throw new Error('no classifier provider in this run');
      },
      pluginMake: async text => { calls.push({ kind: 'plugin', request: text }); },
      workflowMake: async text => { calls.push({ kind: 'workflow', request: text }); return 0; },
    });
    await program.parseAsync(['node', 'elanous', 'make', request]);
    const route = debug.events(64).filter(ev => ev.category === 'cli.make' && ev.event === 'route').at(-1);
    if (!route) throw new Error('cli.make/route debug event missing');
    return { calls, lines, exitCode: process.exitCode, evidence: route.data as MakeRouteEvidence, judgeCalls };
  } finally {
    console.log = oldLog;
    process.exitCode = oldExitCode ?? 0;
    debug.clear();
    debug.setFileEnabled(sinks.file);
    debug.setDiagEnabled(sinks.diag);
  }
}

/** Compare one route evidence against the independently authored row. Returns the
 *  mismatch list; an empty list means the production judgement matched. */
function problemsAgainst(row: MatrixRow, ev: MakeRouteEvidence): string[] {
  const problems: string[] = [];
  if (ev.kind !== row.kind) problems.push(`kind ${String(ev.kind)} ≠ expected ${String(row.kind)}`);
  const expectedDecidedBy = row.kind ? 'request-evidence' : 'none';
  if (ev.decidedBy !== expectedDecidedBy) problems.push(`decidedBy ${ev.decidedBy} ≠ ${expectedDecidedBy}`);
  if (ev.measured !== (row.kind !== null)) problems.push(`measured ${ev.measured} ≠ ${row.kind !== null}`);
  if (!ev.reason.trim()) problems.push('판정 이유가 비어 있다');
  for (const token of row.reasonIncludes) {
    if (!ev.reason.includes(token)) problems.push(`판정 이유에 '${token}' 가 없다`);
  }
  for (const signal of row.signals) {
    if (!ev.signals.includes(signal)) problems.push(`signals 에 '${signal}' 가 없다`);
  }
  const expectedExcluded = row.kind === null ? ['plugin', 'workflow'] : [row.kind === 'plugin' ? 'workflow' : 'plugin'];
  const gotExcluded = ev.excluded.map(e => e.kind).sort();
  if (gotExcluded.join(',') !== [...expectedExcluded].sort().join(',')) {
    problems.push(`excluded ${gotExcluded.join(',')} ≠ ${expectedExcluded.join(',')}`);
  }
  for (const exclusion of ev.excluded) {
    if (!exclusion.reason.trim()) problems.push(`제외 이유(${exclusion.kind})가 비어 있다`);
    for (const token of row.excludedReasonIncludes) {
      if (!exclusion.reason.includes(token)) problems.push(`제외 이유(${exclusion.kind})에 '${token}' 가 없다`);
    }
    for (const token of row.excludedReasonExcludes ?? []) {
      if (exclusion.reason.includes(token)) problems.push(`제외 이유(${exclusion.kind})에 불필요한 '${token}' 가 있다`);
    }
  }
  return problems;
}

function reportLine(row: MatrixRow, ev: MakeRouteEvidence, problems: string[]): string {
  return `#${String(row.id).padStart(2, '0')} ${problems.length ? '✗' : '✓'} `
    + `kind=${ev.kind ?? 'undecided'} decidedBy=${ev.decidedBy} measured=${ev.measured} `
    + `reason="${ev.reason}" signals=[${ev.signals.join(', ')}] `
    + `excluded=[${ev.excluded.map(e => `${e.kind}: ${e.reason}`).join(' | ')}] `
    + `request="${row.request}"`
    + (problems.length ? ` PROBLEMS: ${problems.join('; ')}` : '');
}

async function checkRows(rows: MatrixRow[], label: string): Promise<void> {
  const mismatches: string[] = [];
  for (const row of rows) {
    const t = await run(row.request);
    const problems = problemsAgainst(row, t.evidence);
    console.log(reportLine(row, t.evidence, problems));
    const expectedCalls = row.kind ? [{ kind: row.kind, request: row.request }] : [];
    if (JSON.stringify(t.calls) !== JSON.stringify(expectedCalls)) problems.push(`dispatch ${JSON.stringify(t.calls)}`);
    const expectedLines = row.kind ? [] : [QUESTION];
    if (JSON.stringify(t.lines) !== JSON.stringify(expectedLines)) problems.push(`lines ${JSON.stringify(t.lines)}`);
    const expectedExit = row.kind ? 0 : 1;
    if (t.exitCode !== expectedExit) problems.push(`exitCode ${t.exitCode} ≠ ${expectedExit}`);
    const expectedJudgeCalls = row.kind ? 0 : 1;
    if (t.judgeCalls !== expectedJudgeCalls) problems.push(`judgeCalls ${t.judgeCalls} ≠ ${expectedJudgeCalls}`);
    if (problems.length) mismatches.push(`#${row.id} ${row.request}: ${problems.join('; ')}`);
  }
  const count = (kind: MakeKind | null) => rows.filter(r => r.kind === kind).length;
  console.log(
    `${label}: ${rows.length - mismatches.length}/${rows.length} matched · `
    + `expected ${count('workflow')} workflow · ${count('plugin')} plugin · ${count(null)} undecided · model answers copied: 0`,
  );
  expect(mismatches).toEqual([]);
}

test('isolated public CLI exposes elanous make', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const child = Bun.spawn([process.execPath, 'bin/elanous.mjs', '--test', 'make', '--help'], { cwd: repo, stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(120_000) });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(output).toContain('Usage: elanous make [options] <request>');
  expect(output).toContain('--route-only');
}, 120_000);

test('30 pre-authored requests are judged by the production cli.make/route evidence path', async () => {
  await checkRows(MATRIX, 'cli.make route matrix');
});

test('compound-guard and upper-cell conflicts route per the documented judgement criteria', async () => {
  await checkRows(CONFLICT_MATRIX, 'cli.make conflict matrix');
});

test('classify judge verdict is recorded verbatim with its own rationale and exclusion ground', async () => {
  const ev = await routeMakeRequest('그거 좀 만들어 줘', {
    call: async () => ({
      text: '{"kind":"workflow","reason":"반복되는 잡 묶음으로 읽힌다","excluded":"커넥터 단품 요청이 아니다"}',
    }),
  });
  expect(ev.kind).toBe('workflow');
  expect(ev.decidedBy).toBe('classify-judge');
  expect(ev.measured).toBe(true);
  expect(ev.signals).toEqual(['judge:workflow']);
  expect(ev.reason).toContain('판정기 근거: 반복되는 잡 묶음으로 읽힌다');
  expect(ev.excluded).toEqual([
    { kind: 'plugin', reason: '요청 근거 없음 · 판정기 배제 근거: 커넥터 단품 요청이 아니다' },
  ]);
});

test('a judge answer without both rationales is unmeasured, never a success', async () => {
  const transports = [
    async () => ({ text: '{"kind":"workflow"}' }),
    async () => ({ text: '{"kind":"plugin","reason":"","excluded":"이유 있음"}' }),
    async () => ({ text: '{"kind":"workflow","reason":"이유 있음","excluded":""}' }),
    async () => ({ text: '{"kind":"unclear"}' }),
    async () => ({ text: '워크플로' }),
    async () => { throw new Error('offline'); },
  ];
  for (const call of transports) {
    const ev = await routeMakeRequest('무언가 해 줘', { call });
    expect(ev.kind).toBeNull();
    expect(ev.decidedBy).toBe('none');
    expect(ev.measured).toBe(false);
    expect(ev.reason).toContain('필수 근거 없음');
    expect(ev.excluded.map(e => e.kind)).toEqual(['plugin', 'workflow']);
    for (const exclusion of ev.excluded) expect(exclusion.reason.trim().length).toBeGreaterThan(0);
  }
});

test('--route-only prints the evidence JSON and never dispatches or judges', async () => {
  const calls: Array<{ kind: string; request: string }> = [];
  const lines: string[] = [];
  let judgeCalls = 0;
  const sinks = debug.status();
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  debug.setFileEnabled(false);
  debug.setDiagEnabled(true);
  debug.clear();
  try {
    for (const request of ['이메일 파싱 API', '무언가 해 줘']) {
      const program = new Command();
      registerMakeCommand(program, {
        judgeCall: async () => {
          judgeCalls += 1;
          throw new Error('no classifier provider in this run');
        },
        pluginMake: async text => { calls.push({ kind: 'plugin', request: text }); },
        workflowMake: async text => { calls.push({ kind: 'workflow', request: text }); return 0; },
      });
      await program.parseAsync(['node', 'elanous', 'make', '--route-only', request]);
    }
  } finally {
    console.log = oldLog;
    process.exitCode = oldExitCode ?? 0;
    debug.clear();
    debug.setFileEnabled(sinks.file);
    debug.setDiagEnabled(sinks.diag);
  }
  expect(judgeCalls).toBe(0);
  expect(calls).toEqual([]);
  expect(process.exitCode ?? 0).toBe(0);
  const evidences = lines.map(line => JSON.parse(line) as MakeRouteEvidence);
  expect(evidences).toHaveLength(2);
  expect(evidences[0]!.kind).toBe('plugin');
  expect(evidences[0]!.measured).toBe(true);
  expect(evidences[0]!.reason).toContain('파싱');
  expect(evidences[1]!.kind).toBeNull();
  expect(evidences[1]!.measured).toBe(false);
  expect(evidences[1]!.reason).toContain('필수 근거 없음');
}, 120_000);

/** The --route-only child prints one JSON evidence object on stdout; other lines
 *  (boot banners, help text) are skipped. */
function parseRouteEvidence(output: string): MakeRouteEvidence {
  for (const line of output.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as MakeRouteEvidence;
      if (parsed && typeof parsed === 'object' && 'kind' in parsed && 'measured' in parsed) return parsed;
    } catch {
      // not the evidence line — keep scanning
    }
  }
  throw new Error(`route evidence JSON not found in child output: ${output.slice(0, 400)}`);
}

test('the real CLI entry point routes all 30 matrix requests (bin/elanous.mjs --test make --route-only)', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const spawnRow = async (row: MatrixRow) => {
    const child = Bun.spawn(
      [process.execPath, 'bin/elanous.mjs', '--test', 'make', '--route-only', row.request],
      { cwd: repo, stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(120_000) },
    );
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { row, code, output };
  };

  const results: Array<{ row: MatrixRow; code: number; output: string }> = [];
  const POOL = 4;
  for (let at = 0; at < MATRIX.length; at += POOL) {
    results.push(...await Promise.all(MATRIX.slice(at, at + POOL).map(spawnRow)));
  }

  const mismatches: string[] = [];
  for (const { row, code, output } of results) {
    const ev = parseRouteEvidence(output);
    const problems = problemsAgainst(row, ev);
    if (code !== 0) problems.push(`exitCode ${code} ≠ 0`);
    console.log(reportLine(row, ev, problems));
    if (problems.length) mismatches.push(`#${row.id} ${row.request}: ${problems.join('; ')}`);
  }
  console.log(`cli.make real-entry route matrix: ${MATRIX.length - mismatches.length}/${MATRIX.length} matched`);
  expect(mismatches).toEqual([]);
}, 240_000);
