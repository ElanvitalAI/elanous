import { setDefaultTimeout, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { registerOpsCommands } from './cli/ops-cli.js';
import { setUserConfigOverlay } from './user-config.js';
import * as podDispatch from './harness/harness-pod-dispatch.js';
import { registerPublishCommands } from './cli/publish-cli.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assembleAskLaunchPolicy, buildCodexAccountImportGuidance, buildHarnessOrchestratePlan, executeDevPipelineInvocation, filterDashboardArgs, formatReviewStatsPercentage, formatSelfSendCandidateDisplay, runHarnessBrowserAction, runHarnessOrchestrateExecution, runSchedule, scheduleCreatePlan, readSelfOrchestrateGoals, setCodexAccountLogSinkModuleForTesting, type HarnessOrchestrateExecutionDeps, type ScheduleDispatch } from './index.js';
import { selectFabricDecomposer } from './self-dev/self-orchestrate-runtime.js';
import { debug } from './debug/log.js';
import { LogStore, logsDbPath } from './mss/logging/log-store.js';
import { _resetGlobalPersonaRegistryForTest, setGlobalPersonaRegistryDir } from './persona/global-registry.js';
import { addSelfDevRunParticipant, checkpointDependenciesForRun, loadSelfDevRun, saveSelfDevRun, type SelfDevRunState } from './self-dev/run-store.js';
import { registerMcpClients } from './nexus/boot/register-mcp-clients.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

afterEach(() => {
  process.exitCode = 0;
});

describe('Codex account CLI log sink', () => {
  const accountCommand = () => {
    const { program } = require('./index.js') as typeof import('./index.js');
    return program.commands.find((command) => command.name() === 'provider')!
      .commands.find((command) => command.name() === 'codex')!
      .commands.find((command) => command.name() === 'account')!;
  };

  afterEach(() => {
    setCodexAccountLogSinkModuleForTesting(undefined);
  });

  test('registers the Codex account CLI sink before list and import commands', async () => {
    const surfaces: string[] = [];
    setCodexAccountLogSinkModuleForTesting({
      registerStandaloneLogSink: async (surface) => { surfaces.push(surface); return true; },
    });

    await accountCommand().parseAsync(['node', 'elanous', 'list']);
    await accountCommand().parseAsync(['node', 'elanous', 'import', 'bad name', '--home', '/missing']);

    expect(surfaces).toEqual(['codex-account-cli', 'codex-account-cli']);
  });

  test('continues the Codex account command when sink registration throws', async () => {
    setCodexAccountLogSinkModuleForTesting({
      registerStandaloneLogSink: async () => { throw new Error('sink unavailable'); },
    });
    const output: string[] = [];
    const consoleLog = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
    try {
      await accountCommand().parseAsync(['node', 'elanous', 'list']);
    } finally {
      consoleLog.mockRestore();
    }

    expect(output.some((line) => line.startsWith('활성  '))).toBe(true);
  });
});

describe('Codex account import guidance', () => {
  test('distinguishes the stored-account quota entrance from per-run execution and quotes a spaced home', () => {
    const [quota, execution] = buildCodexAccountImportGuidance('b', '/tmp/codex home');

    expect(quota).toBe("쿼터를 재려면: bun bin/elanous.mjs provider codex usage --account 'b'");
    expect(quota).not.toContain('ELANOUS_CODEX_ACCOUNT');
    expect(execution).toBe("이 계정으로 «한 런만» 쓰려면: ELANOUS_CODEX_ACCOUNT='b' ELANOUS_CODEX_ACCOUNT_HOME='/tmp/codex home' bun bin/elanous.mjs <명령>");
    expect(execution).not.toContain('provider codex usage');
  });
});

describe('review-stats human percentage formatting', () => {
  test('renders 미측정 for every zero-denominator rate and preserves denominator-present text', () => {
    expect(formatReviewStatsPercentage(0, 0)).toBe('미측정');
    expect(formatReviewStatsPercentage(0.6, 5)).toBe('60%');
    expect(formatReviewStatsPercentage(0, 5)).toBe('0%');
  });
});

describe('assembleAskLaunchPolicy', () => {
  test('defaults to preflight enforcement and enabled decomposition', () => {
    expect(assembleAskLaunchPolicy()).toEqual({
      forceRequested: false,
      decomposeBeforeLaunch: true,
    });
    expect(assembleAskLaunchPolicy({})).toEqual({
      forceRequested: false,
      decomposeBeforeLaunch: true,
    });
    expect(assembleAskLaunchPolicy({ forcePreflight: false, launchDecomposition: true })).toEqual({
      forceRequested: false,
      decomposeBeforeLaunch: true,
    });
  });

  test('maps explicit force-preflight and launch-decomposition selections', () => {
    expect(assembleAskLaunchPolicy({ forcePreflight: true })).toEqual({
      forceRequested: true,
      decomposeBeforeLaunch: true,
    });
    expect(assembleAskLaunchPolicy({ launchDecomposition: false })).toEqual({
      forceRequested: false,
      decomposeBeforeLaunch: false,
    });
    expect(assembleAskLaunchPolicy({ forcePreflight: true, launchDecomposition: false })).toEqual({
      forceRequested: true,
      decomposeBeforeLaunch: false,
    });
  });

  test('three ask launch assemblies share the policy helper and keep path-specific arguments local', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(indexSource.match(/forceRequested:\s*true/g) ?? []).toHaveLength(0);
    expect(indexSource.match(/blockers\.length > 0/g) ?? []).toHaveLength(0);
    expect(indexSource).toContain('assembleAskLaunchPolicy(selection)');
    expect(indexSource).toContain('...assembleAskLaunchPolicy({');
    expect(indexSource).toContain('launchPolicy.forceRequested');
    expect(indexSource).toContain("inputSource: 'say'");
    expect(indexSource).toContain("inputSource: 'ask'");
    expect(indexSource).toContain('inputSource: authorInput.kind');
    expect(indexSource).toContain('askFile: goalPath');
    expect(indexSource).toContain('askFile: authorInput.value');
    expect(indexSource).toContain('askText: sayText');
    expect(indexSource).toContain('askText: goalDocument');
    expect(indexSource).toContain('isGoalAuthorFileName');
    expect(indexSource).toContain('selectDevAuthorInput([], { ask: askPath })');
    expect(indexSource).toContain('runAskFileLaunchFlow');
  });
});

