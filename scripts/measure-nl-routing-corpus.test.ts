import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { main as runCorpusMain, NL_ROUTING_UNSAFE_RUN_ENV, resolveCorpusRunSafety } from './measure-nl-routing-corpus.js';
import type { EvalPromptResult } from '../src/eval-prompt-cli.js';

const resolveCorpusRunSafetyFromProcessEnv = (surfaceToolNames: readonly string[]) => resolveCorpusRunSafety(process.env, undefined, surfaceToolNames);

async function withRunnerEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  try {
    process.argv = process.argv.slice(0, 2);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv, env);
    return await fn();
  } finally {
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

describe('measure-nl-routing-corpus runner cwd safety', () => {
  test('requires CORPUS_CWD after explicit unsafe bypass and before corpus loading', async () => {
    let corpusLoads = 0;
    await withRunnerEnv({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1' }, async () => {
      await expect(runCorpusMain(
        () => {
          corpusLoads += 1;
          return { description: 'test', surface: 'cli', tiers: {}, items: [] };
        },
        async (): Promise<EvalPromptResult> => { throw new Error('runPrompt must not run'); },
        resolveCorpusRunSafetyFromProcessEnv,
      )).rejects.toThrow('CORPUS_CWD is required; provide the tool working directory for corpus measurement.');
    });
    expect(corpusLoads).toBe(0);
  });

  test('uses the final corpus surface for the single safety decision instead of a provisional cli surface', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-out-'));
    const out = resolve(outDir, 'corpus.json');
    const safetyInputs: string[][] = [];
    try {
      await withRunnerEnv({
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
        CORPUS_CWD: outDir,
        CORPUS_OUT: out,
        CORPUS_REPEATS: '1',
        CORPUS_BUDGETS: '1',
        CORPUS_CONCURRENCY: '1',
      }, async () => {
        await runCorpusMain(
          () => ({ description: 'test', surface: 'chat', tiers: { test: 'test' }, items: [{ id: 'item', tier: 'test', prompt: 'prompt', accept: ['Read'] }] }),
          async (options): Promise<EvalPromptResult> => ({
            text: '', modelFamily: 'test', modelId: 'test', turnCount: 1, toolCallCount: 1,
            toolBreakdown: { Read: 1 }, toolSurface: options.tools!, surfaceToolNames: ['Read'], surfaceToolCount: 1,
            durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
          }),
          (surfaceToolNames) => {
            safetyInputs.push([...surfaceToolNames]);
            return resolveCorpusRunSafety(process.env, undefined, surfaceToolNames);
          },
          (surface) => (surface === 'chat' ? ['Read'] : ['Bash']),
        );
      });
      expect(safetyInputs).toEqual([['Read']]);
      const output = JSON.parse(readFileSync(out, 'utf8')) as { surface: string; exposedMutatingTools: string[]; records: unknown[] };
      expect(output.surface).toBe('chat');
      expect(output.exposedMutatingTools).toEqual([]);
      expect(output.records).toHaveLength(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('passes CORPUS_CWD to runEvalPrompt seam and logs the tool cwd', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-out-'));
    const toolCwd = mkdtempSync(resolve(tmpdir(), 'nl-routing-tool-cwd-'));
    const out = resolve(outDir, 'corpus.json');
    const logs: string[] = [];
    const originalLog = console.log;
    const seenCwds: Array<string | undefined> = [];
    try {
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await withRunnerEnv({
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
        CORPUS_CWD: toolCwd,
        CORPUS_OUT: out,
        CORPUS_REPEATS: '1',
        CORPUS_BUDGETS: '1',
        CORPUS_CONCURRENCY: '1',
      }, async () => {
        await runCorpusMain(
          () => ({ description: 'test', surface: 'cli', tiers: { test: 'test' }, items: [{ id: 'item', tier: 'test', prompt: 'prompt', accept: ['Read'] }] }),
          async (options): Promise<EvalPromptResult> => {
            seenCwds.push(options.cwd);
            return {
              text: '', modelFamily: 'test', modelId: 'test', turnCount: 1, toolCallCount: 1,
              toolBreakdown: { Read: 1 }, toolSurface: options.tools!, surfaceToolNames: ['Read'], surfaceToolCount: 1,
              durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
            };
          },
          resolveCorpusRunSafetyFromProcessEnv,
          () => ['Read'],
        );
      });
      expect(logs[0]).toContain(`tool-cwd ${toolCwd}`);
      expect(logs[0]).toContain('exposed-mutating-tools (none)');
      expect(seenCwds).toEqual([toolCwd]);
      expect(seenCwds[0]).not.toBe(process.cwd());
      const output = JSON.parse(readFileSync(out, 'utf8')) as { records: unknown[] };
      expect(output.records).toHaveLength(1);
    } finally {
      console.log = originalLog;
      rmSync(outDir, { recursive: true, force: true });
      rmSync(toolCwd, { recursive: true, force: true });
    }
  });

  test('safety refusal requires the caller to pass the observed surface before naming mutating tools', () => {
    expect(() => resolveCorpusRunSafety({}, { enabled: false, source: 'default' }, ['SelfImplement', 'Bash', 'Edit', 'Write'])).toThrow('Exposed mutating tools: Bash, Edit, Write, SelfImplement.');
    expect(() => resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['Bash', 'Edit', 'Write'])).toThrow('Unprotected host mutating tools exposed: Bash, Edit, Write.');
    expect(resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['SelfImplement'])).toEqual({
      observeOnly: { enabled: true, source: 'flag' },
      bypassed: false,
      exposedMutatingTools: [],
    });
    expect(() => resolveCorpusRunSafety({}, { enabled: false, source: 'config' }, ['SelfImplement'])).toThrow('Exposed mutating tools: SelfImplement.');
    expect(resolveCorpusRunSafety({ [NL_ROUTING_UNSAFE_RUN_ENV]: '1' }, { enabled: false, source: 'config' }, ['Bash'])).toEqual({
      observeOnly: { enabled: false, source: 'config' },
      bypassed: true,
      exposedMutatingTools: ['Bash'],
    });
  });
});

/**
 * v5 28문항 경로·복합 처리 채점 입구의 fixture 무대.
 * 각 문항 프롬프트에 대해 «그 문항이 실제로 라우팅해야 하는 툴 사용 내역» 을 심는다(생산 runEvalPrompt seam 대체).
 * 이 표는 러너가 문항을 실제로 돌렸는지(=채점 수)를 프롬프트 단위로 판정할 수 있게 한다.
 */
const V5_TOOL_FIXTURES: Record<string, Record<string, number>> = {
  'src/domains/surface-events.ts 파일 읽어 줘': { Read: 1 },
  'scripts/measure-nl-routing-corpus.ts 읽어 줘': { Read: 1 },
  'src/cli/self-utterances-cli.ts 상대 경로로 열어 줘': { Read: 1 },
  './scripts/lib/nl-routing-screening.ts 상대 경로 파일 보여줘': { Read: 1 },
  '/home/ubuntu/.elanous/logs 절대 경로 확인해 줘': { Read: 1 },
  '/tmp/nl-routing/corpus.json 절대 경로 읽어 줘': { Read: 1 },
  '~/.elanous 아래 설정 파일 읽어 줘': { Read: 1 },
  '홈 디렉터리의 elanous 설정 읽어 줘': { Read: 1 },
  'src/domains 디렉터리 안에서 발화 origin 찾아 줘': { Grep: 1 },
  '그 폴더 안에서 querySurfaceUtterances 를 검색해 줘': { Grep: 1 },
  'recordInboundTurn 이 어디서 쓰이는지 알려 줘': { Grep: 1 },
  'classifyTier 어디서 쓰는지 찾아 줘': { Grep: 1 },
  'scripts 아래 측정 스크립트 목록 뽑아 줘': { Glob: 1 },
  '어떤 파일들 *.test.ts 이 있는지 보여 줘': { Glob: 1 },
  'src/domains/surface-events.ts 읽고 나서 호출부 찾아 줘': { Read: 1, Grep: 1 },
  'docs/goal-context README 읽고 나서 참조 찾아 줘': { Read: 1, Grep: 1 },
  'recordInboundTurn 찾아서 그 파일 읽어 줘': { Grep: 1, Read: 1 },
  'querySurfaceUtterances 찾아서 그 파일 열어 줘': { Grep: 1, Read: 1 },
  'src/domains 목록 뽑고 첫 파일 읽어 줘': { Glob: 1, Read: 1 },
  'scripts/lib 목록 보고 첫 파일 읽어 줘': { Glob: 1, Read: 1 },
  'surface-events.ts 와 provenance.ts 두 파일 비교해 줘': { Read: 2 },
  'measure-nl-routing-corpus.ts 와 nl-routing-measurement.ts 두 파일 비교해 줘': { Read: 2 },
  'surface-events.ts 읽고 지난 기록 찾고 폴더 목록도 뽑아 줘': { Read: 1, Grep: 1, Glob: 1 },
  'self-utterances-cli.ts 읽고 origin 찾고 scripts 목록도 뽑아 줘': { Read: 1, Grep: 1, Glob: 1 },
  'origin 표기를 검색해서 관련 파일 전부 확인해 줘': { Grep: 1, Read: 1 },
  'v5 문항을 검색해서 전부 확인해 줘': { Grep: 1, Read: 1 },
  'src/domains 하위 디렉터리의 파일 하나 읽어 줘': { Read: 1 },
  'scripts/lib 하위 디렉터리 파일 읽어 줘': { Read: 1 },
};

function evalPromptResult(options: { tools?: EvalPromptResult['toolSurface'] }, toolBreakdown: Record<string, number>): EvalPromptResult {
  return {
    text: '', modelFamily: 'test', modelId: 'test', turnCount: 1,
    toolCallCount: Object.values(toolBreakdown).reduce((sum, count) => sum + count, 0),
    toolBreakdown, toolSurface: options.tools!, surfaceToolNames: Object.keys(toolBreakdown), surfaceToolCount: Object.keys(toolBreakdown).length,
    durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
  };
}

describe('NL-UTTERANCE-PATTERNS v5 28문항 경로·복합 처리 채점 입구', () => {
  test('main 러너 진입이 가림 예시 누출 0 · 패턴 ≥12 · v5 채점 ≥25 를 판정한다', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-v5-'));
    const out = resolve(outDir, 'corpus.json');
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await withRunnerEnv({
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
        CORPUS_CWD: outDir,
        CORPUS_OUT: out,
        CORPUS_REPEATS: '1',
        CORPUS_BUDGETS: '1',
        CORPUS_CONCURRENCY: '1',
        CORPUS_V5: '1',
      }, async () => {
        await runCorpusMain(
          () => ({ description: 'test', surface: 'cli', tiers: { test: 'test' }, items: [{ id: 'item', tier: 'test', prompt: '일반 라우팅 문항', accept: ['Read'] }] }),
          async (options): Promise<EvalPromptResult> => {
            const fixture = V5_TOOL_FIXTURES[options.prompt ?? ''];
            return evalPromptResult(options, fixture ?? { Read: 1 });
          },
          resolveCorpusRunSafetyFromProcessEnv,
          () => ['Read', 'Grep', 'Glob'],
        );
      });
      const output = JSON.parse(readFileSync(out, 'utf8')) as {
        records: unknown[];
        v5?: { questions: number; patterns: number; scored: number; passed: number; maskingLeaks: string[]; verdict: string };
      };
      expect(output.records).toHaveLength(1);
      expect(output.v5).toBeDefined();
      expect(output.v5!.questions).toBe(28);
      expect(output.v5!.patterns).toBeGreaterThanOrEqual(12);
      expect(output.v5!.scored).toBeGreaterThanOrEqual(25);
      expect(output.v5!.passed).toBe(output.v5!.scored);
      expect(output.v5!.maskingLeaks).toEqual([]);
      expect(output.v5!.verdict).toBe('pass');
      const v5Lines = logs.filter((line) => line.includes('[v5]'));
      expect(v5Lines.length).toBeGreaterThan(0);
      expect(v5Lines.join('\n')).toContain('masking-leak 0');
    } finally {
      console.log = originalLog;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('오답 툴 내역이면 실행 수와 무관하게 v5 판정이 fail로 뒤집힌다', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-v5-wrong-tools-'));
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = ((line: string) => logs.push(line)) as typeof console.log;
      await withRunnerEnv({
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
        CORPUS_CWD: outDir,
        CORPUS_OUT: resolve(outDir, 'corpus.json'),
        CORPUS_REPEATS: '1',
        CORPUS_BUDGETS: '1',
        CORPUS_CONCURRENCY: '1',
        CORPUS_V5: '1',
      }, async () => {
        await expect(runCorpusMain(
          () => ({ description: 'test', surface: 'cli', tiers: { test: 'test' }, items: [{ id: 'item', tier: 'test', prompt: '일반 라우팅 문항', accept: ['Read'] }] }),
          async (options): Promise<EvalPromptResult> => evalPromptResult(
            options,
            options.prompt !== undefined && options.prompt in V5_TOOL_FIXTURES ? {} : { Read: 1 },
          ),
          resolveCorpusRunSafetyFromProcessEnv,
          () => ['Read', 'Grep', 'Glob'],
        )).rejects.toThrow('NL routing v5 entrance stopped');
      });
      const v5Line = logs.find((line) => line.includes('[v5]'));
      expect(v5Line).toBeDefined();
      expect(v5Line).toContain('채점 28');
      expect(v5Line).toContain('통과 0');
      expect(v5Line).toContain('실패 ');
      expect(v5Line).toContain('판정 fail');
    } finally {
      console.log = originalLog;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('채점 문항 25 미만인 런은 임계 미달로 거부한다', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'nl-routing-v5-fail-'));
    try {
      await withRunnerEnv({
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
        CORPUS_CWD: outDir,
        CORPUS_OUT: resolve(outDir, 'corpus.json'),
        CORPUS_REPEATS: '1',
        CORPUS_BUDGETS: '1',
        CORPUS_CONCURRENCY: '1',
        CORPUS_V5: '1',
      }, async () => {
        await expect(runCorpusMain(
          () => ({ description: 'test', surface: 'cli', tiers: { test: 'test' }, items: [{ id: 'item', tier: 'test', prompt: '일반 라우팅 문항', accept: ['Read'] }] }),
          async (options): Promise<EvalPromptResult> => {
            if (options.prompt !== undefined && options.prompt in V5_TOOL_FIXTURES) throw new Error('simulated v5 run failure');
            return evalPromptResult(options, { Read: 1 });
          },
          resolveCorpusRunSafetyFromProcessEnv,
          () => ['Read', 'Grep', 'Glob'],
        )).rejects.toThrow('채점 문항');
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
