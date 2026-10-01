import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { listLoops } from '../../src/loops/registry.js';
import type { DecisionEvent } from '../../src/live/detail-switch.js';
import { classifyReviewRounds, matchMustFix } from './must-fix-match.js';
import { runMission } from './run-mission.js';

const root = join(import.meta.dir, '../..');
const sample = JSON.parse(readFileSync(join(root, 'test/fixtures/landing-heal/pr21699-must-fix.json'), 'utf8')) as {
  pr: number; mustFix: string; diffRepresentation: string; finalDiff: string; otherDiff: string;
};
const rounds = JSON.parse(readFileSync(join(root, 'test/fixtures/landing-heal/pr21953-review-rounds.json'), 'utf8')) as {
  pr: number; comments: Array<{ body?: string }>;
};

test('#21953 reviewer rounds classify each bullet by later reviewer round in the same run', () => {
  const items = classifyReviewRounds(rounds.comments);
  expect(items).toHaveLength(6);
  expect(items.filter((item) => item.verdict === 'rereviewed')).toHaveLength(4);
  expect(items.filter((item) => item.verdict === 'open').map((item) => item.round)).toEqual([3, 3]);
  expect(new Set(items.map((item) => item.run)).size).toBe(1);
  const otherRun = rounds.comments[3]!.body!.replace('run-33962896-d5a1-4a0a-b474-18c0f1047148', 'different-run');
  expect(classifyReviewRounds([rounds.comments[1]!, { body: otherRun }]).map((item) => item.verdict)).toEqual(['open', 'open', 'open']);
  expect(classifyReviewRounds([{ body: '<!-- elanous-pr-comment v1 role=reviewer -->\nmust-fix:\n- old' },
    { body: '<!-- elanous-pr-comment v1 role=author round=2 run=run-x -->\n- not reviewer' }])).toEqual([]);
});

test('#21953 must-fix-match and report expose open vs rereviewed without changing legacy totals', () => {
  const collect = { prs: [{ number: rounds.pr, state: 'MERGED', files: [] }] };
  const match = runMission('must-fix-match', { outputs: { collect } }, (args) =>
    args[1] === 'view' ? JSON.stringify({ reviews: [], comments: rounds.comments })
      : args[0] === 'api' ? '[[]]' : '');
  expect((match.matches as Array<{ verdict: string; run?: string; round?: number }>)).toHaveLength(6);
  expect((match.matches as Array<{ verdict: string; run?: string; round?: number }>).every((item) => !!item.run && item.round !== undefined)).toBe(true);
  const report = runMission('report', { outputs: { collect, 'must-fix-match': match, 'verify-needed': { verifyNeeded: [] } } });
  expect(report).toMatchObject({ mustFixOpen: 2, mustFixRereviewed: 4, mustFixUnknown: 0, mustFixUnresolved: 2 });
});