describe('self send superseded explicit target protection', () => {
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  const decode = (output: Uint8Array | undefined) => new TextDecoder().decode(output);

  async function withStateDir(run: (stateDir: string) => void | Promise<void>): Promise<void> {
    const stateDir = await mkdtemp(join(tmpdir(), 'elanous-self-send-'));
    try {
      await run(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  function writeScreen(stateDir: string, spaceId: string): void {
    const screenPath = join(stateDir, 'harness-screens', `${spaceId}.screen`);
    mkdirSync(join(stateDir, 'harness-screens'), { recursive: true });
    writeFileSync(screenPath, 'working');
  }

  function writeHeartbeat(stateDir: string, spaceId: string, heartbeat: unknown): void {
    writeFileSync(join(stateDir, 'harness-screens', `${spaceId}.hb`), JSON.stringify(heartbeat));
  }

  function invoke(stateDir: string, ...args: string[]) {
    const readWait = (args.includes('--memo') || args.includes('--stop')) && !args.includes('--read-wait') ? ['--read-wait', '0'] : [];
    return Bun.spawnSync({
      cmd: [process.execPath, elanous, `--test=${stateDir}`, 'self', 'send', ...args, ...readWait],
      cwd,
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  function inboxReady(stateDir: string, spaceId: string): string {
    return join(stateDir, 'harness-screens', `${spaceId}.inbox.ready`);
  }

  function memoRecords(stateDir: string, spaceId: string): string[] {
    const ready = inboxReady(stateDir, spaceId);
    return existsSync(ready) ? readdirSync(ready).filter((entry) => entry.startsWith('record-')) : [];
  }

  function writeRunLedger(stateDir: string, runId: string, entries: readonly { event: string; data?: Record<string, unknown> }[]): void {
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), entries.map((entry, index) => JSON.stringify({
      timestamp: `2026-09-17T00:0${index}:00.000Z`, runId, event: entry.event, data: entry.data ?? {},
    })).join('\n') + (entries.length > 0 ? '\n' : ''));
  }

  function writeRunScreen(stateDir: string, runId: string, screenKey: string, timestamp: string): void {
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const store = new LogStore(logsDbPath(), { instance: 'test' });
      store.insertBatch([{ surface: 'test', rec: { ts: timestamp, category: 'self-implement', event: 'headless.spawn', data: { runId, screenKey } } }]);
      store.close();
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
    }
  }

  test('rejects a terminal run resolved from a dead heartbeat without inbox records', async () => {
    await withStateDir((stateDir) => {
      const runId = 'run-893d29dd-0000-4000-8000-000000000001';
      const target = 'self-impl-dead-run-goal-aaaaaaaa';
      writeScreen(stateDir, target);
      writeHeartbeat(stateDir, target, { alive: false });
      writeRunScreen(stateDir, runId, target, '2026-09-14T00:02:00.000Z');
      writeRunLedger(stateDir, runId, [{ event: 'start' }, { event: 'terminal' }]);

      const result = invoke(stateDir, '--run', runId, '--memo', 'must not record');

      expect(result.exitCode).toBe(2);
      expect(decode(result.stderr)).toContain('런이 이미 종료되었습니다');
      expect(decode(result.stderr)).not.toContain('heartbeat alive=false');
      expect(memoRecords(stateDir, target)).toHaveLength(0);
    });
  }, 20_000);

  test('records a memo for a continuing run despite its dead child through explicit --run', async () => {
    await withStateDir((stateDir) => {
      const runId = 'run-893d29dd-0000-4000-8000-000000000010';
      const target = 'self-impl-continuing-dead-run-aaaaaaaa';
      writeScreen(stateDir, target);
      writeHeartbeat(stateDir, target, { alive: false });
      writeRunScreen(stateDir, runId, target, '2026-09-17T00:01:00.000Z');
      writeRunLedger(stateDir, runId, [{ event: 'start' }]);

      const result = invoke(stateDir, '--run', runId, '--memo', 'deliver to next iteration');

      expect(result.exitCode).toBe(0);
      const ready = inboxReady(stateDir, target);
      const records = memoRecords(stateDir, target);
      expect(records).toHaveLength(1);
      const content = readFileSync(join(ready, records[0]!), 'utf8');
      expect(content.startsWith('memo:CONTROL_MEMO_FRAME:')).toBe(true);
      expect(content.endsWith('\n')).toBe(true);
      const frame = JSON.parse(Buffer.from(content.slice('memo:CONTROL_MEMO_FRAME:'.length).trim(), 'base64url').toString('utf8'));
      expect(frame).toEqual({ version: 1, kind: 'supervisor', urgency: 'normal', body: 'deliver to next iteration' });
    });
  }, 20_000);
});

describe('root command help dispatch', () => {
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  const decode = (output: Uint8Array | undefined) => new TextDecoder().decode(output);

  function invoke(...args: string[]) {
    return Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  test('rejects an unknown first command even when help follows it', () => {
    const result = invoke('zzzznotacommand', '--help');

    expect(result.exitCode).not.toBe(0);
    expect(decode(result.stderr)).toContain("error: unknown command 'zzzznotacommand'");
  });

  test('harness ask no longer offers a graph authority override', () => {
    const result = invoke('harness', 'ask', '/tmp/goal.md', '--graph', 'off', '--dry-run');
    expect(result.exitCode).not.toBe(0);
    expect(decode(result.stderr)).toContain("error: unknown option '--graph'");
  });

  // ⚠️ 2026-09-21 `#19291` 재작성으로 `setup` 은 단계 인자·답변 파일(`--config`)을 받지 않는다 — 옛 계약을 재던 시험을 지금 계약으로.
  test('setup prints the non-TTY onboarding refusal without a stack trace, and --non-interactive reports without prompting', async () => {
    const home = await mkdtemp(join(tmpdir(), 'elanous-setup-home-'));
    const invokeSetup = (...args: string[]) => Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'setup', ...args],
      cwd,
      env: { ...process.env, HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const nonTty = invokeSetup();
      const nonTtyOutput = `${decode(nonTty.stdout)}${decode(nonTty.stderr)}`;
      expect(nonTty.exitCode).not.toBe(0);
      expect(nonTtyOutput).toContain('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다.');
      expect(nonTtyOutput).toContain('`elanous setup --non-interactive`를 사용하라.');
      expect(nonTtyOutput).not.toMatch(/\n\s*at\s+/);

      const report = invokeSetup('--non-interactive');
      const reportOutput = `${decode(report.stdout)}${decode(report.stderr)}`;
      expect(report.exitCode).toBe(0);
      expect(reportOutput).not.toMatch(/\n\s*at\s+/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('preserves registered-command and root help', () => {
    const registered = invoke('self', '--help');
    const root = invoke('--help');

    expect(registered.exitCode).toBe(0);
    expect(decode(registered.stdout)).toContain('Self-awareness memory');
    expect(root.exitCode).toBe(0);
    expect(decode(root.stdout)).toContain('Usage: elanous [options] [command]');
  }, 30_000);

  test('self unfinished-runs-cleanup plans by default, removes only on request, and blocks removal for incomplete queries', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elanous-unfinished-runs-cleanup-'));
    const ledgerDir = join(stateDir, 'run-ledger');
    const oldRunId = 'run-00000000-0000-4000-8000-000000000101';
    const recentRunId = 'run-00000000-0000-4000-8000-000000000102';
    const blockedRunId = 'run-00000000-0000-4000-8000-000000000103';
    const unreadableRunId = 'run-00000000-0000-4000-8000-000000000104';
    const ledgerPath = (runId: string) => join(ledgerDir, `${runId}.jsonl`);
    const writeLedger = (runId: string, timestamp: string) => {
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(ledgerPath(runId), `${JSON.stringify({ timestamp, runId, event: 'start', data: {} })}\n`);
    };
    const cleanup = (...args: string[]) => Bun.spawnSync({
      cmd: [process.execPath, elanous, `--test=${stateDir}`, 'self', 'unfinished-runs-cleanup', '--json', ...args],
      cwd,
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      writeLedger(oldRunId, '2020-01-01T00:00:00.000Z');
      writeLedger(recentRunId, new Date().toISOString());
      const help = invoke('self', 'unfinished-runs-cleanup', '--help');
      const planned = cleanup();
      const planOutput = JSON.parse(decode(planned.stdout));

      expect(help.exitCode).toBe(0);
      expect(decode(help.stdout)).toContain('--age <minutes>');
      expect(decode(help.stdout)).toContain('--remove');
      expect(planned.exitCode).toBe(0);
      expect(planOutput.plannedRemoval).toEqual([ledgerPath(oldRunId)]);
      expect(planOutput.removed).toEqual([]);
      expect(planOutput.preserved).toEqual(expect.arrayContaining([ledgerPath(oldRunId), ledgerPath(recentRunId)]));
      expect(planOutput.counts.queryUnavailable).toBe(0);
      expect(existsSync(ledgerPath(oldRunId))).toBe(true);

      const removed = cleanup('--remove');
      const removeOutput = JSON.parse(decode(removed.stdout));

      expect(removed.exitCode).toBe(0);
      expect(removeOutput.removed).toEqual([ledgerPath(oldRunId)]);
      expect(existsSync(ledgerPath(oldRunId))).toBe(false);
      expect(existsSync(ledgerPath(recentRunId))).toBe(true);

      writeLedger(blockedRunId, '2020-01-01T00:00:00.000Z');
      writeFileSync(ledgerPath(unreadableRunId), '{not-json}\n');
      const blocked = cleanup('--remove');
      const blockedOutput = JSON.parse(decode(blocked.stdout));

      expect(blocked.exitCode).toBe(0);
      expect(blockedOutput.counts.queryUnavailable).toBe(1);
      expect(blockedOutput.removed).toEqual([]);
      expect(existsSync(ledgerPath(blockedRunId))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('self unfinished-runs-cleanup rejects malformed age values before cleanup', () => {
    for (const age of ['60s', '1,000', '1oops']) {
      const result = invoke('self', 'unfinished-runs-cleanup', '--age', age, '--remove', '--json');

      expect(result.exitCode).not.toBe(0);
      expect(decode(result.stderr)).toContain(`--age must be a non-negative number of minutes: ${age}`);
    }
  }, 30_000);

  test('self implement retains --plan only to reject the retired staged-harness door before standalone-run setup', () => {
    const rejected = invoke('self', 'implement', '--plan', 'x');
    const help = invoke('self', 'implement', '--help');
    const devPlanHelp = invoke('dev', '--plan', '--help');
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const action = indexSource.slice(indexSource.indexOf(".command('implement [feature...]')"), indexSource.indexOf('// self orchestrate'));

    expect(rejected.exitCode).not.toBe(0);
    expect(`${decode(rejected.stdout)}${decode(rejected.stderr)}`).toContain('--plan');
    expect(action.indexOf('if (opts.plan)')).toBeGreaterThanOrEqual(0);
    expect(action.indexOf('if (opts.plan)')).toBeLessThan(action.indexOf('enterStandaloneHarnessRun'));
    expect(help.exitCode).toBe(0);
    expect(decode(help.stdout)).toContain('지정하면 명시적으로 거부됨');
    expect(devPlanHelp.exitCode).toBe(0);
    expect(decode(devPlanHelp.stdout)).toContain('--plan');
  }, 30_000);

  test('preserves Commander implicit help command dispatch', () => {
    const help = invoke('help', '--help');
    const nestedHelp = invoke('help', 'self', '--help');

    expect(help.exitCode).toBe(1);
    expect(decode(help.stderr)).toContain('Usage: elanous [options] [command]');
    expect(decode(help.stderr)).not.toContain("error: unknown command 'help'");
    expect(nestedHelp.exitCode).toBe(0);
    expect(decode(nestedHelp.stdout)).toContain('Self-awareness memory');
  }, 30_000);

  test('token rotate uses --config-dir, masks default output, and only reveals on request', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'elanous-token-rotate-'));
    try {
      const first = invoke('--config-dir', configDir, 'token', 'rotate');
      const firstOutput = decode(first.stdout);
      const rawPath = join(configDir, 'acp-token');
      const envelopePath = join(configDir, 'acp-token.json');
      const firstToken = readFileSync(rawPath, 'utf8');

      expect(first.exitCode).toBe(0);
      expect(firstOutput).toContain(`length=${firstToken.length}`);
      expect(firstOutput).toContain(`prefix=${firstToken.slice(0, 4)}`);
      expect(firstOutput).not.toContain(firstToken);
      expect(JSON.parse(readFileSync(envelopePath, 'utf8')).active).toBe(firstToken);

      const second = invoke('--config-dir', configDir, 'token', 'rotate', '--grace-ms', '0', '--show-token');
      const secondToken = readFileSync(rawPath, 'utf8');
      const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));

      expect(second.exitCode).toBe(0);
      expect(secondToken).not.toBe(firstToken);
      expect(decode(second.stdout).trim()).toBe(secondToken);
      expect(envelope.active).toBe(secondToken);
      expect(envelope.prev).toBe(firstToken);
      expect(envelope.prevExpiresAt).toBeDefined();
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('mcp serve handshake timeout wiring', () => {
  test('passes the parsed global handshake timeout to the direct production register call', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const serveAction = indexSource.slice(indexSource.indexOf(".command('serve')"), indexSource.indexOf(".command('login <serverId>')"));

    expect(serveAction).toContain('handshakeTimeoutMs: cfg.mcp?.handshakeTimeoutMs');
  });

  test('preserves unset/default, global, and server handshake timeout precedence', async () => {
    const observedTimeouts: number[] = [];
    const timeoutProbe = (callback: () => void, timeoutMs: number) => {
      observedTimeouts.push(timeoutMs);
      callback();
      return { unref: () => {} };
    };
    const createClient = () => ({
      start: () => new Promise<void>(() => {}),
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      dispose: async () => {},
    });
    const boot = async (servers: Array<{ id: string; transport: 'stdio'; command: string[]; handshakeTimeoutMs?: number }>, handshakeTimeoutMs?: number) => {
      const handle = await registerMcpClients({
        servers,
        ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
        createClient,
        logger: { info: () => {}, warn: () => {} },
        setTimeoutFn: timeoutProbe,
        clearTimeoutFn: () => {},
      });
      await handle.shutdown();
      return handle.perServer;
    };

    expect(await boot([{ id: 'default', transport: 'stdio', command: ['fake'] }])).toEqual({
      default: { status: 'failed', toolCount: 0, reason: 'mcp.default.start-timeout after 8000ms', reasonClass: 'handshake-timeout' },
    });
    expect(await boot([
      { id: 'global', transport: 'stdio', command: ['fake'] },
      { id: 'server', transport: 'stdio', command: ['fake'], handshakeTimeoutMs: 13 },
    ], 7)).toEqual({
      global: { status: 'failed', toolCount: 0, reason: 'mcp.global.start-timeout after 7ms', reasonClass: 'handshake-timeout' },
      server: { status: 'failed', toolCount: 0, reason: 'mcp.server.start-timeout after 13ms', reasonClass: 'handshake-timeout' },
    });
    expect(observedTimeouts).toEqual([8000, 7, 13]);
  });
});

describe('deprecated harness CLI doors are hidden but still refuse', () => {
  test('harness --help does not list dogfood or run as choices', async () => {
    const { program } = await import('./index.js');
    const harness = program.commands.find((command) => command.name() === 'harness')!;
    const help = harness.helpInformation();
    expect(help).not.toMatch(/^\s*dogfood\b/m);
    expect(help).not.toMatch(/^\s*run \[options\]/m);
    expect(help).toContain('orchestrate');
    expect(harness.commands.some((command) => command.name() === 'dogfood')).toBe(true);
    expect(harness.commands.some((command) => command.name() === 'run')).toBe(true);
    expect(harness.commands.some((command) => command.name() === 'run-detached')).toBe(true);
  });
});

describe('agent-mission backend help', () => {
  test('renders every registered backend in command and mission help', async () => {
    const [{ program }, { agentBackendNames }] = await Promise.all([
      import('./index.js'),
      import('./agent-mission/driver.js'),
    ]);
    const agentMission = program.commands.find((command) => command.name() === 'agent-mission')!;
    const mission = agentMission.commands.find((command) => command.name() === 'mission')!;
    const backendOption = mission.options.find((option) => option.long === '--backend')!;

    for (const backend of agentBackendNames()) {
      expect(agentMission.description()).toContain(backend);
      expect(mission.description()).toContain(backend);
      expect(backendOption.description).toContain(backend);
    }
  });
});

describe('harness ask production entry wiring', () => {
  const originalElanousRunId = process.env.ELANOUS_RUN_ID;
  afterEach(() => {
    if (originalElanousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = originalElanousRunId;
  });

  const withHarnessRunIdentity = <T extends object>(spec: T) => ({
    ...spec,
    runId: expect.any(String),
    runIdSource: expect.stringMatching(/^(?:inherited|minted)$/),
  });

  const passingPreflightDeps = (lines: string[] = []) => ({
    loadLaunchPreflight: async () => ({
      prepareAskLaunch: (() => ({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 })) as never,
      decideAskPreflight: ((input: { goalFile: string }, _deps: unknown, force: boolean) => ({
        result: {
          paths: [input.goalFile],
          blockers: [],
          warnings: [],
          openPrs: { state: 'checked', count: 0 },
          liveRuns: { state: 'checked', count: 0 },
          interruptedRuns: { state: 'checked', count: 0 },
          interruptedRunMatches: [],
          activeUnfinishedRuns: { state: 'checked', count: 0 },
          inactiveUnfinishedRuns: { state: 'checked', count: 0 },
          unreadableUnfinishedRunAges: { state: 'checked', count: 0 },
          recentChanges: { state: 'checked', count: 0 },
          preexistingFailures: { state: 'checked', files: [] },
          recentChangeWindowDays: 7,
          unreadableRuns: 0,
          liveRunWindowMs: 30 * 60_000,
        },
        shouldLaunch: force,
      })) as never,
      renderLaunchPreflight: (() => '[preflight] ✅ 막는 것 없음 — 발사로 간다') as never,
    }),
    loadAskLaunchIo: async () => ({ buildAskPreflightDeps: (async () => ({})) as never }),
    loadAskLaunchFlow: async () => ({
      measureInvokerBehindDefaultBranch: (() => ({ state: 'measured', commits: 0, baseRef: 'origin/main' })) as never,
      recommendLaunchDecomposition: (async (_goalFile: string, _input: unknown, deps: { print: (line: string) => void }) => {
        deps.print('[ask] ⑷ 발사 전 분해 권고 — 조각 2개: 출력 배선 · 회귀 검증');
        return { state: 'measured', outcome: 'decomposed', actualTaskCount: 2, pieces: ['출력 배선', '회귀 검증'], reason: '분해기가 조각을 제안했다' };
      }) as never,
    }),
    print: (line: string) => { lines.push(line); },
    cwd: () => '/tmp/test-cwd',
    setExitCode: () => {},
    runAskFileLaunchFlow: async () => {
      throw new Error('authored-goal harness ask must not enter the ask-file authoring flow');
    },
  });

  test('production harness help exposes ask, say, and mission after the index-level handler injection', async () => {
    const { program } = await import('./index.js');
    const harness = program.commands.find((command) => command.name() === 'harness')!;

    const help = harness.helpInformation();
    expect(harness.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['ask', 'say', 'mission']));
    expect(help).toMatch(/^\s+ask \[options\] <goal-path>/m);
    expect(help).toMatch(/^\s+say \[options\] <sentence\.\.\.>/m);
    expect(help).toMatch(/^\s+mission \[options\] <mission-ids\.\.\.>/m);
  });

  test('production harness mission parser routes multiple IDs to the loop and renders each returned outcome', async () => {
    const { program, setHarnessMissionLoopDepsForTesting } = await import('./index.js');
    const received: unknown[] = [];
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      setHarnessMissionLoopDepsForTesting({
        runMissionSolveLoop: (async (input: unknown) => {
          received.push(input);
          return [
            { missionId: 'apm-one', status: 'solved', terminal: 'deployed' },
            { missionId: 'apm-two', status: 'not-found', detail: '미션 미존재' },
          ];
        }) as never,
        openAutopilotMissionsDb: (() => ({ close: () => {} })) as never,
        getMission: (() => null) as never,
        defaultSeams: (() => ({ })) as never,
        childInstanceScope: (() => ({ })) as never,
        surfaceUxFromDispatchCtx: (() => ({ })) as never,
        solveMissionViaHarness: (async () => ({ })) as never,
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'mission', 'apm-one', 'apm-two', '--executor', 'self-implement']);

      expect(received).toEqual([expect.objectContaining({
        missionIds: ['apm-one', 'apm-two'],
        solve: expect.any(Function),
      })]);
      const loopInput = received[0] as { solve: (input: unknown) => Promise<unknown> };
      expect(await loopInput.solve({ mission: {} })).toEqual({});
      expect(lines).toEqual([
        "🧩 미션 'apm-one' — solved: deployed",
        "🧩 미션 'apm-two' — not-found: 미션 미존재",
      ]);
    } finally {
      console.log = originalLog;
      setHarnessMissionLoopDepsForTesting(undefined);
    }
  });

  test('production harness ask and say expose the explicit preflight bypass but not decomposition control', async () => {
    // `--force-preflight` is now an explicit, observable bypass; decomposition remains unavailable at these entrances.
    const { program } = await import('./index.js');
    const harness = program.commands.find((command) => command.name() === 'harness')!;
    for (const name of ['ask', 'say'] as const) {
      const longs = harness.commands.find((command) => command.name() === name)!.options.map((option) => option.long);
      expect(longs).toContain('--force-preflight');
      expect(longs).not.toContain('--no-launch-decomposition');
    }
  });

  test('harness ask-file and say resolve only existing non-self directories as grounding roots and warn once for invalid targets', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const launchCwd = await mkdtemp(join(tmpdir(), 'harness-grounding-launch-'));
    const target = await mkdtemp(join(launchCwd, 'target-'));
    const relativeTarget = basename(target);
    const targetFile = join(launchCwd, 'target-file');
    await writeFile(targetFile, 'not a directory');
    const selections: Array<{ entrance: 'ask' | 'say'; selection: { groundingCwd?: string } }> = [];
    const lines: string[] = [];
    const originalCwd = process.cwd();
    try {
      process.chdir(launchCwd);
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(lines),
        cwd: () => launchCwd,
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string; say?: string }) => opts.ask === undefined
            ? { kind: 'say', value: opts.say }
            : { kind: 'ask', value: opts.ask }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async (_path, selection) => {
          selections.push({ entrance: 'ask', selection: selection ?? {} });
          return { kind: 'launch', goalFile: '/tmp/ask-grounding-goal.md' } as never;
        },
        runSayLaunchFlow: async (_text, _entrance, selection) => {
          selections.push({ entrance: 'say', selection: selection ?? {} });
          return { kind: 'launch', goalFile: '/tmp/say-grounding-goal.md' } as never;
        },
        setExitCode: () => {},
      });

      for (const [entrance, command] of [
        ['ask', ['harness', 'ask', '--target', relativeTarget, '/tmp/ask-grounding.txt']],
        ['say', ['harness', 'say', '--target', relativeTarget, 'ground', 'this']],
      ] as const) {
        await program.parseAsync(['node', 'elanous', ...command]);
        expect(selections.at(-1)).toEqual({ entrance, selection: { groundingCwd: resolve(launchCwd, relativeTarget) } });
      }
      for (const [entrance, command] of [
        ['ask', ['harness', 'ask', '/tmp/ask-self.txt']],
        ['say', ['harness', 'say', 'default', 'grounding']],
        ['ask', ['harness', 'ask', '--target', 'self', '/tmp/ask-self-target.txt']],
        ['say', ['harness', 'say', '--target', 'self', 'self', 'grounding']],
      ] as const) {
        await program.parseAsync(['node', 'elanous', ...command]);
        expect(selections.at(-1)).toEqual({ entrance, selection: {} });
      }
      for (const [entrance, command, reason] of [
        ['ask', ['harness', 'ask', '--target', 'missing', '/tmp/ask-missing.txt'], 'ENOENT'],
        ['say', ['harness', 'say', '--target', 'missing', 'missing', 'grounding'], 'ENOENT'],
        ['ask', ['harness', 'ask', '--target', 'target-file', '/tmp/ask-file.txt'], 'is not a directory'],
        ['say', ['harness', 'say', '--target', 'target-file', 'file', 'grounding'], 'is not a directory'],
      ] as const) {
        const before = lines.length;
        await program.parseAsync(['node', 'elanous', ...command]);
        expect(selections.at(-1)).toEqual({ entrance, selection: {} });
        const warnings = lines.slice(before).filter((line) => line.startsWith('[ask] ⚠️ --target 을 접지 루트로 못 풀었다 — 발사 트리로 접지한다:'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(reason);
      }
    } finally {
      process.chdir(originalCwd);
      await rm(launchCwd, { recursive: true, force: true });
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask handler passes the goal path to the shared dev pipeline execution function', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const goalPath = '/tmp/GOAL-requested-goal.md';
    const specs: unknown[] = [];
    const pipelineSpecs: unknown[] = [];
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => {
            const spec = { input, executor, opts };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath]);

      expect(specs).toEqual([{ input: { file: goalPath }, executor: { kind: 'self' }, opts: {} }]);
      expect(pipelineSpecs).toEqual(specs.map((spec) => withHarnessRunIdentity(spec as object)));
      expect(exitCodes).toEqual([]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  // ── 런 신원은 «저작 전»에 선다 ────────────────────────────────────────────────
  //
  // 🩸 계기(실측 2026-09-02 · prod 전수 surface=harness): mint 뒤인 `self-implement` 1566/1640 ·
  //   `harness.boundary` 136/136 은 `data.runId` 가 찍혔는데, mint «앞»인 `goal-author` 0/120 ·
  //   `llm.request` 0/133 은 «하나도» 안 찍혔다. `debug.log` 는 그 순간 env 가 서 있어야만 찍는다
  //   (src/debug/log.ts enrichDebugRecord) ⇒ mint 가 늦으면 저작 구간 로그가 런에 «영영» 안 묶인다.
  // ⛔ 이 시험은 「그 함수를 부르나」가 아니라 ***「저작 seam 이 불릴 때 env 가 이미 서 있나」***를 문다.
  test('harness ask 는 저작 seam 이 불리기 «전»에 ELANOUS_RUN_ID 를 세운다', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const previous = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;
    let runIdAtPreflight: string | undefined = 'NOT-CALLED';
    try {
      const base = passingPreflightDeps();
      setRunDevAskFromGoalFileDepsForTesting({
        ...base,
        loadLaunchPreflight: async () => {
          // 저작·발사 전 검사 모듈을 «읽는 순간»이 저작 구간의 첫 자리다.
          runIdAtPreflight = process.env.ELANOUS_RUN_ID;
          return (await base.loadLaunchPreflight!()) as never;
        },
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts }) as never) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} }) as never) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-runid-order.md']);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
      if (previous === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previous;
    }
    // ⛔ 'NOT-CALLED' 면 시험이 «안 문» 것이고, undefined 면 mint 가 «늦은» 것이다 — 둘을 가른다.
    expect(runIdAtPreflight).not.toBe('NOT-CALLED');
    expect(typeof runIdAtPreflight).toBe('string');
    expect(runIdAtPreflight).toMatch(/^run-/);
  });

  // ⛔ 리뷰 should-fix ①: `harness say` 도 «같은» 선행 mint 를 받았는데 시험은 ask 만 돌렸다.
  //   두 진입은 «다른 함수»라 하나가 초록이어도 다른 하나는 열려 있을 수 있다.
  test('harness say 도 저작 seam 이 불리기 «전»에 ELANOUS_RUN_ID 를 세운다', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const previous = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;
    let runIdAtPreflight: string | undefined = 'NOT-CALLED';
    try {
      const base = passingPreflightDeps();
      setRunDevAskFromGoalFileDepsForTesting({
        ...base,
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts }) as never) as never,
          // ⛔ say 경로는 이 seam 이 {kind:'say'} 를 내야 저작으로 «간다» — undefined 면 그 앞에서 돌아선다.
          selectDevAuthorInput: ((_: unknown, input: { say?: string }) => ({ kind: 'say', value: input.say ?? '' })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} }) as never) as never,
          devResultOk: (() => true) as never,
        }),
        // ⛔ say 경로의 «저작 seam» 은 이것이다(ask 와 달리 loadLaunchPreflight 를 안 탄다).
        runSayLaunchFlow: async () => {
          runIdAtPreflight = process.env.ELANOUS_RUN_ID;
          return { kind: 'launch', goalFile: '/unused' } as never;
        },
        setExitCode: () => {},
      });
      await program.parseAsync(['node', 'elanous', 'harness', 'say', '무언가를', '고쳐라']);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
      if (previous === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previous;
    }
    expect(runIdAtPreflight).not.toBe('NOT-CALLED');
    expect(runIdAtPreflight).toMatch(/^run-/);
  });

  // ⛔ 리뷰 should-fix ②: mint-once ⊕ 「자식 값이 이긴다」를 PR 본문에만 적어 뒀다 — 시험이 지키게 한다.
  //   ⚠️ 이 둘은 «다른 계약»이라 한 시험에 접지 않는다.
  test('mint-once — 이미 선 runId 는 다시 불러도 «안 바뀌고» source 가 inherited 다', async () => {
    const { ensureRunIdentity } = await import('./harness/harness-space.js');
    const env: NodeJS.ProcessEnv = {};
    const first = ensureRunIdentity(env);
    const second = ensureRunIdentity(env);
    expect(first.source).toBe('minted');
    expect(second.source).toBe('inherited');
    expect(second.runId).toBe(first.runId);
    expect(env.ELANOUS_RUN_ID).toBe(first.runId);
  });

  test('debug.log 는 호출부가 실은 runId 를 env 값으로 «안 덮는다»', async () => {
    const { debug } = await import('./debug/log.js');
    const previous = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_RUN_ID = 'run-from-env';
    const seen: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({
      name: 'runid-precedence-probe',
      emit: (record: { category?: string; data?: unknown }) => {
        if (record.category === 'probe.runid-precedence' && record.data && typeof record.data === 'object') {
          seen.push(record.data as Record<string, unknown>);
        }
      },
    } as never);
    try {
      debug.log('probe.runid-precedence', 'own', { runId: 'CHILD-OWN' });
      debug.log('probe.runid-precedence', 'absent', { marker: 'x' });
    } finally {
      off();
      if (previous === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previous;
    }
    // ⛔ 0 이면 시험이 «안 문» 것이다 — 「덮지 않는다」와 구분한다.
    expect(seen.length).toBe(2);
    expect(seen[0]?.runId).toBe('CHILD-OWN');   // ⛔ env 가 이기면 여기서 빨강
    expect(seen[1]?.runId).toBe('run-from-env');
  });

  test('harness supervisor rerun marks only the second pipeline execution as relaunch', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const pipelineSpecs: Array<Record<string, unknown>> = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string }) => opts.ask === undefined ? undefined : { kind: 'ask', value: opts.ask }) as never,
          executeDevSelfRun: (async (_input: string, rerun: (relaunch?: boolean) => Promise<unknown>, _options: unknown, initial: unknown) => {
            await rerun(true);
            return { result: initial };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: Record<string, unknown>) => {
            pipelineSpecs.push(spec);
            return { kind: 'self', result: { runId: 'run-supervised' }, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/ask-goal.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/plain.ask']);

      expect(pipelineSpecs).toHaveLength(2);
      expect(pipelineSpecs[0]).not.toHaveProperty('relaunch');
      expect(pipelineSpecs[0]).toMatchObject({ input: { file: '/tmp/ask-goal.md' } });
      expect(pipelineSpecs[1]).toMatchObject({ relaunch: true, input: { file: '/tmp/ask-goal.md' } });
      expect(pipelineSpecs[1]).not.toHaveProperty('input.text');
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('dev self-mission initial, supervisor relaunch, and fragment reexecution call the production pipeline helper with distinct markers', async () => {
    const calls: Array<{ pieceFeature?: string; relaunch?: boolean; base?: string }> = [];
    const executePipeline = async (pieceFeature?: string, relaunch?: boolean, base?: string) => {
      calls.push({
        ...(pieceFeature === undefined ? {} : { pieceFeature }),
        ...(relaunch === undefined ? {} : { relaunch }),
        ...(base === undefined ? {} : { base }),
      });
      return calls.length;
    };

    await executeDevPipelineInvocation(executePipeline, { kind: 'initial' });
    await executeDevPipelineInvocation(executePipeline, { kind: 'supervisor-relaunch', relaunch: true });
    await executeDevPipelineInvocation(executePipeline, { kind: 'fragment-reexecution', pieceFeature: 'repair fragment' });
    await executeDevPipelineInvocation(executePipeline, { kind: 'fragment-reexecution', pieceFeature: 'stacked fragment', base: 'piece-branch' });

    expect(calls).toEqual([
      {},
      { relaunch: true },
      { pieceFeature: 'repair fragment' },
      { pieceFeature: 'stacked fragment', base: 'piece-branch' },
    ]);
  });

  test('optionless harness ask and say enable the supervisor with a default source', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const decisions: Array<{ input: string; options: unknown }> = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string; say?: string }) => opts.ask === undefined
            ? (opts.say === undefined ? undefined : { kind: 'say', value: opts.say })
            : { kind: 'ask', value: opts.ask }) as never,
          executeDevSelfRun: (async (input: string, _rerun: unknown, options: unknown, initial: unknown) => {
            decisions.push({ input, options });
            return { result: initial };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'self', result: { runId: 'run-supervised' }, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/say-goal.md' } as never),
        runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/ask-goal.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-ask.md']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal']);

      expect(decisions.map((decision) => decision.input)).toEqual([
        '/tmp/GOAL-ask.md',
        '/tmp/say-goal.md',
      ]);
      for (const decision of decisions) {
        expect(decision.options).toEqual(expect.objectContaining({
          executePiece: expect.any(Function),
        }));
      }
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask executes promoted pieces at the pipeline boundary, forwards a chained base, and preserves the initial base without opts', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const pipelineSpecs: Array<{ input?: unknown; base?: string }> = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts, base: 'default-base' })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string }) => opts.ask === undefined ? undefined : { kind: 'ask', value: opts.ask }) as never,
          executeDevSelfRun: (async (
            input: string,
            rerun: (relaunch?: boolean) => Promise<import('./self-implement/orchestrator.js').SelfImplementResult>,
            options: import('./self-dev/dev-cli.js').DevSelfRunSuperviseOptions,
            initial: import('./self-implement/orchestrator.js').SelfImplementResult,
          ) => {
          const { executeDevSelfRun } = await import('./self-dev/dev-cli.js');
          return executeDevSelfRun(input, rerun, {
            ...options,
            rounds: 1,
            completion: 'worktree-only',
            readProposals: () => ({
              proposals: new Map([['run-piece', { shardId: 'run-piece', pieces: [
                { id: 'first', feature: 'first fragment', dependsOn: [] },
                { id: 'second', feature: 'second fragment', dependsOn: [] },
              ] }]]),
              goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
            }),
          }, initial);
        }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: { input?: unknown; base?: string }) => {
            pipelineSpecs.push(spec);
            const text = spec.input && typeof spec.input === 'object' && 'text' in spec.input
              ? (spec.input as { text?: unknown }).text
              : undefined;
            return { kind: 'self', result: { ok: true, runId: 'run-piece', piece: spec.input, branch: text === 'first fragment' ? 'first-branch' : undefined }, plan: { completion: 'worktree-only' } } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/ask-goal.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/plain.ask']);

      expect(pipelineSpecs).toMatchObject([
        { input: { file: '/tmp/ask-goal.md' }, base: 'default-base' },
        { input: { text: 'first fragment' }, base: 'default-base' },
        { input: { text: 'second fragment' }, base: 'first-branch' },
      ]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('dev --ask rejects --branch on configured Pod before authoring or dispatch, while explicit local preserves the option', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const dir = await mkdtemp(join(tmpdir(), 'dev-ask-branch-'));
    const askPath = join(dir, 'ask.txt');
    await writeFile(askPath, '# goal\n## PROBLEM\nPreserve branch.\n## WHAT TO BUILD\nCheck branch.\n## ACCEPTANCE CRITERIA\n- [ ] No silent loss.\n## REQUIRED EVIDENCE\n- [test] Check the refusal.\n## TRACED PATHS\n- src/index.ts\n## SCOPE BOUNDARY\n- Boundary decision: Do not start a Pod.\n## 답하지 못하는 것\n- Live Pod availability is unmeasured.\n## 불변식\n- Local stays local.\n## 판정 신호\n- Branch is not lost.\n');
    const previousPool = process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_POD_POOL;
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-node-b@node-b:8' } }));
    const dispatched = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`PROCESS_EXIT_${code}`); }) as never);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    let authored = 0;
    try {
      setDevLaunchControlTestSeams({ runAskLaunchFlow: (async () => { authored++; throw new Error('author-flow-reached'); }) as never });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--ask', askPath, '--branch', 'feature/chosen']))
        .rejects.toThrow('PROCESS_EXIT_1');
      expect(error.mock.calls.flat().join('\n')).toContain('`--branch` 는 Pod 경로에서 아직 지원하지 않는다');
      expect(authored).toBe(0);
      expect(dispatched).not.toHaveBeenCalled();
      error.mockClear();
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--ask', askPath, '--branch', 'feature/chosen', '--substrate', 'local']))
        .rejects.toThrow('PROCESS_EXIT_1');
      expect(authored).toBe(1);
      expect(error.mock.calls.flat().join('\n')).not.toContain('`--branch` 는 Pod 경로에서 아직 지원하지 않는다');
      expect(dispatched).not.toHaveBeenCalled();
    } finally {
      setDevLaunchControlTestSeams(undefined);
      dispatched.mockRestore();
      exit.mockRestore();
      error.mockRestore();
      setUserConfigOverlay(null);
      if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
      else process.env.ELANOUS_POD_POOL = previousPool;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('dev --ask forwards its selected base and configured pool across the Pod dispatch boundary', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const dir = await mkdtemp(join(tmpdir(), 'dev-ask-base-'));
    const askPath = join(dir, 'ask.txt');
    await writeFile(askPath, '# goal\n## PROBLEM\nPod base must be preserved.\n## WHAT TO BUILD\nForward --base.\n## ACCEPTANCE CRITERIA\n- [ ] The dispatched Pod receives feature/base.\n## REQUIRED EVIDENCE\n- [test] Check the dispatch argument.\n## TRACED PATHS\n- src/index.ts\n## SCOPE BOUNDARY\n- Boundary decision: No real Pod is started.\n## 답하지 못하는 것\n- Pod availability is unmeasured.\n## 불변식\n- Local execution is not started.\n## 판정 신호\n- The dispatch receives feature/base.\n');
    const previousPool = process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_POD_POOL;
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-node-b@node-b:8' } }));
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { if (code === 0) throw new Error('POD_DISPATCH_EXIT'); }) as never);
    try {
      setDevLaunchControlTestSeams({
        runAskLaunchFlow: (async () => ({ kind: 'launch', goalFile: askPath })) as never,
      });
      await program.parseAsync(['node', 'elanous', 'dev', '--ask', askPath, '--base', 'feature/base']);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({ entrance: 'cli-harness-ask', input: askPath, podPool: 'pool-node-b@node-b:8', base: 'feature/base' }, expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      setDevLaunchControlTestSeams(undefined);
      dispatch.mockRestore();
      exit.mockRestore();
      setUserConfigOverlay(null);
      if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
      else process.env.ELANOUS_POD_POOL = previousPool;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('dev --ask Pod dispatch classifies a human stop after one oversized output chunk through the run ledger', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const dir = await mkdtemp(join(tmpdir(), 'dev-ask-pod-stop-'));
    const askPath = join(dir, 'ask.txt');
    const stateDir = join(dir, 'state');
    const runId = `run-${crypto.randomUUID()}`;
    const previousPool = process.env.ELANOUS_POD_POOL;
    const previousState = process.env.ELANOUS_STATE_DIR;
    await writeFile(askPath, '# goal\n## PROBLEM\nReport the stopped run.\n## WHAT TO BUILD\nClassify the exit.\n## ACCEPTANCE CRITERIA\n- [ ] Human stop is reported.\n## REQUIRED EVIDENCE\n- [test] Check the dispatch.\n## TRACED PATHS\n- src/index.ts\n## SCOPE BOUNDARY\n- Boundary decision: No real Pod.\n## 답하지 못하는 것\n- Pod availability unmeasured.\n## 불변식\n- The run keeps its identity.\n## 판정 신호\n- Human stop is reported.\n');
    mkdirSync(join(stateDir, 'run-ledger'), { recursive: true });
    writeFileSync(join(stateDir, 'run-ledger', `${runId}.jsonl`),
      `${JSON.stringify({ runId, event: 'human-stop', data: {} })}\n`);
    process.env.ELANOUS_STATE_DIR = stateDir;
    delete process.env.ELANOUS_POD_POOL;
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-node-b@node-b:8' } }));
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
      deps?.onOutput?.(`[self-dev] 1 goal 병렬 실행 · run ${runId}\n${'x'.repeat(17_000)}`);
      return 1;
    });
    const errors: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      setDevLaunchControlTestSeams({
        runAskLaunchFlow: (async () => ({ kind: 'launch', goalFile: askPath })) as never,
      });
      await program.parseAsync(['node', 'elanous', 'dev', '--ask', askPath, '--substrate', 'pod', '--pod-pool', 'pool-node-b@node-b:8']);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        { entrance: 'cli-harness-ask', input: askPath, podPool: 'pool-node-b@node-b:8' },
        expect.objectContaining({ onOutput: expect.any(Function) }),
      );
      expect(errors).toContain('사람이 멈춘 런이다');
      expect(errors.join('\n')).not.toContain('Pod 실행에 닿지 못했다');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      setDevLaunchControlTestSeams(undefined);
      dispatch.mockRestore();
      error.mockRestore();
      exit.mockRestore();
      setUserConfigOverlay(null);
      if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
      else process.env.ELANOUS_POD_POOL = previousPool;
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('dev command executes promoted pieces at the pipeline boundary, forwards a chained base, and preserves the initial base without opts', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const previousRunId = process.env.ELANOUS_RUN_ID;
    const pipelineSpecs: Array<{ input?: unknown; base?: string }> = [];
    const launchOrder: string[] = [];
    const triageEvents: Array<Record<string, unknown>> = [];
    const exitCodes: Array<number | undefined> = [];
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCodes.push(code); }) as never);
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'draft-triage-start') triageEvents.push(data as Record<string, unknown>);
    });
    let supervisorCalls = 0;
    try {
      process.env.ELANOUS_RUN_ID = 'run-dev-triage';
      setDevLaunchControlTestSeams({
        startDraftTriageOptions: {
          queryAbandonedDraftPrs: () => { launchOrder.push('triage'); return []; },
        },
        runDevPipeline: (async (spec: { input?: unknown; base?: string }) => {
          launchOrder.push('pipeline');
          pipelineSpecs.push(spec);
          const text = spec.input && typeof spec.input === 'object' && 'text' in spec.input
            ? (spec.input as { text?: unknown }).text
            : undefined;
          return { kind: 'self', result: { ok: true, runId: 'run-dev-piece', branch: text === 'first fragment' ? 'first-branch' : undefined }, plan: { completion: 'worktree-only' } } as never;
        }) as never,
        executeDevSelfRun: (async (
          input: string,
          rerun: (relaunch?: boolean) => Promise<import('./self-implement/orchestrator.js').SelfImplementResult>,
          options: import('./self-dev/dev-cli.js').DevSelfRunSuperviseOptions,
          initial: import('./self-implement/orchestrator.js').SelfImplementResult,
        ) => {
          supervisorCalls += 1;
          const { executeDevSelfRun } = await import('./self-dev/dev-cli.js');
          return executeDevSelfRun(input, rerun, {
            ...options,
            rounds: 1,
            completion: 'worktree-only',
            readProposals: () => ({
              proposals: new Map([['run-dev-piece', { shardId: 'run-dev-piece', pieces: [
                { id: 'first', feature: 'first fragment', dependsOn: [] },
                { id: 'second', feature: 'second fragment', dependsOn: [] },
              ] }]]),
              goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/ledger',
            }),
          }, initial);
        }) as never,
      });

      await program.parseAsync(['node', 'elanous', 'dev', '--no-open-pr', '--no-auto-merge', '--no-auto-review', '--base', 'default-base', 'goal']);

      expect(supervisorCalls).toBe(1);
      expect(launchOrder).toEqual(['triage', 'pipeline', 'pipeline', 'pipeline']);
      expect(triageEvents).toEqual([expect.objectContaining({ runId: 'run-dev-triage' })]);
      expect(exitCodes).toEqual([0]);
      expect(pipelineSpecs).toMatchObject([
        { input: { text: 'goal' }, base: 'default-base' },
        { input: { text: 'first fragment' }, base: 'default-base' },
        { input: { text: 'second fragment' }, base: 'first-branch' },
      ]);
    } finally {
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
      setDevLaunchControlTestSeams(undefined);
      log.mockRestore();
      exit.mockRestore();
    }
  });

  test('harness ask and say pass hidden --no-supervise as disabled supervisor options', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const decisions: Array<{ input: string; options: unknown }> = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string; say?: string }) => opts.ask === undefined
            ? (opts.say === undefined ? undefined : { kind: 'say', value: opts.say })
            : { kind: 'ask', value: opts.ask }) as never,
          executeDevSelfRun: (async (input: string, _rerun: unknown, options: unknown, initial: unknown) => {
            decisions.push({ input, options });
            return { result: initial };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'self', result: { runId: 'run-unsupervised' }, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/say-goal.md' } as never),
        runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/ask-goal.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--no-supervise', '/tmp/GOAL-ask.md']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', '--no-supervise', 'write', 'goal']);

      expect(decisions).toEqual([
        { input: '/tmp/GOAL-ask.md', options: undefined },
        { input: '/tmp/say-goal.md', options: undefined },
      ]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask and say stamp ensureRunIdentity onto the pipeline spec', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const previousRunId = process.env.ELANOUS_RUN_ID;
    const pipelineSpecs: Array<{ runId?: string; runIdSource?: string }> = [];
    try {
      process.env.ELANOUS_RUN_ID = 'run-harness-identity-ask';
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string; say?: string }) => opts.ask === undefined
            ? { kind: 'say', value: opts.say }
            : { kind: 'ask', value: opts.ask }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: { runId?: string; runIdSource?: string }) => {
            pipelineSpecs.push({ runId: spec.runId, runIdSource: spec.runIdSource });
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/GOAL-identity-goal.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-identity-goal.md']);
      process.env.ELANOUS_RUN_ID = 'run-harness-identity-say';
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'stamp', 'identity']);

      expect(pipelineSpecs).toEqual([
        { runId: 'run-harness-identity-ask', runIdSource: 'inherited' },
        { runId: 'run-harness-identity-say', runIdSource: 'inherited' },
      ]);
    } finally {
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask and say run injected start triage once before each initial pipeline with their launch run ids', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const previousRunId = process.env.ELANOUS_RUN_ID;
    const order: string[] = [];
    const triageEvents: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'draft-triage-start') triageEvents.push(data as Record<string, unknown>);
    });
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string; say?: string }) => opts.ask === undefined
            ? { kind: 'say', value: opts.say }
            : { kind: 'ask', value: opts.ask }) as never,
          startDraftTriageOptions: {
            queryAbandonedDraftPrs: () => { order.push('triage'); return []; },
          },
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => {
            order.push('pipeline');
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/triage-say-goal.md' } as never),
        setExitCode: () => {},
      });

      process.env.ELANOUS_RUN_ID = 'run-triage-ask';
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-triage-ask.md']);
      process.env.ELANOUS_RUN_ID = 'run-triage-say';
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'triage', 'say']);

      expect(order).toEqual(['triage', 'pipeline', 'triage', 'pipeline']);
      expect(triageEvents).toEqual([
        expect.objectContaining({ runId: 'run-triage-ask' }),
        expect.objectContaining({ runId: 'run-triage-say' }),
      ]);
    } finally {
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
      log.mockRestore();
    }
  });

  test('harness ask runs start triage once before an initial pipeline exception', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const previousRunId = process.env.ELANOUS_RUN_ID;
    const order: string[] = [];
    try {
      process.env.ELANOUS_RUN_ID = 'run-triage-throw';
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: (() => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { ask?: string }) => opts.ask === undefined ? undefined : { kind: 'ask', value: opts.ask }) as never,
          startDraftTriageOptions: {
            queryAbandonedDraftPrs: () => { order.push('triage'); return []; },
          },
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => { order.push('pipeline'); throw new Error('initial pipeline failed'); }) as never,
          devResultOk: (() => false) as never,
        }),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-triage-throw.md']);
      expect(order).toEqual(['triage', 'pipeline']);
    } finally {
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask and shared say/plan obtain run identity from ensureRunIdentity without duplicating plan', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const askBody = indexSource.slice(
      indexSource.indexOf('async function runDevAskFromGoalFile'),
      indexSource.indexOf('async function runDevPlanFromWords'),
    );
    const planBody = indexSource.slice(
      indexSource.indexOf('async function runDevPlanFromWords'),
      indexSource.indexOf('async function runDevSayFromWords'),
    );
    const sayBody = indexSource.slice(
      indexSource.indexOf('async function runDevSayFromWords'),
      indexSource.indexOf('export interface SelfSendCandidate'),
    );
    expect(askBody).toContain('ensureRunIdentity()');
    expect(askBody).toContain('runId: identity.runId');
    expect(askBody).toContain('runIdSource: identity.source');
    expect(sayBody).toContain('ensureRunIdentity()');
    expect(sayBody).toContain('runId: identity.runId');
    expect(sayBody).toContain('runIdSource: identity.source');
    expect(planBody).not.toContain('ensureRunIdentity');
    expect(planBody).toContain('runDevSayFromWords(words, opts, { planStaged: true })');
    expect(indexSource).toContain("import { ensureRunIdentity, getHarnessSpace, normalizeSpaceId } from './harness/harness-space.js'");
  });

  test('harness ask forwards the four promoted knobs to the shared dev pipeline spec and JSON output', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    const pipelineSpecs: unknown[] = [];
    const stdout: string[] = [];
    const printed: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'self', result: { runId: 'run-json-1', ok: true }, plan: { base: 'release/base' } } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--json', '--base', 'release/base', '--no-auto-merge', '--observe-only', '/tmp/GOAL-knobs.md']);

      expect(specs).toEqual([{
        input: { file: '/tmp/GOAL-knobs.md' },
        executor: { kind: 'self' },
        opts: { json: true, base: 'release/base', autoMerge: false, observeOnly: true },
        explicitNames: ['json', 'base', 'autoMerge', 'observeOnly'],
      }]);
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity({ ...(specs[0] as object), humanReadableOutput: false })]);
      expect(printed).toEqual([]);
      expect(stdout.join('').trim().split(/\n+/)).toHaveLength(1);
      expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, kind: 'self', result: { runId: 'run-json-1', ok: true } });
    } finally {
      process.stdout.write = originalWrite;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask forwards the goal without a graph authority override', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-graph-default.md']);
      expect(specs).toEqual([
        { input: { file: '/tmp/GOAL-graph-default.md' }, executor: { kind: 'self' }, opts: {}, explicitNames: [] },
      ]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask forwards correlation unchanged while preserving adjacent dev options and omits it when absent', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync([
        'node', 'elanous', 'harness', 'ask',
        '--correlation', 't156-denom-press',
        '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.6', '--child-llm-effort', 'high',
        '--target', 'src/index.ts', '/tmp/GOAL-correlation.md',
      ]);
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-correlation-omitted.md']);

      expect(specs).toEqual([
        {
          input: { file: '/tmp/GOAL-correlation.md' },
          executor: { kind: 'self' },
          opts: {
            correlation: 't156-denom-press',
            childLlmProvider: 'grok',
            childLlmModel: 'grok-4.6',
            childLlmEffort: 'high',
            target: 'src/index.ts',
          },
          explicitNames: ['childLlmProvider', 'childLlmModel', 'childLlmEffort', 'correlation', 'target'],
        },
        {
          input: { file: '/tmp/GOAL-correlation-omitted.md' },
          executor: { kind: 'self' },
          opts: {},
          explicitNames: [],
        },
      ]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask forwards child LLM selections through the shared dev pipeline spec', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync([
        'node', 'elanous', 'harness', 'ask',
        '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.6',
        '/tmp/GOAL-child-llm.md',
      ]);

      expect(specs).toEqual([{
        input: { file: '/tmp/GOAL-child-llm.md' },
        executor: { kind: 'self' },
        opts: { childLlmProvider: 'grok', childLlmModel: 'grok-4.6' },
        explicitNames: ['childLlmProvider', 'childLlmModel'],
      }]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask provider-only child LLM fills the provider default model instead of rejecting', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const { buildDevCliSpec, assertDevCliPathOptions, selectDevAuthorInput, renderDevCompletionLine } = await import('./self-dev/dev-cli.js');
    const pipelineSpecs: unknown[] = [];
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({ renderDevCompletionLine, assertDevCliPathOptions, buildDevCliSpec, selectDevAuthorInput, startDraftTriage: () => {} }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'self', result: { ok: true }, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--child-llm-provider', 'grok', '/tmp/GOAL-unpaired.md']);

      // ⭐ 2026-09-02 (대표) — provider «만» 줘도 이제 «거부하지 않는다». 기본 모델이 채워져 파이프라인이 «돈다».
      //   ⛔ 종전 계약은 「짝이 없으면 거부」였다. 그 문면을 무는 이 줄을 «갱신»한다.
      expect(pipelineSpecs).toHaveLength(1);
      expect(errors.join('\n')).not.toMatch(/--child-llm-model 필요/);
    } finally {
      console.error = originalError;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  }, 20_000);

  test('harness ask emits a pre-launch decomposition recommendation before pipeline execution', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const goalDir = await mkdtemp(join(tmpdir(), 'elanous-harness-ask-decompose-'));
    const goalPath = join(goalDir, 'GOAL-goal.md');
    const printed: string[] = [];
    const pipelineSpecs: unknown[] = [];
    const decompositionInputs: Array<{
      forceRequested?: boolean;
      decomposeBeforeLaunch?: boolean;
      inputSource?: string;
      askFile?: string;
    }> = [];
    try {
      await writeFile(goalPath, '대상 경로: src/index.ts\n\n## WHAT TO BUILD\n- harness ask 권고 출력 회귀용이다.');
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        loadAskLaunchFlow: async () => ({
          measureInvokerBehindDefaultBranch: (() => ({ state: 'measured', commits: 0, baseRef: 'origin/main' })) as never,
          recommendLaunchDecomposition: (async (
            _goalFile: string,
            input: {
              forceRequested?: boolean;
              decomposeBeforeLaunch?: boolean;
              inputSource?: string;
              askFile?: string;
            },
            deps: { print: (line: string) => void },
          ) => {
            decompositionInputs.push(input);
            deps.print('[ask] ⑷ 발사 전 분해 권고 — 조각 2개: 출력 배선 · 회귀 검증');
            return { state: 'measured', outcome: 'decomposed', actualTaskCount: 2, pieces: ['출력 배선', '회귀 검증'], reason: '분해기가 조각을 제안했다' };
          }) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath]);

      expect(printed.some((line) => line.startsWith('[ask]') && line.includes('발사 전 분해 권고'))).toBe(true);
      expect(decompositionInputs).toEqual([expect.objectContaining({
        forceRequested: false,
        decomposeBeforeLaunch: true,
        inputSource: 'ask',
        askFile: goalPath,
      })]);
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity({ input: { file: goalPath }, executor: { kind: 'self' }, opts: {} })]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
      await rm(goalDir, { recursive: true, force: true });
    }
  });

  test('harness ask emits non-blocking launch preflight for overlap, behind tree, and recent changes', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const goalPath = '/tmp/GOAL-overlap-goal.md';
    const printed: string[] = [];
    const pipelineSpecs: unknown[] = [];
    const exitCodes: number[] = [];
    const decideForceArgs: boolean[] = [];
    const renderForcedArgs: boolean[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        loadLaunchPreflight: async () => ({
          prepareAskLaunch: (() => ({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 })) as never,
          decideAskPreflight: ((input: unknown, _deps: unknown, force: boolean) => {
            decideForceArgs.push(force);
            return {
              result: { input, blockers: [{ kind: 'no-target-paths' }], warnings: [{ kind: 'live-run' }, { kind: 'recent-change' }] },
              shouldLaunch: force,
            };
          }) as never,
          renderLaunchPreflight: ((result: { warnings: unknown[] }, forced: boolean) => {
            renderForcedArgs.push(forced);
            return [
              '[preflight] 요청문이 선언한 대상 경로 1개 · 실재하지 않음 0개: src/index.ts',
              '[preflight] ⚠️ run-overlap — 도는 런이 같은 파일을 만진다: src/index.ts',
              '[preflight] ⚠️ 최근 변경 1개 대상 경로 — 사람이 읽는다: src/index.ts',
              forced
                ? `[preflight] ⚠️ --force-preflight — 위 막힘을 «뚫고» 발사한다 (경고 ${result.warnings.length}건 · forced=${String(forced)})`
                : '[preflight] 그래도 가려면 --force-preflight (그 우회는 관측에 남는다)',
            ].join('\n');
          }) as never,
        }),
        loadAskLaunchIo: async () => ({ buildAskPreflightDeps: (async () => ({ marker: 'deps' })) as never }),
        loadAskLaunchFlow: async () => ({
          measureInvokerBehindDefaultBranch: (() => ({ state: 'measured', commits: 3, baseRef: 'origin/main' })) as never,
          recommendLaunchDecomposition: (async (_goalFile: string, _input: unknown, deps: { print: (line: string) => void }) => {
            deps.print('[ask] ⑷ 발사 전 분해 권고 — 조각 2개: 출력 배선 · 회귀 검증');
            return { state: 'measured', outcome: 'decomposed', actualTaskCount: 2, pieces: ['출력 배선', '회귀 검증'], reason: '분해기가 조각을 제안했다' };
          }) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        print: (line) => { printed.push(line); },
        cwd: () => '/tmp/test-cwd',
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath]);

      const output = printed.join('\n');
      expect(output.split('\n').filter((line) => line.startsWith('[preflight]')).length).toBeGreaterThan(0);
      expect(output).toContain('run-overlap — 도는 런이 같은 파일을 만진다: src/index.ts');
      expect(output).toContain('3커밋 뒤처졌다 (origin/main)');
      expect(output).toContain('최근 변경 1개 대상 경로');
      expect(decideForceArgs).toEqual([false]);
      expect(renderForcedArgs).toEqual([false]);
      expect(output).toContain('그래도 가려면 --force-preflight (그 우회는 관측에 남는다)');
      expect(output).not.toContain('위 막힘을 «뚫고» 발사한다');
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity({ input: { file: goalPath }, executor: { kind: 'self' }, opts: {} })]);
      expect(exitCodes).toEqual([]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask preserves blocker output by default and uses the existing observable bypass when explicitly requested', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const { renderLaunchPreflight } = await import('./self-dev/launch-preflight.js');
    const printed: string[] = [];
    const decideForceArgs: boolean[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        loadLaunchPreflight: async () => ({
          prepareAskLaunch: (() => ({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 })) as never,
          decideAskPreflight: ((input: { goalFile: string }, _deps: unknown, force: boolean) => {
            decideForceArgs.push(force);
            return {
              result: {
                paths: [],
                missingDeclaredPathCount: 0,
                blockers: [{
                  kind: 'no-target-paths',
                  name: '(대상 경로 0)',
                  detail: '골에서 대상 경로를 하나도 못 뽑았다',
                }],
                warnings: [],
                openPrs: { state: 'checked', count: 0 },
                liveRuns: { state: 'checked', count: 0 },
                completedRuns: { state: 'checked', count: 0 },
                completedRunMatches: [],
                interruptedRuns: { state: 'checked', count: 0 },
                interruptedRunMatches: [],
                activeUnfinishedRuns: { state: 'checked', count: 0 },
                inactiveUnfinishedRuns: { state: 'checked', count: 0 },
                unreadableUnfinishedRunAges: { state: 'checked', count: 0 },
                recentChanges: { state: 'checked', count: 0 },
                preexistingFailures: { state: 'checked', files: [] },
                recentChangeWindowDays: 7,
                unreadableRuns: 0,
                liveRunWindowMs: 30 * 60_000,
              },
              shouldLaunch: force,
            };
          }) as never,
          renderLaunchPreflight,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-no-target.md']);

      const unforcedOutput = printed.join('\n');
      expect(decideForceArgs).toEqual([false]);
      expect(unforcedOutput).toContain('[preflight] ⛔ 막는 것 1건 — 발사하지 않는다');
      expect(unforcedOutput).toContain('(대상 경로 0) — 골에서 대상 경로를 하나도 못 뽑았다');
      expect(unforcedOutput).toContain('[preflight] 그래도 가려면 --force-preflight (그 우회는 관측에 남는다)');
      expect(unforcedOutput).not.toContain('위 막힘을 «뚫고» 발사한다');

      printed.length = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--force-preflight', '/tmp/GOAL-no-target.md']);

      const forcedOutput = printed.join('\n');
      expect(decideForceArgs).toEqual([false, true]);
      expect(forcedOutput).toContain('[preflight] ⚠️ --force-preflight — 위 막힘을 «뚫고» 발사한다');
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask propagates a failed shared dev pipeline result to a non-zero exit code', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'self', result: { ok: false }, plan: {} } as never)) as never,
          devResultOk: (() => false) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-failing-goal.md']);

      expect(exitCodes).toEqual([2]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  // ⛔⭐⭐ 「목이 그 함수를 갖는다」가 아니라 ***「그 줄이 실제로 «나온다»」***를 문다.
  //   📏 2026-08-22 실측 계기: 이 입구로 돈 미션이 `[self-implement:pr-opened] …` 에서 «끝»났고
  //     사람이 outcome·merged-into·run id 를 하나도 못 봤다. 목만 고치면 그 결손이 다시 숨는다.
  test('harness ask prints a completion summary line carrying the observed run id', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const printed: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 여기서는 «진짜» 렌더러를 쓴다 — 문면 계약까지 함께 물기 위해서다.
          renderDevCompletionLine: (await import('./self-dev/dev-cli.js')).renderDevCompletionLine,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({
            kind: 'self',
            result: { runId: 'run-observed-1', outcome: 'completed', merged: true, mergedBase: 'main' },
            plan: { base: 'main' },
          } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-goal.md']);

      const line = printed.find((entry) => entry.includes('run='));
      expect(line).toBeDefined();
      expect(line).toContain('run-observed-1');
      expect(line).toContain('ok=true');
    } finally {
      console.log = originalLog;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  // ⭐ `harness plan` 은 `say` 를 «재사용»한다 — ⛔ 두 번째 구현을 만들지 않는다.
  //   그리고 그 재사용의 «다른 한 칸»은 공개 옵션이 아니라 ***내부 인자***여야 한다
  //   (공개 옵션을 늘리면 `--plan` 이 ask·say 에도 보이고, 그건 «없는 계약»이다).
  test('harness plan reuses the say flow through an internal flag, not a public option', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const planHandler = indexSource.slice(
      indexSource.indexOf('async function runDevPlanFromWords'),
      indexSource.indexOf('async function runDevSayFromWords'),
    );
    expect(planHandler).toContain('runDevSayFromWords(words, opts, { planStaged: true })');
    // ⛔ 공개 옵션 타입에 plan 이 «없어야» 한다
    const sinkSource = readFileSync(new URL('./harness/harness-cli-command.ts', import.meta.url), 'utf8');
    const optionsType = sinkSource.slice(
      sinkSource.indexOf('export interface HarnessAskSayOptions'),
      sinkSource.indexOf('}', sinkSource.indexOf('export interface HarnessAskSayOptions')),
    );
    expect(optionsType).not.toContain('plan');
  });

  test('harness say and plan pass distinct registry entrances into the shared authoring launch flow', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const authoringEntrances: string[] = [];
    const assembledSpecs: Array<{ entrance?: string }> = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, _provided: readonly string[], entrance: string) => ({ input, executor, opts, entrance })) as never,
          selectDevAuthorInput: (() => ({ kind: 'say', value: 'author this goal' })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: { entrance?: string }) => {
            assembledSpecs.push(spec);
            return { kind: 'self', result: { runId: 'run-entrance', outcome: 'completed' }, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async (_sayText, entrance, selection) => {
          authoringEntrances.push(`${entrance?.id ?? 'missing'}:${String(selection?.forcePreflight === true)}`);
          return { kind: 'launch', goalFile: '/tmp/goal.md' } as never;
        },
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'author this goal']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'author this goal', '--force-preflight']);

      expect(authoringEntrances).toEqual(['cli-harness-say:false', 'cli-harness-say:true']);
      expect(assembledSpecs.map((spec) => spec.entrance)).toEqual(['cli-harness-say', 'cli-harness-say']);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  // ⛔⭐ 던진 경우엔 이 줄을 «만들지 않는다» — runId 를 지어내야 하기 때문이다.
  //   그 자리는 harness-cli-command 의 `❌ <한 줄>`(#11437)이 이미 덮는다.
  test('harness ask does not fabricate a completion line when the pipeline returns a non-self kind', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const printed: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (await import('./self-dev/dev-cli.js')).renderDevCompletionLine,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/unused' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/GOAL-goal.md']);

      expect(printed.some((entry) => entry.includes('run='))).toBe(false);
    } finally {
      console.log = originalLog;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness plan refuses instead of entering the staged pipeline', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const { setHarnessPlanRfcForTesting } = await import('./harness/harness-cli-command.js');
    const planRfcCalls: Array<[string, { dryRun: boolean }]> = [];
    const printed: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try {
      setHarnessPlanRfcForTesting(async (input, opts) => {
        const dryRun = opts?.dryRun === true;
        planRfcCalls.push([input, { dryRun }]);
        return { path: 'docs/RFC-stub.md', markdown: '', openQuestions: [], dryRun };
      });
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (await import('./self-dev/dev-cli.js')).renderDevCompletionLine,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, _provided: readonly string[], entrance: string) => ({ input, executor, opts, entrance })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({
            kind: 'plan-staged',
            result: { output: 'PLAN: update docs\nartifact: /tmp/harness-plan-output.md' },
            plan: { base: 'main' },
          } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/authored-plan.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'plan', 'write', 'a', 'plan']);

      const output = printed.join('\n');
      expect(planRfcCalls).toEqual([['write a plan', { dryRun: false }]]);
      expect(output).not.toContain('PLAN: update docs');
      expect(output).not.toContain('run=');
    } finally {
      console.log = originalLog;
      setHarnessPlanRfcForTesting(undefined);
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say joins every sentence word and reaches the shared dev say launch and pipeline path', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const selected: unknown[] = [];
    const sayLaunchInputs: string[] = [];
    const sayLaunchEntrances: string[] = [];
    const specs: unknown[] = [];
    const pipelineSpecs: unknown[] = [];
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => {
            const spec = { input, executor, opts };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: ((textParts: readonly string[], opts: { say?: string }) => {
            selected.push({ textParts, opts });
            return { kind: 'say', value: opts.say };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async (sayText, entrance) => {
          sayLaunchInputs.push(sayText);
          sayLaunchEntrances.push(entrance?.id ?? 'missing');
          return { kind: 'launch', goalFile: '/tmp/authored-from-say.md' } as never;
        },
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'one', 'two', 'three']);

      expect(selected).toEqual([{ textParts: [], opts: { say: 'one two three' } }]);
      expect(sayLaunchInputs).toEqual(['one two three']);
      expect(sayLaunchEntrances).toEqual(['cli-harness-say']);
      expect(specs).toEqual([{ input: { file: '/tmp/authored-from-say.md' }, executor: { kind: 'self' }, opts: {} }]);
      expect(pipelineSpecs).toEqual(specs.map((spec) => withHarnessRunIdentity(spec as object)));
      expect(exitCodes).toEqual([]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say rejects unsupported observe-only through the default dev-cli loader before it calls the authoring launch flow', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const sayLaunchInputs: string[] = [];
    const printed: string[] = [];
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => { throw new Error('pipeline must not run'); }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async (sayText) => {
          sayLaunchInputs.push(sayText);
          return { kind: 'launch', goalFile: '/tmp/must-not-author.md' } as never;
        },
        print: (line) => { printed.push(line); },
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', '--observe-only', 'write', 'goal']);

      expect(sayLaunchInputs).toEqual([]);
      expect(printed.join('\n')).toContain('--observe-only');
      expect(exitCodes).toEqual([1]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say permits supported base and auto-merge options to reach authoring', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const { assertDevCliPathOptions } = await import('./self-dev/dev-cli.js');
    const sayLaunchInputs: string[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'self', result: { ok: true }, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async (sayText) => {
          sayLaunchInputs.push(sayText);
          return { kind: 'launch', goalFile: '/tmp/authored-supported.md' } as never;
        },
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', '--base', 'main', '--no-auto-merge', 'write', 'goal']);

      expect(sayLaunchInputs).toEqual(['write goal']);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say forwards the four promoted knobs to the shared dev pipeline spec', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    const pipelineSpecs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/say-knobs.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', '--json', '--base', 'main', '--no-auto-merge', '--observe-only', 'write', 'goal']);

      expect(specs).toEqual([{
        input: { file: '/tmp/say-knobs.md' },
        executor: { kind: 'self' },
        opts: { json: true, base: 'main', autoMerge: false, observeOnly: true },
        explicitNames: ['json', 'base', 'autoMerge', 'observeOnly'],
      }]);
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity({ ...(specs[0] as object), humanReadableOutput: false })]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say forwards child LLM selections through the shared dev pipeline spec', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const specs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'interactive', result: null, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/say-child-llm.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync([
        'node', 'elanous', 'harness', 'say',
        '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.6',
        'write', 'goal',
      ]);

      expect(specs).toEqual([{
        input: { file: '/tmp/say-child-llm.md' },
        executor: { kind: 'self' },
        opts: { childLlmProvider: 'grok', childLlmModel: 'grok-4.6' },
        explicitNames: ['childLlmProvider', 'childLlmModel'],
      }]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness plan rejects repeated --role-llm values before the shared dev pipeline spec', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const { setHarnessPlanRfcForTesting } = await import('./harness/harness-cli-command.js');
    const planRfcCalls: Array<[string, { dryRun: boolean }]> = [];
    const {
      clearLaunchRoleLlmOverrides,
      getLaunchRoleLlmOverrides,
      setLaunchRoleLlmOverrides,
    } = await import('./user-config.js');
    const originalLaunchRoleLlmOverrides = getLaunchRoleLlmOverrides();
    const specs: unknown[] = [];
    try {
      setHarnessPlanRfcForTesting(async (input, opts) => {
        const dryRun = opts?.dryRun === true;
        planRfcCalls.push([input, { dryRun }]);
        return { path: 'docs/RFC-stub.md', markdown: '', openQuestions: [], dryRun };
      });
      clearLaunchRoleLlmOverrides();
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown, explicitNames: unknown) => {
            const spec = { input, executor, opts, explicitNames };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'plan-staged', result: { output: 'PLAN' }, plan: {} } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/plan-role-llm.md' } as never),
        setExitCode: () => {},
      });

      await program.parseAsync([
        'node', 'elanous', 'harness', 'plan',
        '--role-llm', 'implement=grok/best',
        '--role-llm', 'review=anthropic',
        'write', 'a', 'plan',
      ]);

      expect(planRfcCalls).toEqual([['write a plan', { dryRun: false }]]);
      expect(specs).toEqual([]);
    } finally {
      setHarnessPlanRfcForTesting(undefined);
      setRunDevAskFromGoalFileDepsForTesting(undefined);
      clearLaunchRoleLlmOverrides();
      if (originalLaunchRoleLlmOverrides) setLaunchRoleLlmOverrides(originalLaunchRoleLlmOverrides);
    }
  });

  test('harness say propagates a stopped shared say launch flow to a non-zero exit code before pipeline execution', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const pipelineSpecs: unknown[] = [];
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'stopped-by-preflight', goalFile: '/tmp/stopped.md' } as never),
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'blocked', 'launch']);

      expect(pipelineSpecs).toEqual([]);
      expect(exitCodes).toEqual([1]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness say propagates a failed shared dev pipeline result to a non-zero exit code', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(),
        loadDevCli: async () => ({
          // ⭐ 하니스 입구가 «완료 요약 한 줄»을 내므로 목도 그 함수를 갖는다(#11437 이후 계약).
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((_: readonly string[], opts: { say?: string }) => ({ kind: 'say', value: opts.say })) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({ kind: 'self', result: { ok: false }, plan: {} } as never)) as never,
          devResultOk: (() => false) as never,
        }),
        runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/failing-say-goal.md' } as never),
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'pipeline', 'fails']);

      expect(exitCodes).toEqual([2]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask routes a non-goal filename through selectDevAuthorInput and runAskLaunchFlow', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const askPath = '/tmp/ASK-2026-08-24-live.txt';
    const selected: unknown[] = [];
    const askLaunchInputs: Array<{ path: string; selection: unknown }> = [];
    const specs: unknown[] = [];
    const pipelineSpecs: unknown[] = [];
    const printed: string[] = [];
    const exitCodes: number[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => {
            const spec = { input, executor, opts };
            specs.push(spec);
            return spec as never;
          }) as never,
          selectDevAuthorInput: ((textParts: readonly string[], opts: { ask?: string }) => {
            selected.push({ textParts, opts });
            return { kind: 'ask', value: opts.ask };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async (path, selection) => {
          askLaunchInputs.push({ path, selection });
          return { kind: 'launch', goalFile: '/tmp/GOAL-authored-from-ask.md' } as never;
        },
        setExitCode: (code) => { exitCodes.push(code); },
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', askPath, '--goal-type', 'research']);

      expect(printed[0]).toBe('[harness ask] 입력 종류: ask-file');
      expect(selected).toEqual([{ textParts: [], opts: { ask: askPath } }]);
      expect(askLaunchInputs).toEqual([{ path: askPath, selection: { goalType: 'research' } }]);
      expect(specs).toEqual([{ input: { file: '/tmp/GOAL-authored-from-ask.md' }, executor: { kind: 'self' }, opts: {} }]);
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity(specs[0]!)]);
      expect(exitCodes).toEqual([]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask --json keeps stdout JSON and still prints the ask-file classification on stderr', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const askPath = '/tmp/ASK-2026-08-24-json.txt';
    const selected: unknown[] = [];
    const askLaunchInputs: string[] = [];
    const printed: string[] = [];
    const stdout: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: ((textParts: readonly string[], opts: { ask?: string }) => {
            selected.push({ textParts, opts });
            return { kind: 'ask', value: opts.ask };
          }) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async () => ({
            kind: 'self',
            result: { runId: 'run-ask-json-1', ok: true },
            plan: { base: 'release/base' },
          } as never)) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async (path) => {
          askLaunchInputs.push(path);
          return { kind: 'launch', goalFile: '/tmp/GOAL-authored-from-ask-json.md' } as never;
        },
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--json', askPath]);

      expect(printed[0]).toBe('[harness ask] 입력 종류: ask-file');
      expect(selected).toEqual([{ textParts: [], opts: { ask: askPath } }]);
      expect(askLaunchInputs).toEqual([askPath]);
      expect(stdout.join('').trim().split(/\n+/)).toHaveLength(1);
      expect(JSON.parse(stdout.join(''))).toEqual({
        ok: true,
        kind: 'self',
        result: { runId: 'run-ask-json-1', ok: true },
      });
    } finally {
      process.stdout.write = originalWrite;
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });

  test('harness ask preserves the authored-goal launch path without an input-kind diagnostic', async () => {
    const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('./index.js');
    const goalPath = '/tmp/GOAL-already-authored.md';
    const printed: string[] = [];
    const askLaunchInputs: string[] = [];
    const pipelineSpecs: unknown[] = [];
    try {
      setRunDevAskFromGoalFileDepsForTesting({
        ...passingPreflightDeps(printed),
        loadDevCli: async () => ({
          renderDevCompletionLine: (() => '[dev] self 완료(목)') as never,
          assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
          buildDevCliSpec: ((input: unknown, executor: unknown, opts: unknown) => ({ input, executor, opts })) as never,
          selectDevAuthorInput: (() => undefined) as never,
        }),
        loadDevPipeline: async () => ({
          runDevPipeline: (async (spec: unknown) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: {} } as never;
          }) as never,
          devResultOk: (() => true) as never,
        }),
        runAskFileLaunchFlow: async (path) => {
          askLaunchInputs.push(path);
          return { kind: 'launch', goalFile: '/unused' } as never;
        },
        setExitCode: () => {},
      });

      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath]);

      expect(printed.some((line) => line.includes('[harness ask] 입력 종류:'))).toBe(false);
      expect(printed[0]).toBe('[preflight] 인보커 작업 트리 원격 기본 브랜치 대비 — 뒤처지지 않았다 (origin/main)');
      expect(printed).toContain('[preflight] ✅ 막는 것 없음 — 발사로 간다');
      expect(askLaunchInputs).toEqual([]);
      expect(pipelineSpecs).toEqual([withHarnessRunIdentity({ input: { file: goalPath }, executor: { kind: 'self' }, opts: {} })]);
    } finally {
      setRunDevAskFromGoalFileDepsForTesting(undefined);
    }
  });
});

