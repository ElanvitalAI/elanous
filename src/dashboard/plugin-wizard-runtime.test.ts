import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandTaskOptions } from '../task-agent/task-hand.js';
import type { InstalledPlugin } from '../plugins/install/plugin-install.js';
import type { ClassicSidetabMissionPairCompletionResult } from './classic-sidetab-mission-job.js';
import { composePluginMission } from '../graph-wizard/mission-compose.js';
import { createDashboardClassicSidetabMissionCallbacks, createDashboardTuiPluginWizard } from './index.js';

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