test('report decision separates landed open must-fixes from unresolved, unknown and rereviewed', () => {
  const collect = { prs: [21977, 21953].map((number) => ({ number, state: 'MERGED', files: [] })) };
  const review = (pr: number, round: number, count: number) => ({ body:
    `<!-- elanous-pr-comment v1 role=reviewer round=${round} run=run-${pr} -->\nRound ${round}: reviewer requested ${count} must-fix change(s).\n\n${Array.from({ length: count }, (_, i) => `- fix ${i}`).join('\n')}` });
  const match = runMission('must-fix-match', { outputs: { collect } }, (args) => {
    if (args[0] === 'api') return '[[]]';
    const pr = Number(args[2]);
    return JSON.stringify({ comments: pr === 21953 ? [review(pr, 0, 1), review(pr, 1, 1)] : [review(pr, 0, 2)] });
  });
  const matches = [...(match.matches as Array<{ pr: number; text: string; verdict: string }>),
    { pr: 21977, text: 'legacy', verdict: 'unresolved' },
    { pr: 21953, text: 'ambiguous', verdict: 'unknown' }];
  expect(matches.filter((item) => item.verdict === 'open').map((item) => item.pr)).toEqual([21977, 21977, 21953]);
  expect(matches.filter((item) => item.verdict === 'rereviewed')).toHaveLength(1);
  const decisions: DecisionEvent[] = [];
  const report = runMission('report', { runId: 'landing-run', outputs: {
    collect, 'must-fix-match': { ...match, matches }, 'verify-needed': { verifyNeeded: [21977] },
  }, decision: (event) => { decisions.push(event); return true; } });
  expect(report).toEqual({ outcome: 'ok', prs: 2, mustFixUnresolved: 5, mustFixOpen: 4,
    mustFixUnknown: 1, mustFixRereviewed: 1, verifyNeeded: [21977] });
  expect(decisions).toEqual([{ kind: 'VERIFY', what: '착지·치유 관측: PR 2건 — 열린 must-fix 3건(PR #21953, #21977)',
    reason: '열린 채 착지 3건 · 미해결 1건 · 미상 1건 · 다시 봄 1건 · 착지 뒤 검증 필요 1건',
    purpose: '착지 후속 작업 관측', target: 'landing-heal', runId: 'landing-run' }]);

  const noOpen: DecisionEvent[] = [];
  runMission('report', { outputs: { collect, 'must-fix-match': { matches: matches.filter((item) => item.verdict !== 'open') },
    'verify-needed': { verifyNeeded: [] } }, decision: (event) => { noOpen.push(event); return true; } });
  expect(noOpen[0]?.what).toBe('착지·치유 관측: PR 2건');
  expect(noOpen[0]?.reason).toBe('열린 채 착지 0건 · 미해결 1건 · 미상 1건 · 다시 봄 1건 · 착지 뒤 검증 필요 0건');
});

test('report does not describe an OPEN PR must-fix as landed while preserving all return totals', () => {
  const collect = { prs: [
    { number: 21977, state: 'MERGED', files: [] },
    { number: 21699, state: 'OPEN', files: [] },
    { number: 21953, state: 'MERGED', files: [] },
  ] };
  const review = (pr: number, count: number) => ({ body:
    `<!-- elanous-pr-comment v1 role=reviewer round=0 run=run-${pr} -->\nRound 0: reviewer requested ${count} must-fix change(s).\n\n${Array.from({ length: count }, (_, i) => `- fix ${i}`).join('\n')}` });
  const match = runMission('must-fix-match', { outputs: { collect } }, (args) => {
    if (args[0] === 'api') return '[[]]';
    return JSON.stringify({ comments: [review(Number(args[2]), Number(args[2]) === 21977 ? 2 : 1)] });
  });
  const decisions: DecisionEvent[] = [];
  const report = runMission('report', { outputs: { collect, 'must-fix-match': match,
    'verify-needed': { verifyNeeded: [] } }, decision: (event) => { decisions.push(event); return true; } });
  expect(report).toEqual({ outcome: 'ok', prs: 3, mustFixOpen: 4, mustFixUnknown: 0,
    mustFixRereviewed: 0, mustFixUnresolved: 4, verifyNeeded: [] });
  expect(decisions[0]?.what).toBe('착지·치유 관측: PR 3건 — 열린 must-fix 3건(PR #21953, #21977)');
  expect(decisions[0]?.reason).toBe('열린 채 착지 3건 · 미해결 0건 · 미상 0건 · 다시 봄 0건 · 착지 뒤 검증 필요 0건');
});