describe('filterDashboardArgs', () => {
  test('strips dashboard resume and its value when no subcommand leads', () => {
    expect(filterDashboardArgs(['--resume', 'dashboard-session', '--debug']))
      .toEqual([]);
  });

  test('preserves resume and its following token when a subcommand leads', () => {
    expect(filterDashboardArgs(['self', 'goal-run-search', '--resume', 'XYZ']))
      .toEqual(['self', 'goal-run-search', '--resume', 'XYZ']);
  });

  test('preserves the token following session fork boolean resume', () => {
    expect(filterDashboardArgs(['session', 'fork', '--resume', 'unrelated-token']))
      .toEqual(['session', 'fork', '--resume', 'unrelated-token']);
  });
});

describe('buildCliAgentTools — harnessPlan child tool wiring', () => {
  const source = readFileSync(new URL('./cli/agent-cli.ts', import.meta.url), 'utf8');

  function harnessPlanBlock(text: string): string {
    const start = text.indexOf('if (harnessPlan) {');
    const end = text.indexOf('  // Native dispatch', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  function assertHarnessPlanWiring(text: string): void {
    const block = harnessPlanBlock(text);

    expect(block).toContain('specs.push(buildPlanTool(), buildMarkStepDoneTool());');
    expect(block).toContain("dispatchByName.set('Plan', async (args) => dispatchPlan(");
    expect(block).toContain("dispatchByName.set('MarkStepDone', async (args) => dispatchMarkStepDone(");
  }

  function assertCliAgentChildToolWiring(text: string): void {
    const dispatchStart = text.indexOf('const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {');
    const dispatchEnd = text.indexOf('  return { specs, dispatch, workingDirectory };', dispatchStart);
    expect(dispatchStart).toBeGreaterThanOrEqual(0);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    const block = text.slice(dispatchStart, dispatchEnd);

    expect(block).toContain('agentHostTools: specs,');
    expect(block).toContain('agentDispatchTool: dispatch,');
  }

  test('adds Plan and MarkStepDone specs and dispatchers inside the harnessPlan branch while passing its existing tool catalog and dispatcher to inline child Agent dispatch', () => {
    assertHarnessPlanWiring(source);
    assertCliAgentChildToolWiring(source);
  });

  test('rejects mutations that remove either Plan tool registration or child Agent tool context', () => {
    const missingPlanSpec = source.replace('buildPlanTool(), ', '');
    const missingMarkStepDoneDispatch = source.replace("dispatchByName.set('MarkStepDone'", "dispatchByName.set('RemovedMarkStepDone'");
    const missingHostTools = source.replace('        agentHostTools: specs,\n', '');
    const missingDispatcher = source.replace('        agentDispatchTool: dispatch,\n', '');

    expect(() => assertHarnessPlanWiring(missingPlanSpec)).toThrow();
    expect(() => assertHarnessPlanWiring(missingMarkStepDoneDispatch)).toThrow();
    expect(() => assertCliAgentChildToolWiring(missingHostTools)).toThrow();
    expect(() => assertCliAgentChildToolWiring(missingDispatcher)).toThrow();
  });
});

describe('dev and drive Commander option-source wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  function assertExplicitDevOptionSourceWiring(text: string): void {
    expect(text).toContain(".filter((name) => command.getOptionValueSource(name) === 'cli')");
    expect(text).toContain("devCli.buildDriveAliasDevSpec(hasText ? textParts.join(' ') : undefined, devOpts, devCli.explicitDevOptionNames(command))");
    expect(text).toContain('buildDevCliSpec(input, executor, devOpts, devCli.explicitDevOptionNames(command))');
  }

  test('passes Commander explicit option sources into both dev and drive spec branches', () => {
    assertExplicitDevOptionSourceWiring(source);
  });

  test('fails if either dev or drive branch stops passing Commander explicit option sources', () => {
    const driveSourceRemoved = source.replace('devCli.explicitDevOptionNames(command))\n        : buildDevCliSpec', '[] )\n        : buildDevCliSpec');
    const devSourceRemoved = source.replace('buildDevCliSpec(input, executor, devOpts, devCli.explicitDevOptionNames(command))', 'buildDevCliSpec(input, executor, devOpts, [])');

    expect(() => assertExplicitDevOptionSourceWiring(driveSourceRemoved)).toThrow();
    expect(() => assertExplicitDevOptionSourceWiring(devSourceRemoved)).toThrow();
  });
});

