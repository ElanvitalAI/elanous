import { setDefaultTimeout, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** `#8609`(R1c) 이후의 자식 진행 계약 — 사람 줄 하나 ⊕ 구조 프레임 하나.
 *  ⛔ 문자열 전체를 못 박지 않는다: `planId` 는 런마다 달라서 그러면 자가 매번 빨개진다. */
/**
 * 진행 프레임 계약 — ⛔ **약화하지 않는다.**
 *
 * 🔑 종전 이 함수는 「프레임이 «정확히 하나»」를 단정했다. 그런데 한 산출이 프레임 «둘»(plan → step)을
 *   내는 자리가 생겼고, 그때 이 함수를 «부르지 않고» 인라인 검사로 «갈아끼운» 적이 있다.
 *   ⇒ 그러면 version·seq·사람줄↔프레임 짝 같은 «기존 칸»이 그 자리에서 조용히 사라진다.
 *
 * ✅ 그래서 수를 «인자»로 받는다. 칸 검사는 프레임 «마다» 그대로 돌고, 종류의 «순서»는 따로 단정한다.
 *   ⛔ `expectedKinds` 를 안 주면 종전과 «같다» — 프레임 하나.
 */
function expectProgressContract(output: string, expectedKinds: readonly string[] = ['plan']): void {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const frames = lines.filter((line) => line.startsWith('PROGRESS_FRAME:'));
  const humanLines = lines.filter((line) => line.startsWith('PROGRESS:'));
  expect(humanLines).toHaveLength(1);
  expect(frames).toHaveLength(expectedKinds.length);
  const decoded = frames.map((line) => JSON.parse(Buffer.from(line.slice('PROGRESS_FRAME:'.length), 'base64').toString('utf8')) as
    { version: number; kind: string; seq: number; humanLine?: string });
  // ⭐ 칸 검사는 «프레임마다» — 하나만 보면 뒤쪽 프레임이 계약을 깨도 안 잡힌다.
  for (const frame of decoded) {
    expect(frame.version).toBe(1);
    expect(['plan', 'step']).toContain(frame.kind);
    expect(typeof frame.seq).toBe('number');
  }
  // ⭐ 순서 — 종류가 나오는 «차례»가 계약이다(plan 이 step 보다 먼저다).
  expect(decoded.map((frame) => frame.kind)).toEqual([...expectedKinds]);
  // 사람 줄과 «첫» 프레임이 «같은 것»을 말해야 한다 — 층이 갈려 둘이 어긋나면 화면이 거짓을 말한다.
  expect(`PROGRESS:${decoded[0]!.humanLine ?? ''}`).toBe(humanLines[0]);
}
import { debug } from '../debug/log.js';
import { runHeadlessGoalLoopPty } from './headless-elanous-driver.js';
import { GOAL_RULES_POLICY } from './goal-author.js';
import { defaultSeams, reviewScopeDiff } from './seams.js';
import { runSelfImplement } from './orchestrator.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe('self-implement progress runId', () => {
  test('headless.progress and poll.heartbeat retain the driving runId', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress' || event === 'poll.heartbeat') events.push({ event, data: data ?? {} });
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'run-progress',
        maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true,
        spawn: (() => ({
          id: 'self_progress', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
          snapshot: () => 'working', drainDelta: () => 'agent output', isAlive: () => true, exitCode: null, kill: () => {},
        })) as never,
      });
      expect(events).toContainEqual({ event: 'headless.progress', data: expect.objectContaining({ ptyId: 'self_progress', runId: 'run-progress' }) });
      expect(events).toContainEqual({ event: 'poll.heartbeat', data: expect.objectContaining({ ptyId: 'self_progress', runId: 'run-progress' }) });
    } finally {
      log.mockRestore();
    }
  });

  test('forwards ELANOUS_HARNESS_POLICY without changing child argv', async () => {
    const policy = '하니스 정책 시험 문장 이다';
    const priorPolicy = process.env.ELANOUS_HARNESS_POLICY;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'harness-policy-applied') events.push({ event, data: data ?? {} });
    }) as never);
    let childEnv: Record<string, string> | undefined;
    process.env.ELANOUS_HARNESS_POLICY = policy;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1,
        ptyAvailable: () => true,
        spawn: ((opts: { args: string[]; env?: Record<string, string> }) => {
          childEnv = opts.env;
          expect(opts.args).toEqual(['/tmp/repo/bin/elanous.mjs', 'dev', '--implement', 'x']);
          return {
            id: 'self_policy', write: () => {}, renderScreen: async () => 'done', renderScreenPng: async () => null,
            snapshot: () => 'GOAL-COMPLETE\n', drainDelta: () => '', isAlive: () => false, exitCode: 0, kill: () => {},
          };
        }) as never,
      });
      expect(result.exitCode).toBe(0);
      expect(childEnv?.ELANOUS_HARNESS_POLICY).toBe(policy);
      expect(events).toEqual([]);
    } finally {
      if (priorPolicy === undefined) delete process.env.ELANOUS_HARNESS_POLICY;
      else process.env.ELANOUS_HARNESS_POLICY = priorPolicy;
      log.mockRestore();
    }
  });

  test('forwards the default goal rules policy when parent does not set one', async () => {
    const priorPolicy = process.env.ELANOUS_HARNESS_POLICY;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'harness-policy-applied') events.push({ event, data: data ?? {} });
    }) as never);
    let childEnv: Record<string, string> | undefined;
    delete process.env.ELANOUS_HARNESS_POLICY;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1,
        ptyAvailable: () => true,
        spawn: ((opts: { args: string[]; env?: Record<string, string> }) => {
          childEnv = opts.env;
          expect(opts.args).toEqual(['/tmp/repo/bin/elanous.mjs', 'dev', '--implement', 'x']);
          return {
            id: 'self_no_policy', write: () => {}, renderScreen: async () => 'done', renderScreenPng: async () => null,
            snapshot: () => 'GOAL-COMPLETE\n', drainDelta: () => '', isAlive: () => false, exitCode: 0, kill: () => {},
          };
        }) as never,
      });
      expect(childEnv?.ELANOUS_HARNESS_POLICY).toBe(GOAL_RULES_POLICY.join('\n'));
      expect(events).toEqual([]);
    } finally {
      if (priorPolicy === undefined) delete process.env.ELANOUS_HARNESS_POLICY;
      else process.env.ELANOUS_HARNESS_POLICY = priorPolicy;
      log.mockRestore();
    }
  });

  test('a real child process reaches runChatTurnCli and applies policy before its instruction without exposing the value', () => {
    const policy = '하니스 정책 시험 문장 이다';
    const indexModule = `${import.meta.dir}/../index.ts`;
    const debugModule = `${import.meta.dir}/../debug/log.ts`;
    const configModule = `${import.meta.dir}/../user-config.ts`;
    const child = spawnSync('bun', [
      '--eval',
      `
        import { debug } from ${JSON.stringify(debugModule)};
        import { getUserConfig } from ${JSON.stringify(configModule)};
        const events = [];
        debug.log = (_category, event, data) => { if (event === 'harness-policy-applied') events.push(data); };
        const { runChatTurnCli } = await import(${JSON.stringify(indexModule)});
        const cfg = getUserConfig();
        cfg.chat.toolDeny = [];
        let request;
        await runChatTurnCli({
          cfg, userText: 'child instruction', explicitSessionId: undefined, reuseActive: false,
          forceNew: true, json: true, enableTools: true,
          runTurn: async (input) => { request = input; return { provider: 'test', model: 'test' }; },
        });
        const systemPrompt = request?.systemPrompt;
        console.log(JSON.stringify({
          status: typeof systemPrompt === 'string' && systemPrompt.startsWith(process.env.ELANOUS_HARNESS_POLICY + '\\n\\n') ? 'applied' : 'missing',
          lengths: events.map((event) => event.length),
        }));
      `,
    ], { encoding: 'utf8', env: { ...process.env, ELANOUS_HARNESS_POLICY: policy, ELANOUS_STATE_DIR: mkdtempSync(join(tmpdir(), 'policy-child-state-')) } });
    expect(child.status).toBe(0);
    expect(child.stderr).not.toContain(policy);
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(report).toEqual({ status: 'applied', lengths: [policy.length] });
    expect(child.stdout).not.toContain(policy);
  });

  test('harness children expose and dispatch Plan tools while ordinary CLI turns do not', () => {
    const indexModule = `${import.meta.dir}/../index.ts`;
    const configModule = `${import.meta.dir}/../user-config.ts`;
    const child = spawnSync('bun', [
      '--eval',
      `
        import { getUserConfig } from ${JSON.stringify(configModule)};
        const { runChatTurnCli } = await import(${JSON.stringify(indexModule)});
        const cfg = getUserConfig();
        cfg.chat.toolDeny = [];
        delete process.env.ELANOUS_HARNESS_SPACE;
        const requests = [];
        const runTurn = async (input) => { requests.push(input); return { provider: 'test', model: 'test' }; };
        await runChatTurnCli({
          cfg, userText: 'ordinary', explicitSessionId: undefined, reuseActive: false,
          forceNew: true, json: true, enableTools: true, runTurn,
        });
        process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
        let planOutput = '';
        let markStepDoneOutput = '';
        let markStepDone;
        await runChatTurnCli({
          cfg, userText: 'harness', explicitSessionId: undefined, reuseActive: false,
          forceNew: true, json: true, enableTools: true,
          runTurn: async (input) => {
            requests.push(input);
            const write = process.stdout.write.bind(process.stdout);
            let captured = '';
            process.stdout.write = (chunk, ...args) => {
              captured += String(chunk);
              return write(chunk, ...args);
            };
            try {
              await input.dispatchTool('Plan', { steps: [{ text: 'inspect' }, { text: 'wire' }] });
              planOutput = captured;
              captured = '';
              markStepDone = await input.dispatchTool('MarkStepDone', { stepIndex: 0 });
              markStepDoneOutput = captured;
              return { provider: 'test', model: 'test' };
            } finally {
              process.stdout.write = write;
            }
          },
        });
        const ordinary = requests[0].tools.map((tool) => tool.name);
        const harness = requests[1].tools.map((tool) => tool.name);
        console.log(JSON.stringify({ ordinary, harness, planOutput, markStepDoneOutput, markStepDone }));
      `,
    ], {
      encoding: 'utf8',
      env: { ...process.env, ELANOUS_STATE_DIR: mkdtempSync(join(tmpdir(), 'plan-child-state-')) },
    });
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(report.ordinary.length).toBeGreaterThan(0);
    expect(report.ordinary).not.toContain('Plan');
    expect(report.ordinary).not.toContain('MarkStepDone');
    expect(report.harness.length).toBeGreaterThan(0);
    expect(report.harness).toContain('Plan');
    expect(report.harness).toContain('MarkStepDone');
    // ⭐ `#8609`(R1c) 이 계약을 바꿨다 — 자식은 이제 «사람 줄 ⊕ 구조 프레임» 둘을 낸다.
    //   ⛔ 옛 기대(`[plan] agent.plan: 2 steps`)는 그 결정으로 «사라진» 문면이지 회귀가 아니다.
    //   그래서 문자열을 바꿔 끼우지 않고 ***새 계약을 문다*** — planId 가 매번 달라도 안 깨진다.
    expectProgressContract(report.planOutput);
    expect(report.markStepDone).toMatchObject({
      steps: [{ text: 'inspect', status: 'done' }, { text: 'wire', status: 'pending' }],
      activeIndex: 1,
    });
    // ⛔ 인라인으로 갈아끼우지 않는다 — 기존 계약을 «그대로» 돌리고 종류 순서만 더 준다.
    expectProgressContract(report.markStepDoneOutput, ['plan', 'step']);
  });

  test('forwards ELANOUS_HARNESS_POLICY through the spawnSync fallback and uses default goal rules without a parent policy', async () => {
    const policy = '하니스 정책 시험 문장 이다';
    const priorPolicy = process.env.ELANOUS_HARNESS_POLICY;
    const repo = mkdtempSync(join(tmpdir(), 'policy-fallback-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const policyEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'harness-policy-applied') policyEvents.push({ event, data: data ?? {} });
    }) as never);
    const spawnSyncFallback = ((_: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env });
      return { status: 0, stdout: '', stderr: '', signal: null, error: undefined };
    }) as never;
    try {
      process.env.ELANOUS_HARNESS_POLICY = policy;
      await defaultSeams({ ptyAvailable: () => false, spawnSync: spawnSyncFallback }).implement({ cwd: repo, feature: 'x', runId: 'run-policy-fallback' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([expect.stringContaining('/bin/elanous.mjs'), 'dev', '--implement', expect.any(String)]);
      expect(calls[0]!.env?.ELANOUS_HARNESS_POLICY).toBe(policy);
      expect(policyEvents).toEqual([]);

      delete process.env.ELANOUS_HARNESS_POLICY;
      await defaultSeams({ ptyAvailable: () => false, spawnSync: spawnSyncFallback }).implement({ cwd: repo, feature: 'x', runId: 'run-policy-fallback' });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.env?.ELANOUS_HARNESS_POLICY).toBe(GOAL_RULES_POLICY.join('\n'));
      expect(policyEvents).toEqual([]);
    } finally {
      if (priorPolicy === undefined) delete process.env.ELANOUS_HARNESS_POLICY;
      else process.env.ELANOUS_HARNESS_POLICY = priorPolicy;
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('implement.result retains its supplied runId', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'implement-result-runid-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'implement.result') events.push(data ?? {});
    }) as never);
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: (async ({ cwd }: { cwd: string }) => {
          writeFileSync(join(cwd, 'changed.ts'), 'export const changed = true;\n');
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 1, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'self_result' };
        }) as never,
      });
      await seams.implement({ cwd: repo, feature: 'x', runId: 'run-result' });
      expect(events).toContainEqual(expect.objectContaining({ runId: 'run-result', transport: 'pty', pty: 'self_result' }));
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('review.diff-scope runId', () => {
    let repo: string;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'review-runid-'));
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 't@example.test');
      git(repo, 'config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'base');
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    test('adds runId when supplied and omits it when unavailable', async () => {
      writeFileSync(join(repo, 'change.ts'), 'export const change = true;\n');
      const events: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
        if (event === 'review.diff-scope') events.push(data ?? {});
      }) as never);
      try {
        await reviewScopeDiff(repo, 'origin/main', 'run-review', 'resolved-base');
        await reviewScopeDiff(repo, 'origin/main');
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ runId: 'run-review', baseOrigin: 'resolved-base' });
        expect(events[1]).toMatchObject({ baseOrigin: 'default-origin-main' });
        expect(events[1]).not.toHaveProperty('runId');
      } finally {
        log.mockRestore();
      }
    });
  });

  test('orchestrator wires its run and round through the default implement and reflect seams', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orchestrator-reflect-runid-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'implement.result' || event === 'review.diff-scope' || event === 'reflect.done') events.push({ event, data: data ?? {} });
    }) as never);
    try {
      const base = defaultSeams({
        llmReview: async () => '1: REJECT — 등가계약 밖',
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: (async ({ cwd }: { cwd: string }) => {
          writeFileSync(join(cwd, 'changed.ts'), 'export const changed = true;\n');
          return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 1, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'orchestrator_result' };
        }) as never,
      });
      await runSelfImplement({
        feature: '반사 관측을 연결한다', runId: 'run-orchestrator-reflect', memory: false,
        seams: {
          ...base,
          createWorktree: async () => ({ path: repo, branch: 'test', base: 'main' }),
          gate: async () => ({ passed: true }),
          reviewDiff: async () => ({ verdict: 'fail', mustFix: ['범위 밖'], shouldFix: [], summary: 'must fix', reviewed: true }),
          approvePr: async () => false,
        },
      });
      expect(events).toContainEqual(expect.objectContaining({ event: 'implement.result', data: expect.objectContaining({ runId: 'run-orchestrator-reflect' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'review.diff-scope', data: expect.objectContaining({ runId: 'run-orchestrator-reflect' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'reflect.done', data: expect.objectContaining({ runId: 'run-orchestrator-reflect', round: 0, accepted: 0, rejected: 1 }) }));
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reflectMustFix joins diff and decision observations to the supplied run and round', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'reflect-runid-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    writeFileSync(join(repo, 'change.ts'), 'export const change = true;\n');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review.diff-scope' || event === 'reflect.done') events.push({ event, data: data ?? {} });
    }) as never);
    try {
      const seams = defaultSeams({
        llmReview: async () => '1: ACCEPT\n2: REJECT — 등가계약 밖',
      });
      const identified = await seams.reflectMustFix!({
        cwd: repo, goal: '변경을 검토한다', mustFix: ['실버그', '범위 밖'], runId: 'run-reflect', round: 3,
      });
      const unidentifed = await seams.reflectMustFix!({
        cwd: repo, goal: '변경을 검토한다', mustFix: ['실버그', '범위 밖'],
      });

      expect(identified).toEqual(unidentifed);
      const identifiedDiff = events.find(({ event, data }) => event === 'review.diff-scope' && data.runId === 'run-reflect')?.data;
      const identifiedReflect = events.find(({ event, data }) => event === 'reflect.done' && data.runId === 'run-reflect')?.data;
      const unidentifedDiff = events.find(({ event, data }) => event === 'review.diff-scope' && !('runId' in data))?.data;
      const unidentifedReflect = events.find(({ event, data }) => event === 'reflect.done' && !('runId' in data))?.data;

      expect(identifiedDiff).toMatchObject({ runId: 'run-reflect' });
      expect(identifiedReflect).toMatchObject({ runId: 'run-reflect', round: 3, accepted: 1, rejected: 1 });
      expect(unidentifedDiff).not.toHaveProperty('runId');
      expect(unidentifedReflect).not.toHaveProperty('runId');
      expect(unidentifedReflect).not.toHaveProperty('round');
      expect(Object.keys(unidentifedReflect ?? {}).sort()).toEqual(['accepted', 'factConflicts', 'rejected']);
      expect(unidentifedReflect).toMatchObject({ factConflicts: 0 });

      const factAware = await seams.reflectMustFix!({
        cwd: repo,
        goal: '변경을 검토한다',
        mustFix: ['필수 파괴 검증 증거 부실', '공식 Gate가 2 fail로 종료됐다'],
        evidenceFacts: { requiredEvidence: 11, coveredEvidence: 11, missingEvidence: [] },
        gateFacts: { introduced: 0, preexisting: 4, unknown: 1, unknownReason: 'infrastructure-failure', childResponsibility: 'none' },
      });
      expect(factAware.rejected).toHaveLength(1);
      const factAwareReflect = events.filter(({ event }) => event === 'reflect.done').at(-1)?.data;
      expect(factAwareReflect).toMatchObject({ accepted: 1, rejected: 1, factConflicts: 2 });
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