test('reviewer without run/round and other roles retain the final-diff verdict', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const result = runMission('must-fix-match', { outputs: { collect } }, (args) =>
    args[1] === 'view' ? JSON.stringify({ comments: [
      { body: `<!-- elanous-pr-comment v1 role=reviewer -->\nmust-fix: ${sample.mustFix}` },
      { body: `<!-- elanous-pr-comment v1 role=judge round=3 run=run-x -->\nmust-fix: ${sample.mustFix}` },
    ] }) : args[0] === 'api' ? '[[]]' : sample.finalDiff);
  expect(result.matches).toEqual([
    { pr: 21699, text: `<!-- elanous-pr-comment v1 role=reviewer -->\nmust-fix: ${sample.mustFix}`, verdict: 'unknown' },
    { pr: 21699, text: `<!-- elanous-pr-comment v1 role=judge round=3 run=run-x -->\nmust-fix: ${sample.mustFix}`, verdict: 'unknown' },
  ]);
  expect(runMission('report', { outputs: { collect, 'must-fix-match': result, 'verify-needed': { verifyNeeded: [] } } })).toMatchObject({
    mustFixOpen: 0, mustFixRereviewed: 0, mustFixUnknown: 2, mustFixUnresolved: 2,
  });
  const report = runMission('report', { outputs: { collect, 'must-fix-match': { matches: [
    ...(result.matches as Array<{ pr: number; text: string; verdict: string }>),
    { pr: 21699, text: 'legacy', verdict: 'unresolved' },
    { pr: 21699, text: 'latest round', verdict: 'open' },
    { pr: 21699, text: 'older round', verdict: 'rereviewed' },
    { pr: 21699, text: 'confirmed', verdict: 'resolved' },
  ] }, 'verify-needed': { verifyNeeded: [] } } });
  expect(report).toMatchObject({ mustFixOpen: 2, mustFixUnknown: 2, mustFixRereviewed: 1, mustFixUnresolved: 4 });
});