describe('self orchestrate CLI decomposer selection wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;

  function commandBlock(text: string, marker: string): string {
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n  });', start);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end + 6);
  }

  function assertSharedPrepareWiring(text: string): void {
    const selfCommand = commandBlock(text, ".command('orchestrate [goals...]')");
    const harnessCommand = commandBlock(text, ".command('orchestrate <goals...>')");
    const harnessExecution = text.slice(text.indexOf('export async function runHarnessOrchestrateExecution'), text.indexOf('function registerHarnessOrchestrateCapabilityOptions'));
    expect(text.match(/prepareOrchestrateDecomposeGoals\(/g)).toHaveLength(2);
    expect(text.match(/buildOrchestrateDecomposePrepareArgs\(/g)).toHaveLength(2);
    expect(selfCommand.match(/prepareOrchestrateDecomposeGoals\(buildOrchestrateDecomposePrepareArgs\(/g)).toHaveLength(1);
    expect(harnessExecution.match(/prepareGoals\(buildOrchestrateDecomposePrepareArgs\(/g)).toHaveLength(1);
    expect(selfCommand).not.toContain('selectFabricDecomposer(');
    expect(harnessCommand).not.toContain('selectFabricDecomposer(');
    expect(harnessExecution).not.toContain('selectFabricDecomposer(');
    expect(selfCommand).not.toContain('observeDecomposerSelection(');
    expect(harnessCommand).not.toContain('observeDecomposerSelection(');
    expect(harnessExecution).not.toContain('observeDecomposerSelection(');
    expect(selfCommand).toContain('maxTasks: opts.maxTasks');
    expect(harnessExecution).toContain('maxTasks: plan.maxTasks');
    expect(selfCommand).toContain('onInfo: (message) => ui.info(message)');
    expect(harnessExecution).toContain('onInfo: writeInfo');
  }

  test('both entrances call the shared decompose preprocessor once with the same argument shape', () => {
    assertSharedPrepareWiring(source);
  });

  test('keeps explicit fabric selection ahead of enabled config', () => {
    expect(selectFabricDecomposer(true, { enabled: true, autoPathThreshold: null }, undefined))
      .toEqual({ decomposer: 'fabric', source: 'request' });
  });

  test('selects fabric from enabled config without an explicit flag', () => {
    expect(selectFabricDecomposer(undefined, { enabled: true, autoPathThreshold: null }, undefined))
      .toEqual({ decomposer: 'fabric', source: 'config' });
  });

  test('selects the default decomposer without an explicit flag or enabled config', () => {
    expect(selectFabricDecomposer(undefined, { enabled: false, autoPathThreshold: null }, undefined))
      .toEqual({ decomposer: 'default', source: 'default' });
  });

  test('rejects an explicit fabric flag without decomposition with exit code 2', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'self', 'orchestrate', 'goal', '--fabric-decompose'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stdout)).toContain('--fabric-decompose 는 --decompose 와 «함께» 쓴다');
  });

  test('harness still rejects fabric decompose because decompose remains outside this landing', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'harness', 'orchestrate', 'goal', '--fabric-decompose'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("unknown option '--fabric-decompose'");
  });

  test('fails when either entrance inlines decomposer selection again', () => {
    const inlined = source.replace(
      'const prepared = await prepareOrchestrateDecomposeGoals(buildOrchestrateDecomposePrepareArgs({',
      "const selection = selectFabricDecomposer(opts.fabricDecompose, { enabled: false, autoPathThreshold: null }, undefined);\n      const prepared = await prepareOrchestrateDecomposeGoals(buildOrchestrateDecomposePrepareArgs({",
    );

    expect(() => assertSharedPrepareWiring(inlined)).toThrow();
  });
});

