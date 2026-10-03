import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { calibrateMissingGateMeasurements, main, measureGateComparison, readCases, readGateMeasurements } from './measure-gate-shards';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fakeSuite(failIndex = -1, stderrMessage = '') {
  const repo = mkdtempSync(join(tmpdir(), 'gate-shards-six-'));
  scratch.push(repo);
  mkdirSync(join(repo, 'test'));
  const files = Array.from({ length: 6 }, (_, i) => `test/fake-${i}.test.ts`);
  files.forEach((file, index) => writeFileSync(join(repo, file),
    `import { test, expect } from 'bun:test'; test('case ${index}', async () => { console.error(${JSON.stringify(stderrMessage)}); await Bun.sleep(150); expect(${index}).toBe(${index === failIndex ? -1 : index}); });\n`));
  const rss = new Map(files.map((file) => [file, 64]));
  const seconds = new Map(files.map((file) => [file, 1]));
  return { repo, files, rss, seconds, cgroupRoot: join(repo, 'no-delegated-cgroup') };
}

test('six real fake test files produce both JSON modes with matching passing case judgments', async () => {
  const fixture = fakeSuite();
  const result = await measureGateComparison({ ...fixture, commit: 'a'.repeat(40), shards: 3 });
  const json = JSON.parse(JSON.stringify(result));
  expect(Object.keys(json)).toEqual(['commit', 'machine', 'files', 'shards', 'unsharded', 'sharded', 'verdictAgrees']);
  expect(json).toMatchObject({ files: 6, shards: 3, verdictAgrees: true,
    unsharded: { mode: 'unsharded', verdict: 'passed', runs: 1, oomCount: 0, oomCountStatus: 'partial', unknownTerminations: 0 },
    sharded: { mode: 'sharded', verdict: 'passed', runs: 3, oomCount: 0, oomCountStatus: 'partial', unknownTerminations: 0 } });
  for (const mode of [json.unsharded, json.sharded]) {
    expect(mode.durationMs).toBeGreaterThan(0);
    expect(mode.peakRssMb).toBeGreaterThan(0);
    expect(Object.keys(mode.cases)).toHaveLength(6);
    expect(Object.values(mode.cases)).toEqual(Array(6).fill('passed'));
  }
});

test('the same six real files agree on a failing case, not merely on failure counts', async () => {
  const result = await measureGateComparison({ ...fakeSuite(2), commit: 'b'.repeat(40), shards: 3 });
  expect(result.verdictAgrees).toBe(true);
  expect(result.unsharded.verdict).toBe('failed');
  expect(result.sharded.verdict).toBe('failed');
  expect(result.sharded.cases['test/fake-2.test.ts > case 2']).toBe('failed');
  expect(result.sharded.cases).toEqual(result.unsharded.cases);
});

test('a passing test printing out of memory is not classified as an OOM', async () => {
  const result = await measureGateComparison({ ...fakeSuite(-1, 'out of memory OOMKilled JavaScript heap out of memory'), commit: 'c'.repeat(40), shards: 3 });
  expect(result.verdictAgrees).toBe(true);
  for (const mode of [result.unsharded, result.sharded]) {
    expect(mode.verdict).toBe('passed');
    expect(mode.oomCount).toBe(0);
    expect(mode.oomCountStatus).toBe('partial');
    expect(mode.unknownTerminations).toBe(0);
  }
});

test('a killed bundle is an unknown termination, not a confirmed OOM', async () => {
  const fixture = fakeSuite();
  // Bun test itself terminates abnormally; the runner must not infer the cause from SIGKILL/137.
  writeFileSync(join(fixture.repo, fixture.files[0]!),
    "import { test } from 'bun:test'; test('killed', async () => { process.kill(process.pid, 'SIGKILL'); });\n");
  const result = await measureGateComparison({ ...fixture, commit: 'd'.repeat(40), shards: 3 });
  expect(result.unsharded).toMatchObject({ verdict: 'unmeasured', oomCount: 0, oomCountStatus: 'partial', unknownTerminations: 1 });
  expect(result.sharded).toMatchObject({ verdict: 'unmeasured', oomCount: 0, oomCountStatus: 'partial', unknownTerminations: 1 });
  expect(result.verdictAgrees).toBe(false);
});

