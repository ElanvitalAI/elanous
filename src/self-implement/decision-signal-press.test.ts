import { describe, expect, mock, test } from 'bun:test';
import * as childProcess from 'node:child_process';

const realChildProcess = { ...childProcess };
const spawnResults: ReturnType<typeof childProcess.spawnSync>[] = [];
const spawnOptions: Parameters<typeof childProcess.spawnSync>[2][] = [];

mock.module('node:child_process', () => ({
  ...childProcess,
  spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => {
    spawnOptions.push(args[2]);
    return spawnResults.shift() ?? realChildProcess.spawnSync(...args);
  },
}));

const { parseSafeDecisionSignalCommand, pressDecisionSignal, pressDecisionSignals } = await import('./decision-signal-press.js');

const classifications = {
  kinds: {
    condition: true,
    observation: true,
    expected: true,
  },
  observations: {
    extracted: true,
  },
};

describe('parseSafeDecisionSignalCommand', () => {
  test('names shell syntax and allowlist rejections while preserving the unsafe-command ledger reason', () => {
    const shellComposed = 'bun bin/elanous.mjs logs --category x --json | tee output.json';
    const allowlistMiss = 'bun bin/elanous.mjs provider codex usage --account b';

    expect(parseSafeDecisionSignalCommand(shellComposed)).toEqual({ reason: 'shell-syntax-mixed' });
    expect(parseSafeDecisionSignalCommand(allowlistMiss)).toEqual({ reason: 'not-allowlisted' });
    expect(parseSafeDecisionSignalCommand('grep -c needle src/onboarding.ts')).toEqual({ reason: 'not-allowlisted' });
    expect(pressDecisionSignals({ kinds: null, observations: null, signals: [{ signal: shellComposed, command: shellComposed, kind: 'real' }] }, process.cwd()).unpressed).toEqual([
      { signal: shellComposed, command: shellComposed, kind: 'real', reason: 'unsafe-command' },
    ]);
  });

  test('parses declared read-only elanous observations into argv', () => {
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs logs --category x --json')).toEqual({
      executable: 'bun', args: ['bin/elanous.mjs', 'logs', '--category', 'x', '--json'],
    });
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs logs --category x --json-data')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs pty snapshot ref')).toEqual({
      executable: 'bun', args: ['bin/elanous.mjs', 'pty', 'snapshot', 'ref'],
    });
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs pty lineage ref --json')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs self entrances --json')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs self running-runs --json')).toBeDefined();
  });

  test('rejects unquoted multi-word rg patterns as ambiguous', () => {
    expect(parseSafeDecisionSignalCommand('rg -c create it later src/onboarding.ts')).toEqual({
      reason: 'ambiguous-rg-c-arguments',
    });
  });

  test('parses quoted multi-word rg patterns as one argv slot', () => {
    expect(parseSafeDecisionSignalCommand("rg -c 'create it later' src/onboarding.ts")).toEqual({
      executable: 'rg', args: ['-c', 'create it later', 'src/onboarding.ts'],
    });
  });

  test('allows three-token rg -c commands with a single-word pattern', () => {
    expect(parseSafeDecisionSignalCommand('rg -c create src/onboarding.ts')).toEqual({
      executable: 'rg', args: ['-c', 'create', 'src/onboarding.ts'],
    });
  });

  test('rejects unmatched quotes and shell metacharacters', () => {
    expect(parseSafeDecisionSignalCommand("rg -c 'unclosed src/onboarding.ts")).toEqual({ reason: 'shell-syntax-mixed' });
    for (const command of ['rg -c needle path | cat', 'rg -c needle path; cat', 'rg -c $(echo needle) path']) {
      expect(parseSafeDecisionSignalCommand(command)).toEqual({ reason: 'shell-syntax-mixed' });
    }
  });

  test('preserves existing bun forms', () => {
    expect(parseSafeDecisionSignalCommand('bun test src/self-implement/decision-signal-press.test.ts')).toBeDefined();
    expect(parseSafeDecisionSignalCommand('bun scripts/ask-marker-check.ts docs/goals/x.md')).toBeDefined();
  });

  test('matches elanous command names exactly instead of accepting prefixes', () => {
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs logstash --category x --json')).toEqual({ reason: 'not-allowlisted' });
    expect(parseSafeDecisionSignalCommand('bun bin/elanous.mjs self entrance --json')).toEqual({ reason: 'not-allowlisted' });
  });
});