describe('self orchestrate CLI help tiers', () => {
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  // ⭐⭐ 이 집합이 ***`self orchestrate` 옵션 계약의 canonical***이다.
  //   「옵션이 살아 있나」는 아래 `preserves the existing option set…` 이 «두 티어의 실제 산출»로 판정하고,
  //   `fails if a formerly accepted option is absent…` 가 그 판정이 «무는지»를 반증으로 확인한다.
  //   ⛔ 그래서 다른 절이 같은 계약을 «소스 문자열»로 중복 검사하지 않는다
  //     (#10857 의 --help 접기 뒤 그 중복이 옛 자리를 보고 red 였다 · 2026-08-21).
  const existingOptionNames = new Set([
    '--concurrency', '--auto-merge', '--auto-review', '--open-pr', '--base', '--teardown',
    '--resume', '--board', '--decompose', '--max-tasks', '--fabric-decompose', '--no-supervise',
    '--supervise-rounds', '--json',
    // 2026-09-25 🅢 pod·벤치 기판(#20444 계열)이 더한 다섯 — 계약에 올린다.
    '--substrate', '--pod-account', '--pod-pass-env', '--no-pod-rebuild', '--bench-arms',
    // 2026-09-26 플릿·풀이 기본 도움말에 더한 셋.
    '--pod-pool', '--pod-skill-env', '--reduce',
    // 2026-09-27 pod 원천 표면이 더한 하나 — `--help-all` 에만 보인다.
    '--pod-source',
    '--goal-file',
  ]);

  test('option contract set itself does not silently shrink', () => {
    // ⛔ 위 집합을 줄이면 `toEqual` 이 여전히 통과하므로 계약이 «조용히» 좁아진다. 수를 못 박는다.
    expect(existingOptionNames.size).toBe(24);
  });

  function help(...args: string[]): string {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'self', 'orchestrate', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    return new TextDecoder().decode(result.stdout);
  }

  function optionNames(text: string): Set<string> {
    return new Set(text.split('\n').flatMap((line) => {
      const match = line.match(/^\s+(?:-[\w], )?(--[a-z][a-z-]*)/);
      return match ? [match[1]] : [];
    }));
  }

  test('keeps the primary option listing below eighteen lines', () => {
    const primary = help('--help');
    const optionLines = primary.split('\n').filter((line) => /^\s+-{1,2}[\w-]+/.test(line));

    expect(optionLines.length).toBeLessThan(18);
    expect(primary).toContain('--help-all');
  });

  function assertExistingOptions(primary: string, extended: string): void {
    const available = new Set(
      [...optionNames(primary), ...optionNames(extended)]
        .filter((name) => name !== '--help' && name !== '--help-all'),
    );

    expect([...available].sort()).toEqual([...existingOptionNames].sort());
  }

  test('preserves the existing option set across primary and extended help', () => {
    assertExistingOptions(help('--help'), help('--help-all'));
  }, 30_000);

  test.each([
    ['--help', 'Options:'],
    ['--help-all', 'All options:'],
  ])('prints %s before self preAction can create a log store', async (helpFlag, expectedHeading) => {
    const isolatedCwd = await mkdtemp(join(tmpdir(), 'elanous-orchestrate-help-'));
    const stateDir = join(isolatedCwd, 'state');
    const configDir = join(isolatedCwd, 'config');
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, elanous, 'self', 'orchestrate', helpFlag],
        cwd: isolatedCwd,
        env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toContain(expectedHeading);
      expect(existsSync(join(stateDir, 'logs.db'))).toBe(false);
    } finally {
      await rm(isolatedCwd, { recursive: true, force: true });
    }
  });

  test('fails if a formerly accepted option is absent from both help tiers', () => {
    const primary = help('--help');
    const extendedWithoutResume = help('--help-all').replace(/^\s+--resume.*\n/m, '');

    expect(() => assertExistingOptions(primary, extendedWithoutResume)).toThrow();
  }, 30_000);
});

describe('dev CLI help tiers', () => {
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  const existingOptionNames = new Set([
    '--file', '--ask', '--substrate', '--pod-pool', '--say', '--force-preflight', '--allow-no-evidence',
    '--allow-superseded-goal', '--allow-goal-lint-errors', '--backend', '--transport',
    '--branch', '--base', '--plan', '--implement', '--elanous', '--hold', '--goal',
    '--max-steps', '--poll-ms', '--ready-timeout-ms', '--model', '--observe-only', '--isolated-root', '--jail-home', '--cwd',
    '--worktree', '--no-open-pr', '--no-auto-merge', '--no-auto-review', '--no-draft',
    '--no-supervise', '--child-llm-provider', '--child-llm-model', '--child-llm-effort', '--correlation', '--target', '--context',
    '--context-text', '--evidence', '--doc-dir', '--doc-glob', '--test-path', '--max-rounds',
    '--no-commit', '--deliverable', '--screens', '--json', '--role-llm', '--attach', '--yes',
  ]);
  const primaryOptionNames = new Set([
    '--ask', '--say', '--file', '--backend', '--target',
    '--plan', '--implement', '--elanous', '--attach', '--json', '--help-all', '--help',
  ]);

  test('option contract set itself only shrinks for the intentional retirements including graph authority', () => {
    expect(existingOptionNames.size).toBe(51);
  });

  function help(...args: string[]): string {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'dev', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    return new TextDecoder().decode(result.stdout);
  }

  function optionNames(text: string): Set<string> {
    return new Set(text.split('\n').flatMap((line) => {
      const match = line.match(/^\s+(?:-[\w], )?(--[a-z][a-z-]*)/);
      return match ? [match[1]] : [];
    }));
  }

  test('keeps the primary option listing below sixteen lines and matches the human-chosen primary list', () => {
    const primary = help('--help');
    const optionLines = primary.split('\n').filter((line) => /^\s+-{1,2}[\w-]+/.test(line));

    expect(optionLines.length).toBeLessThan(16);
    expect([...optionNames(primary)].sort()).toEqual([...primaryOptionNames].sort());
    expect(primary).not.toContain('--force-preflight');
  });

  function assertExistingOptions(primary: string, extended: string): void {
    const available = new Set(
      [...optionNames(primary), ...optionNames(extended)]
        .filter((name) => name !== '--help' && name !== '--help-all'),
    );

    expect([...available].sort()).toEqual([...existingOptionNames].sort());
  }

  test('preserves the existing option set across primary and extended help', () => {
    assertExistingOptions(help('--help'), help('--help-all'));
  }, 30_000);

  test('accepts a folded option as a real CLI argument instead of unknown option', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'dev', '--force-preflight'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    expect(output).not.toContain('unknown option');
  });

  test('correlation reaches dev file validation instead of being rejected by the parser', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'dev', '--file', 'tmp/nonexistent-zzz.md', '--correlation', 'request-zzz'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

    expect(output).not.toContain("unknown option '--correlation'");
    expect(output).toContain('ENOENT: no such file');
  }, 30_000);

  test('dev say action carries force-preflight without a graph authority override', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const goalDir = await mkdtemp(join(tmpdir(), 'elanous-dev-graph-action-'));
    const goalFile = join(goalDir, 'GOAL-dev-graph.md');
    await writeFile(goalFile, '대상 경로: src/index.ts\n\n## WHAT TO BUILD\n- graph action wiring');
    const launchForceValues: boolean[] = [];
    const pipelineSpecs: Array<{ self?: { graphAuthoritative?: boolean } }> = [];
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);

    try {
      {
        setDevLaunchControlTestSeams({
          runAskLaunchFlow: (async (input: { forceRequested: boolean }) => {
            launchForceValues.push(input.forceRequested);
            return { kind: 'launch', goalFile } as never;
          }) as never,
          runDevPipeline: (async (spec: { self?: { graphAuthoritative?: boolean } }) => {
            pipelineSpecs.push(spec);
            return { kind: 'interactive', result: null, plan: { base: 'main' } } as never;
          }) as never,
        });
        const argv = ['node', 'elanous', 'dev', '--say', '같은 objective', '--force-preflight'];
        await expect(program.parseAsync(argv)).rejects.toThrow('PROCESS_EXIT_1');
      }
    } finally {
      setDevLaunchControlTestSeams(undefined);
      exit.mockRestore();
      await rm(goalDir, { recursive: true, force: true });
    }

    expect(launchForceValues).toEqual([true]);
    expect(pipelineSpecs).toHaveLength(1);
    expect(pipelineSpecs.every((spec) => !Object.hasOwn(spec.self ?? {}, 'graphAuthoritative'))).toBe(true);
  });

  test('dev --elanous --hold --json leaves the hold JSON as the only stdout document', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line)); });
    const exits: Array<number | undefined> = [];
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as never);

    try {
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => {
          console.log(JSON.stringify({ held: true, ptyId: 'pty_12345678', spaceId: 'dev-run-x', workdir: '/work' }));
          return { kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: true } } } as never;
        }) as never,
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--hold', '--json'])).resolves.toBeDefined();
    } finally {
      setDevLaunchControlTestSeams(undefined);
      output.mockRestore();
      exit.mockRestore();
    }

    expect(exits).toContain(0);
    expect(lines).toHaveLength(1);
    const held = JSON.parse(lines.join('\n'));
    expect(held).toMatchObject({ held: true, ptyId: 'pty_12345678', spaceId: 'dev-run-x', workdir: '/work' });
    expect(held).not.toHaveProperty('result');
    expect(held).not.toHaveProperty('autoWorktree');
  });

  test('records raw hold-owner predicate values only when a requested hold does not enter the owner wait', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const goalDir = await mkdtemp(join(tmpdir(), 'elanous-hold-owner-observation-'));
    const goalFile = join(goalDir, 'GOAL-hold-owner.md');
    await writeFile(goalFile, '대상 경로: src/index.ts\n');
    const seen: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({
      name: 'hold-owner-not-entered-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline'
          && (record.event === 'hold-owner-not-entered' || record.event === 'hold-delegated-to-owner')
          && record.data && typeof record.data === 'object') {
          seen.push({ event: record.event, ...(record.data as Record<string, unknown>) });
        }
      },
    } as never);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;
    const previousRunId = process.env.ELANOUS_RUN_ID;

    try {
      process.env.ELANOUS_HOLD_OWNER = '1';
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'shell-drive', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: true } },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--goal', goalFile])).rejects.toThrow('PROCESS_EXIT_1');

      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main' },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--hold'])).rejects.toThrow('PROCESS_EXIT_1');

      process.env.ELANOUS_HOLD_OWNER = '0';
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: true } },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--goal', goalFile])).rejects.toThrow('PROCESS_EXIT_1');

      delete process.env.ELANOUS_HOLD_OWNER;
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: false } },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--goal', goalFile])).rejects.toThrow('PROCESS_EXIT_1');
    } finally {
      setDevLaunchControlTestSeams(undefined);
      off();
      exit.mockRestore();
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
      await rm(goalDir, { recursive: true, force: true });
    }

    // ⛔⭐ 셋째 줄이 `hold-delegated-to-owner` 인 것이 2026-09-12 정정의 핵심이다 —
    //   `ELANOUS_HOLD_OWNER` 가 '1' 이 아니면 그 프로세스는 **런처**이고, 안 붙드는 것이 «정상»이다.
    // ⭐ 2026-09-25: `debug.log` 가 `ELANOUS_HOST_ID` 를 `hostId` 로 자동 부착한다(RFC 런 출처 O2 · #20468) — runId 처럼 뺀다.
    // ⭐ 2026-09-26: 같은 로거가 `ELANOUS_SUBSTRATE` 를 `substrate` 로 붙인다 — 판정 대상이 아니다.
    expect(seen.map(({ runId: _runId, hostId: _hostId, substrate: _substrate, ...predicate }) => predicate)).toEqual([
      { event: 'hold-owner-not-entered', kind: 'shell-drive', planHold: true, holdOwner: '1', holdRequestedByCli: false },
      { event: 'hold-owner-not-entered', kind: 'elanous-tui', planHold: 'missing', holdOwner: '1', holdRequestedByCli: true },
      { event: 'hold-delegated-to-owner', kind: 'elanous-tui', planHold: true, holdOwner: '0', holdRequestedByCli: false },
    ]);
  });

  test('does not record hold-owner observation when hold was not requested', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const seen: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({
      name: 'hold-owner-not-requested-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline' && record.event === 'hold-owner-not-entered' && record.data && typeof record.data === 'object') {
          seen.push(record.data as Record<string, unknown>);
        }
      },
    } as never);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;

    try {
      process.env.ELANOUS_HOLD_OWNER = '1';
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: false } },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous'])).rejects.toThrow('PROCESS_EXIT_1');
    } finally {
      setDevLaunchControlTestSeams(undefined);
      off();
      exit.mockRestore();
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
    }

    expect(seen).toHaveLength(0);
  });

  // ⛔⭐⭐ 2026-09-12 라이브가 낸 정정의 «회귀 방어» — 실물 런처는 `ELANOUS_HOLD_OWNER` 를 **안 갖는다**.
  //   종전 문면은 그 성공 경로에서 `hold-owner-not-entered` 를 울렸고, 나는 그것을 결함 신호로 읽을 뻔했다.
  test('names the launcher delegation instead of calling it a failure to enter the owner wait', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const seen: Array<{ event: string }> = [];
    const off = debug.registerSink({
      name: 'hold-launcher-delegation-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline'
          && (record.event === 'hold-owner-not-entered' || record.event === 'hold-delegated-to-owner')) {
          seen.push({ event: record.event as string });
        }
      },
    } as never);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;

    try {
      delete process.env.ELANOUS_HOLD_OWNER;
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: true } },
        }) as never),
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--hold'])).rejects.toThrow('PROCESS_EXIT_1');
    } finally {
      setDevLaunchControlTestSeams(undefined);
      off();
      exit.mockRestore();
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
    }

    expect(seen).toEqual([{ event: 'hold-delegated-to-owner' }]);
  });

  test('preserves the all-true hold-owner wait after the poller has started', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    let releaseWait: (() => void) | undefined;
    let pollerStarts = 0;
    const exited = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;
    const previousRunId = process.env.ELANOUS_RUN_ID;
    let enteredWaitResolve: (() => void) | undefined;
    const enteredWait = new Promise<void>((resolve) => { enteredWaitResolve = resolve; });
    const heldWait = new Promise<void>((resolve) => { releaseWait = resolve; });

    try {
      process.env.ELANOUS_HOLD_OWNER = '1';
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui',
          result: { exitCode: 0 },
          plan: { base: 'main', elanous: { hold: true } },
        }) as never),
        startHoldOwnerPoller: () => { pollerStarts += 1; },
        waitForHoldOwner: async () => {
          enteredWaitResolve!();
          await heldWait;
        },
      });
      let parsingSettled = false;
      const parsing = program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--hold']);
      const parseObservation = parsing.then(
        () => { parsingSettled = true; },
        () => { parsingSettled = true; },
      );
      await enteredWait;
      expect(pollerStarts).toBe(1);
      await Promise.resolve();
      expect(parsingSettled).toBe(false);
      expect(exited).not.toHaveBeenCalled();
      releaseWait!();
      await expect(parsing).rejects.toThrow('PROCESS_EXIT_1');
      await parseObservation;
    } finally {
      setDevLaunchControlTestSeams(undefined);
      exited.mockRestore();
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = previousRunId;
    }
  });

  test('hold owner CLI branch exits when its preallocated child dies', async () => {
    const { program, setDevLaunchControlTestSeams } = await import('./index.js');
    const exited = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as never);
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;
    const previousPtyId = process.env.ELANOUS_HOLD_PTY_ID;
    let observations = 0;
    try {
      process.env.ELANOUS_HOLD_OWNER = '1';
      process.env.ELANOUS_HOLD_PTY_ID = 'pty_deadbeef';
      setDevLaunchControlTestSeams({
        runDevPipeline: (async () => ({
          kind: 'elanous-tui', result: { exitCode: 0 }, plan: { base: 'main', elanous: { hold: true } },
        }) as never),
        startHoldOwnerPoller: () => {},
        holdOwnerChildAlive: () => observations++ === 0
          ? { alive: true, exitCode: null }
          : { alive: false, exitCode: 1 },
        holdOwnerWatchMs: 0,
        holdOwnerWatchTimeoutMs: 30,
      });
      await expect(program.parseAsync(['node', 'elanous', 'dev', '--elanous', '--hold'])).rejects.toThrow('PROCESS_EXIT_1');
      expect(observations).toBeGreaterThanOrEqual(2);
    } finally {
      setDevLaunchControlTestSeams(undefined);
      exited.mockRestore();
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
      if (previousPtyId === undefined) delete process.env.ELANOUS_HOLD_PTY_ID;
      else process.env.ELANOUS_HOLD_PTY_ID = previousPtyId;
    }
  }, 5_000);

  test('hold owner child watch ends on death and records the observed exit code', async () => {
    const { setDevLaunchControlTestSeams, waitForHoldOwnerChild } = await import('./index.js');
    const records: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({
      name: 'hold-owner-child-death-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline' && record.event === 'hold-owner-child-died' && record.data && typeof record.data === 'object') {
          records.push(record.data as Record<string, unknown>);
        }
      },
    } as never);
    let observations = 0;
    try {
      setDevLaunchControlTestSeams({
        holdOwnerChildAlive: () => observations++ === 0 ? { alive: true, exitCode: null } : { alive: false, exitCode: 1 },
        holdOwnerWatchMs: 0,
        holdOwnerWatchTimeoutMs: 30,
      });
      await expect(waitForHoldOwnerChild('pty_deadbeef')).resolves.toBe(1);
      expect(observations).toBeGreaterThanOrEqual(2);
      expect(records).toEqual([expect.objectContaining({ ptyId: 'pty_deadbeef', exitCode: 1 })]);
    } finally {
      off();
      setDevLaunchControlTestSeams(undefined);
    }
  }, 5_000);

  test('hold owner child watch is unbounded without a configured timeout and records its start metadata', async () => {
    const { setDevLaunchControlTestSeams, waitForHoldOwnerChild } = await import('./index.js');
    const previousTimeout = process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
    const records: Array<{ event?: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'hold-owner-unbounded-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline' && record.data && typeof record.data === 'object') {
          records.push({ event: record.event, data: record.data as Record<string, unknown> });
        }
      },
    } as never);
    let alive = true;
    try {
      delete process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
      setDevLaunchControlTestSeams({
        holdOwnerChildAlive: () => alive ? { alive: true, exitCode: null } : { alive: false, exitCode: 0 },
        holdOwnerWatchMs: 1,
      });
      const waiting = waitForHoldOwnerChild('pty_unbounded');
      await new Promise((resolve) => setTimeout(resolve, 50));
      alive = false;
      await expect(waiting).resolves.toBe(0);
      expect(records.filter(({ event }) => event === 'hold-owner-watch-timeout')).toEqual([]);
      expect(records.filter(({ event }) => event === 'hold-owner-watch-start')).toEqual([
        { event: 'hold-owner-watch-start', data: expect.objectContaining({ ptyId: 'pty_unbounded', timeoutMs: null, source: 'none' }) },
      ]);
    } finally {
      off();
      setDevLaunchControlTestSeams(undefined);
      if (previousTimeout === undefined) delete process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
      else process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS = previousTimeout;
    }
  }, 5_000);

  test('hold owner child watch uses a positive environment timeout', async () => {
    const { setDevLaunchControlTestSeams, waitForHoldOwnerChild } = await import('./index.js');
    const previousTimeout = process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
    const records: Array<{ event?: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'hold-owner-env-timeout-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline' && record.data && typeof record.data === 'object') {
          records.push({ event: record.event, data: record.data as Record<string, unknown> });
        }
      },
    } as never);
    try {
      process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS = '20';
      setDevLaunchControlTestSeams({
        holdOwnerChildAlive: () => ({ alive: true, exitCode: null }),
        holdOwnerWatchMs: 1,
      });
      await expect(waitForHoldOwnerChild('pty_env_timeout')).resolves.toBeNull();
      expect(records.filter(({ event }) => event === 'hold-owner-watch-start')).toEqual([
        { event: 'hold-owner-watch-start', data: expect.objectContaining({ ptyId: 'pty_env_timeout', timeoutMs: 20, source: 'env' }) },
      ]);
      expect(records.filter(({ event }) => event === 'hold-owner-watch-timeout')).toEqual([
        { event: 'hold-owner-watch-timeout', data: expect.objectContaining({ ptyId: 'pty_env_timeout', timeoutMs: 20 }) },
      ]);
    } finally {
      off();
      setDevLaunchControlTestSeams(undefined);
      if (previousTimeout === undefined) delete process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
      else process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS = previousTimeout;
    }
  }, 5_000);

  test('hold owner child watch gives its test seam precedence over the environment timeout', async () => {
    const { setDevLaunchControlTestSeams, waitForHoldOwnerChild } = await import('./index.js');
    const previousTimeout = process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
    const starts: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({
      name: 'hold-owner-test-seam-timeout-probe',
      emit: (record: { category?: string; event?: string; data?: unknown }) => {
        if (record.category === 'dev-pipeline' && record.event === 'hold-owner-watch-start' && record.data && typeof record.data === 'object') {
          starts.push(record.data as Record<string, unknown>);
        }
      },
    } as never);
    try {
      process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS = '20';
      setDevLaunchControlTestSeams({
        holdOwnerChildAlive: () => ({ alive: true, exitCode: null }),
        holdOwnerWatchMs: 0,
        holdOwnerWatchTimeoutMs: 0,
      });
      await expect(waitForHoldOwnerChild('pty_test_seam')).resolves.toBeNull();
      expect(starts).toEqual([expect.objectContaining({ ptyId: 'pty_test_seam', timeoutMs: 0, source: 'test-seam' })]);
    } finally {
      off();
      setDevLaunchControlTestSeams(undefined);
      if (previousTimeout === undefined) delete process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
      else process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS = previousTimeout;
    }
  }, 5_000);

  test('dev rejects the retired graph authority override', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'dev', '--ask', '/tmp/goal.md', '--graph', 'maybe'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("error: unknown option '--graph'");
    expect(stderr).not.toMatch(/\n\s*at\s+/);
  });

  test('extended dev help retains force-preflight but no graph authority override', () => {
    const extended = help('--help-all');
    expect(extended).not.toContain('--graph <on|off>');
    expect(extended).toContain('--force-preflight');
  });

  test('fails if a formerly accepted option is absent from both help tiers', () => {
    const primary = help('--help');
    const extendedWithoutForce = help('--help-all').replace(/^\s+--force-preflight.*\n/m, '');

    expect(() => assertExistingOptions(primary, extendedWithoutForce)).toThrow(/force-preflight/);
  }, 30_000);
});

