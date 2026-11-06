import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { authorGoal } from '../self-implement/goal-author.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import { seams } from '../self-implement/test-seams.js';
import { buildPrBody, defaultSeams } from '../self-implement/seams.js';
import { runHeadlessGoalLoopPty } from '../self-implement/headless-elanous-driver.js';
import { makePrManager } from '../autopilot/pr-manager.js';
import { TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from './fake-llm.js';
import { createFakeGh } from './fake-gh.js';

const previousFakeLlm = process.env[TEST_FAKE_LLM_ENV];
const previousCapture = process.env[TEST_FAKE_LLM_CAPTURE_ENV];
const previousFakeAsProvider = process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER;
const previousFakeResponse = process.env[TEST_FAKE_LLM_RESPONSE_ENV];
const previousFakeToolCall = process.env[TEST_FAKE_LLM_TOOL_CALL_ENV];
const temporaryRoots: string[] = [];

setDefaultTimeout(90_000);

afterEach(() => {
  if (previousFakeLlm === undefined) delete process.env[TEST_FAKE_LLM_ENV];
  else process.env[TEST_FAKE_LLM_ENV] = previousFakeLlm;
  if (previousCapture === undefined) delete process.env[TEST_FAKE_LLM_CAPTURE_ENV];
  else process.env[TEST_FAKE_LLM_CAPTURE_ENV] = previousCapture;
  if (previousFakeAsProvider === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER;
  else process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = previousFakeAsProvider;
  if (previousFakeResponse === undefined) delete process.env[TEST_FAKE_LLM_RESPONSE_ENV];
  else process.env[TEST_FAKE_LLM_RESPONSE_ENV] = previousFakeResponse;
  if (previousFakeToolCall === undefined) delete process.env[TEST_FAKE_LLM_TOOL_CALL_ENV];
  else process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = previousFakeToolCall;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.serial('SIM-CHAIN-IMPL production orchestrator path', () => {
  test('authors a goal, records fake child LLM input, exercises must-fix cap, and opens a fake GitHub PR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-chain-impl-'));
    temporaryRoots.push(root);
    const testStateRoot = mkdtempSync(join(tmpdir(), 'sim-chain-state-'));
    temporaryRoots.push(testStateRoot);
    const testHome = join(testStateRoot, 'home');
    const testCodexHome = join(testStateRoot, 'codex-home');
    mkdirSync(testHome, { recursive: true });
    mkdirSync(testCodexHome, { recursive: true });
    writeFileSync(join(testStateRoot, 'config.json'), JSON.stringify({
      llm: { provider: 'auto', model: 'auto' },
      onboarding: { completed: true, ready: true },
      telegram: { enabled: false }, discord: { enabled: false },
    }));
    mkdirSync(join(root, 'src', 'ux-sim'), { recursive: true });
    writeFileSync(join(root, 'src', 'ux-sim', 'chain-impl.test.ts'), '// SIM-CHAIN-IMPL fixture\n');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Simulation Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'simulation@example.invalid']);
    execFileSync('git', ['-C', root, 'add', 'src/ux-sim/chain-impl.test.ts']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'SIM-CHAIN-IMPL fixture']);
    const capturePath = join(root, 'llm-requests.jsonl');
    let ptyTranscript = '';
    process.env[TEST_FAKE_LLM_ENV] = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = '1';
    process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'GOAL-COMPLETE';
    process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({
      when: 'SIM-CHAIN-IMPL', name: 'Write',
      args: { file_path: join(root, 'fake-child-result.md'), content: 'SIM-CHAIN-IMPL fake child changed a fixture.' },
    });
    process.env[TEST_FAKE_LLM_CAPTURE_ENV] = capturePath;

    const result = await (async () => {
      const authored = await authorGoal(
        '대상 경로: src/ux-sim/chain-impl.test.ts\n판정선(반증): must-fix 리뷰가 상한에서 멈추고 PR이 열린다.',
        {
          authorGrade: { grade: 'lite', source: 'flag' },
          ground: async () => { throw new Error('lite authoring must not ground'); },
          enhance: async (ask) => ({ original: ask, checklist: [], verbatimPreserved: true }),
          goalTitle: 'SIM-CHAIN-IMPL recorded child and capped review',
          slugFn: async () => 'sim-chain-impl-recorded-child',
        },
      );
      const gh = createFakeGh({ prs: [], repository: 'fixture/sim-chain-impl' });
      const prManager = makePrManager((command, args) => {
        if (command === 'gh') {
          const result = gh.run(command, [...args]);
          return { ok: result.status === 0, out: result.stdout, err: result.stderr, rc: result.status ?? undefined };
        }
        const joined = args.join(' ');
        return { ok: true, out: joined.includes('rev-list --count') ? '1' : joined.includes('rev-parse --verify') ? 'origin/main' : '', rc: 0 };
      });
      const production = defaultSeams({
        prManager,
        elanousBinRoot: resolve(import.meta.dir, '../..'),
        configDir: testStateRoot,
        stateDir: testStateRoot,
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async (options) => {
          const result = await runHeadlessGoalLoopPty(options);
          ptyTranscript += result.transcript;
          return result;
        },
        implementMaxWaitSec: 60,
        implementActivityGraceSec: 5,
        childEnv: {
          [TEST_FAKE_LLM_ENV]: '1',
          ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_STATE_DIR: testStateRoot,
          HOME: testHome,
          PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
          CODEX_HOME: testCodexHome,
          ANTHROPIC_API_KEY: '', BIGMODEL_API_KEY: '', DASHSCOPE_API_KEY: '', GEMINI_API_KEY: '',
          GLM_API_KEY: '', GOOGLE_API_KEY: '', KIMI_API_KEY: '', MOONSHOT_API_KEY: '',
          OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', QWEN_API_KEY: '', XAI_API_KEY: '',
          ZAI_API_KEY: '', ZHIPU_API_KEY: '', CODEX_ACCESS_TOKEN: '',
          [TEST_FAKE_LLM_CAPTURE_ENV]: capturePath,
          [TEST_FAKE_LLM_RESPONSE_ENV]: 'GOAL-COMPLETE',
          [TEST_FAKE_LLM_TOOL_CALL_ENV]: process.env[TEST_FAKE_LLM_TOOL_CALL_ENV]!,
        },
      });
      let reviewCalls = 0;
      let expectedHead = '';
      let orchestratorPrInput: Parameters<typeof production.openPr>[0] | undefined;
      const reviewFindings: string[][] = [];
      const run = await runSelfImplement({
        runId: 'sim-chain-impl-review-cap',
        feature: `SIM-CHAIN-IMPL\n${authored.document}`,
        memory: false,
        maxReworkRounds: 1,
        childLlm: { provider: 'auto', model: 'auto', source: 'config' },
        seams: {
          ...production,
          ...seams({
          createWorktree: async ({ branch, base }) => { expectedHead = branch; return { path: root, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }; },
          detectUncommittedWork: () => ({ status: 'changes', trackedChanges: ['src/ux-sim/chain-impl.test.ts'], untrackedFiles: [] }),
          commitFinishedChildWork: () => ({ ok: true, out: 'simulated child work commit' }),
          gate: async () => ({ passed: true, log: 'simulated changed-file self-gate: pass' }),
          reviewDiff: async () => {
            reviewCalls += 1;
            const mustFix = ['SIM-CHAIN-IMPL repeated must-fix'];
            reviewFindings.push(mustFix);
            return { verdict: 'fail', mustFix, shouldFix: [], summary: 'fake Terra must-fix', reviewed: true, diffTruncated: false };
          },
          }),
          implement: production.implement,
          openPr: async (input) => {
            orchestratorPrInput = input;
            return production.openPr(input);
          },
        },
      });
      const firstPr = { ...gh.prs[0]! };
      const reused = await production.openPr({ title: 'SIM-CHAIN-IMPL reused PR', body: 'SIM-CHAIN-IMPL updated existing PR body', head: firstPr.branch, cwd: root });
      return { authored, gh, run, reviewCalls, reviewFindings, ptyTranscript, expectedHead, reused, firstPr, orchestratorPrInput };
    })();

    expect(result.run).toMatchObject({ ok: true, stage: 'pr-opened', prNumber: 1 });
    expect(result.ptyTranscript).toContain('Write');
    const recorded = readFileSync(capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> });
    expect(result.authored.document).toContain('## ACCEPTANCE CRITERIA');
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    expect(recorded.at(-1)?.messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('SIM-CHAIN-IMPL') }));
    expect(result.reviewCalls).toBe(2);
    expect(result.reviewFindings).toEqual([
      ['SIM-CHAIN-IMPL repeated must-fix'],
      ['SIM-CHAIN-IMPL repeated must-fix'],
    ]);
    expect(result.gh.prs).toHaveLength(1);
    expect(result.orchestratorPrInput).toBeDefined();
    const orchestratorPrInput = result.orchestratorPrInput!;
    expect(result.firstPr.branch).toBe(result.expectedHead);
    expect(result.firstPr.body).toContain(result.authored.document);
    expect(result.firstPr.title).toBe(orchestratorPrInput.title);
    expect(result.firstPr.body).toBe(buildPrBody(resolve(import.meta.dir, '../..'), orchestratorPrInput.body));
    expect(result.reused).toMatchObject({ number: 1, url: 'https://github.com/fixture/sim-chain-impl/pull/1' });
    expect(result.gh.prs[0]?.title).toBe('SIM-CHAIN-IMPL reused PR');
    expect(result.gh.prs[0]?.body).toContain('SIM-CHAIN-IMPL updated existing PR body');
    expect(result.gh.calls.filter((args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1);
    expect(result.gh.calls.some((args) => args[0] === 'pr' && args[1] === 'edit')).toBe(true);
    const createArgs = result.gh.calls.find((args) => args[0] === 'pr' && args[1] === 'create');
    expect(createArgs).toBeDefined();
    const valueAfter = (flag: string): string => createArgs?.[createArgs.indexOf(flag) + 1] ?? '';
    expect(valueAfter('--head')).toBe(orchestratorPrInput.head);
    expect(valueAfter('--title')).toBe(orchestratorPrInput.title);
    expect(valueAfter('--body')).toBe(buildPrBody(resolve(import.meta.dir, '../..'), orchestratorPrInput.body));
    expect(result.run.review?.mustFix).toEqual(['SIM-CHAIN-IMPL repeated must-fix']);
    expect(result.gh.calls.every((args) => args[0] === 'pr')).toBe(true);
  });
});