test('exit code 137 without a signal also has unknown cause', async () => {
  const fixture = fakeSuite();
  writeFileSync(join(fixture.repo, fixture.files[0]!),
    "import { test } from 'bun:test'; test('exits', () => { process.exit(137); });\n");
  const result = await measureGateComparison({ ...fixture, commit: 'e'.repeat(40), shards: 3 });
  for (const mode of [result.unsharded, result.sharded]) {
    expect(mode).toMatchObject({ verdict: 'unmeasured', oomCount: 0, oomCountStatus: 'partial', unknownTerminations: 1 });
  }
  expect(result.verdictAgrees).toBe(false);
});

test('SIGKILL with an observed zero kernel OOM counter remains unknown', async () => {
  const fixture = fakeSuite();
  const cgroupRoot = mkdtempSync(join(tmpdir(), 'gate-shards-zero-oom-'));
  scratch.push(cgroupRoot);
  writeFileSync(join(fixture.repo, fixture.files[0]!),
    "import { test } from 'bun:test'; test('killed', () => process.kill(process.pid, 'SIGKILL'));\n");
  const result = await measureGateComparison({ ...fixture, commit: '0'.repeat(40), shards: 3, cgroupRoot,
    onCgroupCreated: (path) => writeFileSync(join(path, 'memory.events'), 'oom_kill 0\n'),
  });
  for (const mode of [result.unsharded, result.sharded]) {
    expect(mode).toMatchObject({ verdict: 'unmeasured', oomCount: 0, oomCountStatus: 'confirmed', unknownTerminations: 1 });
  }
});

test('a kernel-attributed OOM kill in a bundle increments the JSON OOM count', async () => {
  const fixture = fakeSuite();
  const cgroupRoot = mkdtempSync(join(tmpdir(), 'gate-shards-cgroup-'));
  scratch.push(cgroupRoot);
  writeFileSync(join(fixture.repo, fixture.files[0]!),
    `import { test } from 'bun:test'; import { writeFileSync } from 'node:fs';
     test('oom', () => { writeFileSync(process.env.ELANOUS_GATE_MEASURE_CGROUP_DIR + '/memory.events', 'oom_kill 1\\n'); process.kill(process.pid, 'SIGKILL'); });\n`);
  const result = await measureGateComparison({ ...fixture, commit: 'f'.repeat(40), shards: 3, cgroupRoot,
    onCgroupCreated: (path) => writeFileSync(join(path, 'memory.events'), 'oom_kill 0\n'),
  });
  const json = JSON.parse(JSON.stringify(result));
  expect(json.unsharded).toMatchObject({ verdict: 'unmeasured', oomCount: 1, oomCountStatus: 'confirmed', unknownTerminations: 0 });
  expect(json.sharded).toMatchObject({ verdict: 'unmeasured', oomCount: 1, oomCountStatus: 'confirmed', unknownTerminations: 0 });
  expect(json.verdictAgrees).toBe(false);
});

test('incomplete or missing JUnit cases cannot be called matching verdicts', () => {
  const xml = '<testsuites><testsuite file="test/a.test.ts" tests="1"><testcase name="a" file="test/a.test.ts" /></testsuite></testsuites>';
  expect(readCases(xml, ['test/a.test.ts'])).toEqual({ 'test/a.test.ts > a': 'passed' });
  expect(() => readCases(xml, ['test/a.test.ts', 'test/b.test.ts'])).toThrow('missing JUnit suites');
  expect(() => readCases(xml.replace('tests="1"', 'tests="2"'), ['test/a.test.ts'])).toThrow('incomplete JUnit suite');
});