describe('file-backed self CLI entrances', () => {
  test('self implement CLI reads --feature-file and passes its contents to the implementation core', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'implement-feature-cli-'));
    const featurePath = join(dir, 'feature.md');
    const feature = 'Implement unique-file-feature; 판정 신호: bun test x';
    await writeFile(featurePath, feature);
    const core = await import('./self-implement/self-implement-cli.js');
    const standalone = await import('./harness/standalone-run-context.js');
    const seen: string[] = [];
    const actual = core.runSelfImplementCliCommand;
    const implement = spyOn(core, 'runSelfImplementCliCommand').mockImplementation((value, opts) => actual(value, opts, {
      executeReroute: async (spec) => {
        seen.push('text' in spec.input ? spec.input.text : '');
        return { result: { runId: 'run-feature-test', stage: 'completed', ok: true } as never, exitCode: 0 };
      },
    }));
    const setup = spyOn(standalone, 'enterStandaloneHarnessRun').mockImplementation(async () => undefined as never);
    const exit = spyOn(process, 'exit').mockImplementation((() => { throw new Error('IMPLEMENT_EXIT'); }) as never);
    try {
      const { program } = await import('./index.js');
      await expect(program.parseAsync(['node', 'elanous', 'self', 'implement', '--feature-file', featurePath, '--json', '--no-supervise']))
        .rejects.toThrow('IMPLEMENT_EXIT');
      expect(seen).toEqual([feature]);
    } finally {
      exit.mockRestore();
      setup.mockRestore();
      implement.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('goal-file reads two goals without swallowing positional goals; feature-file accepts a path', async () => {
    const { program } = require('./index.js') as typeof import('./index.js');
    const self = program.commands.find((command) => command.name() === 'self')!;
    const orchestrate = self.commands.find((command) => command.name() === 'orchestrate')!;
    const implement = self.commands.find((command) => command.name() === 'implement')!;
    expect(orchestrate.parseOptions(['positional goal', '--goal-file', 'a.md', '--goal-file', 'b.md']).operands).toEqual(['positional goal']);
    expect(orchestrate.opts().goalFile).toEqual(['a.md', 'b.md']);
    expect(implement.parseOptions(['--feature-file', 'feature.txt']).operands).toEqual([]);
    expect(implement.opts().featureFile).toBe('feature.txt');
    const dir = mkdtempSync(join(tmpdir(), 'orchestrate-input-'));
    try {
      const a = join(dir, 'a.md');
      const b = join(dir, 'b.md');
      writeFileSync(a, 'first;;goal');
      writeFileSync(b, 'second goal');
      expect(readSelfOrchestrateGoals(['positional goal'], [a, b])).toEqual({
        request: 'positional goal first;;goal second goal',
        goals: ['positional goal', 'first;;goal', 'second goal'],
      });
      expect(readSelfOrchestrateGoals(['positional goal'])).toEqual({ request: 'positional goal', goals: ['positional goal'] });
      expect(() => readSelfOrchestrateGoals([], [join(dir, 'missing.md')])).toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('orchestrate CLI entrances wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const selfStart = source.indexOf(".command('orchestrate [goals...]')");
  const harnessStart = source.indexOf(".command('orchestrate <goals...>')");
  const selfCommand = source.slice(selfStart, source.indexOf('\n  });', selfStart) + 6);
  const harnessCommand = source.slice(harnessStart, source.indexOf('\n  });', harnessStart) + 6);

  test('both entrances directly invoke the shared execution seam once without recursive parsing', () => {
    expect(selfStart).toBeGreaterThanOrEqual(0);
    expect(harnessStart).toBeGreaterThanOrEqual(0);
    const harnessExecution = source.slice(source.indexOf('export async function runHarnessOrchestrateExecution'), source.indexOf('function registerHarnessOrchestrateCapabilityOptions'));
    expect(selfCommand.match(/runSelfOrchestrateCliCommand\(/g)).toHaveLength(1);
    expect(harnessCommand.match(/runHarnessOrchestrateExecution\(plan, parts\)/g)).toHaveLength(1);
    expect(harnessExecution.match(/runSelfOrchestrateCliCommand\(/g)).toHaveLength(1);
    expect(harnessCommand).not.toContain('orchestrateHarness');
    expect(harnessCommand).not.toContain('parseAsync');
  });

  // ⛔⭐ 이 시험은 한때 «옵션이 살아 있나»를 «소스 조각»에서 물었고, 그래서 «틀린 자리»를 보고 있었다.
  //   📏 실측 2026-08-21: `--help` 접기(#10857) 이후 확장 티어 옵션은 이 명령 체인에 «인라인으로 없다».
  //     그런데 옵션은 «살아 있다» — `--help-all` 이 14개를 전부 내고, 실제로 넘기면 받는다.
  //   ⇒ 그 계약은 위 `self orchestrate CLI help tiers` 가 ***행동으로*** 물고 있으므로 여기서 중복하지 않는다.
  //   🔑 소스만 답할 수 있는 것 = ***인자 해석의 기본값 매핑***. 이 시험은 그것만 남긴다.
  test('self entrance keeps its argument default mapping (option survival is owned by the help-tier behavior tests above)', () => {
    expect(selfCommand).toContain('Number(opts.concurrency) || 2');
    expect(selfCommand).toContain('maxTasks: opts.maxTasks');
    expect(selfCommand).toContain('Number(opts.superviseRounds) || 3');
  });

  // ⛔⭐ 종전 이 시험은 «틀린 목적지»를 계약으로 잠그고 있었다.
  //   📏 실측 2026-08-21: 안내가 `elanous self orchestrate` 를 가리켰는데 «그쪽도» --domain 을 안 받는다
  //     (`error: unknown option '--domain'` · exit 1) ⇒ 사람을 «막다른 곳»으로 보냈다.
  //   ⇒ `--domain` 의 진짜 집은 NL 표면의 `RunDevHarness` 툴이고 CLI 어디에도 «없다».
  //   🔑 그래서 이 시험은 「무엇을 가리키나」가 아니라 ***「가리킨 곳이 실제로 받나」***를 기준으로 쓴다.
  test('harness rejects --domain and names a destination that «actually» accepts it', () => {
    expect(harnessCommand).toContain('opts.domain !== undefined');
    // ⛔ CLI 명령을 목적지로 대지 않는다 — 어느 CLI 도 --domain 을 받지 않는다.
    expect(harnessCommand).not.toContain('`elanous self orchestrate`를 사용하십시오');
    // ✅ 실제로 그 축을 갖는 표면을 이름으로 댄다.
    expect(harnessCommand).toContain('RunDevHarness');
  });
});

describe('harness browser-act CLI wiring', () => {
  test('unarmed CLI path returns the guard result before its executor is invoked', async () => {
    let executorCalls = 0;
    const result = await runHarnessBrowserAction('https://example.test', '#save', {}, {
      execute: async () => { executorCalls += 1; return { x: 1, y: 1 }; },
    });

    expect(result).toEqual({ ok: false, url: 'https://example.test', target: '#save', reason: 'unarmed' });
    expect(executorCalls).toBe(0);
  });

  test('both performBrowserAction paths supply the searchable harness browser-act entry point', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("performBrowserAction({ url, target, armed: false, entryPoint }, deps)");
    // 🔬 2026-08-30(37차): 이 줄에 «탐침 귀속»이 한 줄 끼었다 — 그 «전달»이 끊기면 여기가 문다.
    expect(source).toContain("...(opts.probe === true ? { probe: true } : {}),");
    expect(source).toContain("...(persona === undefined ? {} : { persona }) }, {");
    expect(source).toContain("const HARNESS_BROWSER_ACT_ENTRY_POINT = 'src/index.ts:harness browser-act';");
  });

  test('armed CLI attribution is named by default and preserves caller attribution overrides', async () => {
    const defaultEvents: Array<Record<string, unknown>> = [];
    const overrideEvents: Array<Record<string, unknown>> = [];
    const makeDeps = (events: Array<Record<string, unknown>>) => ({
      connect: async () => {
        const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
        return {
          port: 9222, pid: -1, isAlive: true,
          async navigate() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
            return { frameId: 'frame', loaderId: 'loader' };
          },
          async evaluate() { return { x: 120, y: 80, kind: 'navigation' as const }; },
          async setScriptExecutionDisabled() {},
          async click() {
            const listener = listeners.get('Page.lifecycleEvent');
            listener?.({ method: 'Page.lifecycleEvent', params: { name: 'init', frameId: 'frame', loaderId: 'clicked-loader' } });
            listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'clicked-loader' } });
          }, async screenshot() { return Buffer.alloc(0); }, async close() {},
          on(method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) {
            listeners.set(method, listener);
            return () => listeners.delete(method);
          },
        };
      },
      saveAttachment: async () => ({ ok: false as const, reason: 'empty' as const }),
      observe: (_event: string, data: Record<string, unknown>) => events.push(data),
      getRunId: () => null,
    });

    const defaultArmed = await runHarnessBrowserAction('https://example.test', '#save', { armed: true }, makeDeps(defaultEvents));
    const overrideArmed = await runHarnessBrowserAction('https://example.test', '#save', { armed: true, entryPoint: 'caller/browser-act' }, makeDeps(overrideEvents));

    expect(defaultArmed.ok).toBe(true);
    expect(defaultEvents).toEqual([expect.objectContaining({
      attribution: { kind: 'entry-point', entryPoint: 'src/index.ts:harness browser-act' },
    })]);
    expect(overrideArmed.ok).toBe(true);
    expect(overrideEvents).toEqual([expect.objectContaining({
      attribution: { kind: 'entry-point', entryPoint: 'caller/browser-act' },
    })]);
  });

  test('unknown persona fails loudly instead of silently using the default residence', async () => {
    // ⛔⭐ 조용히 기본 거처로 흘러가면 「봇 X 를 몰았다」고 «믿으면서» 다른 브라우저를 몬 것이 되고,
    //    산출이 ok:true 라 아무도 못 본다. 32차 실물에서 실제로 그렇게 «성공»이 떴다.
    const dir = await mkdtemp(join(tmpdir(), 'browser-act-persona-missing-'));
    let connectCalls = 0;
    try {
      setGlobalPersonaRegistryDir(dir);
      const result = await runHarnessBrowserAction('https://example.test', '#save', { armed: true, persona: 'no-such-bot' }, {
        connect: async () => { connectCalls += 1; throw new Error('should not connect'); },
      });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: 'execution-failed' });
      const error = String((result as { error?: string }).error);
      expect(error).toContain('no-such-bot');
      expect(error).toContain(`scanned: ${dir}`);
      expect(error).toContain('found personaIds:');
      // ⛔ 「거부했다」가 아니라 ***「붙지도 않았다」***를 문다 — 기본 거처로 «갔다가» 실패한 것과 갈린다
      expect(connectCalls).toBe(0);
    } finally {
      _resetGlobalPersonaRegistryForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('selected persona routes the existing CLI caller to its declared browserPort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-act-persona-'));
    try {
      await writeFile(join(dir, 'remote.yaml'), 'personaId: remote\ndisplayName: Remote\nbrowserPort: 9333\n');
      _resetGlobalPersonaRegistryForTest();
      setGlobalPersonaRegistryDir(dir);
      const ports: Array<number | undefined> = [];
      const result = await runHarnessBrowserAction('https://example.test', '#save', { armed: true, persona: 'remote', port: '9223' }, {
        connect: async (port) => {
          ports.push(port);
          const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
          return {
            port: port ?? 9222,
            pid: -1,
            isAlive: true,
            async navigate() {
              listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
              return { frameId: 'frame', loaderId: 'loader' };
            },
            async evaluate() { return { x: 120, y: 80, kind: 'navigation' as const }; },
            async setScriptExecutionDisabled() {},
            async click() {
              listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
            },
            async screenshot() { return Buffer.alloc(0); },
            async close() {},
            on(method, listener) {
              listeners.set(method, listener);
              return () => listeners.delete(method);
            },
          };
        },
        saveAttachment: async () => ({ ok: false, reason: 'empty' as const }),
      });

      expect(result.ok).toBe(true);
      expect(ports).toEqual([9333]);
    } finally {
      _resetGlobalPersonaRegistryForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('armed CLI seam reaches the default CDP click path', async () => {
    const expressions: string[] = [];
    const closeCalls = { value: 0 };
    const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
    const result = await runHarnessBrowserAction('https://example.test', '#save', { armed: true }, {
      connect: async () => ({
        port: 9222,
        pid: -1,
        isAlive: true,
        async navigate() {
          listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
          return { frameId: 'frame', loaderId: 'loader' };
        },
        async evaluate(expression) { expressions.push(expression); return { x: 120, y: 80, kind: 'navigation' as const }; },
        async setScriptExecutionDisabled() {},
        async click() {
          listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
        },
        async screenshot() { return Buffer.alloc(0); },
        async close() { closeCalls.value += 1; },
        on(method, listener) {
          listeners.set(method, listener);
          return () => listeners.delete(method);
        },
      }),
      saveAttachment: async () => ({ ok: false, reason: 'empty' as const }),
    });

    expect(result).toEqual({
      ok: true,
      url: 'https://example.test',
      target: '#save',
      // 🪞⛔ 이 단언은 «늙어 있었다»(2026-08-30 · 37차가 다른 일로 이 파일을 열다 발견).
      //    착지 관측 세 칸(clickedHref · landedUrl · landingVerdict)이 뒤에 붙었는데 여기를 안 고쳤다
      //    ⇒ 이 시험은 ***내 변경과 무관하게 이미 빨갰다***. 「늘 빨간 검사」는 늘 초록인 검사와 같은 병이다.
      //    ⛔ 값을 「대충 맞추지」 않는다 — 이 심은 이동을 «시켰지만» 착지를 못 쟀으므로 `unmeasured` 가 맞다.
      observed: {
        coordinates: { x: 120, y: 80 }, captureOutcome: 'not-saved',
        clickedHref: null, landedUrl: null, landingVerdict: 'unmeasured',
      },
    });
    // 🪞 여기도 «늙어 있었다» — 착지 관측이 붙으며 평가가 «둘»이 됐는데 수는 1 그대로였다.
    //    ⛔ 수만 2 로 고치지 «않는다» — 그러면 셋째가 붙는 날 또 늙는다.
    //    ⇒ 🔑 이 시험이 «정말로» 묻는 것을 적는다: ***클릭은 좌표로 하고 element.click() 으로 하지 않는다.***
    expect(expressions.length).toBeGreaterThanOrEqual(1);
    expect(expressions[0]).toContain('document.querySelector("#save")');
    expect(expressions.some((e) => e.includes('element.click()'))).toBe(false);
    expect(closeCalls.value).toBe(1);
  });

  /**
   * 🔬⭐⭐ **탐침 귀속**(2026-08-30 · 37차 · RFC §23b-4 의 `P3`)
   *
   * 🚨 이것이 없던 동안 ***카나리아 탐침이 봇으로 «행세»했다*** — kind=bot · 같은 entryPoint.
   *    📏 실측: newsbot 궤적 104걸음 중 87 이 탐침이었다(84%).
   * ⛔ 그리고 이것은 «면제»가 아니다 — 아래 마지막 시험이 그것을 문다.
   */
  test('🔬 --probe 는 귀속을 probe 로 바꾼다 — persona 가 있어도 bot 으로 접히지 않는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const deps = {
      connect: async () => {
        const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
        return {
          port: 9222, pid: -1, isAlive: true,
          async navigate() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
            return { frameId: 'frame', loaderId: 'loader' };
          },
          async evaluate() { return { x: 1, y: 2, kind: 'navigation' as const }; },
          async setScriptExecutionDisabled() {},
          async click() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
          },
          async screenshot() { return Buffer.alloc(0); }, async close() {},
          on(method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) {
            listeners.set(method, listener); return () => listeners.delete(method);
          },
        };
      },
      saveAttachment: async () => ({ ok: false as const, reason: 'empty' as const }),
      observe: (_event: string, data: Record<string, unknown>) => events.push(data),
      getRunId: () => null,
    };

    const r = await runHarnessBrowserAction('https://example.test', 'a', { armed: true, probe: true }, deps);
    expect(r.ok).toBe(true);
    expect(events[0]).toMatchObject({ attribution: { kind: 'probe' } });
  });

  test('🔬 ⛔ 탐침이 «런보다도» 앞선다 — 뒤에 두면 다시 접혀 행세가 남는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const deps = {
      connect: async () => {
        const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
        return {
          port: 9222, pid: -1, isAlive: true,
          async navigate() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
            return { frameId: 'frame', loaderId: 'loader' };
          },
          async evaluate() { return { x: 1, y: 2, kind: 'navigation' as const }; },
          async setScriptExecutionDisabled() {},
          async click() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
          },
          async screenshot() { return Buffer.alloc(0); }, async close() {},
          on(method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) {
            listeners.set(method, listener); return () => listeners.delete(method);
          },
        };
      },
      saveAttachment: async () => ({ ok: false as const, reason: 'empty' as const }),
      observe: (_event: string, data: Record<string, unknown>) => events.push(data),
      getRunId: () => 'run-1',
    };
    await runHarnessBrowserAction('https://example.test', 'a', { armed: true, probe: true }, deps);
    expect(events[0]).toMatchObject({ attribution: { kind: 'probe' } });
  });

  test('🔬 ⛔ --probe 를 «안 주면» 귀속이 안 바뀐다 — 이 플래그는 스스로 켜지지 않는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const deps = {
      connect: async () => {
        const listeners = new Map<string, (event: { method: string; params: Record<string, unknown> }) => void>();
        return {
          port: 9222, pid: -1, isAlive: true,
          async navigate() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
            return { frameId: 'frame', loaderId: 'loader' };
          },
          async evaluate() { return { x: 1, y: 2, kind: 'navigation' as const }; },
          async setScriptExecutionDisabled() {},
          async click() {
            listeners.get('Page.lifecycleEvent')?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
          },
          async screenshot() { return Buffer.alloc(0); }, async close() {},
          on(method: string, listener: (event: { method: string; params: Record<string, unknown> }) => void) {
            listeners.set(method, listener); return () => listeners.delete(method);
          },
        };
      },
      saveAttachment: async () => ({ ok: false as const, reason: 'empty' as const }),
      observe: (_event: string, data: Record<string, unknown>) => events.push(data),
      getRunId: () => null,
    };
    await runHarnessBrowserAction('https://example.test', 'a', { armed: true }, deps);
    expect(events[0]).toMatchObject({ attribution: { kind: 'entry-point' } });
  });

  // 🔬🪞 **「탐침은 면제가 아니다」는 여기서 «옮겨 갔다»** — 2026-08-30 자기 리뷰(`#14158`)가
  //    *「소스 400자 조각 검사일 뿐 실제 동작이 아니다」*라고 짚었고 맞다.
  //    ⇒ 이제 `src/harness/browser-act.test.ts` 가 ***행동으로*** 문다(경계 밖 refused · 경계 안 ok ·
  //      ⭐ probe «없이»와 «같은» 결과인지까지). ⛔ 약한 중복 검사를 남겨 두면 거짓 안심을 만든다.

  test('actual Commander browser-act entrance emits the unarmed structured refusal', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, new URL('../bin/elanous.mjs', import.meta.url).pathname, '--test', 'harness', 'browser-act', 'https://example.test', '#save'],
      cwd: new URL('../', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(JSON.stringify({
      ok: false,
      url: 'https://example.test',
      target: '#save',
      reason: 'unarmed',
    }));
  });
});

