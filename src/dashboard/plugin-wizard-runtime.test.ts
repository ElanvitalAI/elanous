import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandTaskOptions } from '../task-agent/task-hand.js';
import type { InstalledPlugin } from '../plugins/install/plugin-install.js';
import type { ClassicSidetabMissionPairCompletionResult } from './classic-sidetab-mission-job.js';
import { composePluginMission } from '../graph-wizard/mission-compose.js';
import { createDashboardClassicSidetabMissionCallbacks, createDashboardTuiPluginWizard } from './index.js';
import { startPty, unregisterPty } from '../pty-shell/registry.js';

test('dashboard index wires the plugin wizard to the production pair runner', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source).toContain('createDashboardTuiPluginWizard(classicSidetabMission, pluginWizardPairCompletions, {');
});

test('TUI tool returns immediately, hands off to handTask, and composer adopts one paired winner on the same run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tui-plugin-wizard-')));
  const workspace = join(root, 'workroom');
  const pluginPath = join(workspace, 'plugin');
  mkdirSync(pluginPath, { recursive: true });
  let handed: HandTaskOptions | undefined;
  let pairCalls = 0;
  let pairRunId: string | undefined;
  const childBriefs: string[] = [];
  const pairCompletions = new Map<string, Promise<ClassicSidetabMissionPairCompletionResult>>();
  const sidetab = createDashboardClassicSidetabMissionCallbacks(
    async () => { throw new Error('wizard should dispatch a pair'); },
    undefined,
    async (_agent, codexBrief, claudeBrief, context) => {
      pairCalls++;
      pairRunId = context?.callId;
      childBriefs.push(codexBrief, claudeBrief);
      if (!context?.callId) throw new Error('pair dispatch did not carry its call ID');
      pairCompletions.set(context.callId, Promise.resolve({
        status: 'done', finishedAt: 1,
        codex: { ok: true, status: 'completed', content: `PLUGIN_SPEC=${pluginPath}` },
        claude: { ok: true, status: 'completed', content: `PLUGIN_SPEC=${pluginPath}` },
      }));
      return {
        pairId: 'wizard-pair',
        codex: { ok: true, status: 'running', interactionId: 'codex-child' },
        claude: { ok: true, status: 'running', interactionId: 'claude-child' },
      };
    },
  );
  let composed: Awaited<ReturnType<typeof composePluginMission>> | undefined;
  const events: Array<{ ts: string; wizardId: string; step: string; detail?: unknown }> = [];
  let complete!: () => void;
  const taskCompleted = new Promise<void>((resolve) => { complete = resolve; });
  const installed: InstalledPlugin = { name: 'test-plugin', version: '1.0.0', market: 'local', path: pluginPath, sha256: null };

  try {
    const tool = createDashboardTuiPluginWizard(sidetab, pairCompletions, {
      getWorkspace: () => workspace,
      taskHand: async (options) => {
        handed = options;
        try {
          const pluginWizard = options.pluginWizard;
          if (!pluginWizard) throw new Error('plugin wizard input missing from handTask');
          composed = await composePluginMission({ ...pluginWizard, mission: options.text, root: workspace }, {
            ask: async () => ({ answer: 'Build the missing capability' }),
            searchMarket: async () => ({ candidates: [], unavailable: [] }),
            developPair: options.pluginWizardDeps?.developPair,
            trial: async ({ maker }) => ({ ok: true, score: maker === 'codex' ? 9 : 3, detail: 'fixture passed' }),
            install: async () => installed,
            use: async () => ({ ok: true, detail: 'used in fixture mission' }),
            onEvent: options.pluginWizardDeps?.onEvent,
          });
        } finally { complete(); }
      },
      launcher: async () => undefined,
      onEvent: (event) => { events.push(event); },
    });

    const response = await tool.dispatchTool('StartPluginWizard', { mission: 'Finish the task', missing: 'the required tool' }, { callId: 'tool-call-1' });
    expect(response).toMatchObject({ status: 'running' });
    await taskCompleted;

    const runId = handed?.pluginWizard?.wizardId;
    expect(typeof runId).toBe('string');
    expect(response).toMatchObject({ id: runId });
    expect(handed?.id).toMatch(/^ta-plugin-/);
    expect(handed?.live).toBe(true);
    expect(handed?.pluginWizard).toMatchObject({ missing: 'the required tool', workspace });
    expect(pairCalls).toBe(1);
    expect(pairRunId).toBe(`plugin-wizard:${runId}`);
    expect(childBriefs).toHaveLength(2);
    expect(childBriefs[0]).not.toBe(childBriefs[1]);
    expect(childBriefs[0]).toContain('Codex');
    expect(childBriefs[1]).toContain('Claude');
    expect(childBriefs[0]).toContain('codex-candidate');
    expect(childBriefs[1]).toContain('claude-candidate');
    expect(childBriefs.every((brief) => brief.includes('PLUGIN_SPEC='))).toBe(true);
    expect(composed).toMatchObject({ status: 'done', origin: 'maker' });
    const validationEvents = events.filter((event) => event.step === 'validate');
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({ wizardId: runId, detail: { winner: { maker: 'codex', spec: pluginPath } } });
    expect(Date.parse(validationEvents[0]!.ts)).not.toBeNaN();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('showDashboard boot dispatches StartPluginWizard through its registered sidetab pair integration', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-plugin-wizard-boot-')));
  const workspace = join(root, 'workspace');
  const configRoot = join(root, 'config');
  const stateRoot = join(root, 'state');
  const dataRoot = join(root, 'data');
  const pairEvidence = join(root, 'pair.json');
  const taskEvidence = join(root, 'task.json');
  const pluginPath = join(workspace, 'plugin');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(pluginPath, { recursive: true });
  let catalogIncludedWizard = false;
  let modelRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return Response.json({ data: [{ id: 'wizard-boot-fixture' }] });
      if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      const body = await request.json() as { tools?: Array<{ function?: { name?: string } }> };
      catalogIncludedWizard ||= body.tools?.some((tool) => tool.function?.name === 'StartPluginWizard') ?? false;
      modelRequests += 1;
      const first = modelRequests === 1;
      const chunks = first
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-start-plugin-wizard', type: 'function', function: {
              name: 'StartPluginWizard', arguments: JSON.stringify({
                mission: '⑤ 시나리오별 수익 시뮬레이션 도구가 없습니다. 플러그인을 찾아보겠습니다.',
                missing: '시나리오별 수익 시뮬레이션 도구',
              }),
            } }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [{ choices: [{ delta: { content: '플러그인 후보 비교를 시작했습니다.' }, finish_reason: 'stop' }] }];
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  writeFileSync(join(configRoot, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'local', model: 'wizard-boot-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false }, mcp: { enabled: false },
  }));
  const driverPath = join(root, 'dashboard-plugin-wizard-driver.ts');
  const dashboardPath = join(import.meta.dir, 'index.ts');
  const configSetterPath = join(import.meta.dir, '../elanous-config-dir.ts');
  const composePath = join(import.meta.dir, '../graph-wizard/mission-compose.ts');
  const driver = `
    import { writeFileSync } from 'node:fs';
    import { setElanousConfigDir } from ${JSON.stringify(configSetterPath)};
    import { showDashboard } from ${JSON.stringify(dashboardPath)};
    import { composePluginMission } from ${JSON.stringify(composePath)};
    setElanousConfigDir(${JSON.stringify(configRoot)});
    await showDashboard({
      pluginWizardTestOverrides: {
        // This scenario asserts the missing-capability path; keep it independent
        // of whichever host tools happen to be installed on the test runner.
        findAvailableTools: () => [],
        runPair: async (agent, mission, parallelMission, context) => {
          writeFileSync(${JSON.stringify(pairEvidence)}, JSON.stringify({ agent, mission, parallelMission, context }));
          const result = {
            pairId: 'dashboard-boot-pair',
            codex: { ok: true, status: 'running', interactionId: 'codex-child' },
            claude: { ok: true, status: 'running', interactionId: 'claude-child' },
          };
          const completion = Promise.resolve({
            status: 'done', finishedAt: 1,
            codex: { ok: true, status: 'completed', content: ${JSON.stringify(`PLUGIN_SPEC=${pluginPath}`)} },
            claude: { ok: true, status: 'completed', content: ${JSON.stringify(`PLUGIN_SPEC=${pluginPath}`)} },
          });
          return { result, completion };
        },
        taskHand: async (options) => {
          const input = options.pluginWizard;
          if (!input || !options.pluginWizardDeps) throw new Error('plugin wizard boot inputs missing');
          const installed = { name: 'boot-fixture', version: '1.0.0', market: 'local', path: ${JSON.stringify(pluginPath)}, sha256: null };
          const composed = await composePluginMission({ ...input, mission: options.text, root: ${JSON.stringify(workspace)} }, {
            ask: async () => ({ answer: 'Create the missing capability' }),
            searchMarket: async () => ({ candidates: [], unavailable: [] }),
            developPair: options.pluginWizardDeps.developPair,
            trial: async ({ maker }) => ({ ok: true, score: maker === 'codex' ? 9 : 3, detail: 'boot fixture passed' }),
            install: async () => installed,
            use: async () => ({ ok: true, detail: 'boot fixture used' }),
            onEvent: options.pluginWizardDeps.onEvent,
          });
          writeFileSync(${JSON.stringify(taskEvidence)}, JSON.stringify(composed));
        },
      },
    });
  `;
  writeFileSync(driverPath, driver);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: 'development', HOME: root, ELANOUS_STATE_DIR: stateRoot,
    ELANOUS_DATA_DIR: dataRoot, ELANOUS_SESSION_ROOT: join(root, 'sessions'),
    TERM: 'xterm-256color', COLUMNS: '120', LINES: '30',
  };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const handle = startPty({ cmd: process.execPath, args: [driverPath], workdir: workspace, cols: 120, rows: 30, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  try {
    const deadline = Date.now() + 120_000;
    const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(100);
      }
      throw new Error(`${label} timeout; screen=${(await handle.renderScreen()).slice(-1800)}`);
    };
    await waitFor(async () => (await handle.renderScreen()).split('\n').some((line) => line.trim() === '❯'), 'dashboard prompt');
    handle.write('⑤ 시나리오별 수익 시뮬레이션 도구가 없습니다. 플러그인을 찾아보겠습니다.\r');
    await waitFor(() => existsSync(pairEvidence), 'actual RunSidetabMission dispatch');
    await waitFor(() => existsSync(taskEvidence), 'safe plugin composer completion');
    expect(catalogIncludedWizard).toBe(true);
    expect(modelRequests).toBeGreaterThanOrEqual(2);
    const pair = JSON.parse(readFileSync(pairEvidence, 'utf8')) as { agent: string; mission: string; parallelMission: string; context?: { callId?: string } };
    expect(pair.agent).toBe('codex');
    expect(pair.mission).toContain('시나리오별 수익 시뮬레이션');
    expect(pair.parallelMission).toContain('Claude');
    expect(pair.mission).toContain('codex-candidate');
    expect(pair.parallelMission).toContain('claude-candidate');
    expect(pair.mission).not.toBe(pair.parallelMission);
    expect(pair.context?.callId).toMatch(/^plugin-wizard:/);
    expect(JSON.parse(readFileSync(taskEvidence, 'utf8'))).toMatchObject({ status: 'done', origin: 'maker' });
  } finally {
    handle.kill();
    unregisterPty(handle.id);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
