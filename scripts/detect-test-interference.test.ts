import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  detectTestInterference,
  EXIT_INTERFERENCE,
  EXIT_INVALID_INPUT,
  EXIT_NO_INTERFERENCE,
  EXIT_UNMEASURABLE,
  failedNamesFromStreams,
  formatIsolatedFailureSummary,
  main,
  MAX_ISOLATED_FAILURE_FILES,
  parseFailedTestNames,
  runBunTest,
  type BunSpawn,
  type RunnerResult,
  type TestRunner,
} from './detect-test-interference.js';

const result = (pass: number, fail: number, files: number = 1): RunnerResult => ({
  stdout: `${pass} pass\n${fail} fail\nRan ${pass + fail} tests across ${files} files.\n`, stderr: '', exitCode: fail === 0 ? 0 : 1,
});

function fakeRunner(outputs: Record<string, RunnerResult>): { runner: TestRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (files) => {
      calls.push([...files]);
      return outputs[files.join(' ')]!;
    },
  };
}

describe('detect test interference', () => {
  test('keeps only file and test names printed for failures', async () => {
    const output = 'src/a.test.ts:\n(pass) okay\n(fail) wrong answer [0.09ms]\nsrc/b.test.ts:\n(fail) other case [1.2ms]\n';
    expect(parseFailedTestNames(output)).toEqual({ files: ['src/a.test.ts', 'src/b.test.ts'], tests: ['wrong answer', 'other case'] });
    expect(parseFailedTestNames('(fail) name without heading [1ms]')).toEqual({ files: [], tests: ['name without heading'] });
    expect(parseFailedTestNames('1 fail\nRan 1 test across 1 file.')).toEqual({ files: [], tests: [] });
    expect(parseFailedTestNames('src/a.spec.ts:\n(fail) spec case [1ms]')).toEqual({ files: ['src/a.spec.ts'], tests: ['spec case'] });
    expect(parseFailedTestNames('src/a.test.ts:\n1 fail\nRan 1 test across 1 file.\n(fail) detached case [1ms]'))
      .toEqual({ files: [], tests: ['detached case'] });
    expect(parseFailedTestNames('src/a.test.ts:\nother.ts:\n(fail) detached case [1ms]'))
      .toEqual({ files: [], tests: ['detached case'] });
    expect(parseFailedTestNames('src/a.test.ts:\nother.txt:\n(fail) detached case [1ms]'))
      .toEqual({ files: [], tests: ['detached case'] });
    expect(parseFailedTestNames('src/a.test.ts:\n(fail) case with colon:'))
      .toEqual({ files: ['src/a.test.ts'], tests: ['case with colon:'] });
    expect(failedNamesFromStreams({ stdout: 'src/a.test.ts:\n1 fail\nRan 1 test across 1 file.\n', stderr: '(fail) stderr case [1ms]', exitCode: 1 }))
      .toEqual({ files: [], tests: ['stderr case'] });
  });

  test('reports interference and numeric difference when the combined run adds failures', async () => {
    const { runner } = fakeRunner({ A: result(3, 0), B: result(4, 0), 'A B': result(2, 5, 2) });
    const lines: string[] = [];
    expect(await main(['A', 'B'], runner, (line) => lines.push(line))).toBe(EXIT_INTERFERENCE);
    expect(lines.join('\n')).toContain('INTERFERENCE');
    expect(lines.join('\n')).toContain('difference: 5');
  });

  test('reports isolated failing files and suppresses passing file paths without changing no-interference status', async () => {
    const passingA = 'pass-alpha.test.ts';
    const failingB = 'failed-bravo.test.ts';
    const passingC = 'pass-charlie.test.ts';
    const { runner } = fakeRunner({
      [passingA]: result(3, 0),
      [failingB]: result(1, 3),
      [passingC]: result(4, 0),
      [`${passingA} ${failingB} ${passingC}`]: result(5, 3, 3),
    });
    const lines: string[] = [];
    expect(await main([passingA, failingB, passingC], runner, (line) => lines.push(line))).toBe(EXIT_NO_INTERFERENCE);
    const output = lines.join('\n');
    expect(output).toContain('isolated failures: 3');
    expect(output).toContain(`${failingB} (3 fail)`);
    expect(output).not.toContain(passingA);
    expect(output).not.toContain(passingC);
  });

  test('does not call pre-existing isolated failures interference', async () => {
    const { runner } = fakeRunner({ A: result(3, 2), B: result(4, 0), 'A B': result(5, 2, 2) });
    expect(await main(['A', 'B'], runner, () => {})).toBe(EXIT_NO_INTERFERENCE);
  });

  test('bounds isolated failure file summaries and reports the numeric remainder', async () => {
    const files = Array.from({ length: MAX_ISOLATED_FAILURE_FILES + 2 }, (_, index) => `F${index}`);
    const report = await detectTestInterference(files, fakeRunner(Object.fromEntries([
      ...files.map((file) => [file, result(0, 1)]),
      [files.join(' '), result(0, files.length, files.length)],
    ])).runner);
    const summary = formatIsolatedFailureSummary(report);
    expect(summary).toContain(`F${MAX_ISOLATED_FAILURE_FILES - 1} (1 fail)`);
    expect(summary).not.toContain(`F${MAX_ISOLATED_FAILURE_FILES} (1 fail)`);
    expect(summary).toContain('; 2 more');
  });

  test('preserves the unmeasurable report text', async () => {
    const { runner } = fakeRunner({ A: result(3, 0), B: { stdout: 'runner crashed', stderr: '', exitCode: 1 }, 'A B': result(7, 0, 2) });
    const lines: string[] = [];
    expect(await main(['A', 'B'], runner, (line) => lines.push(line))).toBe(EXIT_UNMEASURABLE);
    expect(lines).toEqual(['UNMEASURABLE test-interference order: A B\naffected runs: B (test summary unavailable, ambiguous, or ran zero files)']);
  });

  test('marks missing, debug-only, and multiple summaries unmeasurable', async () => {
    for (const output of [
      'runner crashed',
      'debug: Ran 2 tests across 1 file\n0 fail',
      '0 pass\n0 fail\nRan 0 tests across 0 files.\nRan 2 tests across 1 file.',
    ]) {
      const { runner } = fakeRunner({ A: result(3, 0), B: { stdout: output, stderr: '', exitCode: 1 }, 'A B': result(7, 0, 2) });
      const lines: string[] = [];
      expect(await main(['A', 'B'], runner, (line) => lines.push(line))).toBe(EXIT_UNMEASURABLE);
      expect(lines.join('\n')).toContain('UNMEASURABLE');
      expect(lines.join('\n')).toContain('B (test summary unavailable, ambiguous, or ran zero files)');
    }
  });

  test('reports each supplied order and its distinct combined difference', async () => {
    const { runner, calls } = fakeRunner({
      A: result(1, 0),
      B: result(1, 0),
      'A B': result(0, 5, 2),
      'B A': result(0, 2, 2),
    });
    const abLines: string[] = [];
    const baLines: string[] = [];
    expect(await main(['A', 'B'], runner, (line) => abLines.push(line))).toBe(EXIT_INTERFERENCE);
    expect(await main(['B', 'A'], runner, (line) => baLines.push(line))).toBe(EXIT_INTERFERENCE);
    expect(abLines.join('\n')).toContain('difference: 5');
    expect(baLines.join('\n')).toContain('difference: 2');
    expect(calls).toEqual([['A'], ['B'], ['A', 'B'], ['B'], ['A'], ['B', 'A']]);
  });

  test('rejects empty input with usage and a distinct nonzero exit code', async () => {
    const lines: string[] = [];
    expect(await main([], async () => result(0, 0), (line) => lines.push(line))).toBe(EXIT_INVALID_INPUT);
    expect(lines).toEqual(['Usage: bun scripts/detect-test-interference.ts <test-file> [test-file...]']);
  });

  test('R7: bun test runs in an isolated env — temp HOME/state, no credentials, remote parent off, PATH kept, root removed', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const spawn: BunSpawn = ((options) => {
      seen = options.env;
      return { stdout: new Blob(['1 pass\n0 fail\nRan 1 test across 1 file.\n']).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0), signalCode: null };
    }) as BunSpawn;
    const source = { HOME: '/Users/operator', PATH: '/opt/homebrew/bin:/usr/bin', OPENAI_API_KEY: 'sk-x', ELANOUS_STATE_DIR: '/Users/operator/.elanous', ELANOUS_STATE_DIR_SOURCE: 'derived', ELANOUS_RUN_ID: 'run-parent', ELANOUS_TA_PARENT_HOST: 'node-b' };
    await runBunTest(['a.test.ts'], spawn, '/repo', source);
    expect(seen!.HOME).not.toBe('/Users/operator');
    expect(seen!.HOME!.startsWith(tmpdir())).toBe(true);
    expect(seen!.ELANOUS_STATE_DIR!.startsWith(seen!.HOME!)).toBe(true);
    expect(seen!.ELANOUS_TA_PARENT_HOST).toBe('off');
    expect(seen!.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(seen!.OPENAI_API_KEY).toBeUndefined();
    expect(seen!.ELANOUS_STATE_DIR_SOURCE).toBeUndefined();
    expect(seen!.ELANOUS_RUN_ID).toBeUndefined();
    expect(existsSync(seen!.HOME!)).toBe(false);
  });

  test('forwards supplied path spellings and selected cwd to Bun', async () => {
    const spawns: Array<{ cmd: string[]; cwd: string }> = [];
    const spawn: BunSpawn = ((options) => {
      spawns.push({ cmd: options.cmd, cwd: options.cwd });
      return {
        stdout: new Blob(['2 pass\\n0 fail\\nRan 2 tests across 2 files.\\n']).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        signalCode: null,
      };
    }) as BunSpawn;
    await runBunTest(['foo.test.ts', './nested/bar.test.ts', '/tmp/baz.test.ts'], spawn, '/repo');
    expect(spawns).toEqual([{
      cmd: [process.execPath, 'test', 'foo.test.ts', './nested/bar.test.ts', '/tmp/baz.test.ts'],
      cwd: '/repo',
    }]);
  });
});
