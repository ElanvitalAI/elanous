import { describe, expect, test } from 'bun:test';
import { selectCorpusItems, corpusFiltersFromEnv, assertGradableItems, assertProbeOutsideCorpus, normalizeCorpusItems, classifyRouting, closedTurnBoundary, logIds, logRowKey, passSummary, positiveInteger, positiveIntegerList, summarizeCorpusRun, toolsForSessionTurn, turnTextBytes, turnStartedAfter, unavailableExpectedToolIds, wilsonInterval } from './lib/nl-routing-measurement.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { commandResult, createElanousLiveTurnRunner, endsLiveRun, measureLiveTurn, provePtyDrivesSession, verifyPtySession, waitForOpenTurnClose, type LiveTurnRunner } from './lib/nl-routing-live.js';
import { resolveTruncatedTurnWaitMs, runLiveCorpus } from './lib/nl-routing-corpus-run.js';
import { truncatedTurnsSummary } from './lib/nl-routing-live-summary.js';
import { main as runCorpusMain, resolveCorpusRunSafety, NL_ROUTING_UNSAFE_RUN_ENV } from './measure-nl-routing-corpus.js';
import { EVAL_PROMPT_TOOL_SURFACES, type EvalPromptResult } from '../src/eval-prompt-cli.js';

const CORPUS_RUNNER_PATH = resolve(import.meta.dir, 'measure-nl-routing-corpus.ts');
const resolveCorpusRunSafetyFromProcessEnv = (surfaceToolNames: readonly string[]) => resolveCorpusRunSafety(process.env, undefined, surfaceToolNames);