describe('pressDecisionSignals execution failures', () => {
  test('names ETIMEDOUT as timed-out while preserving its error text and timeout', () => {
    const error = Object.assign(new Error('spawnSync bun ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnResults.push({ error, status: null, signal: 'SIGTERM', stdout: '', stderr: '' } as unknown as ReturnType<typeof childProcess.spawnSync>);

    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [{ signal: 'timeout', command: 'bun test src/self-implement/decision-signal-press.test.ts', kind: 'unit-test' }],
    }, process.cwd());

    expect(result).toMatchObject({
      pressedGreen: [],
      pressedRed: [],
      pressedBaselineOnly: [],
      unpressed: [{ reason: 'timed-out', error: 'spawnSync bun ETIMEDOUT' }],
      pressedCount: 0,
    });
    expect(spawnOptions.at(-1)?.timeout).toBe(180_000);
  });

  test('keeps genuine ENOENT start failures named start-failed', () => {
    const error = Object.assign(new Error('spawnSync bun ENOENT'), { code: 'ENOENT' });
    spawnResults.push({ error, status: null, signal: null, stdout: '', stderr: '' } as unknown as ReturnType<typeof childProcess.spawnSync>);

    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [{ signal: 'missing executable', command: 'bun test src/self-implement/decision-signal-press.test.ts', kind: 'unit-test' }],
    }, process.cwd());

    expect(result.unpressed).toEqual([{
      signal: 'missing executable',
      command: 'bun test src/self-implement/decision-signal-press.test.ts',
      kind: 'unit-test',
      reason: 'start-failed',
      error: 'spawnSync bun ENOENT',
    }]);
  });
});

describe('pressDecisionSignals rg -c wider presses', () => {
  test('records matches outside the failed target without changing its red verdict', () => {
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [{ signal: 'exists elsewhere', command: "rg -c 'records matches outside the failed target' src/self-implement/decision-signal-press.ts", kind: 'real' }],
    }, process.cwd());

    expect(result.pressedGreen).toEqual([]);
    expect(result.pressedRed).toHaveLength(1);
    expect(result.pressedRed[0]?.widerMatchCount).toBeGreaterThanOrEqual(1);
  });

  test('records zero for a pathless re-press when the pattern exists nowhere', () => {
    const pattern = ['decision-signal', 'wider-nowhere'].join('-');
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [{ signal: 'exists nowhere', command: `rg -c ${pattern} src/self-implement/decision-signal-press.ts`, kind: 'real' }],
    }, process.cwd());

    expect(result.pressedRed).toHaveLength(1);
    expect(result.pressedRed[0]?.widerMatchCount).toBe(0);
  });
});

