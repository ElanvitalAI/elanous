import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readShardArtifacts } from './gate-shard-artifacts.js';
import { createGateRunner, readGateInterferencePairs, shardParts, writeGateVerdictRecord } from './gate-runtime.js';
import { cleanRetryVerdict, coLocateInterferencePairs, failedJunitFiles, interferencePairsFromRetries, junitFailedCaseIds, junitPassedCaseIds,
  junitTestcaseFiles, planInterferenceSupplement } from './gate-shard-load-flaky';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';

test('pair-only interference expands the dirty set and keeps both files in one process group', () => {
  const pairMap = interferencePairsFromRetries([
    { id: 'src/a.test.ts > transient error', cause: 'isolation', peers: ['src/b.test.ts'] },
    { id: 'src/a.test.ts > transient error', cause: 'isolation', peers: ['src/b.test.ts'] },
    { id: 'src/c.test.ts > timed out', cause: 'timeout', peers: ['src/a.test.ts'] },
  ]);
  expect(pairMap).toEqual([{ files: ['src/a.test.ts', 'src/b.test.ts'] }]);

  // Fake world: either file passes alone, the pair fails. A's dirty selection must re-run the
  // recorded neighbor B in one process, where the pair-only failure becomes observable again.
  const plan = planInterferenceSupplement(['src/a.test.ts'],
    ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], pairMap);
  expect(plan.files).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  expect(plan.groups).toEqual([['src/a.test.ts', 'src/b.test.ts']]);
  expect(plan.groups.map((group) => group.length > 1)).toEqual([true]);
  expect(shardParts(plan.files, () => 1, 120, plan.pairs)).toEqual([['src/a.test.ts', 'src/b.test.ts']]);
  const shards = coLocateInterferencePairs([{ files: ['src/a.test.ts'], plannedSeconds: 1 },
    { files: ['src/b.test.ts', 'src/c.test.ts'], plannedSeconds: 2 }], plan.pairs);
  expect(shards.some((shard) => shard.files.includes('src/a.test.ts') && shard.files.includes('src/b.test.ts'))).toBe(true);
  expect(shards.flatMap((shard) => shard.files).sort()).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']);
  const pairFails = (files: readonly string[]) => files.includes('src/a.test.ts') && files.includes('src/b.test.ts');
  expect(pairFails(['src/a.test.ts'])).toBe(false);
  expect(pairFails(['src/b.test.ts'])).toBe(false);
  expect(plan.groups.some(pairFails)).toBe(true);
});