describe('harness orchestrate canonical entrance capability', () => {
  const elanous = new URL('../bin/elanous.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const promotedHarnessOptions = ['--auto-merge', '--auto-review', '--open-pr', '--base', '--decompose'] as const;
  const excludedHarnessOptions = ['--fabric-decompose', '--max-tasks'] as const;
  const expectedHarnessRootEntrances = [
    'ask',
    // 💰 예산 입구 — `harness budget`(뿌리 입구에 새로 섰다 · 기대 목록이 따라오지 않아 main 이 결정적으로 빨갛던 자리 · 🅞 09-27 분석).
    'budget',
    'browser-act',
    // ⌨️ 타이핑 «판정» 입구 — 판정기 decideTypeAction 의 CLI 표면(키를 보내지 않는다).
    'browser-type',
    'clean',
    'deliverable-verify',
    // 🧹 draft PR 정리 — `harness drafts`(installHarnessDraftSweepCommand).
    'drafts',
    'incidents',
    'map',
    'mission',
    'orchestrate',
    'plan',
    'processes',
    'replay',
    'say',
    // 🛑 런 정지 — `harness stop <runId>`(stopHarnessRun).
    'stop',
    'trajectory',
    'terminals-purge',
    'verify-url',
    'worktree',
    'worktrees',
  ] as const;

  function help(entrance: readonly string[], ...args: string[]): { text: string; exitCode: number } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', ...entrance, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? 1,
      text: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
    };
  }

  test.each([
    ['--auto-merge', { autoMerge: true as const }],
    ['--open-pr', { openPr: true as const }],
    ['--base', 'origin/main', { base: 'origin/main' as const }],
  ])('canonical entrance puts promoted self-compatible option %s onto the execution plan', (...args: readonly unknown[]) => {
    const flags = args.slice(0, -1) as string[];
    const expected = args[args.length - 1] as Record<string, unknown>;
    const opts: Record<string, unknown> = {};
    if (flags[0] === '--auto-merge') opts.autoMerge = true;
    if (flags[0] === '--open-pr') opts.openPr = true;
    if (flags[0] === '--base') opts.base = flags[1];
    const plan = buildHarnessOrchestratePlan(['goal-a'], opts);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const [key, value] of Object.entries(expected)) {
      expect(plan).toHaveProperty(key, value);
      expect(plan.goals[0]).toHaveProperty(key, value);
      expect(plan.spec.parallel.goals[0]).toHaveProperty(key, value);
    }
  });

  test('canonical orchestrate plan assembles its registry entrance into the returned spec', () => {
    const plan = buildHarnessOrchestratePlan(['goal-a', 'goal-b'], {
      concurrency: '3',
      json: true,
    });
    expect(plan).toMatchObject({
      ok: true,
      concurrency: 3,
      json: true,
      goals: [{ feature: 'goal-a' }, { feature: 'goal-b' }],
      spec: {
        entrance: 'cli-harness-orchestrate',
        parallel: {
          concurrency: 3,
          goals: [{ feature: 'goal-a' }, { feature: 'goal-b' }],
        },
      },
    });
    expect(plan).not.toHaveProperty('autoMerge');
    expect(plan).not.toHaveProperty('openPr');
    expect(plan).not.toHaveProperty('base');
  });

  test('canonical entrance still rejects --domain by name', () => {
    const plan = buildHarnessOrchestratePlan(['goal-a'], { domain: 'web' });
    expect(plan).toMatchObject({ ok: false, exitCode: 2 });
    if (plan.ok) return;
    expect(plan.error).toContain('--domain');
    expect(plan.error).toContain('RunDevHarness');
    const result = Bun.spawnSync({
      cmd: [process.execPath, elanous, '--test', 'harness', 'orchestrate', 'goal-a', '--domain', 'web'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    expect(result.exitCode).toBe(2);
    expect(output).toContain('--domain');
    expect(output).toContain('RunDevHarness');
  });

  test('canonical entrance parses the command line once', () => {
    const harnessStart = source.indexOf(".command('orchestrate <goals...>')");
    const harnessCommand = source.slice(harnessStart, source.indexOf('\n  });', harnessStart) + 6);
    expect(harnessCommand.match(/runHarnessOrchestrateExecution\(plan, parts\)/g)).toHaveLength(1);
    expect(harnessCommand).not.toContain('parseAsync');
    expect(source.slice(harnessStart, source.indexOf("program.command('self')", harnessStart)).match(/\.hook\(/g) ?? []).toHaveLength(0);
  });

  test('canonical entrance persists run lifecycle through the real run-store format before invoking the shared execution seam', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elanous-harness-run-store-'));
    try {
      const plan = buildHarnessOrchestratePlan(['goal-a'], { concurrency: '4' });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const runInputs: unknown[] = [];
      const deps: HarnessOrchestrateExecutionDeps = {
        prepareGoals: async ({ goals }) => ({ ok: true, goals: [{ id: 'g1', feature: goals[0]!.feature, dependsOn: ['root'] }] }),
        loadRun: (runId) => loadSelfDevRun(runId, dir),
        checkpointDependencies: checkpointDependenciesForRun,
        resolveRunIdentity: () => ({ runId: 'harness-run-1', source: 'minted' }),
        harnessRunIdEnv: 'TEST_RUN_ID',
        setEnv: () => {},
        now: () => 1000,
        pid: 4242,
        saveRun: (state) => saveSelfDevRun(state, dir),
        addParticipant: (runId, participant) => addSelfDevRunParticipant(runId, participant, dir),
        resolveStart: (input) => ({ concurrency: input.explicit, announcement: `start ${input.runId}` }),
        runCommand: async (input) => {
          runInputs.push(input);
          const preExecution = loadSelfDevRun('harness-run-1', dir);
          expect(preExecution).toMatchObject({
            runId: 'harness-run-1',
            createdAt: 1000,
            results: [],
            dependencies: { g1: ['root'] },
            goals: [{ id: 'g1', feature: 'goal-a', dependsOn: ['root'] }],
            participants: [{ id: 'process:4242', kind: 'process', transports: [], runIdSource: 'minted' }],
            pid: 4242,
          });
          input.runtime.checkpoint?.([{ taskId: 't1', feature: 'goal-a', status: 'done' }]);
          return { ok: true, results: [{ taskId: 't1', feature: 'goal-a', status: 'done' }], exitCode: 0 };
        },
        writeInfo: () => {},
        writeError: () => {},
        writeOutput: () => {},
      };

      await runHarnessOrchestrateExecution(plan, ['goal-a'], deps);

      const persisted = loadSelfDevRun('harness-run-1', dir);
      expect(persisted).toMatchObject({
        runId: 'harness-run-1',
        createdAt: 1000,
        results: [{ taskId: 't1', feature: 'goal-a', status: 'done' }],
        dependencies: { g1: ['root'] },
        goals: [{ id: 'g1', feature: 'goal-a', dependsOn: ['root'] }],
        participants: [{ id: 'process:4242', kind: 'process', transports: [], runIdSource: 'minted' }],
        pid: 4242,
      });
      expect(runInputs).toHaveLength(1);
      expect(runInputs[0]).toMatchObject({ goals: [{ id: 'g1', feature: 'goal-a', dependsOn: ['root'] }], concurrency: 4 });
      expect((runInputs[0] as { runtime: { checkpoint?: unknown } }).runtime.checkpoint).toBeFunction();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('canonical entrance restores resume goals from real run-store and uses the shared resume classifier for start metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elanous-harness-resume-store-'));
    try {
      const plan = buildHarnessOrchestratePlan(['ignored'], { resume: 'prior-run' });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const startInputs: unknown[] = [];
      const runInputs: unknown[] = [];
      const prior: SelfDevRunState = {
        runId: 'prior-run',
        createdAt: 700,
        updatedAt: 800,
        results: [
          { taskId: 'old-1', feature: 'done', status: 'done', stage: 'merged', merged: true },
          { taskId: 'old-2', feature: 'retry', status: 'done', stage: 'gate-failed', merged: false },
        ],
        dependencies: { resumed: ['upstream'] },
        goals: [{ id: 'resumed', feature: 'resume-goal', dependsOn: ['upstream'] }],
        pid: 77,
      };
      saveSelfDevRun(prior, dir);
      await runHarnessOrchestrateExecution(plan, ['ignored'], {
        prepareGoals: async ({ goals }) => ({ ok: true, goals }),
        loadRun: (runId) => loadSelfDevRun(runId, dir),
        saveRun: (state) => saveSelfDevRun(state, dir),
        addParticipant: (runId, participant) => addSelfDevRunParticipant(runId, participant, dir),
        checkpointDependencies: checkpointDependenciesForRun,
        resolveRunIdentity: ({ explicit }) => ({ runId: explicit ?? 'missing', source: 'explicit' }),
        resolveStart: (input) => { startInputs.push(input); return { concurrency: input.explicit, announcement: 'resume start' }; },
        runCommand: async (input) => { runInputs.push(input); return { ok: true, results: [{ taskId: 'new-1', feature: 'resume-goal', status: 'done' }], exitCode: 0 }; },
        writeInfo: () => {},
        writeError: () => {},
        writeOutput: () => {},
        now: () => 900,
        pid: 77,
        setEnv: () => {},
      });

      expect(startInputs[0]).toMatchObject({ runId: 'prior-run', resume: { skipped: 1, rerun: 1 } });
      expect(runInputs[0]).toMatchObject({ goals: [{ id: 'resumed', feature: 'resume-goal', dependsOn: ['upstream'] }], runtime: { resumeFrom: prior.results } });
      expect(loadSelfDevRun('prior-run', dir)).toMatchObject({
        runId: 'prior-run',
        createdAt: 700,
        dependencies: { resumed: ['upstream'] },
        goals: [{ id: 'resumed', feature: 'resume-goal', dependsOn: ['upstream'] }],
        participants: [{ id: 'process:77', kind: 'process', transports: [], runIdSource: 'explicit' }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('canonical entrance keeps persistence failures non-fatal and explicit in json mode', async () => {
    const plan = buildHarnessOrchestratePlan(['goal-a'], { json: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const errors: string[] = [];
    const outputs: string[] = [];
    const diagnostics: unknown[] = [];
    let executed = false;
    await runHarnessOrchestrateExecution(plan, ['goal-a'], {
      prepareGoals: async ({ goals }) => ({ ok: true, goals }),
      loadRun: () => null,
      saveRun: () => { throw new Error('checkpoint denied'); },
      addParticipant: () => { throw new Error('participant denied'); },
      checkpointDependencies: () => ({ 'goal-a': [] }),
      resolveRunIdentity: () => ({ runId: 'json-run', source: 'minted' }),
      runCommand: async () => { executed = true; return { ok: true, results: [{ taskId: 't1', feature: 'goal-a', status: 'done' }], exitCode: 0 }; },
      writeError: (message) => errors.push(message),
      writeOutput: (message) => outputs.push(message),
      writeInfo: () => {},
      onPersistenceDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setEnv: () => {},
    });

    expect(executed).toBe(true);
    expect(errors).toEqual([
      '[self-dev] ⚠️ run checkpoint 저장 실패(non-fatal): checkpoint denied',
      '[self-dev] ⚠️ run participant 저장 실패(non-fatal): participant denied',
    ]);
    expect(diagnostics).toEqual([
      { stage: 'checkpoint', error: 'checkpoint denied' },
      { stage: 'participant', error: 'participant denied' },
    ]);
    expect(outputs).toEqual([JSON.stringify({
      results: [{ taskId: 't1', feature: 'goal-a', status: 'done' }],
      persistenceDiagnostics: [
        { stage: 'checkpoint', error: 'checkpoint denied' },
        { stage: 'participant', error: 'participant denied' },
      ],
    })]);
  });

  test('self와 harness orchestrate는 원장 기록을 공용 bindOrchestrateRunLedger로만 조립한다', () => {
    const selfStart = source.indexOf(".command('orchestrate [goals...]')");
    const selfSeam = source.indexOf('const outcome = await runSelfOrchestrateCliCommand({', selfStart);
    const beforeSelfSeam = source.slice(selfStart, selfSeam);
    const harnessExecution = source.slice(source.indexOf('export async function runHarnessOrchestrateExecution'), source.indexOf('function registerHarnessOrchestrateCapabilityOptions'));
    const runtimeSource = readFileSync(join(import.meta.dir, 'self-dev', 'self-orchestrate-runtime.ts'), 'utf-8');

    expect(runtimeSource.match(/export function bindOrchestrateRunLedger\(/g)).toHaveLength(1);
    expect(source.match(/bindOrchestrateRunLedger\(/g)).toHaveLength(2);
    expect(beforeSelfSeam.match(/bindOrchestrateRunLedger\(/g)).toHaveLength(1);
    expect(harnessExecution.match(/bindOrchestrateRunLedger\(/g)).toHaveLength(1);
    expect(beforeSelfSeam).not.toMatch(/const checkpoint = \(rs: any\[\]\): void => saveSelfDevRun/);
    expect(harnessExecution).not.toMatch(/const checkpoint = \(results: HarnessOrchestrateRunResult\[\]\): void =>/);
    expect(beforeSelfSeam).toContain('checkpoint,');
    expect(harnessExecution).toContain('runtime.checkpoint = checkpoint');
  });

  test('primary help exposes only the promoted harness orchestrate options from the self-only gap', () => {
    const optionLines = (text: string): number => text.split('\n').filter((line) => /^\s+-{1,2}[\w-]+/.test(line)).length;
    const harnessPrimary = help(['harness', 'orchestrate'], '--help');
    const harnessAll = help(['harness', 'orchestrate'], '--help-all');
    const selfPrimary = help(['self', 'orchestrate'], '--help');
    const selfAll = help(['self', 'orchestrate'], '--help-all');
    expect(harnessPrimary.exitCode).toBe(0);
    expect(harnessAll.exitCode).toBe(0);
    expect(selfPrimary.exitCode).toBe(0);
    expect(selfAll.exitCode).toBe(0);
    expect(optionLines(harnessPrimary.text)).toBeLessThan(optionLines(harnessAll.text));
    expect(optionLines(selfPrimary.text)).toBeLessThan(optionLines(selfAll.text));
    for (const flag of promotedHarnessOptions) {
      expect(harnessPrimary.text).toContain(flag);
    }
    for (const flag of excludedHarnessOptions) {
      expect(harnessPrimary.text).not.toContain(flag);
      expect(harnessAll.text).not.toContain(flag);
    }
    const harnessRoot = help(['harness'], '--help');
    expect(harnessRoot.exitCode).toBe(0);
    const rootEntrances = harnessRoot.text
      .split('\n')
      .map((line) => /^\s{2}([\w-]+)(?:\s|$)/.exec(line)?.[1])
      .filter((entry): entry is string => entry !== undefined)
      .filter((entry) => entry !== 'help')
      .sort();
    expect(rootEntrances).toEqual([...expectedHarnessRootEntrances].sort());
    expect(harnessPrimary.text).not.toContain('browser-act');
    expect(harnessAll.text).not.toContain('browser-act');
  }, 20_000);

  test('fails if promoted harness options fall off the canonical execution plan', () => {
    const plan = buildHarnessOrchestratePlan(['goal-a'], { autoMerge: true, openPr: true, base: 'main' });
    const stripped = { ...plan, autoMerge: undefined, openPr: undefined, base: undefined };
    expect(plan.ok).toBe(true);
    expect(stripped.autoMerge).toBeUndefined();
    expect(plan).toMatchObject({ autoMerge: true, openPr: true, base: 'main' });
  });

  test('excluded option names remain on self orchestrate but are rejected by harness orchestrate', () => {
    const selfAll = help(['self', 'orchestrate'], '--help-all');
    expect(selfAll.exitCode).toBe(0);
    for (const flag of [...promotedHarnessOptions, ...excludedHarnessOptions]) {
      expect(selfAll.text).toContain(flag);
    }
    for (const flag of excludedHarnessOptions) {
      const result = help(['harness', 'orchestrate'], 'goal-a', flag);
      expect(result.exitCode).not.toBe(0);
      expect(result.text).toContain(`unknown option '${flag}'`);
    }
  }, 20_000);
});

describe('self orchestrate CLI deliverable wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  function orchestrateCommandInput(text: string): string {
    const start = text.indexOf('const outcome = await runSelfOrchestrateCliCommand({', text.indexOf(".command('orchestrate [goals...]')"));
    const end = text.indexOf('      });', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  function assertDeliverableWiring(text: string): void {
    const input = orchestrateCommandInput(text);

    expect(input).toContain('...(parentRequest === undefined ? {} : { parentRequest }),');
    expect(input).toContain('...(deliverable === undefined ? {} : { deliverable }),');
    expect(input).toContain('runtime,');
    const commandStart = text.indexOf('let deliverable:', text.indexOf(".command('orchestrate [goals...]')"));
    const commandEnd = text.indexOf('const outcome = await runSelfOrchestrateCliCommand({', commandStart);
    const command = text.slice(commandStart, commandEnd);
    expect(command).toContain("await import('./self-implement/goal-author.js')");
    expect(command).toContain("goalTitle: 'SelfOrchestrate deliverable'");
    expect(command).toContain('goalPath: authored.path');
  }

  test('forwards the decomposed raw request as a separately attributed deliverable', () => {
    assertDeliverableWiring(source);
  });

  test('omits deliverable with parentRequest for non-decomposition calls', () => {
    const withoutDecomposition = source.replace(
      '...(deliverable === undefined ? {} : { deliverable }),',
      '',
    );

    expect(() => assertDeliverableWiring(withoutDecomposition)).toThrow();
  });

  test('does not repurpose either output-type --deliverable option', () => {
    const outputTypeOptions = [...source.matchAll(/\.option\('--deliverable(?:\s|<)/g)];
    expect(outputTypeOptions).toHaveLength(2);
    expect(orchestrateCommandInput(source)).not.toContain(".option('--deliverable");
  });
});

describe('schedule migrate/adopt/release/delete default dry-run', () => {
  for (const action of ['migrate', 'adopt', 'release', 'delete']) {
    test(`${action} does not dispatch without --yes and dispatches once with --yes`, async () => {
      const dispatched: Record<string, unknown>[] = [];
      const exits: number[] = [];
      const output: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        callback?.();
        return true;
      }) as typeof process.stdout.write;
      try {
        const dispatch: ScheduleDispatch = async args => {
          dispatched.push(args);
          return { applied: true };
        };
        await runSchedule(action, { id: 'x', json: true }, dispatch, code => exits.push(code));
        expect(dispatched).toHaveLength(0);
        expect(JSON.parse(output[0])).toEqual({
          dryRun: true, action, id: 'x', note: '적용하려면 --yes 를 붙인다',
        });
        expect(exits).toEqual([0]);

        await runSchedule(action, { id: 'x', json: true, yes: true }, dispatch, code => exits.push(code));
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({ action, id: 'x', yes: true });
        expect(JSON.parse(output[1])).toEqual({ applied: true });
        expect(exits).toEqual([0, 0]);
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  }

  test('list still dispatches without --yes', async () => {
    const dispatched: Record<string, unknown>[] = [];
    const exits: number[] = [];
    await runSchedule('list', { json: true }, async args => {
      dispatched.push(args);
      return { schedules: [] };
    }, code => exits.push(code));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'list' });
    expect(exits).toEqual([0]);
  });
});

describe('schedule create --dry-run --from', () => {
  const specification = 'docs/ops/SPEC-daily-backlog-and-unfinished-runs-sweep-2026-08-10.md';

  test.skipIf(!existsSync(specification))('creates a plan from the private real specification without dispatching registration', async () => {
    let dispatchCalls = 0;
    const dispatch: ScheduleDispatch = async () => {
      dispatchCalls += 1;
      return { error: 'registration must not run during dry-run' };
    };
    const exitCodes: number[] = [];

    await runSchedule('create', { dryRun: true, from: specification, json: true }, dispatch, code => exitCodes.push(code));
    const result = await scheduleCreatePlan({ dryRun: true, from: specification });

    expect(dispatchCalls).toBe(0);
    expect(exitCodes).toEqual([0]);
    expect(result).toMatchObject({
      dryRun: true,
      from: specification,
      plan: {
        schedule: { found: '하루에 정확히 한 번' },
        commands: { found: ['self parked --json', 'self unfinished-runs --all --include-test --json'] },
        resultPath: { found: 'reports/ops/daily-backlog-and-unfinished-runs/YYYY-MM-DD.json' },
        cron: { missing: '명세에 cron 식이 없음' },
      },
    });
  });

  test('refuses registration for every missing required plan field', async () => {
    const completeSpecification = [
      '- **주기:** 매일 한 번.',
      'cron: `0 7 * * *`',
      'bun bin/elanous.mjs self parked --json',
      'reports/ops/complete/YYYY-MM-DD.json',
    ].join('\n');
    const cases = [
      ['schedule', completeSpecification.replace('- **주기:** 매일 한 번.\n', '')],
      ['commands', completeSpecification.replace('bun bin/elanous.mjs self parked --json\n', '')],
      ['resultPath', completeSpecification.replace('reports/ops/complete/YYYY-MM-DD.json', '')],
      ['cron', completeSpecification.replace('cron: `0 7 * * *`\n', '')],
    ] as const;
    const directory = await mkdtemp(join(tmpdir(), 'schedule-spec-'));
    try {
      for (const [missingField, content] of cases) {
        const path = join(directory, `${missingField}.md`);
        await writeFile(path, content);
        const output: string[] = [];
        const exitCodes: number[] = [];
        const write = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
          output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
          callback?.();
          return true;
        }) as typeof process.stdout.write;
        try {
          await runSchedule('create', { from: path, json: true }, async () => {
            throw new Error('registration must not run for an incomplete plan');
          }, code => exitCodes.push(code));
        } finally {
          process.stdout.write = write;
        }

        expect(exitCodes).toEqual([1]);
        expect(JSON.parse(output[0])).toMatchObject({
          error: `명세 등록을 거부했습니다: ${missingField}`,
          plan: { [missingField]: { missing: expect.any(String) } },
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('registers the complete plan values from a specification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schedule-spec-'));
    const path = join(directory, 'complete.md');
    await writeFile(path, [
      '- **주기:** 매일 한 번.',
      'cron: `0 7 * * *`',
      '```sh',
      'bun bin/elanous.mjs self parked --json',
      'bun bin/elanous.mjs self unfinished-runs --all --include-test --json',
      '```',
      'reports/ops/complete/YYYY-MM-DD.json',
    ].join('\n'));
    try {
      const dispatched: Record<string, unknown>[] = [];
      const exitCodes: number[] = [];

      await runSchedule('create', { from: path, json: true }, async args => {
        dispatched.push(args);
        return { created: true };
      }, code => exitCodes.push(code));

      const alternatePath = join(directory, 'alternate.md');
      await writeFile(alternatePath, [
        '- **주기:** 평일마다 한 번.',
        'cron: `0 7 * * *`',
        'bun bin/elanous.mjs self parked --json',
        'bun bin/elanous.mjs self unfinished-runs --all --include-test --json',
        'reports/ops/alternate/YYYY-MM-DD.json',
      ].join('\n'));
      await runSchedule('create', { from: alternatePath, json: true }, async args => {
        dispatched.push(args);
        return { created: true };
      }, code => exitCodes.push(code));

      expect(dispatched).toEqual([
        {
          action: 'create',
          id: undefined,
          category: undefined,
          cron: '0 7 * * *',
          command: 'bun bin/elanous.mjs self parked --json && bun bin/elanous.mjs self unfinished-runs --all --include-test --json',
          schedule: '매일 한 번',
          resultPath: 'reports/ops/complete/YYYY-MM-DD.json',
          yes: true,
        },
        {
          action: 'create',
          id: undefined,
          category: undefined,
          cron: '0 7 * * *',
          command: 'bun bin/elanous.mjs self parked --json && bun bin/elanous.mjs self unfinished-runs --all --include-test --json',
          schedule: '평일마다 한 번',
          resultPath: 'reports/ops/alternate/YYYY-MM-DD.json',
          yes: true,
        },
      ]);
      expect(exitCodes).toEqual([0, 0]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a readable specification that lacks required schedule values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schedule-spec-'));
    const path = join(directory, 'incomplete.md');
    await writeFile(path, '# incomplete\n\nThis document has no schedule details.\n');
    try {
      await expect(scheduleCreatePlan({ dryRun: true, from: path })).resolves.toEqual({
        error: '명세에 등록 계획의 필수 주기 또는 실행 명령이 없음',
        from: path,
        plan: {
          schedule: { missing: '주기' },
          commands: { missing: '실행 명령' },
          resultPath: { missing: '결과 경로' },
          cron: { missing: '명세에 cron 식이 없음' },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps direct cron and command registration unchanged', async () => {
    const dispatched: Record<string, unknown>[] = [];
    const exitCodes: number[] = [];

    await runSchedule('create', { cron: '0 8 * * *', command: 'scripts/direct.ts', json: true }, async args => {
      dispatched.push(args);
      return { created: true };
    }, code => exitCodes.push(code));

    expect(dispatched).toEqual([{
      action: 'create',
      id: undefined,
      category: undefined,
      cron: '0 8 * * *',
      command: 'scripts/direct.ts',
    }]);
    expect(exitCodes).toEqual([0]);
  });

  test('reports a missing --from separately from a missing file', async () => {
    await expect(scheduleCreatePlan({ dryRun: true })).resolves.toEqual({
      error: 'dry-run에는 명세 문서 경로를 --from으로 지정해야 합니다.',
    });
    await expect(scheduleCreatePlan({ dryRun: true, from: 'docs/ops/NO-SUCH-SPEC.md' })).resolves.toEqual({
      error: '명세 문서를 읽을 수 없음: docs/ops/NO-SUCH-SPEC.md',
    });
  });
});

// ⛔⭐ 이 절은 «보조» 검증이다 — 동작 계약(찍은 수 == 넘긴 수 · 해석 1회)은
//   src/self-dev/orchestrate-cli.test.ts 의 resolveOrchestrateStart 시험이 «행동으로» 진다.
//   여기서는 소스만 답할 수 있는 것 둘만 보고, 범위를 «그 액션 블록»으로 엄격히 제한한다
//   (리뷰 지적 2026-08-21: 파일 끝까지 훑는 검색은 «다른 자리의 같은 문자열»로도 통과한다).
describe('self orchestrate 시작 안내 배선 (보조 — 소스만 답할 수 있는 것)', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
  const selfStart = source.indexOf(".command('orchestrate [goals...]')");
  const callSite = source.indexOf('const outcome = await runSelfOrchestrateCliCommand({', selfStart);
  const action = source.slice(selfStart, callSite);
  // 호출 «인자 블록»만 — 파일 끝이 아니라 그 객체 리터럴이 닫히는 곳까지.
  const callArguments = source.slice(callSite, source.indexOf('\n      });', callSite) + 9);

  test('시작 안내가 concurrency 를 «추측»하지 않는다', () => {
    expect(action.length).toBeGreaterThan(0);
    // ⛔ 종전: `동시 ${concurrency ?? 2}` — 명시값이 없으면 엔진이 쓰지도 않는 2 를 찍었다.
    expect(action).not.toContain('concurrency ?? 2');
    expect(action).toContain('resolveOrchestrateStart(');
  });

  test('실행 호출 «인자 블록»이 해석된 값을 그대로 쓴다', () => {
    expect(callArguments.length).toBeGreaterThan(0);
    expect(callArguments).toContain('concurrency: start.concurrency');
  });

  test('CLI 시작 경로에 self-orchestrate 정적 의존을 더하지 않는다', () => {
    expect(source).not.toMatch(/^import .*from '\.\/self-dev\/orchestrate(-cli)?\.js';$/m);
    expect(action).toContain("await import('./self-dev/orchestrate-cli.js')");
  });
});

describe('chat --json finalReply (2026-09-23)', () => {
  // #22316: `reply` became the final answer; the joined text moved to `transcript`.
  test('reply·finalReply 는 «마지막 어시스턴트 메시지»만, transcript 는 모든 조각 — 목표 루프가 최종 답을 반복해도 한 번', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'elanous-cli-final-reply-'));
    const indexModule = new URL('./index.ts', import.meta.url).pathname;
    const configModule = new URL('./user-config.ts', import.meta.url).pathname;
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', `
          import { getUserConfig } from ${JSON.stringify(configModule)};
          const { runChatTurnCli } = await import(${JSON.stringify(indexModule)});
          const cfg = getUserConfig();
          const runTurn = async (r) => {
            r.onDelta('읽겠습니다.');
            r.onToolCall?.({ name: 'Read', args: {} });
            r.onDelta('name=x scripts=3');
            r.onToolCall?.({ name: 'update_goal', args: {} });
            r.onDelta('name=x scripts=3');
            return { provider: 'test', model: 'test' };
          };
          await runChatTurnCli({ cfg, userText: 'q', explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools: true, runTurn });
        `],
        cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: join(cwd, 'state'), ELANOUS_CONFIG_DIR: join(cwd, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      const out = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!) as { reply: string; finalReply: string; transcript: string };
      expect(out.reply).toBe('name=x scripts=3');
      expect(out.finalReply).toBe('name=x scripts=3');
      expect(out.transcript).toBe('읽겠습니다.name=x scripts=3name=x scripts=3');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('CLI universal preamble wiring', () => {
  test('both tool modes pass the project anchor to the production runTurn request, but only tools mode receives session guidance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'elanous-cli-preamble-'));
    const stateDir = join(cwd, 'state');
    const configDir = join(cwd, 'config');
    const anchor = 'CLI_ANCHOR_SENTINEL: use zzq-build --plum-mode';
    const indexModule = new URL('./index.ts', import.meta.url).pathname;
    const configModule = new URL('./user-config.ts', import.meta.url).pathname;
    try {
      await writeFile(join(cwd, 'AGENTS.md'), anchor);
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', `
          import { getUserConfig } from ${JSON.stringify(configModule)};
          const { runChatTurnCli } = await import(${JSON.stringify(indexModule)});
          const cfg = getUserConfig();
          cfg.chat.toolDeny = [];
          const requests = [];
          const runTurn = async (request) => {
            requests.push({
              systemPrompt: request.systemPrompt,
              toolCount: request.tools?.length ?? 0,
            });
            return { provider: 'test', model: 'test' };
          };
          for (const enableTools of [false, true]) {
            await runChatTurnCli({
              cfg, userText: 'which build command?', explicitSessionId: undefined,
              reuseActive: false, forceNew: true, json: true, enableTools, runTurn,
            });
          }
          console.log(JSON.stringify(requests));
        `],
        cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      const requests = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!) as Array<{
        systemPrompt?: string;
        toolCount: number;
      }>;
      expect(requests).toHaveLength(2);
      const [withoutTools, withTools] = requests;
      expect(withoutTools!.systemPrompt).toContain(anchor);
      expect(withTools!.systemPrompt).toContain(anchor);
      expect(withoutTools!.toolCount).toBe(0);
      expect(withTools!.toolCount).toBeGreaterThan(0);
      expect(withoutTools!.systemPrompt).not.toContain('# Session-specific guidance');
      expect(withTools!.systemPrompt).toContain('# Session-specific guidance');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('self author inspection observation', () => {
  test('the self author Commander action logs the selected inspection decision once without changing JSON output', async () => {
    const { program } = await import('./index.js');
    const output: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['node', 'elanous', 'self', 'author', '--inspect-decision-signal', '판정 신호: 조건 = x; 관측 = y; 기대 = z']);

      expect(log).toHaveBeenCalledWith('goal-author.inspect', 'result', expect.objectContaining({ kind: 'decision-signal', decision: true }));
      expect(JSON.parse(output.join(''))).toMatchObject({ extracted: true, condition: 'x', observation: 'y', expectedResult: 'z', unreadableCount: 1 });
    } finally {
      log.mockRestore();
      process.stdout.write = write;
    }
  });
});

describe('self repair-signals CLI combined population', () => {
  async function captureRepairSignals(
    listing: {
      parked: Array<{ feature: string; status: string; runId: string; updatedAt: number; stage?: string; source: 'self-dev-run' | 'self-implement-ledger' }>;
      counts: { total: number; selfDevRun: number; selfImplementLedger: number };
    },
    args: string[] = [],
  ): Promise<{ text: string; combinedCalls: number }> {
    const { program } = await import('./index.js');
    const runStore = await import('./self-dev/run-store.js');
    const output: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    const print = spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    const combined = spyOn(runStore, 'listCombinedParkedGoals').mockReturnValue({
      ...listing,
      displayLimit: Number.MAX_SAFE_INTEGER,
      omittedCount: 0,
      population: { selfDevRun: 'existing parked-goal scan', selfImplementLedgerStatus: 'interrupted' },
      stores: { count: 2, names: ['self-dev-runs', 'run-ledger'] },
      limitation: '이 자는 현재 self-dev run 저장소와 self-implement 원장만 읽고 다른 우주는 보지 않으며, 그 런이 아직 열려 있는지도 보지 않습니다.',
    });
    try {
      await program.parseAsync(['node', 'elanous', 'self', 'repair-signals', ...args]);
      return { text: output.join('\n'), combinedCalls: combined.mock.calls.length };
    } finally {
      combined.mockRestore();
      print.mockRestore();
      process.stdout.write = write;
    }
  }

  test('the repair-signals action reads listCombinedParkedGoals and reports scanned store counts instead of global absence', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('repair-signals')");
    const end = source.indexOf(".command('typecheck')", start);
    const action = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(action).toContain('listCombinedParkedGoals');
    expect(action).toContain('analyzeRepairSignals(parked)');
    expect(action).not.toContain('listParkedGoals');
    expect(action).not.toContain('막힌 자율 작업 없음');
    expect(action).toContain('.option(...LOGS_SINCE_OPTION)');
    expect(action).toContain('selfDevRun: parked.filter');
    expect(action).toContain('selfImplementLedger: parked.filter');
    expect(action).toContain("if (opts.json) { await writeStdoutJson(JSON.stringify(signals) + '\\n'); return; }");
  });

  test('self parked still uses the combined reader and keeps its empty copy', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('parked')");
    const end = source.indexOf(".command('repair-signals')", start);
    const action = source.slice(start, end);
    expect(action).toContain('listCombinedParkedGoals({ limit: opts.limit })');
    expect(action).toContain('막힌 자율 작업 없음');
  });

  test('empty combined population reports scanned 0 without claiming global absence', async () => {
    const { text, combinedCalls } = await captureRepairSignals({
      parked: [],
      counts: { total: 0, selfDevRun: 0, selfImplementLedger: 0 },
    });
    expect(combinedCalls).toBe(1);
    expect(text).toContain('훑은 0건 (self-dev 0건 · self-implement 원장 0건)');
    expect(text).not.toContain('막힌 자율 작업 없음');
  });

  test('JSON remains a signals array and stays empty when both stores are empty', async () => {
    const { text } = await captureRepairSignals({
      parked: [],
      counts: { total: 0, selfDevRun: 0, selfImplementLedger: 0 },
    }, ['--json']);
    expect(JSON.parse(text)).toEqual([]);
  });

  test('since recalculates source denominators and json-envelope carries the window counts', async () => {
    const listing = {
      parked: [
        { feature: 'new self-dev', status: 'cancelled', runId: 'new-dev', updatedAt: Date.now(), source: 'self-dev-run' as const },
        { feature: 'old ledger', status: 'cancelled', runId: 'old-ledger', updatedAt: 1, source: 'self-implement-ledger' as const },
      ],
      counts: { total: 2, selfDevRun: 1, selfImplementLedger: 1 },
    };
    const { text } = await captureRepairSignals(listing, ['--since', '1h']);
    expect(text).toContain('훑은 1건 (self-dev 1건 · self-implement 원장 0건 · 창 밖 제외 1건)');

    const envelope = await captureRepairSignals(listing, ['--since', '1h', '--json-envelope']);
    expect(JSON.parse(envelope.text)).toEqual({
      signals: [],
      scanned: { total: 1, selfDevRun: 1, selfImplementLedger: 0 },
      windowExcluded: 1,
    });
  });

  test('cancelled-only parked rows still report scanned store counts when no signal clusters', async () => {
    const { text } = await captureRepairSignals({
      parked: [{ feature: 'Cancelled only', status: 'cancelled', runId: 'cancelled-only', updatedAt: 1, source: 'self-dev-run' }],
      counts: { total: 1, selfDevRun: 1, selfImplementLedger: 0 },
    });
    expect(text).toContain('훑은 1건 (self-dev 1건 · self-implement 원장 0건)');
    expect(text).not.toContain('막힌 자율 작업 없음');
  });

  test('ledger-only interrupted rows produce JSON signals through the combined reader', async () => {
    const { text, combinedCalls } = await captureRepairSignals({
      parked: [{
        feature: 'rework exhausted', status: 'interrupted', stage: 'UNCONVERGEABLE',
        runId: 'run-00000000-0000-0000-0000-000000000001', updatedAt: 1, source: 'self-implement-ledger',
      }],
      counts: { total: 1, selfDevRun: 0, selfImplementLedger: 1 },
    }, ['--json']);
    expect(combinedCalls).toBe(1);
    const signals = JSON.parse(text) as Array<{ pattern: string; count: number }>;
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]).toMatchObject({ pattern: 'UNCONVERGEABLE', count: 1 });
  });
});

describe('decide / ax-screen / decide-recipe JSON stdout completion', () => {
  const indexSource = () => readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  function commandSlice(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;
    const print = spyOn(console, 'log').mockImplementation((value: unknown) => { chunks.push(String(value)); });
    try {
      await run();
      return chunks.join('');
    } finally {
      print.mockRestore();
      process.stdout.write = write;
    }
  }

  test('the four leftover JSON branches await writeStdoutJson with unchanged stringify payloads and opts.json flow', () => {
    const source = indexSource();
    expect(source).not.toMatch(/console\.log\(JSON\.stringify/);
    expect(source).toContain('import { writeStdoutJson } from \'./cli/stdout-json.js\';');
    // agent / ops / publish / autopilot call sites now live in their registration modules; count them together.
    const jsonSources = source
      + readFileSync(new URL('./cli/agent-cli.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('./cli/ops-cli.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('./cli/publish-cli.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('./cli/autopilot-cli.ts', import.meta.url), 'utf8');
    expect((jsonSources.match(/writeStdoutJson/g) ?? []).length).toBeGreaterThan(102);

    const extracted = new Command();
    registerOpsCommands(extracted);
    registerPublishCommands(extracted);
    expect(extracted.commands.map((command) => command.name())).toEqual(['ops', 'publish']);

    const decide = commandSlice(source, ".command('decide <question>')", ".command('ax-screen <tasks.json>')");
    expect(decide).toContain('.action(async (question: string, opts:');
    expect(decide).toContain("if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\\n'); return; }");
    expect(decide).toContain("if (opts.json) { await writeStdoutJson(JSON.stringify(res, null, 2) + '\\n'); return; }");

    const axScreen = commandSlice(source, ".command('ax-screen <tasks.json>')", ".command('decide-recipe <name> <state.json>')");
    expect(axScreen).toContain('.action(async (file: string, opts:');
    expect(axScreen).toContain("if (opts.json) { await writeStdoutJson(JSON.stringify(rows.map((r) => ({ ...r.t, ...r.v })), null, 2) + '\\n'); return; }");

    const recipe = commandSlice(source, ".command('decide-recipe <name> <state.json>')", ".command('signals')");
    expect(recipe).toContain('.action(async (name: string, stateFile: string, opts:');
    expect(recipe).toContain("if (opts.json) { await writeStdoutJson(JSON.stringify({ recipe: recipe.name, ...r, verdict: d.verdict, reasons: d.reasons }, null, 2) + '\\n'); }");
    expect(recipe).not.toContain("if (opts.json) { await writeStdoutJson(JSON.stringify({ recipe: recipe.name, ...r, verdict: d.verdict, reasons: d.reasons }, null, 2) + '\\n'); return; }");
  });

  test('decide --json holds parseAsync until a delayed stdout write callback then parses complete JSON', async () => {
    const { program } = await import('./index.js');
    const jev = await import('./decide/jev.js');
    const payload = {
      model: 'jev-test',
      answers: { q: { type: 'noul' as const, noul: 0.91 } },
      usage: { input_tokens: 12 },
    };
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    const call = spyOn(jev, 'callJev').mockResolvedValue(payload);
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    let markWriteEntered: (() => void) | undefined;
    const writeEntered = new Promise<void>((resolve) => { markWriteEntered = resolve; });
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      if (done) {
        releaseWrite = done;
        markWriteEntered?.();
      }
      return true;
    }) as typeof process.stdout.write;
    try {
      let settled = false;
      const parsed = program.parseAsync(['node', 'elanous', 'decide', '이 신호는 강한가', '--json']).then(
        (value) => { settled = true; return value; },
        (error) => { settled = true; throw error; },
      );
      await writeEntered;
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(typeof releaseWrite).toBe('function');
      releaseWrite?.();
      await parsed;
      expect(settled).toBe(true);
      const text = chunks.join('');
      expect(JSON.parse(text)).toEqual(payload);
      expect(text).toBe(JSON.stringify(payload, null, 2) + '\n');
      expect(call).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalWrite;
      call.mockRestore();
      exit.mockRestore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  test('decide --json writes the callJev payload as complete pretty JSON and returns before human output', async () => {
    const { program } = await import('./index.js');
    const jev = await import('./decide/jev.js');
    const payload = {
      model: 'jev-test',
      answers: { q: { type: 'noul' as const, noul: 0.91 } },
      usage: { input_tokens: 12 },
    };
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    const call = spyOn(jev, 'callJev').mockResolvedValue(payload);
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const text = await captureStdout(async () => {
        await program.parseAsync(['node', 'elanous', 'decide', '이 신호는 강한가', '--json']);
      });
      expect(JSON.parse(text)).toEqual(payload);
      expect(text).toBe(JSON.stringify(payload, null, 2) + '\n');
      expect(call).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
      exit.mockRestore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  test('decide --json --file writes the fan-out callJev payload as complete pretty JSON and returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elanous-decide-file-json-'));
    const file = join(dir, 'questions.json');
    await writeFile(file, JSON.stringify({
      state: '상황',
      questions: { q1: { type: 'noul', instructions: '강한가' } },
    }));
    const payload = {
      model: 'jev-test',
      answers: { q1: { type: 'noul' as const, noul: 0.95 } },
      usage: { input_tokens: 4 },
    };
    const { program } = await import('./index.js');
    const jev = await import('./decide/jev.js');
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    const call = spyOn(jev, 'callJev').mockResolvedValue(payload);
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const text = await captureStdout(async () => {
        await program.parseAsync(['node', 'elanous', 'decide', 'ignored', '--file', file, '--json']);
      });
      expect(JSON.parse(text)).toEqual(payload);
      expect(text).toBe(JSON.stringify(payload, null, 2) + '\n');
      expect(call).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
      exit.mockRestore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('ax-screen --json writes the merged task+verdict rows as complete pretty JSON and returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elanous-ax-screen-json-'));
    const tasksPath = join(dir, 'tasks.json');
    const task = { id: 'T1', 업무: '알람 확인', 현재판단: 'human-judgment' as const };
    await writeFile(tasksPath, JSON.stringify([task]));
    const answers = {
      repetition: { type: 'score' as const, score: 3, confidence: 0.9 },
      closed_set: { type: 'noul' as const, noul: 0.9 },
      extraction: { type: 'noul' as const, noul: 0.1 },
      reversible: { type: 'noul' as const, noul: 0.8 },
    };
    const { program } = await import('./index.js');
    const jev = await import('./decide/jev.js');
    const { axVerdict } = await import('./decide/ax-screen.js');
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    const call = spyOn(jev, 'callJev').mockResolvedValue({
      model: 'jev-test',
      answers,
      usage: { input_tokens: 7 },
    });
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const text = await captureStdout(async () => {
        await program.parseAsync(['node', 'elanous', 'ax-screen', tasksPath, '--json']);
      });
      const expected = [{
        ...task,
        ...axVerdict(task, {
          repetition: { score: 3 },
          closed_set: { noul: 0.9 },
          extraction: { noul: 0.1 },
          reversible: { noul: 0.8 },
        }),
      }];
      expect(JSON.parse(text)).toEqual(expected);
      expect(text).toBe(JSON.stringify(expected, null, 2) + '\n');
      expect(call).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
      exit.mockRestore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('decide-recipe --json writes recipe+callJev+verdict as complete pretty JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elanous-decide-recipe-json-'));
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir);
    await writeFile(join(recipesDir, 'json-complete.json'), JSON.stringify({
      name: 'json-complete',
      description: 'test',
      requiredStateKeys: ['source'],
      questions: {
        injection: {
          type: 'noul',
          instructions: 'x',
          criteria: { true: 't', false: 'f' },
        },
      },
    }));
    const statePath = join(dir, 'state.json');
    await writeFile(statePath, JSON.stringify({ source: 'web' }));
    const r = {
      model: 'jev-test',
      answers: { injection: { type: 'noul' as const, noul: 0.1 } },
      usage: { input_tokens: 3 },
    };
    const { program } = await import('./index.js');
    const jev = await import('./decide/jev.js');
    const { decideByRecipe } = await import('./decide/recipe.js');
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    const call = spyOn(jev, 'callJev').mockResolvedValue(r);
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const text = await captureStdout(async () => {
        await program.parseAsync(['node', 'elanous', 'decide-recipe', 'json-complete', statePath, '--recipes-dir', recipesDir, '--json']);
      });
      const d = decideByRecipe(
        {
          name: 'json-complete',
          description: 'test',
          requiredStateKeys: ['source'],
          questions: { injection: { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } } },
        },
        r.answers,
        jev.gateAnswer as never,
      );
      const expected = { recipe: 'json-complete', ...r, verdict: d.verdict, reasons: d.reasons };
      expect(JSON.parse(text)).toEqual(expected);
      expect(text).toBe(JSON.stringify(expected, null, 2) + '\n');
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      call.mockRestore();
      exit.mockRestore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