async function runCorpusRunner(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', CORPUS_RUNNER_PATH],
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function runEmptyCorpus(env: Record<string, string>, surfaceTools: readonly string[] = ['Read']): Promise<{ logs: string[]; output: Record<string, unknown>; cwds: Array<string | undefined> }> {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-corpus-'));
  const out = resolve(outDir, 'corpus.json');
  const logs: string[] = [];
  const cwds: Array<string | undefined> = [];
  try {
    process.argv = process.argv.slice(0, 2);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv, env, { CORPUS_OUT: out, CORPUS_IDS: 'test-1', CORPUS_REPEATS: '1', CORPUS_BUDGETS: '1', CORPUS_CONCURRENCY: '1' });
    console.log = ((line: string) => logs.push(line)) as typeof console.log;
    await runCorpusMain(
      () => ({ description: 'test', surface: 'cli', tiers: { test: 'test' }, items: [{ id: 'test-1', tier: 'test', prompt: 'test', accept: [] }] }),
      async (options): Promise<EvalPromptResult> => {
        cwds.push(options.cwd);
        return {
          text: '', modelFamily: 'test', modelId: 'test', turnCount: 0, toolCallCount: 0,
          toolBreakdown: {}, toolSurface: 'cli', surfaceToolNames: [], surfaceToolCount: 0,
          durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
        };
      },
      resolveCorpusRunSafetyFromProcessEnv,
      () => surfaceTools,
    );
    return { logs, output: JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>, cwds };
  } finally {
    console.log = originalLog;
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('NL routing corpus runner safety gate', () => {
  test('fail-closed before corpus loading when observe-only is disabled', async () => {
    const safetyError = () => resolveCorpusRunSafety({}, { enabled: false, source: 'default' }, ['SelfImplement', 'Bash', 'Edit', 'Write']);
    expect(safetyError).toThrow('exposed mutating tools can modify this worktree');
    expect(safetyError).toThrow('tools.selfImplement.observeOnly is disabled (source: default)');
    expect(safetyError).toThrow('Unprotected host mutating tools exposed: Bash, Edit, Write.');
    expect(safetyError).toThrow('Exposed mutating tools: Bash, Edit, Write, SelfImplement.');
    expect(safetyError).toThrow(NL_ROUTING_UNSAFE_RUN_ENV);

    let corpusLoads = 0;
    const originalEnv = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv, { CORPUS_CWD: tmpdir() });
      await expect(runCorpusMain(
        () => {
          corpusLoads += 1;
          return { description: 'test', surface: 'cli', tiers: {}, items: [] };
        },
        async (): Promise<EvalPromptResult> => { throw new Error('runPrompt must not run'); },
        safetyError,
      )).rejects.toThrow('exposed mutating tools can modify this worktree');
      expect(corpusLoads).toBe(1);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });

  test('the runner entrypoint stops after final surface resolution with non-zero exit and safety guidance', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-cwd-'));
    const corpusPath = resolve(cwd, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify({ description: 'test', surface: 'cli', tiers: {}, items: [] }));
    try {
      const result = await runCorpusRunner({ CORPUS_CWD: cwd, CORPUS_PATH: corpusPath });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('exposed mutating tools can modify this worktree');
      expect(result.stderr).toContain('Unprotected host mutating tools exposed: Bash, Edit, Write.');
      expect(result.stderr).toContain('Exposed mutating tools: Bash, Edit, Write.');
      expect(result.stderr).toContain('Known mutating tool surface: SelfImplement, Bash, Edit, Write.');
      expect(result.stderr).toContain(NL_ROUTING_UNSAFE_RUN_ENV);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('observe-only alone still refuses exposed Bash/Edit/Write without unsafe bypass', () => {
    const safetyError = () => resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['SelfImplement', 'Bash', 'Edit', 'Write']);
    expect(safetyError).toThrow('SelfImplement observe-only is enabled (source: flag).');
    expect(safetyError).toThrow('Unprotected host mutating tools exposed: Bash, Edit, Write.');
    expect(safetyError).toThrow('Exposed mutating tools: Bash, Edit, Write.');
    expect(safetyError).toThrow(NL_ROUTING_UNSAFE_RUN_ENV);
    expect(resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['SelfImplement'])).toEqual({
      observeOnly: { enabled: true, source: 'flag' },
      bypassed: false,
      exposedMutatingTools: [],
    });
    expect(() => resolveCorpusRunSafety({}, { enabled: false, source: 'config' }, ['SelfImplement'])).toThrow('Exposed mutating tools: SelfImplement.');
  });

  test('requires CORPUS_CWD after explicit unsafe bypass and before corpus loading', async () => {
    const result = await runCorpusRunner({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CORPUS_CWD is required; provide the tool working directory for corpus measurement.');
    expect(result.stderr).not.toContain('CORPUS_PATH is required');
  });

  test('requires an external CORPUS_PATH after CORPUS_CWD is explicit', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-cwd-'));
    try {
      const result = await runCorpusRunner({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1', CORPUS_CWD: cwd });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('CORPUS_PATH is required; provide the corpus JSON path to measure.');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('invalid CORPUS_SURFACE stops before measurement with an authoritative valid-values message', async () => {
    const invalidSurface = 'coding';
    const cwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-cwd-'));
    try {
      const result = await runCorpusRunner({
        [NL_ROUTING_UNSAFE_RUN_ENV]: '1',
        CORPUS_CWD: cwd,
        CORPUS_SURFACE: invalidSurface,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`Invalid CORPUS_SURFACE ${JSON.stringify(invalidSurface)}`);
      expect(result.stderr).toContain(EVAL_PROMPT_TOOL_SURFACES.join(', '));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('permits observe-only only when the active surface has no mutating tools and preserves its decision source', () => {
    expect(resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['Read'])).toEqual({
      observeOnly: { enabled: true, source: 'flag' },
      bypassed: false,
      exposedMutatingTools: [],
    });
  });

  test('does not report an unsafe bypass when no mutating tools are exposed', () => {
    expect(resolveCorpusRunSafety({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1' }, { enabled: true, source: 'flag' }, ['Read'])).toEqual({
      observeOnly: { enabled: true, source: 'flag' },
      bypassed: false,
      exposedMutatingTools: [],
    });
  });

  test('records an explicit unsafe bypass when mutating tools are exposed', () => {
    expect(resolveCorpusRunSafety({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1' }, { enabled: false, source: 'config' }, ['SelfImplement', 'Bash', 'Edit', 'Write'])).toEqual({
      observeOnly: { enabled: false, source: 'config' },
      bypassed: true,
      exposedMutatingTools: ['Bash', 'Edit', 'Write', 'SelfImplement'],
    });
  });

  test('runner startup logs tool cwd and passes CORPUS_CWD to runEvalPrompt without using process cwd', async () => {
    const toolCwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-tool-cwd-'));
    try {
      const result = await runEmptyCorpus({ ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1', CORPUS_CWD: toolCwd });
      expect(result.logs[0]).toContain('서피스 cli (유효 목록 1/3)');
      expect(result.logs[0]).toContain(`tool-cwd ${toolCwd}`);
      expect(result.logs[0]).toContain('observe-only true (flag)');
      expect(result.logs[0]).toContain('exposed-mutating-tools (none)');
      expect(result.logs[0]).toContain('unsafe-bypass false');
      expect(result.cwds).toEqual([toolCwd]);
      expect(result.cwds[0]).not.toBe(process.cwd());
      expect(result.output.observeOnly).toEqual({ enabled: true, source: 'flag' });
      expect(result.output.unsafeBypass).toBe(false);
      expect(result.output.records).toHaveLength(1);
    } finally {
      rmSync(toolCwd, { recursive: true, force: true });
    }
  });

  test('runner startup and CORPUS_OUT record only an actual unsafe bypass', async () => {
    const toolCwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-tool-cwd-'));
    try {
      const result = await runEmptyCorpus({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1', CORPUS_CWD: toolCwd }, ['Bash']);
      expect(result.logs[0]).toContain(`tool-cwd ${toolCwd}`);
      expect(result.logs[0]).toContain('observe-only false (default)');
      expect(result.logs[0]).toContain('exposed-mutating-tools Bash');
      expect(result.logs[0]).toContain('unsafe-bypass true');
      expect(result.output.observeOnly).toEqual({ enabled: false, source: 'default' });
      expect(result.output.unsafeBypass).toBe(true);
      expect(result.output.exposedMutatingTools).toEqual(['Bash']);
      expect(result.output.records).toHaveLength(1);
    } finally {
      rmSync(toolCwd, { recursive: true, force: true });
    }
  });

  // 🚨 73차 — 요약이 `rejected-tool` 을 «세지 않던» 결함(HARNESS-N 넷이 코퍼스 최초로 reject 를 쓰자마자 드러났다).
  //   ⛔ 반증 지점: ③ 칸을 지우면 「거부 목록의 툴이 «실제로» 발화했는데 오선택 0」이 다시 보고된다.
  test('거부 목록의 툴이 발화하면 요약의 ③ 칸이 «센다»', async () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalLog = console.log;
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-corpus-'));
    const out = resolve(outDir, 'corpus.json');
    const logs: string[] = [];
    try {
      process.argv = process.argv.slice(0, 2);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv, {
        [NL_ROUTING_UNSAFE_RUN_ENV]: '1', CORPUS_CWD: outDir, CORPUS_OUT: out, CORPUS_SURFACE: 'chat',
        CORPUS_REPEATS: '1', CORPUS_BUDGETS: '1', CORPUS_CONCURRENCY: '1',
      });
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await runCorpusMain(
        () => ({
          description: 'test', surface: 'cli', tiers: { test: 'test' },
          items: [{ id: 'named', tier: 'test', prompt: '하니스로 해줘', accept: ['RunDevHarness'], reject: ['SelfImplement'] } as never],
        }),
        async (options): Promise<EvalPromptResult> => ({
          text: '', modelFamily: 'test', modelId: 'test', turnCount: 1, toolCallCount: 1,
          // 거부 목록의 툴이 «실제로» 발화한다.
          toolBreakdown: { SelfImplement: 1 }, toolSurface: options.tools!,
          surfaceToolNames: ['RunDevHarness', 'SelfImplement'], surfaceToolCount: 2,
          durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
        }),
        resolveCorpusRunSafetyFromProcessEnv,
        () => ['RunDevHarness', 'SelfImplement'],
      );
      const output = JSON.parse(readFileSync(out, 'utf8')) as { records: { outcome: string }[] };
      expect(output.records[0]?.outcome).toBe('rejected-tool');
      expect(logs).toContain('  실패 분류 — ①미발사 0 · ②툴 오선택 0 · ③거부툴 선택 1 (측정 가능 실행 1)\n');
    } finally {
      process.argv = originalArgv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      console.log = originalLog;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('reports an item tier without metadata instead of silently dropping its k/n result', async () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalLog = console.log;
    const logs: string[] = [];
    try {
      process.argv = process.argv.slice(0, 2);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv, {
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1', CORPUS_CWD: tmpdir(),
        CORPUS_REPEATS: '1', CORPUS_BUDGETS: '1', CORPUS_CONCURRENCY: '1',
      });
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await runCorpusMain(
        () => ({
          description: 'test', surface: 'cli', tiers: {},
          items: [{ id: 'undocumented-item', tier: 'UNDOCUMENTED', prompt: 'test', accept: ['Read'] }],
        }),
        async (): Promise<EvalPromptResult> => ({
          text: '', modelFamily: 'test', modelId: 'test', turnCount: 1, toolCallCount: 1,
          toolBreakdown: { Read: 1 }, toolSurface: 'cli', surfaceToolNames: ['Read'], surfaceToolCount: 1,
          durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
        }),
        resolveCorpusRunSafetyFromProcessEnv,
        () => ['Read'],
      );
      expect(logs).toContain('  UNDOCUMENTED ((설명 없음))');
      expect(logs).toContain('    문항별 undocumented-item 1/1');
    } finally {
      process.argv = originalArgv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      console.log = originalLog;
    }
  });

  test('CORPUS_SURFACE override excludes unavailable expected tools from failures and records their count', async () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalLog = console.log;
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-corpus-'));
    const out = resolve(outDir, 'corpus.json');
    const logs: string[] = [];
    const seenSurfaces: string[] = [];
    try {
      process.argv = process.argv.slice(0, 2);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv, {
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1', CORPUS_CWD: outDir, CORPUS_OUT: out, CORPUS_SURFACE: 'chat',
        CORPUS_REPEATS: '1', CORPUS_BUDGETS: '1', CORPUS_CONCURRENCY: '1',
      });
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await runCorpusMain(
        () => ({
          description: 'test', surface: 'cli', tiers: { test: 'test' },
          items: [
            { id: 'available', tier: 'test', prompt: 'available', accept: ['Read'] },
            { id: 'unavailable', tier: 'test', prompt: 'unavailable', accept: ['SelfImplement'] },
          ],
        }),
        async (options): Promise<EvalPromptResult> => {
          seenSurfaces.push(options.tools!);
          return {
            text: '', modelFamily: 'test', modelId: 'test', turnCount: 0, toolCallCount: 0,
            toolBreakdown: {}, toolSurface: options.tools!, surfaceToolNames: ['Read'], surfaceToolCount: 1,
            durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
          };
        },
        resolveCorpusRunSafetyFromProcessEnv,
        (surface) => {
          expect(surface).toBe('chat');
          return ['Read'];
        },
      );
      const output = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
      expect(seenSurfaces).toEqual(['chat']);
      expect(logs).toContain('[corpus] 측정 불가 1문항 — 서피스 chat에 기대 툴이 없어 실행·라우팅 실패·티어 분모에서 제외: unavailable');
      expect(logs).toContain('  실패 분류 — ①미발사 1 · ②툴 오선택 0 · ③거부툴 선택 0 (측정 가능 실행 1)\n');
      expect(output.surface).toBe('chat');
      expect(output.surfaceToolNames).toEqual(['Read']);
      expect(output.unmeasurableIds).toEqual(['unavailable']);
    } finally {
      process.argv = originalArgv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      console.log = originalLog;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('권위 서피스에 기대 툴이 있는데 모든 실행이 실패하면 측정 불가로 제외하지 않는다', async () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalError = console.error;
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-corpus-'));
    const out = resolve(outDir, 'corpus.json');
    let calls = 0;
    try {
      process.argv = process.argv.slice(0, 2);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv, {
        [NL_ROUTING_UNSAFE_RUN_ENV]: '1', CORPUS_CWD: outDir, CORPUS_OUT: out,
        CORPUS_REPEATS: '1', CORPUS_BUDGETS: '1', CORPUS_CONCURRENCY: '1',
      });
      console.error = (() => undefined) as typeof console.error;
      await runCorpusMain(
        () => ({
          description: 'test', surface: 'chat', tiers: { test: 'test' },
          items: [{ id: 'available-but-error', tier: 'test', prompt: 'test', accept: ['SelfImplement'] }],
        }),
        async (): Promise<EvalPromptResult> => {
          calls += 1;
          throw new Error('runner unavailable');
        },
        resolveCorpusRunSafetyFromProcessEnv,
        () => ['SelfImplement'],
      );
      const output = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
      expect(calls).toBe(1);
      expect(output.unmeasurableIds).toEqual([]);
      expect(output.records).toEqual([]);
    } finally {
      process.argv = originalArgv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      console.error = originalError;
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('NL routing measurement', () => {
  test('counts only actual tool-selected rows for the injected child session and closed turn', () => {
    const logs = [
      JSON.stringify({ id: 1, timestamp: '2026-07-30T00:00:00.000Z', event: 'tool-selected', sessionId: 'target-session', runId: 'target-run', tool: 'Read' }),
      JSON.stringify({ id: 2, timestamp: '2026-07-30T00:00:01.000Z', event: 'tool-selected', sessionId: 'other-session', tool: 'Write' }),
      JSON.stringify({ id: 3, timestamp: '2026-07-30T00:00:02.000Z', event: 'not-tool-selected', sessionId: 'target-session', runId: 'target-run', tool: 'Bash' }),
      JSON.stringify({ id: 4, timestamp: '2026-07-30T00:00:02.500Z', event: 'tool-selected', sessionId: 'target-session', tool: 'Grep' }),
      JSON.stringify({ id: 5, timestamp: '2026-07-30T00:00:04.000Z', event: 'tool-selected', sessionId: 'target-session', runId: 'target-run', tool: 'Bash' }),
    ].join('\n');

    const fired = toolsForSessionTurn(logs, 'target-session', { startId: 0, instance: '', timestamp: '2026-07-30T00:00:01.000Z', runId: 'target-run', completedAt: '2026-07-30T00:00:03.000Z' });
    expect(fired).toEqual(['Grep']);
    expect(classifyRouting(fired, ['Grep'])).toBe('pass');
  });

  test('verifies the configured PTY and session identity before any live input', () => {
    const logs = [
      JSON.stringify({ event: 'lifecycle.bridge-attached', sessionId: 'other-session', data: { ptyId: 'pty-other', runId: 'run-other' } }),
      JSON.stringify({ event: 'lifecycle.bridge-attached', sessionId: 'target-session', data: { ptyId: 'pty-target', runId: 'run-target' } }),
    ].join('\n');

    expect(verifyPtySession(() => logs, 'pty-target', 'target-session')).toBe(true);
    expect(verifyPtySession(() => logs, 'pty-target', 'other-session')).toBe(false);
    expect(verifyPtySession(() => { throw new Error('logs unavailable'); }, 'pty-target', 'target-session')).toBe(false);
  });

  test('uses a newly observed session-scoped submit start and its later completion as the turn boundary', () => {
    const before = JSON.stringify({ id: 10, timestamp: '2026-07-30T00:00:00.000Z', event: 'execute.begin', sessionId: 'target-session', runId: 'before' });
    const after = [before, JSON.stringify({ id: 11, timestamp: '2026-07-30T00:00:01.000Z', event: 'execute.ok', sessionId: 'other-session', runId: 'other' }), JSON.stringify({ id: 12, timestamp: '2026-07-30T00:00:02.000Z', event: 'execute.begin', sessionId: 'target-session', runId: 'current' }), JSON.stringify({ id: 13, timestamp: '2026-07-30T00:00:03.000Z', event: 'execute.error', sessionId: 'target-session', runId: 'current' })].join('\n');
    const boundary = turnStartedAfter(after, logIds(before), 'target-session');
    expect(boundary).toEqual({ startId: 12, instance: '', timestamp: '2026-07-30T00:00:02.000Z', runId: 'current' });
    expect(boundary && closedTurnBoundary(after, boundary, 'target-session')).toEqual({ startId: 12, instance: '', timestamp: '2026-07-30T00:00:02.000Z', runId: 'current', completedAt: '2026-07-30T00:00:03.000Z' });
  });

  test('turn command failure is unmeasurable and prevents another input from being delivered', async () => {
    let lifecycleCalls = 0;
    let delivered = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => {
        lifecycleCalls += 1;
        return lifecycleCalls === 1 ? '' : null;
      },
      deliverInput: () => { delivered += 1; return true; },
      toolsForClosedTurn: () => ['Grep'],
    };
    const result = await measureLiveTurn(runner, 'target-session', { id: 'q1', accept: ['Grep'] }, 'prompt', 0, { settleMs: 10, pollMs: 1, now: (() => { let now = 0; return () => ++now; })(), sleep: async () => {} });
    // ⛔ 이 기대가 종전엔 `completion-failed` 였다 — **그 기대 자체가 결함**이었다(1R 리뷰 must-fix ①).
    //    이 시나리오는 «턴이 안 열렸다» 가 아니라 **«폴링 중 로그 조회가 실패했다»** 이고,
    //    앞은 잰 결과이며 뒤는 못 잰 것이다. 뭉치면 측정 실패가 능력 판정으로 둔갑한다.
    expect(result).toEqual({ kind: 'unmeasurable', reason: 'snapshot-failed' });
    expect(delivered).toBe(1);
    expect(passSummary([])).toEqual({ passes: 0, runs: 0, expectedRuns: 0 });
  });

  test('a production log command exception remains a measurement failure rather than an empty tool list', async () => {
    expect(commandResult(() => { throw new Error('logs unavailable'); }, ['logs'])).toBeNull();
    const runner = createElanousLiveTurnRunner(() => { throw new Error('logs unavailable'); }, 'pty-1');
    const result = await measureLiveTurn(runner, 'target-session', { id: 'q1', accept: ['Grep'] }, 'prompt', 0, { settleMs: 1, pollMs: 1 });
    expect(result).toEqual({ kind: 'unmeasurable', reason: 'snapshot-failed' });
    expect(passSummary([])).toEqual({ passes: 0, runs: 0, expectedRuns: 0 });
  });

  test('reports observed pass counts and Wilson intervals and rejects malformed execution controls', () => {
    expect(passSummary([{ outcome: 'no-fire' }], 3)).toEqual({ passes: 0, runs: 1, expectedRuns: 3 });
    expect(passSummary([{ outcome: 'pass' }, { outcome: 'wrong-tool' }, { outcome: 'pass' }])).toEqual({ passes: 2, runs: 3, expectedRuns: 3 });
    expect(wilsonInterval(3, 3)).toEqual({ lower: expect.closeTo(0.4385, 4), upper: 1 });
    expect(wilsonInterval(0, 3)).toEqual({ lower: 0, upper: expect.closeTo(0.5615, 4) });
    expect(wilsonInterval(4, 3)).toBeNull();
    expect(() => positiveInteger('0', 'CORPUS_REPEATS', 3)).toThrow('CORPUS_REPEATS must be a positive integer');
    expect(() => positiveInteger('-1', 'CORPUS_CONCURRENCY', 4)).toThrow('CORPUS_CONCURRENCY must be a positive integer');
    expect(() => positiveIntegerList('6,NaN', 'CORPUS_BUDGETS', [6])).toThrow('CORPUS_BUDGETS must be a comma-separated list of positive integers');
    expect(positiveIntegerList(undefined, 'CORPUS_BUDGETS', [6])).toEqual([6]);
  });
});

describe('selectCorpusItems — 집중 프로브를 같은 자에서 한다 (MEAS-T8)', () => {
  const items = [
    { id: 'T1-01', tier: 'T1' }, { id: 'T1-04', tier: 'T1' },
    { id: 'T2-08', tier: 'T2' }, { id: 'T3-01', tier: 'T3' },
  ];

  test('필터가 없으면 전부', () => {
    expect(selectCorpusItems(items, {}).map((i) => i.id)).toEqual(['T1-01', 'T1-04', 'T2-08', 'T3-01']);
  });

  test('티어로 좁힌다(공백 허용)', () => {
    expect(selectCorpusItems(items, { tiers: 'T1, T3' }).map((i) => i.id)).toEqual(['T1-01', 'T1-04', 'T3-01']);
  });

  test('⭐ 문항 id 로 좁힌다 — 이것이 집중 프로브의 자리다', () => {
    expect(selectCorpusItems(items, { ids: 'T2-08,T1-04' }).map((i) => i.id)).toEqual(['T1-04', 'T2-08']);
  });

  test('⛔ 없는 id 는 조용히 무시하지 않는다 — 오타가 빈 표본을 "측정했다" 로 만든다', () => {
    expect(() => selectCorpusItems(items, { ids: 'T2-08,T9-99' })).toThrow('T9-99');
  });

  test('⛔ 필터가 서로 배타적이면 0 을 돌려주지 않고 던진다', () => {
    // ⛔⭐⭐ 없는 «티어» 이름은 이름을 대고 거부한다 — `CORPUS_IDS` 와 같은 형태.
    //   그 전엔 오타가 조용히 전부를 걸러 내고 일반 메시지가 「다른 가설」을 가리켰다
    //   (2026-08-03 · `GOAL-T27` · 자식이 3라운드 동안 0건을 받고 죽었다).
    expect(() => selectCorpusItems(items, { tiers: 'DEV-T1,DEV-T2' })).toThrow('코퍼스에 없는 티어 DEV-T1, DEV-T2');
    // ⭐ 있는 티어를 «같이» 알려 준다 — 읽는 쪽이 다음 명령을 바로 쓸 수 있어야 한다.
    expect(() => selectCorpusItems(items, { tiers: 'DEV-T1' })).toThrow('있는 티어는');
    // ⭐ 하나만 오타여도 거부한다(부분 성공으로 빈 표본을 만들지 않는다).
    expect(() => selectCorpusItems(items, { tiers: 'T1,DEV-T9' })).toThrow('코퍼스에 없는 티어 DEV-T9');
    expect(() => selectCorpusItems(items, { tiers: 'T1', ids: 'T2-08' })).toThrow('선택된 문항이 0');
  });
});

describe('corpusFiltersFromEnv — env 가 실제로 선택에 닿는다(배선 고정)', () => {
  const items = [{ id: 'T1-04', tier: 'T1' }, { id: 'T2-08', tier: 'T2' }, { id: 'T3-01', tier: 'T3' }];

  test('둘 다 없으면 빈 필터 = 전부', () => {
    expect(corpusFiltersFromEnv({})).toEqual({});
    expect(selectCorpusItems(items, corpusFiltersFromEnv({})).length).toBe(3);
  });

  test('⭐ CORPUS_IDS 가 선택까지 닿는다', () => {
    expect(selectCorpusItems(items, corpusFiltersFromEnv({ CORPUS_IDS: 'T2-08' })).map((i) => i.id)).toEqual(['T2-08']);
  });

  test('빈 문자열은 필터로 치지 않는다(빈 표본 방지)', () => {
    expect(corpusFiltersFromEnv({ CORPUS_IDS: '', CORPUS_TIERS: '' })).toEqual({});
  });
});

describe('부정 기대(대조군) — classifyRouting 의 reject 축', () => {
  const REJECT = ['SelfImplement', 'self_implement'];

  test('⛔ 금지 툴이 돌면 다른 무엇이 돌았든 실패다', () => {
    expect(classifyRouting(['Read', 'SelfImplement'], [], REJECT)).toBe('rejected-tool');
    // 별칭도 같은 툴이다 — 한쪽만 막으면 다른 이름으로 새어 나간다.
    expect(classifyRouting(['self_implement'], [], REJECT)).toBe('rejected-tool');
  });

  test('⭐ 대조군은 금지 툴만 피하면 통과다 — 조회 툴을 쓰든 말로만 답하든', () => {
    expect(classifyRouting(['Read', 'Grep'], [], REJECT)).toBe('pass');
    expect(classifyRouting([], [], REJECT)).toBe('pass');
  });

  test('⛔ 음성 대조 — 같은 발사가 reject 유무로 갈린다(이 축이 실제로 판정을 바꾼다)', () => {
    // ⭐ accept 에 든 툴이라도 reject 가 이긴다 — 대조군에서 "통과처럼 보이는 발사"가
    //    새어 나가지 않게 하는 것이 이 순서의 전부다.
    expect(classifyRouting(['SelfImplement'], ['SelfImplement'])).toBe('pass');
    expect(classifyRouting(['SelfImplement'], ['SelfImplement'], REJECT)).toBe('rejected-tool');
  });

  test('reject 가 없으면 종전 의미론 그대로다(무회귀)', () => {
    expect(classifyRouting(['Grep'], ['Grep'])).toBe('pass');
    expect(classifyRouting([], ['Grep'])).toBe('no-fire');
    expect(classifyRouting(['Write'], ['Grep'])).toBe('wrong-tool');
  });

  test('⛔ accept 가 비고 reject 도 없으면 종전 판정이 유지된다 — 1R 리뷰 must-fix ①', () => {
    // 종전 의미론: accept 가 비면 어떤 발사도 accept 에 없으므로 wrong-tool 이고, 미발사는 no-fire 다.
    // 초판은 reject 유무와 무관하게 pass 로 뒤집어, 부정 기대와 상관없는 호출부를 조용히 바꿨다.
    expect(classifyRouting(['X'], [])).toBe('wrong-tool');
    expect(classifyRouting([], [])).toBe('no-fire');
    // 대조군(= reject 가 있는 칸)에서만 빈 accept 가 통과다.
    expect(classifyRouting(['X'], [], ['SelfImplement'])).toBe('pass');
  });

  test('⭐ reject 가 정본 경로(measureLiveTurn)까지 실제로 닿는다 — 2R 리뷰 should-fix ②', async () => {
    // ⛔ 이 레포가 반복해서 밟은 형태: "생산은 됐는데 도달을 안 한다".
    //    분류기만 고치고 라이브가 그 인자를 안 넘기면 대조군은 영영 통과한다.
    const boundary = [
      JSON.stringify({ id: 1, timestamp: '2026-08-01T00:00:00.000Z', event: 'execute.begin', sessionId: 's', runId: 'r' }),
      JSON.stringify({ id: 2, timestamp: '2026-08-01T00:00:01.000Z', event: 'execute.ok', sessionId: 's', runId: 'r' }),
    ].join('\n');
    // ⚠️ 첫 조회는 **입력 전 스냅샷**이라 비어 있어야 한다 — 같은 로그를 돌려주면 그 턴이
    //    "이미 알던 것" 으로 걸러져 경계를 못 잡는다(측정 불가).
    const makeRunner = (): LiveTurnRunner => {
      let calls = 0;
      return {
        lifecycleLogs: () => (calls++ === 0 ? '' : boundary),
        deliverInput: () => true,
        toolsForClosedTurn: () => ['SelfImplement'],
      };
    };
    const runner = makeRunner();
    const control = { id: 'D0-01', accept: [] as string[], reject: REJECT };
    const result = await measureLiveTurn(runner, 's', control, 'pty list 에 시작 시각이 나오나?', 0, { settleMs: 10, pollMs: 1 });
    expect(result.kind).toBe('measured');
    expect(result.kind === 'measured' && result.record.outcome).toBe('rejected-tool');

    // 음성 대조 — 같은 배선에서 reject 를 빼면 이 발사는 rejected-tool 이 아니다.
    const noReject = await measureLiveTurn(makeRunner(), 's', { id: 'D0-01', accept: ['SelfImplement'] }, 'p', 0, { settleMs: 10, pollMs: 1 });
    expect(noReject.kind === 'measured' && noReject.record.outcome).toBe('pass');
  });

  test('⛔ accept·reject 가 둘 다 비면 늘 통과하는 칸이므로 로드에서 거부한다', () => {
    expect(() => assertGradableItems([{ id: 'X-01', accept: [], reject: [] }])).toThrow('X-01');
    expect(() => assertGradableItems([{ id: 'X-02' }])).toThrow('X-02');
    expect(() => assertGradableItems([{ id: 'D0-01', accept: [], reject: REJECT }])).not.toThrow();
  });
});

describe('nl-selfdev-trigger 코퍼스 — 계약이 파일과 맞는가', () => {
  const corpus = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../test/fixtures/nl-selfdev-trigger-corpus.json'), 'utf8'),
  ) as { tiers: Record<string, string>; tier_oracle_status: Record<string, string>; surface: string; target_terms: Record<string, string[]>; items: { id: string; tier: string; target?: string; prompt: string; accept: string[]; reject?: string[]; boundary?: boolean }[] };

  test('모든 문항이 채점 가능하다', () => {
    expect(() => assertGradableItems(corpus.items)).not.toThrow();
  });

  test('⭐ 대조군이 실재한다 — 없으면 트리거율만 재게 되고 "아무 말에나 쏘는 것"이 만점을 받는다', () => {
    const control = corpus.items.filter((item) => item.tier === 'D0');
    expect(control.length).toBeGreaterThan(0);
    for (const item of control) {
      expect(item.accept).toEqual([]);
      expect(item.reject).toEqual(['SelfImplement', 'self_implement']);
    }
  });

  test('⛔ 위임 문항은 툴 이름 **둘 다** 받는다(한쪽만 적으면 정상 발사가 미발사로 읽힌다)', () => {
    for (const item of corpus.items.filter((i) => i.tier !== 'D0')) {
      expect(item.accept).toEqual(['SelfImplement', 'self_implement']);
    }
  });

  test('선언한 티어와 실제 문항 티어가 어긋나지 않는다', () => {
    for (const item of corpus.items) expect(Object.keys(corpus.tiers)).toContain(item.tier);
  });

  test('⭐ 대조군은 위임 문항과 **같은 대상**으로 짝지어져 있다(주제어가 아니라 위임 의도를 재기 위해)', () => {
    // ⛔ 초판은 **id 접미사**만 비교해서 "같은 대상"을 증명하지 못했다(1R 리뷰 should-fix ②).
    //    ⇒ fixture 에 `target` 을 명시해 **짝을 관례가 아니라 계약**으로 만들었다.
    const targetsOf = (tier: string) => corpus.items.filter((i) => i.tier === tier).map((i) => i.target).sort();
    expect(targetsOf('D0')).toEqual(targetsOf('D2'));
    // 세 축이 같은 대상 집합을 공유해야 "위임 어휘만 다르다" 가 참이다.
    expect(targetsOf('D1')).toEqual(targetsOf('D2'));
    // 대상이 비어 있으면 위 비교가 [undefined…] 끼리 맞아 조용히 통과한다 — 음성 대조.
    for (const item of corpus.items) expect(item.target).toBeTruthy();
    // 같은 티어 안에서 대상이 중복되면 짝이 1:1 이 아니다.
    expect(new Set(targetsOf('D2')).size).toBe(targetsOf('D2').length);
  });

  test('⛔ target 이 문면으로 증명된다 — 자기기입 문자열 비교는 Goodhart 다(2R 리뷰 must-fix)', () => {
    // `target` 은 내가 적은 값이라 그것끼리 맞춰 봐야 아무것도 증명하지 않는다.
    // ⇒ 대상마다 문면에 반드시 있어야 할 낱말을 못박고, 그것이 prompt 에 실재하는지 본다.
    for (const item of corpus.items) {
      const terms = corpus.target_terms[item.target!];
      expect(terms, `target ${item.target} 에 대응하는 target_terms 가 없다 (${item.id})`).toBeTruthy();
      for (const term of terms) {
        expect(item.prompt.includes(term), `${item.id} 문면에 "${term}" 이 없다: ${item.prompt}`).toBe(true);
      }
    }
    // 선언만 있고 쓰이지 않는 대상이 남으면 계약이 실제와 어긋난다.
    expect(Object.keys(corpus.target_terms).sort()).toEqual([...new Set(corpus.items.map((i) => i.target!))].sort());
  });

  test('⭐ 경계 문항이 선언돼 있고 대조군 안에 있다 — 합계와 분리되는 근거(4R 리뷰 should-fix ②)', () => {
    const boundary = corpus.items.filter((i) => i.boundary);
    // 경계가 하나도 없으면 대조군은 "명백히 안 쏠 문장"만 모아 놓고 통과를 세게 된다.
    expect(boundary.length).toBeGreaterThan(0);
    // 경계는 대조군 안에서만 의미가 있다(위임 문항의 애매함은 D2 티어가 이미 담당한다).
    for (const item of boundary) expect(item.tier).toBe('D0');
    // 대조군 전부가 경계면 분리가 무의미하다 — 비교할 비-경계 대조군이 남아야 한다.
    expect(corpus.items.filter((i) => i.tier === 'D0' && !i.boundary).length).toBeGreaterThan(0);
  });

  test('⛔ 선언 필드가 실제와 어긋나지 않는다 — 검증 가능한 것은 검증한다(3R 리뷰 must-fix)', () => {
    // 티어마다 오라클 상태가 선언돼 있어야 한다. 하나라도 빠지면 "이 수를 어떻게 읽나" 가 비어
    // 있는 채로 측정에 들어간다. 반대로 없는 티어에 상태만 선언돼 있으면 계약이 실제와 갈린다.
    expect(Object.keys(corpus.tier_oracle_status).sort()).toEqual(Object.keys(corpus.tiers).sort());
    // 선언만 되고 문항이 하나도 없는 티어는 "재는 척" 이다.
    for (const tier of Object.keys(corpus.tiers)) {
      expect(corpus.items.filter((i) => i.tier === tier).length).toBeGreaterThan(0);
    }
    expect(corpus.surface).toBeTruthy();
  });

  test('⭐ accept 가 빠진 항목도 러너가 받는다 — 정규화 경로(3R 리뷰 should-fix ①)', () => {
    // 계약은 `reject` 만 있는 항목을 유효로 인정한다. 그 모양이 러너까지 살아 오는지 본다.
    const raw = [{ id: 'D0-x', reject: ['SelfImplement'] }, { id: 'D1-x', accept: ['SelfImplement'] }];
    expect(() => assertGradableItems(raw)).not.toThrow();
    const normalized = normalizeCorpusItems(raw);
    expect(normalized[0]!.accept).toEqual([]);
    expect(normalized[1]!.accept).toEqual(['SelfImplement']);
    // 정규화 전에는 러너가 읽는 자리가 undefined 였다(그래서 죽었다) — 음성 대조.
    expect((raw[0] as { accept?: string[] }).accept).toBeUndefined();
    // 그리고 정규화된 항목이 실제로 대조군으로 채점된다.
    expect(classifyRouting(['SelfImplement'], normalized[0]!.accept, normalized[0]!.reject)).toBe('rejected-tool');
  });

  test('⛔ 닫힌 코퍼스다 — 문항 수와 티어 구성을 고정한다(1R 리뷰 should-fix ①)', () => {
    // "닫힌 코퍼스" 는 수가 움직이지 않는다는 뜻이다. 늘리려면 이 기대와 함께 **세대를 올린다**
    // (nl-routing-corpus 의 세대 규율과 같다 — 세대가 다른 수를 같은 표에 놓으면 안 된다).
    expect(corpus.items.length).toBe(12);
    for (const tier of ['D1', 'D2', 'D0']) {
      expect(corpus.items.filter((i) => i.tier === tier).length).toBe(4);
    }
    expect(new Set(corpus.items.map((i) => i.id)).size).toBe(12);
  });
});

describe('서피스 기대 툴 가용성 — 없으면 라우팅 실패가 아니라 측정 불가', () => {
  const items = [
    { id: 'available', accept: ['Read'] },
    { id: 'unavailable', accept: ['SelfImplement'] },
    { id: 'control', accept: [] },
  ];

  test('기대 툴이 하나도 없는 문항만 측정 불가이며 부정 기대 대조군은 측정 가능하다', () => {
    expect(unavailableExpectedToolIds(items, ['Read', 'Grep'])).toEqual(['unavailable']);
  });

  test('⛔ 음성 대조 — 기대 툴 하나라도 있으면 측정 불가로 빼지 않는다', () => {
    expect(unavailableExpectedToolIds(items, ['Read', 'SelfImplement'])).toEqual([]);
  });
});

describe('summarizeCorpusRun — 경계 문항 분리가 **결과로** 증명된다 (5R 리뷰 must-fix)', () => {
  const items = [
    { id: 'D0-01' }, { id: 'D0-04', boundary: true }, { id: 'D1-01' },
  ];
  const records = [
    { id: 'D0-01', outcome: 'pass' as const }, { id: 'D0-01', outcome: 'pass' as const },
    { id: 'D0-04', outcome: 'rejected-tool' as const }, { id: 'D0-04', outcome: 'pass' as const },
    { id: 'D1-01', outcome: 'no-fire' as const }, { id: 'D1-01', outcome: 'pass' as const },
  ];

  test('⭐ 경계 문항의 회차가 합계에서 실제로 빠진다', () => {
    const summary = summarizeCorpusRun(items, records, 2);
    // 전체 6회 중 경계 2회를 뺀 4회만 합계에 든다 — 개수가 그것을 증명한다.
    expect(summary.aggregate).toEqual({ passes: 3, runs: 4, expectedRuns: 4 });
    // ⭐ 기대 회차는 **문항 수 × 회차**다 — 실제 레코드 수가 아니다(6R 리뷰 should-fix).
    expect(summary.boundaryIds).toEqual(['D0-04']);
  });

  test('⭐ 경계 문항은 따로 집계된다', () => {
    expect(summarizeCorpusRun(items, records, 2).boundary).toEqual({ passes: 1, runs: 2, expectedRuns: 2 });
  });

  test('⛔ 음성 대조 — boundary 표시를 떼면 같은 회차가 합계로 들어온다', () => {
    const noBoundary = summarizeCorpusRun(items.map(({ id }) => ({ id })), records, 2);
    expect(noBoundary.aggregate).toEqual({ passes: 4, runs: 6, expectedRuns: 6 });
    expect(noBoundary.boundary).toBeNull();
    expect(noBoundary.boundaryIds).toEqual([]);
  });

  test('문항별 집계와 흔들린 문항은 종전과 같다(무회귀)', () => {
    const summary = summarizeCorpusRun(items, records, 2);
    expect(summary.perItem.map((p) => `${p.id} ${p.summary.passes}/${p.summary.runs}`))
      .toEqual(['D0-01 2/2', 'D0-04 1/2', 'D1-01 1/2']);
    // 회차가 갈린 문항은 경계 여부와 무관하게 드러난다 — 확률 표본이라는 사실을 숨기지 않는다.
    expect(summary.fluctuating).toEqual(['D0-04', 'D1-01']);
  });
});

describe('summarizeCorpusRun — 서피스 측정 불가가 실패 분모에서 분리된다', () => {
  const items = [{ id: 'available' }, { id: 'unavailable', unmeasurable: true }];
  const records = [
    { id: 'available', outcome: 'pass' as const },
    { id: 'available', outcome: 'no-fire' as const },
    { id: 'unavailable', outcome: 'no-fire' as const },
    { id: 'unavailable', outcome: 'wrong-tool' as const },
  ];

  test('기대 툴이 없는 표본은 실패가 아닌 별도 측정 불가 합계가 된다', () => {
    const summary = summarizeCorpusRun(items, records, 2);
    expect(summary.aggregate).toEqual({ passes: 1, runs: 2, expectedRuns: 2 });
    expect(summary.unmeasurable).toEqual({ passes: 0, runs: 2, expectedRuns: 2 });
    expect(summary.unmeasurableIds).toEqual(['unavailable']);
    expect(summary.fluctuating).toEqual(['available']);
  });

  test('측정 가능한 문항의 집계는 측정 불가 표본과 무관하게 종전과 같다', () => {
    expect(summarizeCorpusRun([{ id: 'available' }], records.filter((record) => record.id === 'available'), 2).aggregate)
      .toEqual(summarizeCorpusRun(items, records, 2).aggregate);
  });
});

describe('summarizeCorpusRun — 런이 끊기면 그것이 수에 드러난다 (6R 리뷰 should-fix)', () => {
  const items = [{ id: 'A' }, { id: 'B' }, { id: 'C', boundary: true }];

  test('⛔ 중단된 런이 "완전한 수"로 보이지 않는다', () => {
    // B 는 1회만 돌고 끊겼고 C 는 아예 못 돌았다.
    const partial = summarizeCorpusRun(items, [
      { id: 'A', outcome: 'pass' as const }, { id: 'A', outcome: 'pass' as const },
      { id: 'B', outcome: 'pass' as const },
    ], 2);
    // 비경계 2문항 × 2회 = 4 가 기대인데 3회만 돌았다 — runs≠expectedRuns 가 그것을 말한다.
    expect(partial.aggregate).toEqual({ passes: 3, runs: 3, expectedRuns: 4 });
    // 경계 문항은 한 번도 안 돌았다: 0/0 인데 기대는 2 다(0/0 만 보면 "없음"과 구별되지 않는다).
    expect(partial.boundary).toEqual({ passes: 0, runs: 0, expectedRuns: 2 });
  });

  test('완주하면 runs 와 expectedRuns 가 같다(음성 대조)', () => {
    const full = summarizeCorpusRun(items, [
      { id: 'A', outcome: 'pass' as const }, { id: 'A', outcome: 'pass' as const },
      { id: 'B', outcome: 'pass' as const }, { id: 'B', outcome: 'no-fire' as const },
      { id: 'C', outcome: 'pass' as const }, { id: 'C', outcome: 'pass' as const },
    ], 2);
    expect(full.aggregate).toEqual({ passes: 3, runs: 4, expectedRuns: 4 });
    expect(full.boundary).toEqual({ passes: 2, runs: 2, expectedRuns: 2 });
  });
});

describe('⛔⭐⭐ 실제 로그 모양을 잠근다 — 표기가 한 행 안에서 갈린다 (2026-08-01 실측)', () => {
  // ⚠️ 이 픽스처는 `elanous logs --json` 이 **실제로 내는 모양**이다. 최상위는 snake_case 이고
  //    중첩 `data` 는 **JSON 문자열이며 camelCase** 다. 종전 픽스처는 존재하지 않는 모양을 썼고,
  //    그래서 라이브 러너가 오래 못 돌면서도 아무 에러를 안 냈다.
  const realRow = (over: Record<string, unknown> = {}) => JSON.stringify({
    id: 824,
    ts: '2026-08-01T12:00:01.000Z',
    level: 'debug',
    instance: 'test:state',
    surface: 'tui',
    category: 'capability.resolve',
    event: 'tool-selected',
    session_id: 'elanous-session-g0wp80',
    data: JSON.stringify({ sessionId: 'elanous-session-g0wp80', callId: 'call_x', tool: 'SelfImplement' }),
    ...over,
  });

  test('⭐ tool-selected 를 실제 모양에서 읽는다(최상위 ts·session_id · 중첩 문자열 data)', () => {
    const fired = toolsForSessionTurn(realRow(), 'elanous-session-g0wp80', {
      startId: 0, instance: 'test:state', timestamp: '2026-08-01T12:00:00.000Z', runId: 'r', completedAt: '2026-08-01T12:00:02.000Z',
    });
    expect(fired).toEqual(['SelfImplement']);
  });

  test('⛔ 음성 대조 — 세션이 다르면 안 센다', () => {
    expect(toolsForSessionTurn(realRow({ session_id: 'other' , data: JSON.stringify({ sessionId: 'other', tool: 'X' }) }), 'elanous-session-g0wp80')).toEqual([]);
  });

  test('⭐ 턴 경계도 실제 모양에서 잡힌다(ts 를 timestamp 로 읽지 않는다)', () => {
    const raw = [
      realRow({ id: 1, event: 'execute.begin', category: 'input.submit', ts: '2026-08-01T12:00:00.000Z', data: JSON.stringify({ runId: 'r1', textBytes: 6 }) }),
      realRow({ id: 2, event: 'execute.ok', category: 'input.submit', ts: '2026-08-01T12:00:03.000Z', data: JSON.stringify({ runId: 'r1' }) }),
    ].join('\n');
    const started = turnStartedAfter(raw, new Set<string>(), 'elanous-session-g0wp80');
    expect(started).toEqual({ startId: 1, instance: 'test:state', timestamp: '2026-08-01T12:00:00.000Z', runId: 'r1' });
    expect(started && closedTurnBoundary(raw, started, 'elanous-session-g0wp80'))
      .toEqual({ startId: 1, instance: 'test:state', timestamp: '2026-08-01T12:00:00.000Z', runId: 'r1', completedAt: '2026-08-01T12:00:03.000Z' });
  });

  test('⭐ verifyPtySession 이 실제 모양(문자열 data)에서 참이 된다', () => {
    const logs = realRow({
      category: 'signal', event: 'lifecycle.bridge-attached',
      data: JSON.stringify({ ptyId: 'pty_28781bd3', runId: 'r1' }),
    });
    expect(verifyPtySession(() => logs, 'pty_28781bd3', 'elanous-session-g0wp80')).toBe(true);
    // ⛔ 음성 대조 — 종전 구현은 data 가 객체일 때만 풀어서 이 케이스가 영영 거짓이었다.
    expect(verifyPtySession(() => logs, 'pty_other', 'elanous-session-g0wp80')).toBe(false);
  });

  test('옛 표기(camelCase 최상위·객체 data)도 계속 읽는다(무회귀)', () => {
    const legacy = JSON.stringify({
      id: 9, timestamp: '2026-08-01T12:00:01.000Z', event: 'tool-selected',
      sessionId: 's', tool: 'Grep', data: { sessionId: 's' },
    });
    expect(toolsForSessionTurn(legacy, 's')).toEqual(['Grep']);
  });
});

describe('⛔ 관대 리더의 핵심 계약 — **최상위에 세션이 없고 중첩에만** 있는 행 (1R 리뷰 should-fix ①)', () => {
  // ⚠️ 이것이 관대 리더가 존재하는 이유다. 최상위 표기만 보면 이 행은 영영 안 잡힌다.
  const nestedOnly = JSON.stringify({
    id: 5, ts: '2026-08-01T12:00:01.000Z', event: 'tool-selected',
    data: JSON.stringify({ sessionId: 'sess-nested', tool: 'SelfImplement' }),
  });

  test('⭐ 중첩 data.sessionId 단독으로도 세션이 맞는다', () => {
    expect(toolsForSessionTurn(nestedOnly, 'sess-nested')).toEqual(['SelfImplement']);
  });

  test('⛔ 음성 대조 — 중첩 세션이 다르면 안 센다(무조건 통과가 아니다)', () => {
    expect(toolsForSessionTurn(nestedOnly, 'sess-other')).toEqual([]);
  });

  test('⭐ verifyPtySession 도 중첩 단독에서 참이 된다', () => {
    const logs = JSON.stringify({
      id: 6, ts: '2026-08-01T12:00:02.000Z', event: 'lifecycle.bridge-attached',
      data: JSON.stringify({ sessionId: 'sess-nested', ptyId: 'pty_x' }),
    });
    expect(verifyPtySession(() => logs, 'pty_x', 'sess-nested')).toBe(true);
    expect(verifyPtySession(() => logs, 'pty_x', 'sess-other')).toBe(false);
  });
});

describe('provePtyDrivesSession — 선언 대신 **인과**로 pty↔session 을 묶는다', () => {
  const rows = (...items: { id: number; event: string; ts: string; bytes?: number }[]) =>
    items.map((r) => JSON.stringify({
      id: r.id, timestamp: r.ts, event: r.event, sessionId: 's', runId: 'r',
      ...(r.bytes === undefined ? {} : { data: { textBytes: r.bytes } }),
    })).join('\n');
  const probe = '안녕';
  const bytes = Buffer.byteLength(probe, 'utf8');
  const opts = { settleMs: 20, pollMs: 1 };

  const runnerFor = (after: string, delivered = { n: 0 }): LiveTurnRunner => {
    let calls = 0;
    return {
      lifecycleLogs: () => (calls++ === 0 ? '' : after),
      deliverInput: () => { delivered.n += 1; return true; },
      toolsForClosedTurn: () => [],
    };
  };

  test('⭐ 내가 넣은 길이의 입력이 그 세션의 턴을 열면 증명된다', async () => {
    const after = rows(
      { id: 1, event: 'execute.begin', ts: '2026-08-01T00:00:00.000Z', bytes },
      { id: 2, event: 'execute.ok', ts: '2026-08-01T00:00:01.000Z' },
    );
    expect(await provePtyDrivesSession(runnerFor(after), 's', probe, opts)).toEqual({ proven: true });
  });

  test('⛔ 길이가 다르면 거부한다 — 남이 연 턴을 내 것으로 세지 않는다', async () => {
    const after = rows(
      { id: 1, event: 'execute.begin', ts: '2026-08-01T00:00:00.000Z', bytes: bytes + 7 },
      { id: 2, event: 'execute.ok', ts: '2026-08-01T00:00:01.000Z' },
    );
    expect(await provePtyDrivesSession(runnerFor(after), 's', probe, opts)).toEqual({ proven: false, reason: 'length-mismatch' });
  });

  test('⛔ 턴이 안 열리면 거부한다 — 그 pty 는 이 세션을 몰지 않는다', async () => {
    expect(await provePtyDrivesSession(runnerFor(''), 's', probe, opts)).toEqual({ proven: false, reason: 'no-turn' });
  });

  test('⛔ 전달이 실패하면 그 자리에서 멈춘다', async () => {
    const runner: LiveTurnRunner = { lifecycleLogs: () => '', deliverInput: () => false, toolsForClosedTurn: () => [] };
    expect(await provePtyDrivesSession(runner, 's', probe, opts)).toEqual({ proven: false, reason: 'delivery-failed' });
  });

  test('turnTextBytes — 그 행이 없거나 필드가 없으면 undefined(추측하지 않는다)', () => {
    const raw = rows({ id: 1, event: 'execute.begin', ts: '2026-08-01T00:00:00.000Z', bytes: 12 });
    expect(turnTextBytes(raw, 1)).toBe(12);
    expect(turnTextBytes(raw, 99)).toBeUndefined();
    expect(turnTextBytes(rows({ id: 2, event: 'execute.begin', ts: '2026-08-01T00:00:00.000Z' }), 2)).toBeUndefined();
  });
});

describe('⛔ 인과 프로브 — 실패 갈래와 배선 (1R 리뷰 must-fix ①③ · should-fix)', () => {
  const REJECT_PROBE = '안녕';
  const opts = { settleMs: 20, pollMs: 1 };

  test('⛔ 폴링 중 로그 조회 실패는 「턴 없음」과 다른 사유다 — 못 잰 것과 잰 결과를 안 섞는다', async () => {
    let calls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : null),   // 스냅샷은 되고 폴링에서 실패
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    expect(await provePtyDrivesSession(runner, 's', REJECT_PROBE, opts))
      .toEqual({ proven: false, reason: 'snapshot-failed' });
  });

  test('⛔ 같은 실패가 measureLiveTurn 에서도 completion-failed 로 뭉개지지 않는다', async () => {
    let calls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : null),
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    const result = await measureLiveTurn(runner, 's', { id: 'q', accept: ['X'] }, 'p', 0, opts);
    expect(result).toEqual({ kind: 'unmeasurable', reason: 'snapshot-failed' });
  });

  test('⭐ 러너의 로그 조회가 중첩 인스턴스를 본다(--all --include-test)', () => {
    const seen: string[][] = [];
    const runner = createElanousLiveTurnRunner((args) => { seen.push(args); return ''; }, 'pty_x');
    runner.lifecycleLogs('s');
    runner.toolsForClosedTurn('s', { startId: 0, instance: '', timestamp: 't', runId: 'r', completedAt: 't2' });
    // ⛔ 한 우주만 보면 자식 TUI 로그(⟨test:state⟩)가 0건으로 읽힌다.
    for (const args of seen) {
      expect(args).toContain('--all');
      expect(args).toContain('--include-test');
    }
    expect(seen.length).toBe(3);
  });

  test('⭐ session.link를 따라 자식 도구를 합치되 턴 경계·중복 제거를 지킨다', () => {
    const boundary = { startId: 0, instance: '', timestamp: '2026-08-02T00:00:00.000Z', runId: 'r', completedAt: '2026-08-02T00:00:10.000Z' };
    const rows: Record<string, string> = {
      parent: [
        JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'tool-selected', session_id: 'parent', data: JSON.stringify({ runId: 'r', tool: 'Grep' }) }),
        JSON.stringify({ ts: '2026-08-02T00:00:02.000Z', event: 'tool-selected', session_id: 'parent', data: JSON.stringify({ runId: 'r', tool: 'Grep' }) }),
      ].join('\n'),
      child: [
        JSON.stringify({ ts: '2026-08-02T00:00:03.000Z', event: 'tool-selected', session_id: 'child', data: JSON.stringify({ runId: 'r', tool: 'Bash' }) }),
        JSON.stringify({ ts: '2026-08-02T00:00:03.500Z', event: 'tool-selected', session_id: 'child', data: JSON.stringify({ runId: 'r', tool: 'Grep' }) }),
        JSON.stringify({ ts: '2026-08-02T00:00:11.000Z', event: 'tool-selected', session_id: 'child', data: JSON.stringify({ runId: 'r', tool: 'Write' }) }),
        JSON.stringify({ ts: '2026-08-02T00:00:04.000Z', event: 'tool-selected', session_id: 'child', data: JSON.stringify({ runId: 'other', tool: 'Read' }) }),
      ].join('\n'),
    };
    const links: Record<string, string> = {
      parent: JSON.stringify({ ts: '2026-08-02T00:00:02.000Z', event: 'core-turn', session_id: 'parent', data: JSON.stringify({ runId: 'r', parentSessionId: 'parent', childSessionId: 'child' }) }),
      child: '',
    };
    const seen: string[][] = [];
    const runner = createElanousLiveTurnRunner((args) => {
      seen.push(args);
      const session = args[args.indexOf('--session') + 1];
      return args.includes('session.link') ? links[session] ?? '' : rows[session] ?? '';
    }, 'pty_x');
    expect(runner.toolsForClosedTurn('parent', boundary)).toEqual(['Grep', 'Bash']);
    expect(seen.filter((args) => args.includes('session.link')).map((args) => args[args.indexOf('--session') + 1])).toEqual(['parent', 'child']);
  });

  test('⛔ 다른 세션 로그와 다른 부모의 session.link는 회차 판정에서 배제한다', () => {
    const boundary = { startId: 0, instance: '', timestamp: '2026-08-02T00:00:00.000Z', runId: 'r', completedAt: '2026-08-02T00:00:10.000Z' };
    const queriedLinkSessions: string[] = [];
    const queriedToolSessions: string[] = [];
    const runner = createElanousLiveTurnRunner((args) => {
      const session = args[args.indexOf('--session') + 1]!;
      if (!args.includes('session.link')) {
        queriedToolSessions.push(session);
        return [
          JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'tool-selected', session_id: session, data: JSON.stringify({ runId: 'r', tool: session === 'target-session' ? 'Grep' : 'ChildRead' }) }),
          JSON.stringify({ ts: '2026-08-02T00:00:02.000Z', event: 'tool-selected', session_id: 'other-session', data: JSON.stringify({ runId: 'r', tool: 'Write' }) }),
        ].join('\n');
      }
      queriedLinkSessions.push(session);
      return [
        JSON.stringify({ ts: '2026-08-02T00:00:03.000Z', event: 'core-turn', session_id: 'target-session', data: JSON.stringify({ runId: 'r', parentSessionId: 'target-session', childSessionId: 'target-child' }) }),
        JSON.stringify({ ts: '2026-08-02T00:00:04.000Z', event: 'core-turn', session_id: 'target-session', data: JSON.stringify({ runId: 'r', parentSessionId: 'other-session', childSessionId: 'other-child' }) }),
      ].join('\n');
    }, 'pty_x');
    expect(runner.toolsForClosedTurn('target-session', boundary)).toEqual(['Grep', 'ChildRead']);
    expect(queriedLinkSessions).toEqual(['target-session', 'target-child']);
    expect(queriedToolSessions).toEqual(['target-session', 'target-child']);
    expect(queriedLinkSessions).not.toContain('other-session');
    expect(queriedToolSessions).not.toContain('other-child');
  });

  test('⭐ 무간선은 중복 제거된 기존 반환값과 바이트 수준으로 같다', () => {
    const boundary = { startId: 0, instance: '', timestamp: '2026-08-02T00:00:00.000Z', runId: 'r', completedAt: '2026-08-02T00:00:10.000Z' };
    const raw = [
      JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'tool-selected', session_id: 'parent', data: JSON.stringify({ runId: 'r', tool: 'Grep' }) }),
      JSON.stringify({ ts: '2026-08-02T00:00:02.000Z', event: 'tool-selected', session_id: 'parent', data: JSON.stringify({ runId: 'r', tool: 'Grep' }) }),
    ].join('\n');
    const runner = createElanousLiveTurnRunner((args) => args.includes('session.link') ? '' : raw, 'pty_x');
    expect(JSON.stringify(runner.toolsForClosedTurn('parent', boundary))).toBe(JSON.stringify(toolsForSessionTurn(raw, 'parent', boundary)));
  });

  test('⭐ session.link 순환과 깊이 상한은 방문하지 않은 도구를 합치지 않는다', () => {
    const boundary = { startId: 0, instance: '', timestamp: '2026-08-02T00:00:00.000Z', runId: 'r', completedAt: '2026-08-02T00:00:10.000Z' };
    const sessionFrom = (args: string[]) => args[args.indexOf('--session') + 1];
    const runner = createElanousLiveTurnRunner((args) => {
      const session = sessionFrom(args);
      if (!args.includes('session.link')) return JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'tool-selected', session_id: session, data: JSON.stringify({ runId: 'r', tool: session }) });
      const child = session === 's8' ? 'too-deep' : session === 's0' ? 's1' : session === 's1' ? 's0' : `s${Number(session.slice(1)) + 1}`;
      return JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'child-scope', session_id: session, data: JSON.stringify({ runId: 'r', childSessionId: child }) });
    }, 'pty_x');
    expect(runner.toolsForClosedTurn('s0', boundary)).toEqual(['s0', 's1']);

    const chainRunner = createElanousLiveTurnRunner((args) => {
      const session = sessionFrom(args);
      if (!args.includes('session.link')) return JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'tool-selected', session_id: session, data: JSON.stringify({ runId: 'r', tool: session }) });
      return JSON.stringify({ ts: '2026-08-02T00:00:01.000Z', event: 'child-scope', session_id: session, data: JSON.stringify({ runId: 'r', childSessionId: `s${Number(session.slice(1)) + 1}` }) });
    }, 'pty_x');
    expect(chainRunner.toolsForClosedTurn('s0', boundary)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  });

  test('⛔ 어느 tool-selected 또는 session.link 조회 실패도 null로 전파한다', () => {
    const boundary = { startId: 0, instance: '', timestamp: '2026-08-02T00:00:00.000Z', runId: 'r', completedAt: '2026-08-02T00:00:10.000Z' };
    expect(createElanousLiveTurnRunner(() => { throw new Error('unavailable'); }, 'pty_x').toolsForClosedTurn('parent', boundary)).toBeNull();
    expect(createElanousLiveTurnRunner((args) => args.includes('session.link') ? (() => { throw new Error('unavailable'); })() : '', 'pty_x').toolsForClosedTurn('parent', boundary)).toBeNull();
  });

  test('⭐ 선언 조회도 중첩 인스턴스를 본다 — 안 그러면 선언이 있는데 프로브 턴을 헛되이 태운다', () => {
    const seen: string[][] = [];
    verifyPtySession((args) => { seen.push(args); return ''; }, 'pty_x', 's');
    expect(seen[0]).toContain('--all');
    expect(seen[0]).toContain('--include-test');
  });

  test('⛔ 프로브가 코퍼스 문항이면 거부한다 — 문면 계약만으로는 안 지켜진다', () => {
    const prompts = ['골 린터가 빈 줄을 못 잡아. 고쳐줘', 'pty list 에 시작 시각이 나오나?'];
    expect(() => assertProbeOutsideCorpus('안녕', prompts)).not.toThrow();
    expect(() => assertProbeOutsideCorpus('골 린터가 빈 줄을 못 잡아. 고쳐줘', prompts)).toThrow('contaminate');
    // 공백만 다른 경우도 같은 문장이다(사람이 손으로 넣기 때문).
    expect(() => assertProbeOutsideCorpus('  골 린터가  빈 줄을 못 잡아. 고쳐줘 ', prompts)).toThrow('contaminate');
    expect(() => assertProbeOutsideCorpus('   ', prompts)).toThrow('empty');
  });
});

describe('⛔⭐⭐ 연합 조회의 id 충돌 — 「id 는 인스턴스마다 독립」 (2R 리뷰 must-fix)', () => {
  // ⚠️ `elanous logs` 자신이 경고한다: "연합(--all) 조회는 행 id 가 인스턴스마다 독립이라
  //    --before 를 쓸 수 없다". 즉 **같은 숫자 id 가 여러 저장소에 존재**한다.
  const row = (instance: string, id: number, event: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, instance, ts, event, session_id: 's', data: JSON.stringify({ runId: 'r1', ...extra }) });

  test('⛔ 다른 인스턴스가 그 번호를 썼다는 이유로 새 턴을 건너뛰지 않는다', () => {
    // 이미 본 것: prod 의 id 7. 새로 난 것: test:state 의 id 7 — **다른 행이다**.
    const seen = logIds(row('prod', 7, 'execute.begin', '2026-08-01T00:00:00.000Z'));
    const fresh = row('test:state', 7, 'execute.begin', '2026-08-01T00:00:05.000Z');
    const started = turnStartedAfter(fresh, seen, 's');
    expect(started).toEqual({ startId: 7, instance: 'test:state', timestamp: '2026-08-01T00:00:05.000Z', runId: 'r1' });
  });

  test('⛔ 음성 대조 — 같은 인스턴스의 같은 id 는 여전히 이미 본 것이다', () => {
    const seen = logIds(row('test:state', 7, 'execute.begin', '2026-08-01T00:00:00.000Z'));
    expect(turnStartedAfter(row('test:state', 7, 'execute.begin', '2026-08-01T00:00:00.000Z'), seen, 's')).toBeNull();
  });

  test('⛔ 남의 인스턴스 행의 textBytes 로 인과를 오판하지 않는다', () => {
    const raw = [
      row('prod', 7, 'execute.begin', '2026-08-01T00:00:00.000Z', { textBytes: 999 }),
      row('test:state', 7, 'execute.begin', '2026-08-01T00:00:05.000Z', { textBytes: 6 }),
    ].join('\n');
    expect(turnTextBytes(raw, 7, 'test:state')).toBe(6);
    expect(turnTextBytes(raw, 7, 'prod')).toBe(999);
    // 인스턴스를 안 주면 빈 문자열과 대조되어 **아무것도 안 맞는다**(조용한 오답보다 낫다).
    expect(turnTextBytes(raw, 7)).toBeUndefined();
  });

  test('⛔ 턴 종료도 같은 인스턴스에서만 닫힌다', () => {
    const raw = [
      row('test:state', 7, 'execute.begin', '2026-08-01T00:00:00.000Z'),
      row('prod', 8, 'execute.ok', '2026-08-01T00:00:01.000Z'),          // 남의 우주의 종료
    ].join('\n');
    const started = turnStartedAfter(raw, new Set<string>(), 's');
    expect(started?.instance).toBe('test:state');
    expect(started && closedTurnBoundary(raw, started, 's')).toBeNull();
  });
});

describe('⭐ 「턴이 안 열렸다」와 「열렸는데 안 닫혔다」는 처방이 다르다 (3R 리뷰 should-fix)', () => {
  const opts = { settleMs: 5, pollMs: 1 };
  const begin = JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) });

  test('⛔ 아무 턴도 안 열리면 no-turn — 배선을 의심하는 신호', async () => {
    const runner: LiveTurnRunner = { lifecycleLogs: () => '', deliverInput: () => true, toolsForClosedTurn: () => [] };
    expect(await provePtyDrivesSession(runner, 's', '안녕', opts)).toEqual({ proven: false, reason: 'no-turn' });
  });

  test('⭐ 열렸는데 시한 내 안 닫히면 turn-not-closed — 대기 시한을 의심하는 신호', async () => {
    let calls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : begin),   // 시작만 있고 종료가 없다
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    expect(await provePtyDrivesSession(runner, 's', '안녕', opts)).toEqual({ proven: false, reason: 'turn-not-closed' });
  });

  test('⭐ 절단 턴은 시한 전 발사 도구로 판정하고 절단 표기를 남긴다', async () => {
    let calls = 0;
    let boundary: { timestamp: string; completedAt: string } | undefined;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : begin),
      deliverInput: () => true,
      toolsForClosedTurn: (_sessionId, currentBoundary) => {
        boundary = currentBoundary;
        return ['SelfImplement'];
      },
    };
    const result = await measureLiveTurn(runner, 's', { id: 'D1-01', accept: ['SelfImplement'] }, 'p', 0, {
      ...opts,
      now: (() => { const start = Date.parse('2026-08-01T00:00:00.000Z'); let offset = 0; return () => start + offset++; })(),
      sleep: async () => {},
    });
    expect(result).toEqual({ kind: 'measured', record: { id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass', truncated: true }, openTurn: expect.objectContaining({ timestamp: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.005Z' }) });
    expect(boundary).toMatchObject({ timestamp: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.005Z' });
  });

  test('⛔ poll overshoot 뒤 deadline 이후 도구는 절단 턴 판정에 넣지 않는다', async () => {
    let calls = 0;
    let capturedBoundary: { timestamp: string; completedAt: string } | undefined;
    const toolLogs = [
      JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:00.004Z', event: 'tool-selected', session_id: 's', data: JSON.stringify({ runId: 'r', tool: 'SelfImplement' }) }),
      JSON.stringify({ id: 3, instance: 'i', ts: '2026-08-01T00:00:00.006Z', event: 'tool-selected', session_id: 's', data: JSON.stringify({ runId: 'r', tool: 'Write' }) }),
    ].join('\n');
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : begin),
      deliverInput: () => true,
      toolsForClosedTurn: (_sessionId, boundary) => {
        capturedBoundary = boundary;
        return toolsForSessionTurn(toolLogs, 's', boundary);
      },
    };
    const start = Date.parse('2026-08-01T00:00:00.000Z');
    const now = (() => { const values = [start, start + 1, start + 9]; return () => values.shift() ?? start + 9; })();
    const result = await measureLiveTurn(runner, 's', { id: 'D1-01', accept: ['SelfImplement'] }, 'p', 0, { settleMs: 5, pollMs: 1, now, sleep: async () => {} });
    expect(capturedBoundary?.completedAt).toBe('2026-08-01T00:00:00.005Z');
    expect(result).toEqual({ kind: 'measured', record: { id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass', truncated: true }, openTurn: expect.any(Object) });
  });

  test('⭐ 절단 턴 추가 대기는 환경변수로 재정의되고 기본값은 settle 시한의 3배다', () => {
    expect(resolveTruncatedTurnWaitMs(undefined, 45_000)).toBe(135_000);
    expect(resolveTruncatedTurnWaitMs('9000', 45_000)).toBe(9_000);
    expect(() => resolveTruncatedTurnWaitMs('0', 45_000)).toThrow('CORPUS_TRUNCATED_TURN_WAIT_MS must be a positive integer');
  });

  test('⛔ 절단 턴 대기는 로그가 안 자랄 때만 멈춘다(경과 시간이 아니라 정지)', async () => {
    const sleeps: number[] = [];
    let time = 0;
    const runner: LiveTurnRunner = { lifecycleLogs: () => '', deliverInput: () => true, toolsForClosedTurn: () => [] };
    const result = await waitForOpenTurnClose(runner, 's', { startId: 1, instance: 'i', timestamp: '2026-08-01T00:00:00.000Z', runId: 'r', completedAt: '2026-08-01T00:00:00.005Z' }, {
      settleMs: 5,
      pollMs: 20,
      now: () => time,
      sleep: async (ms) => { sleeps.push(ms); time += ms; },
    });
    // ⛔ 로그가 한 번도 안 자랐으므로 settleMs 뒤 `stalled`. 종전 `deadline-expired` 는
    //    **진행 중인 턴도 시한이면 죽였고**, 그래서 절단 하나가 남은 문항 전부를 미측정으로 만들었다
    //    (실측 2026-08-02 F4 9차 — 12문항 중 3문항만 재고 멈췄다).
    expect(result).toBe('stalled');
    expect(sleeps).toEqual([20]);
  });

  test('⭐⭐ 로그가 안 자라도 화면이 바뀌면 기다린다 — 긴 툴 호출을 정지로 오판하지 않는다', async () => {
    let time = 0;
    let calls = 0;
    const closed = [
      JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
      JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:09.000Z', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
    ].join('\n');
    const runner: LiveTurnRunner = {
      // ⛔ 로그는 **고정**이다 — `RunShell(tsc)` 처럼 긴 툴 하나는 로그를 안 남긴다(실측 8분 28초).
      lifecycleLogs: () => { calls += 1; return calls >= 40 ? closed : 'fixed'; },
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
      // ⭐ 그런데 화면은 스트리밍 타이머 때문에 매번 바뀐다 — 살아 있다는 증거.
      screenFingerprint: () => `⏱ ${calls}s`,
    };
    const result = await waitForOpenTurnClose(runner, 's', { startId: 1, instance: 'i', timestamp: '2026-08-01T00:00:00.000Z', runId: 'r', completedAt: '2026-08-01T00:00:00.005Z' }, {
      settleMs: 5, pollMs: 1, now: () => time, sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe('closed');
    expect(time).toBeGreaterThan(30);   // settleMs 를 훨씬 넘겨서까지 기다렸다
  });

  test('⛔ 로그도 화면도 안 바뀌면 그때 정지다 — 다시 그리지도 못하는 상태', async () => {
    let time = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => 'fixed',
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
      screenFingerprint: () => 'frozen',
    };
    const result = await waitForOpenTurnClose(runner, 's', { startId: 1, instance: 'i', timestamp: '2026-08-01T00:00:00.000Z', runId: 'r', completedAt: '2026-08-01T00:00:00.005Z' }, {
      settleMs: 5, pollMs: 1, now: () => time, sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe('stalled');
  });

  test('⛔ 성장이 멈춘 뒤에도 settleMs 만큼은 더 기다린다(임계를 잠근다)', async () => {
    let time = 0;
    let calls = 0;
    const runner: LiveTurnRunner = {
      // 3회까지 자라고 그 뒤로는 고정 — 즉 3회차 이후가 「정지」다.
      lifecycleLogs: () => { calls += 1; return 'x'.repeat(Math.min(calls, 3)); },
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    const result = await waitForOpenTurnClose(runner, 's', { startId: 1, instance: 'i', timestamp: '2026-08-01T00:00:00.000Z', runId: 'r', completedAt: '2026-08-01T00:00:00.005Z' }, {
      settleMs: 50,
      pollMs: 1,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe('stalled');
    // ⛔ 성장이 멈춘 직후 바로 끊으면 calls 는 4 근처다. settleMs(50) 를 실제로 기다려야 한다.
    //    이 단언이 없으면 임계값을 0 으로 바꿔도 테스트가 통과한다(깨뜨림 검증에서 실측).
    expect(calls).toBeGreaterThan(40);
  });

  test('⭐ 로그가 자라는 동안은 시한을 넘겨도 기다린다 — 진행 중인 턴을 안 죽인다', async () => {
    let time = 0;
    let calls = 0;
    const closed = [
      JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
      JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:09.000Z', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
    ].join('\n');
    const runner: LiveTurnRunner = {
      // settleMs(5) 를 훨씬 넘긴 뒤 닫히지만 그 사이 로그가 계속 자란다.
      lifecycleLogs: () => { calls += 1; return calls >= 6 ? closed : 'x'.repeat(calls); },
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    const result = await waitForOpenTurnClose(runner, 's', { startId: 1, instance: 'i', timestamp: '2026-08-01T00:00:00.000Z', runId: 'r', completedAt: '2026-08-01T00:00:00.005Z' }, {
      settleMs: 5,
      pollMs: 20,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe('closed');
    expect(time).toBeGreaterThan(5);
  });

  test('⭐ 비절단 회차는 종전 레코드·출력 콜백 경로만 사용하고 대기 콜백을 호출하지 않는다', async () => {
    const closed = [
      JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
      JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:00.001Z', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'r' }) }),
    ].join('\n');
    let lifecycleCalls = 0;
    const measured: string[] = [];
    const waiting: string[] = [];
    const aborts: string[] = [];
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => lifecycleCalls++ === 0 ? '' : closed,
      deliverInput: () => true,
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    const result = await runLiveCorpus(runner, ['s'], [{ id: 'D1-01', accept: ['SelfImplement'] }], {
      repeats: 1, settleMs: 5, truncatedTurnWaitMs: 15, pollMs: 1,
      promptForItem: (item) => item.id,
      onMeasured: (item, rep, record) => { measured.push(`${item.id}:rep${rep + 1}:${record.outcome}`); },
      onWaitingForOpenTurn: (item) => { waiting.push(item.id); },
      onAbort: (_item, _rep, reason) => { aborts.push(reason); },
    });
    expect(result).toEqual({ records: [{ id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass' }], truncatedTurns: 0, aborted: false, contaminatedSessionReuse: false });
    expect(measured).toEqual(['D1-01:rep1:pass']);
    expect(waiting).toEqual([]);
    expect(aborts).toEqual([]);
    expect(truncatedTurnsSummary(result.truncatedTurns)).toBeUndefined();
  });

  test('⭐ 반복 회차마다 제공된 서로 다른 세션을 기록하고 그 세션 로그만 측정한다', async () => {
    const sessionsSeen: string[] = [];
    const lifecycleCalls = new Map<string, number>();
    const runner: LiveTurnRunner = {
      lifecycleLogs: (sessionId) => {
        sessionsSeen.push(sessionId);
        const calls = (lifecycleCalls.get(sessionId) ?? 0) + 1;
        lifecycleCalls.set(sessionId, calls);
        if (calls === 1) return '';
        return [
          JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: sessionId, data: JSON.stringify({ runId: `r-${sessionId}` }) }),
          JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:00.001Z', event: 'execute.ok', session_id: sessionId, data: JSON.stringify({ runId: `r-${sessionId}` }) }),
        ].join('\n');
      },
      deliverInput: () => true,
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    const result = await runLiveCorpus(runner, ['session-rep1', 'session-rep2'], [{ id: 'D1-01', accept: ['SelfImplement'] }], {
      repeats: 2, settleMs: 5, truncatedTurnWaitMs: 10, pollMs: 1,
      promptForItem: () => 'prompt', onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: () => {},
    });
    expect(result.records.map((record) => record.sessionId)).toEqual(['session-rep1', 'session-rep2']);
    expect(new Set(result.records.map((record) => record.sessionId)).size).toBe(2);
    expect(sessionsSeen).toContain('session-rep1');
    expect(sessionsSeen).toContain('session-rep2');
  });

  test('⭐ options.sessions 레거시 호출은 회차별 세션 회전을 유지한다', async () => {
    const sessionsSeen: string[] = [];
    const lifecycleCalls = new Map<string, number>();
    const runner: LiveTurnRunner = {
      lifecycleLogs: (sessionId) => {
        const calls = (lifecycleCalls.get(sessionId) ?? 0) + 1;
        lifecycleCalls.set(sessionId, calls);
        if (calls === 1) return '';
        return [
          JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: sessionId, data: JSON.stringify({ runId: `r-${sessionId}` }) }),
          JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:00.001Z', event: 'execute.ok', session_id: sessionId, data: JSON.stringify({ runId: `r-${sessionId}` }) }),
        ].join('\n');
      },
      deliverInput: () => true,
      toolsForClosedTurn: (sessionId) => { sessionsSeen.push(sessionId); return ['SelfImplement']; },
    };
    const result = await runLiveCorpus(runner, [{ id: 'D1-01', accept: ['SelfImplement'] }], {
      sessions: ['legacy-rep1', 'legacy-rep2'], repeats: 2, settleMs: 5, truncatedTurnWaitMs: 10, pollMs: 1,
      promptForItem: () => 'prompt', onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: () => {},
    });
    expect(result.records.map((record) => record.sessionId)).toEqual(['legacy-rep1', 'legacy-rep2']);
    expect(sessionsSeen).toEqual(['legacy-rep1', 'legacy-rep2']);
  });

  test('⛔ 단일 세션으로 2회 이상 측정은 입력 전에 거부한다', async () => {
    let deliveries = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => '', deliverInput: () => { deliveries += 1; return true; }, toolsForClosedTurn: () => [],
    };
    await expect(runLiveCorpus(runner, ['single-session'], [{ id: 'D1-01', accept: ['SelfImplement'] }], {
      repeats: 2, settleMs: 5, truncatedTurnWaitMs: 10, pollMs: 1,
      promptForItem: () => 'prompt', onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: () => {},
    })).rejects.toThrow('CORPUS_SESSIONS requires at least 2 sessions for 2 repeats.');
    expect(deliveries).toBe(0);
  });

  test('⚠️ 명시 옵트인 단일 세션 재사용은 오염 표식을 결과에 남긴다', async () => {
    const sessions: string[] = [];
    let lifecycleCalls = 0;
    const closed = [
      JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-03T00:00:00.000Z', event: 'execute.begin', session_id: 'single-session', data: JSON.stringify({ runId: 'r' }) }),
      JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-03T00:00:00.001Z', event: 'execute.ok', session_id: 'single-session', data: JSON.stringify({ runId: 'r' }) }),
    ].join('\n');
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => lifecycleCalls++ % 2 === 0 ? '' : closed, deliverInput: () => true,
      toolsForClosedTurn: (sessionId) => { sessions.push(sessionId); return []; },
    };
    const result = await runLiveCorpus(runner, ['single-session'], [{ id: 'D1-01', accept: [] }], {
      repeats: 2, allowContaminatedSessionReuse: true, settleMs: 10, truncatedTurnWaitMs: 1, pollMs: 1,
      promptForItem: () => 'prompt', onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: () => {},
      clock: { now: (() => { let now = 0; return () => now; })(), sleep: async () => {} },
    });
    expect(result.contaminatedSessionReuse).toBe(true);
    expect(result.records.map((record) => record.sessionId)).toEqual(['single-session', 'single-session']);
    expect(sessions).toEqual(['single-session', 'single-session']);
  });

  test('⭐ 운영 직렬 루프는 절단 턴이 닫힌 뒤에만 다음 문항을 실제 전달하고 기록한다', async () => {
    const firstOpen = JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) });
    const firstClosed = [firstOpen, JSON.stringify({ id: 2, instance: 'i', ts: '2026-08-01T00:00:00.010Z', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'r' }) })].join('\n');
    const secondClosed = [firstClosed, JSON.stringify({ id: 3, instance: 'i', ts: '2026-08-01T00:00:00.011Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r2' }) }), JSON.stringify({ id: 4, instance: 'i', ts: '2026-08-01T00:00:00.012Z', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'r2' }) })].join('\n');
    const deliveries: string[] = [];
    const measuredNotes: Array<string | undefined> = [];
    const waiting: string[] = [];
    let firstTurnPolls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => {
        if (deliveries.length === 0) return '';
        if (deliveries.length === 1) return ++firstTurnPolls <= 3 ? firstOpen : firstClosed;
        return secondClosed;
      },
      deliverInput: (prompt) => { deliveries.push(prompt); return true; },
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    let time = 0;
    const result = await runLiveCorpus(runner, ['s'], [
      { id: 'D1-01', accept: ['SelfImplement'], note: 'first-note' },
      { id: 'D1-02', accept: ['SelfImplement'], note: 'second-note' },
    ], {
      repeats: 1, settleMs: 3, truncatedTurnWaitMs: 5, pollMs: 1,
      clock: { now: () => time++, sleep: async () => {} },
      promptForItem: (item) => `${item.id}:${item.note}`,
      onMeasured: (item) => { measuredNotes.push(item.note); },
      onWaitingForOpenTurn: (item, rep, waitMs) => { waiting.push(`${item.id}:rep${rep + 1}:${waitMs}`); },
      onAbort: () => {},
    });
    expect(result).toMatchObject({ aborted: false, truncatedTurns: 1 });
    expect(result.records).toEqual([
      { id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass', truncated: true },
      { id: 'D1-02', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass' },
    ]);
    expect(deliveries).toEqual(['D1-01:first-note', 'D1-02:second-note']);
    expect(measuredNotes).toEqual(['first-note', 'second-note']);
    expect(waiting).toEqual(['D1-01:rep1:5']);
  });

  test('⛔ 운영 직렬 루프는 추가 시한 만료에서 기존 절단 중단 사유를 내고 다음 문항을 전달하지 않는다', async () => {
    const openOnly = JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) });
    const deliveries: string[] = [];
    const abortReasons: string[] = [];
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => deliveries.length === 0 ? '' : openOnly,
      deliverInput: (prompt) => { deliveries.push(prompt); return true; },
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    let time = 0;
    const aborted = await runLiveCorpus(runner, ['s'], [{ id: 'D1-01', accept: ['SelfImplement'] }, { id: 'D1-02', accept: ['SelfImplement'] }], {
      repeats: 1, settleMs: 3, truncatedTurnWaitMs: 2, pollMs: 5,
      clock: { now: () => time++, sleep: async () => {} },
      promptForItem: (item) => item.id,
      onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: (_item, _rep, reason) => { abortReasons.push(reason); },
    });
    expect(aborted).toMatchObject({ aborted: true, truncatedTurns: 1 });
    expect(aborted.records).toHaveLength(1);
    expect(deliveries).toEqual(['D1-01']);
    // ⛔ 사유가 바뀌었다 — 「시한 만료」가 아니라 「진행 정지」다(로그가 안 자랐다).
    expect(abortReasons).toEqual(['truncated-turn-stalled']);
  });

  test('⛔ 운영 직렬 루프는 배수 대기 중 로그 조회 실패를 즉시 abort하고 다음 문항을 전달하지 않는다', async () => {
    const openOnly = JSON.stringify({ id: 1, instance: 'i', ts: '2026-08-01T00:00:00.000Z', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r' }) });
    const deliveries: string[] = [];
    const abortReasons: string[] = [];
    let lifecycleCalls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => {
        lifecycleCalls += 1;
        if (lifecycleCalls === 1) return '';
        if (lifecycleCalls === 2) return openOnly;
        return null;
      },
      deliverInput: (prompt) => { deliveries.push(prompt); return true; },
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    let time = 0;
    const aborted = await runLiveCorpus(runner, ['s'], [{ id: 'D1-01', accept: ['SelfImplement'] }, { id: 'D1-02', accept: ['SelfImplement'] }], {
      repeats: 1, settleMs: 2, truncatedTurnWaitMs: 3, pollMs: 1,
      clock: { now: () => time++, sleep: async () => {} },
      promptForItem: (item) => item.id,
      onMeasured: () => {}, onWaitingForOpenTurn: () => {}, onAbort: (_item, _rep, reason) => { abortReasons.push(reason); },
    });
    expect(aborted).toMatchObject({ aborted: true, truncatedTurns: 1 });
    expect(deliveries).toEqual(['D1-01']);
    expect(abortReasons).toEqual(['snapshot-failed']);
  });

  test('⛔ 절단 회차는 기록을 보존하고 다음 입력 전에 라이브 실행을 끝낸다', async () => {
    let calls = 0;
    let delivered = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : begin),
      deliverInput: () => { delivered += 1; return true; },
      toolsForClosedTurn: () => ['SelfImplement'],
    };
    const result = await measureLiveTurn(runner, 's', { id: 'D1-01', accept: ['SelfImplement'] }, 'p', 0, {
      ...opts,
      now: (() => { let now = 0; return () => ++now; })(),
      sleep: async () => {},
    });
    expect(result).toEqual({ kind: 'measured', record: { id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass', truncated: true }, openTurn: expect.any(Object) });
    expect(endsLiveRun(result)).toBe(true);
    expect(delivered).toBe(1);
  });

  test('⛔ 절단 회차 0은 기존 요약에 바이트를 추가하지 않는다', () => {
    expect(truncatedTurnsSummary(0)).toBeUndefined();
    expect(truncatedTurnsSummary(2)).toBe('[live] 절단 회차 2');
    expect(endsLiveRun({ kind: 'measured', record: { id: 'D1-01', rep: 0, sessionId: 's', fired: ['SelfImplement'], outcome: 'pass' } })).toBe(false);
  });

  test('⛔ 절단 턴의 빈 도구 목록은 no-fire가 아니라 측정 불가다', async () => {
    let calls = 0;
    const runner: LiveTurnRunner = {
      lifecycleLogs: () => (calls++ === 0 ? '' : begin),
      deliverInput: () => true,
      toolsForClosedTurn: () => [],
    };
    await expect(measureLiveTurn(runner, 's', { id: 'D1-01', accept: ['SelfImplement'] }, 'p', 0, opts))
      .resolves.toEqual({ kind: 'unmeasurable', reason: 'completion-failed' });
  });
});

describe('⛔⭐⭐ `runId` 없는 실제 로그로도 턴 경계가 잡힌다 (2026-08-01 전수 실측)', () => {
  // ⚠️ 실측: input.submit 은 runId 를 **최상위에도 중첩에도 내지 않는다**(전 행 0건).
  //    종전 계약은 그것을 필수로 요구해 턴 경계가 영영 안 잡혔다.
  const row = (id: number, event: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, instance: 'test:state', ts, event, session_id: 's',
      data: JSON.stringify({ targetKind: 'plain', sourceKind: 'keyboard', ...extra }) });

  const raw = [
    row(1, 'execute.begin', '2026-08-01T13:00:00.000Z', { textBytes: 6 }),
    row(2, 'execute.ok', '2026-08-01T13:00:04.000Z'),
  ].join('\n');

  test('⭐ runId 가 없어도 시작이 잡히고 runId 는 null 로 남는다(없는 것을 지어내지 않는다)', () => {
    const started = turnStartedAfter(raw, new Set<string>(), 's');
    expect(started).toEqual({ startId: 1, instance: 'test:state', timestamp: '2026-08-01T13:00:00.000Z', runId: null });
  });

  test('⭐ runId 가 null 이면 세션·인스턴스·id 순서로 닫는다', () => {
    const started = turnStartedAfter(raw, new Set<string>(), 's')!;
    expect(closedTurnBoundary(raw, started, 's'))
      .toEqual({ startId: 1, instance: 'test:state', timestamp: '2026-08-01T13:00:00.000Z', runId: null, completedAt: '2026-08-01T13:00:04.000Z' });
  });

  test('⛔ 음성 대조 — 다른 인스턴스의 종료로는 안 닫힌다(느슨해진 것이 아니다)', () => {
    const mixed = [
      row(1, 'execute.begin', '2026-08-01T13:00:00.000Z', { textBytes: 6 }),
      JSON.stringify({ id: 2, instance: 'prod', ts: '2026-08-01T13:00:04.000Z', event: 'execute.ok', session_id: 's', data: '{}' }),
    ].join('\n');
    const started = turnStartedAfter(mixed, new Set<string>(), 's')!;
    expect(closedTurnBoundary(mixed, started, 's')).toBeNull();
  });

  test('⭐ runId 가 **있으면** 여전히 대조한다(무회귀 — 느슨해진 것이 아니다)', () => {
    const withRun = [
      JSON.stringify({ id: 1, instance: 'i', ts: 't1', event: 'execute.begin', session_id: 's', data: JSON.stringify({ runId: 'r1' }) }),
      JSON.stringify({ id: 2, instance: 'i', ts: 't2', event: 'execute.ok', session_id: 's', data: JSON.stringify({ runId: 'OTHER' }) }),
    ].join('\n');
    const started = turnStartedAfter(withRun, new Set<string>(), 's')!;
    expect(started.runId).toBe('r1');
    expect(closedTurnBoundary(withRun, started, 's')).toBeNull();   // runId 가 다르면 안 닫는다
  });

  test('⛔ 실 왕복에서 텍스트 길이가 그대로 읽힌다(인과 프로브의 근거)', () => {
    expect(turnTextBytes(raw, 1, 'test:state')).toBe(6);
  });
});