test('overlapping interference edges remain in one shard component', () => {
  const pairs = [{ files: ['src/a.test.ts', 'src/b.test.ts'] as [string, string] },
    { files: ['src/a.test.ts', 'src/c.test.ts'] as [string, string] }];
  const shards = coLocateInterferencePairs([{ files: ['src/a.test.ts', 'src/b.test.ts'] },
    { files: ['src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts'] }], pairs);
  expect(shards.some(({ files }) => ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'].every((file) => files.includes(file)))).toBe(true);
  expect(shards.flatMap(({ files }) => files).sort()).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts']);
  expect(pairs.every(({ files: [left, right] }) => shards.some((shard) => shard.files.includes(left) && shard.files.includes(right)))).toBe(true);
});

test('production gate sweep runs a lone dirty test, then its recorded interference neighbor in one real test process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-interference-live-path-'));
  const repo = join(root, 'repo');
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"gate-interference-sim","version":"1.0.1"}\n');
  writeFileSync(join(repo, 'bun.lock'), 'lockfileVersion = 1\n');
  for (const file of files) writeFileSync(join(repo, file), `test('${file}', () => expect(true).toBe(true));\n`);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  const events: string[][] = [];
  const gate = join(root, 'release/1.0.1/gate-logs/cut');
  const verdict = join(root, 'release/1.0.1/gate-verdict.json');
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  // Source: 내부 문서 `GOAL-scripts-release-loop-gate-node-ts-scripts-release-loop-gate-node-f99bf544-2026-10-22` — injected fake Pod boundary for production gate-path simulations.
  const scheduler = new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]);
  let podIndex = 0;
  try {
    git('init', '-q'); git('config', 'user.name', 'Gate interference sim'); git('config', 'user.email', 'gate-sim@example.invalid');
    git('add', '.'); git('commit', '-qm', 'gate interference sim');
    const commit = git('rev-parse', 'HEAD');
    const command = async (cmd: string, args: readonly string[], cwd: string) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git') {
        const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
        return { rc: result.status ?? 2, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
      }
      return { rc: 0, output: '' };
    };
    const podCommand = async (options: { command: readonly string[] }) => {
      const source = options.command.join(' ');
      const selected = files.filter((file) => source.includes(`./${file}`));
      events.push(selected);
      const pairFails = selected.includes(files[0]!) && selected.includes(files[1]!);
      const artifactsDir = join(root, `pod-${podIndex++}`);
      mkdirSync(artifactsDir);
      const junitCase = (file: string, fail: boolean) => `<testsuite file="${file}" tests="1"${fail ? ' failures="1"' : ''}><testcase name="${file}" file="${file}">${fail ? '<failure>pair-only</failure>' : ''}</testcase></testsuite>`;
      const log = pairFails
        ? selected.map((file) => `${file}:\n(fail) pair-only [1ms]\n`).join('') + `0 pass\n${selected.length} fail\n0 errors\nRan ${selected.length} tests across ${selected.length} files.\n`
        : `${selected.length} pass\n0 fail\n0 errors\nRan ${selected.length} tests across ${selected.length} files.\n`;
      const junit = `<testsuites>${selected.map((file) => junitCase(file, pairFails)).join('')}</testsuites>`;
      writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
      writeFileSync(join(artifactsDir, 'install.log'), '');
      writeFileSync(join(artifactsDir, 'part-0.rc'), pairFails ? '1\n' : '0\n');
      writeFileSync(join(artifactsDir, 'part-0.log'), log);
      writeFileSync(join(artifactsDir, 'part-0.junit.xml'), junit);
      writeFileSync(join(artifactsDir, 'shard.rc'), pairFails ? '1\n' : '0\n');
      writeFileSync(join(artifactsDir, 'shard.log'), log);
      writeFileSync(join(artifactsDir, 'junit.xml'), junit);
      if (pairFails) {
        writeFileSync(join(artifactsDir, 'part-0.retry-files'), `${files[0]}\n${files[1]}\n`);
        for (const [index, file] of [files[0]!, files[1]!].entries()) {
          writeFileSync(join(artifactsDir, `part-0.retry-${index}.started`), '');
          writeFileSync(join(artifactsDir, `part-0.retry-${index}.rc`), '0\n');
          writeFileSync(join(artifactsDir, `part-0.retry-${index}.log`), `1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n`);
          writeFileSync(join(artifactsDir, `part-0.retry-${index}.junit.xml`), `<testsuites>${junitCase(file, false)}</testsuites>`);
        }
      }
      return { exitCode: 0, artifactsDir, job: `fake-${podIndex}` };
    };
    const runner = createGateRunner(repo, undefined, command, podCommand as never, scheduler, undefined, {
      remoteRun: () => ({ status: 0, stdout: 'Linux\n', stderr: '' }), podImageDigest: () => imageDigest,
    });
    const logDir = join(gate, 'attempts');
    const shardsPath = join(gate, 'shards.json');
    const pod = { pool: 'pool-test', shards: 1, shardsFile: { path: shardsPath, version: '1.0.1', ledgerPath: join(root, 'shards.jsonl'), envFingerprint: 'sim-env' } };
    const first = await runner.sweep(repo, logDir, pod, [files[0]!]);
    expect(first.rc).toBe(0);
    expect(events).toEqual([[files[0]!]]);
    const second = await runner.sweep(repo, logDir, pod, [files[1]!]);
    expect(second.rc).toBe(0);
    expect(events[1]).toEqual([files[1]!]);

    writeGateVerdictRecord(verdict, { commit, outcome: 'ok', retryPass: [
      { id: `${files[0]} > pair-only`, cause: 'isolation', peers: [files[1]!] },
      { id: `${files[2]} > prior-pair`, cause: 'isolation', peers: [files[3]!] },
    ], baselineReceipt: { schema: 2, valid: true, commit } });
    expect(readGateInterferencePairs(verdict)).toEqual([
      { files: [files[0]!, files[1]!] }, { files: [files[2]!, files[3]!] },
    ]);
    const supplemented = await runner.sweep(repo, logDir, pod, [files[0]!]);
    expect(events[2]).toEqual([files[0], files[1]]);
    expect(supplemented.rc).toBe(1);
    expect(supplemented.output).toContain('(fail) pair-only');
    expect(supplemented.retryPass).toMatchObject([
      { id: `${files[0]} > ${files[0]}`, cause: 'isolation', peers: [files[1]] },
      { id: `${files[1]} > ${files[1]}`, cause: 'isolation', peers: [files[0]] },
    ]);
    writeGateVerdictRecord(verdict, { commit, outcome: 'ok', retryPass: supplemented.retryPass!,
      baselineReceipt: { schema: 2, valid: true, commit } });
    expect(readGateInterferencePairs(verdict)).toEqual([
      { files: [files[0]!, files[1]!] }, { files: [files[2]!, files[3]!] },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only complete verdict records seed the interference map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-interference-map-'));
  const path = join(dir, 'gate-verdict.json');
  try {
    const row = { id: 'src/a.test.ts > transient error', cause: 'isolation', peers: ['src/b.test.ts'] };
    writeFileSync(path, JSON.stringify({ outcome: 'error', commit: 'a'.repeat(40), retryPass: [row],
      baselineReceipt: { schema: 2, valid: false, commit: 'a'.repeat(40) } }));
    expect(readGateInterferencePairs(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ outcome: 'ok', commit: 'a'.repeat(40), retryPass: [row],
      baselineReceipt: { schema: 2, valid: true, commit: 'a'.repeat(40) } }));
    expect(readGateInterferencePairs(path)).toEqual([{ files: ['src/a.test.ts', 'src/b.test.ts'] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the complete verdict interference map accumulates sweep and supplement discoveries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-interference-map-growth-'));
  const path = join(dir, 'gate-verdict.json');
  const record = (commit: string, rows: unknown[]) => writeGateVerdictRecord(path, {
    outcome: 'ok', commit, retryPass: rows,
    baselineReceipt: { schema: 2, valid: true, commit },
  });
  try {
    record('a'.repeat(40), [{ id: 'src/a.test.ts > transient', cause: 'isolation', peers: ['src/b.test.ts'] }]);
    record('b'.repeat(40), [{ id: 'src/c.test.ts > transient', cause: 'isolation', peers: ['src/d.test.ts'] }]);
    expect(readGateInterferencePairs(path)).toEqual([
      { files: ['src/a.test.ts', 'src/b.test.ts'] },
      { files: ['src/c.test.ts', 'src/d.test.ts'] },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('same-Pod standalone retry evidence', () => {
  test('selects only attributed failed files from the shard allowlist', () => {
    const xml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="a"><failure/></testcase></testsuite><testsuite file="src/b.test.ts"><testcase name="b"/></testsuite></testsuites>';
    expect(failedJunitFiles(xml, ['src/a.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.ts']);
    expect(failedJunitFiles(xml, ['src/b.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites tests="2"><testsuite file="src/a.test.ts" tests="1"><testcase><failure/></testcase></testsuite><testsuite file="src/b.test.ts" tests="1"><testcase/></testsuite></testsuites>', ['src/a.test.ts', 'src/b.test.ts'])).toEqual(['src/a.test.ts']);
  });

  test('malformed or unlisted failure evidence fails closed', () => {
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts"><testcase><failure/></testsuite>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/other.test.ts"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><!bogus><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    const testcaseOutsideSuite = '<testsuites><testsuite file="src/a.test.ts"/><testcase file="src/a.test.ts"><failure/></testcase></testsuites>';
    expect(failedJunitFiles(testcaseOutsideSuite, ['src/a.test.ts'])).toBeNull();
    const cleanTestcaseOutsideSuite = '<testsuites><testsuite file="src/a.test.ts"/><testcase file="src/a.test.ts"/></testsuites>';
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n', cleanTestcaseOutsideSuite, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts"><failure/></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n',
      '<testsuites><!bogus><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    const commentInsideAttribute = '<testsuites><testsuite fi<!--x-->le="src/a.test.ts"><testcase><failure/></testcase></testsuite></testsuites>';
    expect(failedJunitFiles(commentInsideAttribute, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n', commentInsideAttribute, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" failures="2"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites failures="2"><testsuite file="src/a.test.ts"><testcase><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" failures="1"><testcase><failure/><failure/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
    expect(failedJunitFiles('<testsuites><testsuite file="src/a.test.ts" errors="1"><testcase><error/><error/></testcase></testsuite></testsuites>', ['src/a.test.ts'])).toBeNull();
  });

  test('PI-like text inside legal comments and CDATA remains content', () => {
    const wrap = (content: string) => `<testsuites><testsuite file="src/a.test.ts"><testcase>${content}</testcase></testsuite></testsuites>`;
    expect(failedJunitFiles(wrap('<!-- <?worker?> -->'), ['src/a.test.ts'])).toEqual([]);
    expect(failedJunitFiles(wrap('<![CDATA[<?worker?>]]>'), ['src/a.test.ts'])).toEqual([]);
  });

  test('only the leading XML declaration is accepted; markup processing instructions fail closed', () => {
    const wrap = (content: string) => `<testsuites><testsuite file="src/a.test.ts"><testcase>${content}</testcase></testsuite></testsuites>`;
    expect(failedJunitFiles('<?xml version="1.0"?>' + wrap('pass'), ['src/a.test.ts'])).toEqual([]);
    expect(failedJunitFiles(wrap('<?worker?>'), ['src/a.test.ts'])).toBeNull();
  });

  test('malformed, foreign, or count-mismatched retry JUnit cannot become clean', () => {
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite><testsuite file="src/other.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuites></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, 'junk<testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><failure/></testsuite><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase name="bad &entity;"/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites tests="2"><testsuite file="src/a.test.ts" tests="2"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts" failures="1"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites failures="1"><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><testsuite file="src/a.test.ts"><testcase name="bad &#1;"/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, '<testsuites><!-- bad -- comment --><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>', 'src/a.test.ts').clean).toBe(false);
    const badDeclaration = '<?xml nope?><testsuites><testsuite file="src/a.test.ts"><testcase/></testsuite></testsuites>';
    const rawControl = '<testsuites><testsuite file="src/a.test.ts"><testcase>\u0001</testcase></testsuite></testsuites>';
    const rawLessThan = '<testsuites><testsuite file="src/a.test.ts"><testcase>bad <x</testcase></testsuite></testsuites>';
    const malformedFailure = '<testsuites><testsuite file="src/a.test.ts"><testcase>bad <x</testcase><testcase><failure/></testcase></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, badDeclaration, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(badDeclaration, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, cleanLog, rawControl, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(rawControl, ['src/a.test.ts'])).toBeNull();
    expect(cleanRetryVerdict(0, cleanLog, rawLessThan, 'src/a.test.ts').clean).toBe(false);
    expect(failedJunitFiles(malformedFailure, ['src/a.test.ts'])).toBeNull();
  });

  test('a retry must rerun the originally failed testcase identity; another passing case in the file is insufficient', () => {
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    const passingOtherCase = '<testsuites><testsuite file="src/a.test.ts"><testcase name="other"/></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, passingOtherCase, 'src/a.test.ts', ['src/a.test.ts > failed']).clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, passingOtherCase, 'src/a.test.ts', ['src/a.test.ts > other']).clean).toBe(true);
    expect(junitPassedCaseIds(passingOtherCase)).toEqual(['src/a.test.ts > other']);
    expect(junitTestcaseFiles(passingOtherCase)).toEqual(['src/a.test.ts']);
    expect(junitTestcaseFiles('<testsuites><testsuite><testcase name="missing-file"/></testsuite></testsuites>')).toBeNull();
    const duplicateFail = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"><failure/></testcase><testcase name="same"><failure/></testcase></testsuite></testsuites>';
    expect(junitFailedCaseIds(duplicateFail)).toBeNull();
    const oneDuplicateFails = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"><failure/></testcase><testcase name="same"/></testsuite></testsuites>';
    expect(junitFailedCaseIds(oneDuplicateFails)).toBeNull();
    const onePass = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const twoPasses = '<testsuites><testsuite file="src/a.test.ts"><testcase name="same"/><testcase name="same"/></testsuite></testsuites>';
    expect(cleanRetryVerdict(0, cleanLog, onePass, 'src/a.test.ts', ['src/a.test.ts > same', 'src/a.test.ts > same']).clean).toBe(false);
    expect(cleanRetryVerdict(0, '2 pass\n0 fail\n0 errors\nRan 2 tests across 1 file.\n', twoPasses, 'src/a.test.ts', ['src/a.test.ts > same', 'src/a.test.ts > same']).clean).toBe(true);

    const failedInOtherSuite = '<testsuites><testsuite name="first" file="src/a.test.ts"><testcase name="same"><failure/></testcase></testsuite><testsuite name="second" file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const passingOnlyOtherSuite = '<testsuites><testsuite name="second" file="src/a.test.ts"><testcase name="same"/></testsuite></testsuites>';
    const originalFailureId = junitFailedCaseIds(failedInOtherSuite)?.[0];
    expect(originalFailureId).toBe('src/a.test.ts > first > same');
    expect(cleanRetryVerdict(0, cleanLog, passingOnlyOtherSuite, 'src/a.test.ts', [originalFailureId!]).clean).toBe(false);
  });

  test('a complete clean standalone retry is loadFlaky; persistent failure is not', () => {
    const cleanXml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="works"/></testsuite></testsuites>';
    const failXml = '<testsuites><testsuite file="src/a.test.ts"><testcase name="works"><failure/></testcase></testsuite></testsuites>';
    const cleanLog = '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
    const failLog = '0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.\n';
    expect(cleanRetryVerdict(0, cleanLog, cleanXml, 'src/a.test.ts').clean).toBe(true);
    expect(cleanRetryVerdict(1, failLog, failXml, 'src/a.test.ts').clean).toBe(false);
    expect(cleanRetryVerdict(0, cleanLog, undefined, 'src/a.test.ts').clean).toBe(false);
  });

  test('artifact reader filters only a clean per-file retry; persistent failures stay failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-'));
    try {
      const parts = [['src/a.test.ts', 'src/b.test.ts']];
      const setup = (retryFail: boolean) => {
        const dir = join(root, retryFail ? 'persistent' : 'flaky');
        mkdirSync(dir);
        writeFileSync(join(dir, 'install.rc'), '0\n');
        writeFileSync(join(dir, 'install.log'), '');
        writeFileSync(join(dir, 'part-0.rc'), '1\n');
        writeFileSync(join(dir, 'part-0.log'), 'src/a.test.ts:\n(fail) A [1ms]\n1 pass\n1 fail\nRan 2 tests across 2 files.\n');
        writeFileSync(join(dir, 'part-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite><testsuite file="src/b.test.ts"><testcase name="B"/></testsuite></testsuites>');
        writeFileSync(join(dir, 'part-0.retry-files'), 'src/a.test.ts\n');
        writeFileSync(join(dir, 'part-0.retry-0.rc'), retryFail ? '1\n' : '0\n');
        writeFileSync(join(dir, 'part-0.retry-0.log'), retryFail ? '0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.\n' : '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n');
        writeFileSync(join(dir, 'part-0.retry-0.junit.xml'), retryFail
          ? '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite></testsuites>'
          : '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"/></testsuite></testsuites>');
        return readShardArtifacts(dir, parts);
      };
      expect(setup(false)).toMatchObject({ loadFlaky: ['src/a.test.ts > A'] });
      expect(setup(true).loadFlaky).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('started retry remains recorded when the pod dies before writing rc', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-started-'));
    try {
      writeFileSync(join(root, 'install.rc'), '0\n');
      writeFileSync(join(root, 'install.log'), '');
      writeFileSync(join(root, 'part-0.log'), '0 pass\n1 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(root, 'part-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts"><testcase name="A"><failure/></testcase></testsuite></testsuites>');
      writeFileSync(join(root, 'part-0.retry-files'), 'src/a.test.ts\n');
      writeFileSync(join(root, 'part-0.retry-0.started'), '');
      expect(readShardArtifacts(root, [['src/a.test.ts']])).toMatchObject({ loadFlakyAttemptedFiles: ['src/a.test.ts'] });
      expect(readShardArtifacts(root, [['src/a.test.ts']]).loadFlaky).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a complete timeout JUnit plus clean same-Pod retry propagates loadFlaky', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-load-flaky-timeout-'));
    try {
      writeFileSync(join(root, 'install.rc'), '0\n');
      writeFileSync(join(root, 'install.log'), '');
      writeFileSync(join(root, 'part-0.rc'), '124\n');
      writeFileSync(join(root, 'part-0.log'), '1 pass\n1 fail\nRan 2 tests across 2 files.\n');
      writeFileSync(join(root, 'part-0.junit.xml'), '<testsuites tests="2"><testsuite file="src/a.test.ts" tests="1"><testcase name="A"/></testsuite><testsuite file="src/b.test.ts" tests="1" failures="1"><testcase name="B"><failure/></testcase></testsuite></testsuites>');
      writeFileSync(join(root, 'part-0.retry-files'), 'src/b.test.ts\n');
      writeFileSync(join(root, 'part-0.retry-0.started'), '');
      writeFileSync(join(root, 'part-0.retry-0.rc'), '0\n');
      writeFileSync(join(root, 'part-0.retry-0.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(root, 'part-0.retry-0.junit.xml'), '<testsuites tests="1"><testsuite file="src/b.test.ts" tests="1"><testcase name="B"/></testsuite></testsuites>');
      expect(readShardArtifacts(root, [['src/a.test.ts', 'src/b.test.ts']])).toMatchObject({
        rc: 1, loadFlaky: ['src/b.test.ts > B'], loadFlakyAttemptedFiles: ['src/b.test.ts'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