describe('pressDecisionSignals baseline-only failures', () => {
  const command = 'bun test src/self-implement/decision-signal-press.test.ts';
  const signal = { signal: 'baseline compare', command, kind: 'unit-test' as const };

  function pushExit(stdout: string, status = 1): void {
    spawnResults.push({ error: undefined, status, signal: null, stdout, stderr: '' } as unknown as ReturnType<typeof childProcess.spawnSync>);
  }

  test('moves a signal out of pressedRed when every (fail) name also failed on the baseline', () => {
    pushExit('(fail) a > x\n');
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [signal],
    }, process.cwd(), {
      baselineRun: () => ({ stdout: '(fail) a > x\n' }),
    });

    expect(result.pressedRed).toEqual([]);
    expect(result.pressedBaselineOnly).toEqual([
      expect.objectContaining({
        signal: 'baseline compare',
        command,
        exitCode: 1,
        baselineFailedNames: ['a > x'],
      }),
    ]);
    expect(result.pressedCount).toBe(1);
  });

  test('reads (fail) names from stderr — real bun test prints them there, not on stdout', () => {
    // 🩸 #20114 착지 직후 실물: dev-cli.test.ts 의 기존 3 fail 이 stderr 에만 찍혀 「names could not be extracted」 → 늘 빨강.
    // 실제 모양: 파일 머리줄 ⊕ stderr 의 (fail) 줄(추출기는 이름 앞에 파일 경로를 붙인다)
    spawnResults.push({ error: undefined, status: 1, signal: null, stdout: 'bun test v1.3.12\n', stderr: '\nsrc/a.test.ts:\n(fail) a > x [0.61ms]\n 1 fail\n' } as unknown as ReturnType<typeof childProcess.spawnSync>);
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [signal],
    }, process.cwd(), {
      baselineRun: () => ({ stdout: '', stderr: '\nsrc/a.test.ts:\n(fail) a > x [0.4ms]\n' }),
    });

    expect(result.pressedRed).toEqual([]);
    expect(result.pressedBaselineOnly).toEqual([
      expect.objectContaining({ signal: 'baseline compare', baselineFailedNames: ['src/a.test.ts > a > x'] }),
    ]);
  });

  test('keeps pressedRed when any post-change failure passed on the baseline', () => {
    pushExit('(fail) a > x\n(fail) a > y\n');
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [signal],
    }, process.cwd(), {
      baselineRun: () => ({ stdout: '(fail) a > x\n' }),
    });

    expect(result.pressedBaselineOnly).toEqual([]);
    expect(result.pressedRed).toEqual([
      expect.objectContaining({
        signal: 'baseline compare',
        exitCode: 1,
        baselineReason: 'baseline passed: a > y',
      }),
    ]);
  });

  test('keeps pressedRed and records the reason when the baseline runner throws', () => {
    pushExit('(fail) a > x\n');
    const result = pressDecisionSignals({
      kinds: null,
      observations: null,
      signals: [signal],
    }, process.cwd(), {
      baselineRun: () => { throw new Error('baseline timed out'); },
    });

    expect(result.pressedBaselineOnly).toEqual([]);
    expect(result.pressedRed).toEqual([
      expect.objectContaining({
        signal: 'baseline compare',
        exitCode: 1,
        baselineReason: 'baseline timed out',
      }),
    ]);
  });
});

describe('pressDecisionSignal', () => {
  test('passes existing classifier output through without deriving another classification', async () => {
    const observed: typeof classifications[] = [];

    const result = await pressDecisionSignal(classifications, async (input) => {
      observed.push(input);
      return {
        kinds: input.kinds,
        observations: input.observations,
      };
    });

    expect(observed).toEqual([classifications]);
    expect(result).toEqual(classifications);
  });

  test('preserves arbitrary execution policy results', async () => {
    const result = await pressDecisionSignal(classifications, ({ kinds, observations }) =>
      `${kinds.condition}:${observations.extracted}`);

    expect(result).toBe('true:true');
  });

  test('does not swallow synchronous press failures', () => {
    expect(() => pressDecisionSignal(classifications, () => {
      throw new Error('press unavailable');
    })).toThrow('press unavailable');
  });
});

// METHOD v116 — 그래프 원장 값 신호가 검사기를 통과한다(읽기만) · 실행하는 것은 여전히 거부.
import { parseSafeDecisionSignalCommand as parseV116 } from './decision-signal-press.js';
describe('METHOD v116 graph ledger observations', () => {
  test('logs --event … --json and graph status <id> --json are read-only observations', () => {
    expect(parseV116('bun bin/elanous.mjs logs --event pipeline-node-entry --json --since 1h')).toMatchObject({ executable: 'bun' });
    expect(parseV116('bun bin/elanous.mjs graph status docs-publish --json')).toMatchObject({ executable: 'bun' });
  });
  test('graph run (even --dry-run) and logs without --json stay rejected', () => {
    expect(parseV116('bun bin/elanous.mjs graph run graphs/ops/docs-publish.yaml --dry-run --json')).toEqual({ reason: 'not-allowlisted' });
    expect(parseV116('bun bin/elanous.mjs logs --event pipeline-node-entry')).toEqual({ reason: 'not-allowlisted' });
  });
});
