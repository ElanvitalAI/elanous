import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { listLoops } from '../../src/loops/registry.js';
import { matchMustFix } from './must-fix-match.js';
import { runMission } from './run-mission.js';

const root = join(import.meta.dir, '../..');
const sample = JSON.parse(readFileSync(join(root, 'test/fixtures/landing-heal/pr21699-must-fix.json'), 'utf8')) as {
  pr: number; mustFix: string; diffRepresentation: string; finalDiff: string; otherDiff: string;
};

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
    ['collect', 'observe'], ['must-fix-match', 'judge'], ['verify-needed', 'observe'], ['report', 'observe'], ['done', 'gate'], ['failed', 'gate'],
  ]);
  expect(parsed.template?.nodes.slice(0, 4).map((node) => node.recipe)).toEqual([
    'cmd:collect', 'cmd:must-fix-match', 'cmd:verify-needed', 'cmd:report',
  ]);
  expect(parsed.template?.edges.map((edge) => [edge.from, edge.map?.ok])).toEqual([
    ['collect', 'must-fix-match'], ['must-fix-match', 'verify-needed'], ['verify-needed', 'report'], ['report', 'done'],
  ]);
  const loop = listLoops({ root, schedules: [], stateRoot: join(root, '.elanous-test') }).find((item) => item.id === 'landing-heal');
  expect(loop?.trigger).toEqual({ cron: '*/5 * * * *', events: ['card'] });
  expect(loop?.enabled).toBe(false);
  const recipes = readFileSync(join(root, 'graphs/landing/recipes.yaml'), 'utf8');
  expect(recipes).not.toMatch(/gh pr (?:merge|comment)|git push/);
  expect(recipes.match(/command:/g)).toHaveLength(4);
  expect(recipes.match(/bun scripts\/landing-heal\/run-mission\.ts/g)).toHaveLength(4);
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
  expect(runMission('verify-needed', { outputs: { collect } }).verifyNeeded).toEqual([1]);
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