test('a stale TSV is calibrated from the missing real file before both modes are compared', async () => {
  const fixture = fakeSuite();
  const path = join(fixture.repo, 'old.tsv');
  writeFileSync(path, `file\tsecs\trss_mb\n${fixture.files.slice(0, 5).map((file) => `${file}\t1\t64`).join('\n')}\n`);
  const { rss, seconds } = readGateMeasurements(path);
  expect(rss.has(fixture.files[5]!)).toBe(false);
  await calibrateMissingGateMeasurements({ repo: fixture.repo, files: fixture.files, rss, seconds });
  expect(rss.get(fixture.files[5]!)).toBeGreaterThan(0);
  expect(seconds.get(fixture.files[5]!)).toBeGreaterThan(0);
  const result = await measureGateComparison({ ...fixture, rss, seconds, commit: '1'.repeat(40), shards: 3 });
  expect(result).toMatchObject({ files: 6, verdictAgrees: true,
    unsharded: { verdict: 'passed' }, sharded: { verdict: 'passed' } });
});

test('main emits one JSON line for both modes when its historical TSV lacks a new gate test', async () => {
  const fixture = fakeSuite();
  const path = join(fixture.repo, 'old.tsv');
  writeFileSync(path, `file\tsecs\trss_mb\n${fixture.files.slice(0, 5).map((file) => `${file}\t1\t64`).join('\n')}\n`);
  const wrapper = join(fixture.repo, 'git');
  writeFileSync(wrapper, `#!/bin/sh
case "$1" in
  rev-parse) if [ "$2" = '--show-toplevel' ]; then printf '%s\\n' "$PWD"; else printf '%040d\\n' 1; fi ;;
  symbolic-ref) printf 'main\\n' ;;
  status) : ;;
  ls-files) printf '%s\\n' ${fixture.files.map((file) => `'${file}'`).join(' ')} ;;
  *) exit 1 ;;
esac
`);
  chmodSync(wrapper, 0o755);
  const previousPath = process.env.PATH;
  const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    process.env.PATH = `${fixture.repo}${delimiter}${previousPath ?? ''}`;
    expect(await main(['--shards', '3', '--measurements', path], fixture.repo)).toBe(0);
    const lines = write.mock.calls.map(([value]) => String(value));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ files: 6, verdictAgrees: true,
      unsharded: { mode: 'unsharded', verdict: 'passed' }, sharded: { mode: 'sharded', verdict: 'passed' } });
  } finally {
    process.env.PATH = previousPath;
    write.mockRestore();
  }
});

test('a missing TSV row with an incomplete run cannot be fabricated as a planning input', async () => {
  const fixture = fakeSuite();
  const missing = fixture.files[5]!;
  writeFileSync(join(fixture.repo, missing), "import { test } from 'bun:test'; test('exits', () => process.exit(137));\n");
  const rss = new Map(fixture.rss);
  const seconds = new Map(fixture.seconds);
  rss.delete(missing);
  seconds.delete(missing);
  await expect(calibrateMissingGateMeasurements({ repo: fixture.repo, files: fixture.files, rss, seconds }))
    .rejects.toThrow(`calibration JUnit incomplete for ${missing}`);
  expect(rss.has(missing)).toBe(false);
});

test('measured planning inputs reject missing rows instead of inventing peak RSS', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-shards-tsv-'));
  scratch.push(repo);
  const path = join(repo, 'measure.tsv');
  writeFileSync(path, 'file\tsecs\trss_mb\ntest/a.test.ts\t1\t100\n');
  expect(readGateMeasurements(path).rss.get('test/a.test.ts')).toBe(100);
  writeFileSync(path, 'file\tsecs\trss_mb\ntest/a.test.ts\t1\t\n');
  expect(() => readGateMeasurements(path)).toThrow('invalid measurement row');
});
