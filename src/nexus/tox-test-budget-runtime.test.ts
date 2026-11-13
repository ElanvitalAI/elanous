import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { dispatchTaskCreate } from '../task-orchestrator/runtimes/create.js';
import { getToxRuntimeDeps } from '../task-orchestrator/runtime-deps.js';
import { runNexus } from './index.js';
import { setTestStateRoot } from './paths.js';
import { debug } from '../debug/log.js';

const keys = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_TOX_ZERO_SPEND', 'ELANOUS_TEST_FAKE_LLM',
  'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER', 'ELANOUS_TEST_FAKE_LLM_RESPONSE', 'ELANOUS_SESSION_ROOT'] as const;

async function bootAndSubmit(input: { zeroSpend: boolean; fake: boolean; fakeProvider: boolean;
  mode?: 'fake' | 'real'; estimateUsd?: number }): Promise<{ admitted: boolean; status: string; decision: string }> {
  const root = mkdtempSync(join(tmpdir(), 'nexus-tox-budget-runtime-'));
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])) as Record<typeof keys[number], string | undefined>;
  let nexus: Awaited<ReturnType<typeof runNexus>> | undefined;
  try {
    setElanousConfigDir(root);
    setTestStateRoot(root);
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    process.env.ELANOUS_LLM_MODE = input.mode ?? 'fake';
    process.env.ELANOUS_TEST_TOX_ZERO_SPEND = input.zeroSpend ? '1' : '0';
    process.env.ELANOUS_TEST_FAKE_LLM = input.fake ? '1' : '0';
    process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = input.fakeProvider ? '1' : '0';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '{"outcome":"done"}';
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      httpStartPort: 0, noAuth: true,
      skipSupervisor: true, mcpEnabled: false, skipRestoreFromPending: true, skipEnvMigration: true,
      registerDaemonTab: false, registerSettingsTab: false,
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      toxBudgetReadForTesting: {
        config: { tools: { selfImplement: { childLlm: { mode: 'auto', chain: [
          { provider: 'openai-codex' }, { provider: 'grok' },
        ] } } }, llm: {} } as never,
        inspectCodex: () => ({ candidates: [{ name: 'default', usedPercent: 60 }] }) as never,
        grokSnapshot: () => ({ windows: [{ kind: 'weekly', used: 50 }] }) as never,
      },
      cleanGhostTailscaleServeFn: async () => {}, toolCwd: root });
    expect(nexus).toBeDefined();
    debug.flush();
    const logStart = existsSync(debug.path()) ? statSync(debug.path()).size : undefined;
    const posted = await dispatchTaskCreate({ title: 'isolated intake',
      surface: { kind: 'llm-direct', prompt: 'Return the fake outcome' },
      ...(input.estimateUsd !== undefined ? { estimateUsd: input.estimateUsd } : {}) });
    if (!posted.taskId) throw new Error(posted.output);
    const graph = getToxRuntimeDeps().getGraph();
    expect(graph).not.toBeNull();
    let decision = '';
    const until = Date.now() + 10_000;
    while (!decision && Date.now() < until) {
      debug.flush();
      const log = existsSync(debug.path()) ? readFileSync(debug.path(), 'utf8') : '';
      const observed = log.split('\n').find(line => line.includes(`"taskId":"${posted.taskId}"`)
        && line.includes('"category":"tox.loop"')
        && (line.includes('"event":"budget-hold"') || line.includes('"event":"launched"')));
      decision = observed?.includes('"event":"budget-hold"') ? 'budget-hold'
        : observed?.includes('"event":"launched"') ? 'launched' : '';
      if (!decision) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(decision).not.toBe('');
    if (decision === 'launched') {
      const completedBy = Date.now() + 3_000;
      let finished = false;
      while (!finished && Date.now() < completedBy) {
        debug.flush();
        const lines = existsSync(debug.path())
          ? readFileSync(debug.path()).subarray(logStart).toString('utf8').split('\n') : [];
        finished = lines.some(line => line.includes('"category":"tox.external-exec"')
          && line.includes('"event":"run-finished"') && line.includes(`"taskId":"${posted.taskId}"`));
        if (!finished) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(finished).toBe(true);
      const executedLines = readFileSync(debug.path()).subarray(logStart).toString('utf8').split('\n');
      expect(executedLines.filter(line => line.includes('"category":"llm.request"'))).toHaveLength(0);
    }
    const status = graph?.getTask(posted.taskId!)?.status ?? 'missing';
    if (decision === 'budget-hold') {
      expect(status).toBe('ready');
      const lines = readFileSync(debug.path()).subarray(logStart).toString('utf8').split('\n');
      expect(lines.filter(line => line.includes('"category":"tox.external-exec"')
        && line.includes(`"taskId":"${posted.taskId}"`))).toHaveLength(0);
    }
    return { admitted: decision === 'launched', status, decision };
  } finally {
    await nexus?.release();
    setTestStateRoot(null);
    resetElanousConfigDir();
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('runNexus boots real TOX and admits only the explicit fake zero-spend world', async () => {
  expect((await bootAndSubmit({ zeroSpend: true, fake: true, fakeProvider: true })).admitted).toBe(true);
  expect((await bootAndSubmit({ zeroSpend: true, fake: true, fakeProvider: true, estimateUsd: 0.01 })).decision).toBe('budget-hold');
  expect((await bootAndSubmit({ zeroSpend: false, fake: true, fakeProvider: true })).decision).toBe('budget-hold');
  expect((await bootAndSubmit({ zeroSpend: true, fake: false, fakeProvider: true })).decision).toBe('budget-hold');
  expect((await bootAndSubmit({ zeroSpend: true, fake: true, fakeProvider: false })).decision).toBe('budget-hold');
}, 60_000);