test('#21699 final patch touch does not prove the requested recovery', () => {
  expect(sample.pr).toBe(21699);
  expect(sample.mustFix).toBe('`pty-recording.ts`의 `finish()`는 파일을 만든 뒤 `markStopped()`가 실패하면 녹화가 활성 상태로 남습니다. 이후 재시도는 `wx`의 파일 존재 오류로 계속 실패해 저장을 완료할 수 없습니다. 파일 생성 이후 실패의 복구·재시도 경로가 필요합니다.');
  expect(sample.finalDiff).toContain('diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts');
  expect(sample.finalDiff).toContain('+function finish(');
  expect(sample.finalDiff).toContain("+  getRecordingStore().markStopped(entry.recordingId, { artifactPath: entry.path });");
  expect(sample.diffRepresentation).toContain('gh pr diff 21699 --patch');
  expect(matchMustFix(sample.mustFix, sample.finalDiff)).toBe('unknown');
  expect(matchMustFix(sample.mustFix, sample.otherDiff)).toBe('unresolved');
  expect(matchMustFix(sample.mustFix, sample.finalDiff.replaceAll('pty-recording.ts', 'pty-other.ts'))).toBe('unresolved');
  expect(matchMustFix('파일 생성 뒤 실패의 복구 경로가 필요합니다.', sample.finalDiff)).toBe('unknown');
  expect(matchMustFix('`finish()`를 확인해 주세요.', sample.finalDiff)).toBe('resolved');
  const headerOnly = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -1 +1 @@ function finish(\n-old\n+new\n';
  expect(matchMustFix(sample.mustFix, headerOnly)).toBe('unresolved');
  expect(matchMustFix('`finish()`를 확인해 주세요.', headerOnly)).toBe('unresolved');
  const repaired = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -63,3 +63,7 @@ function finish(\n-function finish(ptyId: string) {\n+function finish(ptyId: string) {\n+  try { getRecordingStore().markStopped(entry.recordingId); }\n+  catch { unlinkSync(entry.path); throw new Error("retry"); }\n';
  expect(matchMustFix(sample.mustFix, repaired)).toBe('unknown');
  const unreachableCleanup = repaired.replace('unlinkSync(entry.path); throw new Error("retry");', 'throw new Error("retry"); unlinkSync(entry.path);');
  expect(matchMustFix(sample.mustFix, unreachableCleanup)).toBe('unknown');
  const headerRecovery = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -70,3 +70,6 @@ function finish(\n-  getRecordingStore().markStopped(entry.recordingId);\n+  try { getRecordingStore().markStopped(entry.recordingId); }\n+  catch { unlinkSync(entry.path); throw new Error("retry"); }\n';
  expect(matchMustFix(sample.mustFix, headerRecovery)).toBe('unknown');
  const unrelatedCatch = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -63,2 +63,4 @@ function finish(\n-function finish(ptyId: string) {\n+function finish(ptyId: string) {\n+  catch { console.log(entry.path); }\n+  getRecordingStore().markStopped(entry.recordingId);\n';
  expect(matchMustFix(sample.mustFix, unrelatedCatch)).toBe('unknown');
  const alternateWording = '`pty-recording.ts`의 `finish()`가 파일을 쓴 뒤 저장 상태 갱신에 실패합니다. 재호출 시 기존 파일 때문에 막히므로 복구해야 합니다.';
  expect(matchMustFix(alternateWording, sample.finalDiff)).toBe('unknown');
  expect(matchMustFix(alternateWording, repaired)).toBe('unknown');
  expect(matchMustFix('`pty-recording.ts`의 `finish()`에서 파일을 만든 뒤 저장 상태가 갱신되지 않습니다.', sample.finalDiff)).toBe('unknown');
  expect(matchMustFix('`finish()`의 저장 실패를 고쳐 확인해 주세요.', sample.finalDiff)).toBe('unknown');
  const disconnectedCatch = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -63,3 +63,9 @@ function finish(\n-function finish(ptyId: string) {\n+function finish(ptyId: string) {\n+  try { unrelatedOperation(); }\n+  catch { unlinkSync(entry.path); throw new Error("retry"); }\n+  getRecordingStore().markStopped(entry.recordingId);\n';
  expect(matchMustFix(sample.mustFix, disconnectedCatch)).toBe('unknown');
  const siblingCatch = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -63,3 +63,9 @@ function finish(\n-function finish(ptyId: string) {\n+function finish(ptyId: string) {\n+  try { getRecordingStore().markStopped(entry.recordingId); }\n+  catch { throw new Error("no cleanup"); }\n+  try { unrelatedOperation(); }\n+  catch { unlinkSync(entry.path); throw new Error("retry"); }\n';
  expect(matchMustFix(sample.mustFix, siblingCatch)).toBe('unknown');
  const swallowedError = repaired.replace('throw new Error("retry");', 'console.log("failed");');
  expect(matchMustFix(sample.mustFix, swallowedError)).toBe('unknown');
});

test('landing graph is registered but not scheduled; all commands are observation-only', () => {
  const yaml = readFileSync(join(root, 'graphs/landing/landing-heal.yaml'), 'utf8');
  const parsed = parseGraphTemplateYaml(yaml, 'landing-heal.yaml');
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.nodes.map((node) => [node.nodeId, node.kind])).toEqual([
    ['collect', 'observe'], ['must-fix-match', 'judge'], ['verify-needed', 'observe'], ['clean-checkout', 'observe'], ['report', 'observe'], ['done', 'gate'], ['failed', 'gate'],
  ]);
  expect(parsed.template?.nodes.slice(0, 5).map((node) => node.recipe)).toEqual([
    'cmd:collect', 'cmd:must-fix-match', 'cmd:verify-needed', 'cmd:clean-checkout', 'cmd:report',
  ]);
  expect(parsed.template?.edges.map((edge) => [edge.from, edge.map?.ok])).toEqual([
    ['collect', 'must-fix-match'], ['must-fix-match', 'verify-needed'], ['verify-needed', 'clean-checkout'], ['clean-checkout', 'report'], ['report', 'done'],
  ]);
  const loop = listLoops({ root, schedules: [], stateRoot: join(root, '.elanous-test') }).find((item) => item.id === 'landing-heal');
  expect(loop?.trigger).toEqual({ cron: '*/30 * * * *', events: ['card'] });
  expect(loop?.enabled).toBe(false);
  const recipes = readFileSync(join(root, 'graphs/landing/recipes.yaml'), 'utf8');
  expect(recipes).not.toMatch(/gh pr (?:merge|comment)|git push/);
  expect(recipes.match(/command:/g)).toHaveLength(5);
  expect(recipes.match(/bun scripts\/landing-heal\/run-mission\.ts/g)).toHaveLength(5);
  const runner = readFileSync(join(root, 'scripts/landing-heal/run-mission.ts'), 'utf8');
  expect(runner).not.toMatch(/(?:spawnSync|run)\(['"](?:git|bun)['"],/);
  expect(runner).not.toMatch(/\b(?:writeFileSync|appendFileSync|unlinkSync|mkdirSync)\b/);
});

test('collect filters harness PRs in the merged window and retains open PRs; verify only marks merged source files', () => {
  const prs = [
    { number: 1, title: 'new', state: 'MERGED', mergedAt: '2026-09-29T09:30:00Z', headRefName: 'self-impl/a', files: [{ path: 'src/x.ts' }] },
    { number: 2, title: 'old', state: 'MERGED', mergedAt: '2026-09-29T07:30:00Z', headRefName: 'self-impl/b', files: [] },
    { number: 3, title: 'open', state: 'OPEN', mergedAt: null, headRefName: 'self-impl/c', files: [{ path: 'apps/pwa/x.ts' }] },
    { number: 4, title: 'foreign', state: 'OPEN', mergedAt: null, headRefName: 'human/a', files: [] },
  ];
  const calls: string[][] = [];
  const collect = runMission('collect', {}, (args) => { calls.push(args); return JSON.stringify(prs); }, new Date('2026-09-29T10:00:00Z'));
  expect(calls[0]).toEqual(['pr', 'list', '--state', 'all', '--search', 'updated:>=2026-09-29T09:00:00.000Z', '--limit', '200', '--json', 'number,title,state,mergedAt,headRefName,files']);
  expect((collect.prs as typeof prs).map((pr) => pr.number)).toEqual([1, 3]);
  expect(runMission('verify-needed', { outputs: { collect } }, () => JSON.stringify({ comments: [] })).verifyNeeded).toEqual([1]);
  expect(runMission('report', { outputs: { collect, 'must-fix-match': { matches: [] }, 'verify-needed': { verifyNeeded: [1] } } })).toMatchObject({
    outcome: 'ok', prs: 2, mustFixUnresolved: 0, verifyNeeded: [1],
  });
  expect(runMission('report', { outputs: { collect, 'must-fix-match': { matches: [
    { pr: 1, text: 'named', verdict: 'unresolved' }, { pr: 3, text: 'ambiguous', verdict: 'unknown' },
  ] }, 'verify-needed': { verifyNeeded: [1] } } }).mustFixUnresolved).toBe(2);
});

test('explicit must-fix input can be checked without review wording', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const result = runMission('must-fix-match', {
    input: { mustFixByPr: { '21699': [sample.mustFix] } }, outputs: { collect },
  }, (args) => args[1] === 'view' ? JSON.stringify({ reviews: [] }) : args[0] === 'api' ? '[[]]' : sample.finalDiff);
  expect((result.matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unknown');
});

test('must-fix-match node does not accept a finish-only hunk header as a repair', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const patch = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -1 +1 @@ function finish(\n-old\n+new\n';
  const result = runMission('must-fix-match', {
    input: { mustFixByPr: { '21699': [sample.mustFix] } }, outputs: { collect },
  }, (args) => args[1] === 'view' ? '{"reviews":[]}' : args[0] === 'api' ? '[[]]' : patch);
  expect((result.matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unresolved');
});

test('multiline must-fix reviews keep their identifiers for final-diff matching', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const result = runMission('must-fix-match', { outputs: { collect } }, (args) =>
    args[1] === 'view' ? JSON.stringify({ reviews: [{ body: `must-fix:\n${sample.mustFix}` }] })
      : args[0] === 'api' ? '[[]]' : sample.finalDiff);
  expect((result.matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unknown');
});

test('inline must-fix comments are observed with the final diff', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const result = runMission('must-fix-match', { outputs: { collect } }, (args) =>
    args[1] === 'view' ? JSON.stringify({ reviews: [] })
      : args[0] === 'api' ? JSON.stringify([[{ body: `must-fix: ${sample.mustFix}` }]]) : sample.otherDiff);
  expect((result.matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unresolved');
});

test('actual prefixed review text reaches the touch-only and conservative branches', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const runReview = (body: string, patch: string) => runMission('must-fix-match', { outputs: { collect } }, (args) =>
    args[1] === 'view' ? JSON.stringify({ reviews: [{ body }] }) : args[0] === 'api' ? '[[]]' : patch);
  expect((runReview('must-fix: `finish()`를 확인해 주세요.', sample.finalDiff).matches as Array<{ verdict: string }>)[0]?.verdict).toBe('resolved');
  expect((runReview(`must-fix: ${sample.mustFix}`, sample.finalDiff).matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unknown');
  const unreachableCleanup = 'diff --git a/src/pty-shell/pty-recording.ts b/src/pty-shell/pty-recording.ts\n@@ -63,3 +63,7 @@ function finish(\n-function finish(ptyId: string) {\n+function finish(ptyId: string) {\n+  try { getRecordingStore().markStopped(entry.recordingId); }\n+  catch { throw new Error("retry"); unlinkSync(entry.path); }\n';
  expect((runReview(`must-fix: ${sample.mustFix}`, unreachableCleanup).matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unknown');
  expect((runReview(`must-fix: ${sample.mustFix}`, sample.otherDiff).matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unresolved');
});

test('must-fix review matching consults final diff, not a prior round', () => {
  const collect = { prs: [{ number: 21699, state: 'OPEN', files: [] }] };
  const calls: string[][] = [];
  const result = runMission('must-fix-match', { outputs: { collect } }, (args) => {
    calls.push(args);
    return args[1] === 'view' ? JSON.stringify({ reviews: [{ body: `must-fix: ${sample.mustFix}` }] })
      : args[0] === 'api' ? '[[]]' : sample.finalDiff;
  });
  expect((result.matches as Array<{ verdict: string }>)[0]?.verdict).toBe('unknown');
  expect(calls).toEqual([['pr', 'view', '21699', '--json', 'reviews,comments'],
    ['api', 'repos/{owner}/{repo}/pulls/21699/comments', '--paginate', '--slurp'], ['pr', 'diff', '21699', '--patch']]);
});

test('landing-heal gh calls use the GitHub App token unless the caller already set GH_TOKEN', async () => {
  const { ghEnv } = await import('./run-mission.js');
  let minted = 0;
  const mint = () => { minted += 1; return 'app-token'; };
  // ⛔ 받은 값을 단언문에 그대로 넣지 않는다 — 실패하면 진짜 토큰이 출력에 찍힌다(09-29).
  expect(ghEnv({ GH_TOKEN: 'caller' }, mint).GH_TOKEN === 'caller').toBe(true);
  expect(minted).toBe(0);
  expect(ghEnv({ PATH: '/bin' }, mint).GH_TOKEN === 'app-token').toBe(true);
  expect(ghEnv({ PATH: '/bin' }, mint).GH_TOKEN === 'app-token').toBe(true);
  expect(minted).toBe(1);
});

test('verify-needed drops merged PRs whose comment starts with a landing-verified line', async () => {
  const { runMission, isLandingVerified } = await import('./run-mission.js');
  expect(isLandingVerified('landing-verified: 921051a · doctor rc 0')).toBe(true);
  expect(isLandingVerified('landing-verified:')).toBe(false);
  expect(isLandingVerified('note\nlanding-verified: x')).toBe(false);
  const prs = [21950, 21951, 21952].map((number) => ({ number, title: '', state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', headRefName: 'self-impl/x', files: [{ path: 'src/a.ts' }] }));
  const ctx = { outputs: { collect: { outcome: 'ok', prs } } };
  const bodies: Record<string, string> = { '21950': 'landing-verified: 921051a · 공개 sha 다섯 그대로', '21951': 'looks fine', '21952': '' };
  const run = (args: string[]) => JSON.stringify({ comments: [{ body: bodies[args[2]!] }] });
  expect(runMission('verify-needed', ctx, run)).toEqual({ outcome: 'ok', verifyNeeded: [21951, 21952], verified: [21950] });
});

test('#21983 a completed (warn) review is a re-review, not a must-fix list — its summary bullets are not counted', async () => {
  const { classifyReviewRounds } = await import('./must-fix-match.js');
  const real = JSON.parse(readFileSync(join(root, 'test/fixtures/landing-heal/pr21983-review-completed.json'), 'utf8')) as { comments: Array<{ body: string }> };
  expect(classifyReviewRounds(real.comments)).toEqual([]);
  const requested = { body: real.comments.find((c) => c.body.includes('role=reviewer'))!.body
    .replace('round=0', 'round=0').replace(/Round 0: review completed \(warn\)\./, 'Round 0: reviewer requested 1 must-fix change(s).').split('\n').slice(0, 3).join('\n') + '\n- fix `x`' };
  const later = { body: real.comments.find((c) => c.body.includes('role=reviewer'))!.body.replace('round=0', 'round=1').replace('Round 0:', 'Round 1:') };
  expect(classifyReviewRounds([requested, later]).map((item) => item.verdict)).toEqual(['rereviewed']);
});

test('outside a git checkout the loop takes GH_REPO from the single App installation repository, and stops when it cannot know', async () => {
  const { ghRepoEnv } = await import('./run-mission.js');
  const outside = mkdtempSync(join(tmpdir(), 'landing-heal-cwd-'));
  try {
    expect((await ghRepoEnv({ GH_TOKEN: 't' }, outside, async () => ['o/r'])).GH_REPO).toBe('o/r');
    expect((await ghRepoEnv({ GH_TOKEN: 't', GH_REPO: 'x/y' }, outside, async () => ['o/r'])).GH_REPO).toBe('x/y');
    expect((await ghRepoEnv({ GH_TOKEN: 't' }, root, async () => { throw new Error('must not list inside a checkout'); })).GH_REPO).toBeUndefined();
    await expect(ghRepoEnv({ GH_TOKEN: 't' }, outside, async () => ['a/b', 'c/d'])).rejects.toThrow('2 repositories');
    await expect(ghRepoEnv({}, outside, async () => ['o/r'])).rejects.toThrow('set GH_REPO');
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test('a «must-fix resolved in #N» note closes the landed-open items of that PR and is not itself a must-fix (#21953 → #21982)', async () => {
  const { runMission, resolvedInPrs } = await import('./run-mission.js');
  expect(resolvedInPrs('must-fix resolved in #21982 — 표·적용 대상 일치')).toEqual([21982]);
  expect(resolvedInPrs('note\nmust-fix resolved in #1')).toEqual([]);
  const real = JSON.parse(readFileSync(join(root, 'test/fixtures/landing-heal/pr21953-review-rounds.json'), 'utf8')) as { comments: Array<{ body: string }> };
  const pr = { number: 21953, title: '', state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', headRefName: 'self-impl/x', files: [] };
  const view = (extra: Array<{ body: string }>) => (args: string[]) => args[0] === 'pr' && args[1] === 'view'
    ? JSON.stringify({ comments: [...real.comments, ...extra], reviews: [] }) : args[0] === 'api' ? '[[]]' : '';
  const ctx = { outputs: { collect: { outcome: 'ok', prs: [pr] } } };
  const before = runMission('must-fix-match', ctx, view([])) as { matches: Array<{ verdict: string }> };
  expect(before.matches.filter((m) => m.verdict === 'open')).toHaveLength(2);
  const after = runMission('must-fix-match', ctx, view([{ body: 'must-fix resolved in #21982 (표 ↔ apply 대상 · 거부가 성공으로 넘어감)' }])) as { matches: Array<{ verdict: string; resolvedIn?: number[] }> };
  expect(after.matches.filter((m) => m.verdict === 'open')).toHaveLength(0);
  expect(after.matches.filter((m) => m.verdict === 'resolved').map((m) => m.resolvedIn)).toEqual([[21982], [21982]]);
  expect(after.matches).toHaveLength(before.matches.length);
});
