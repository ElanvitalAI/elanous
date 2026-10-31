import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { pluginWizardQuestions } from '../graph-wizard/mission-compose.js';
import { registerTasksCommands } from './tasks-cli.js';
import type { AskUserQuestionRequest } from '../ask-user-question/types.js';
import { createTaskPluginWizardHostDeps } from './task-plugin-wizard-host.js';

describe('task plugin wizard host adapters', () => {
  test('routes wizard questions and reports through injected channel adapters', async () => {
    const questions: unknown[] = [];
    const reports: string[] = [];
    const deps = createTaskPluginWizardHostDeps({
      questionChannels: () => [{ name: 'telegram', ask: async (request) => {
        questions.push(request);
        return { answers: { plugin_wizard_1: 'Other' }, otherText: { plugin_wizard_1: 'CSV export from monthly reports' } };
      }, cancel: () => {} }],
      sendReport: (report, kind) => { reports.push(`${kind}\n${report}`); },
      runMission: async () => ({ ok: false, error: 'unused' }),
    });

    const answers = await deps.ask?.(['What should the missing tool do?']);
    await deps.notify?.('wizard finished');

    expect(questions).toEqual([{
      questions: [{
        id: 'plugin_wizard_1', header: '플러그인', question: 'What should the missing tool do?',
        options: [
          { label: '기본안', description: '마법사가 미션과 도구 이름에서 기본 구현을 정합니다.' },
          { label: '직접 입력', description: '원하는 기능을 직접 적습니다.' },
        ], includeOther: true,
      }],
    }]);
    expect(answers).toEqual({ plugin_wizard_1: 'CSV export from monthly reports' });
    expect(reports).toEqual(['report\nwizard finished']);
  });

  test('chooses market or sidetab options from the question meaning, not its position', async () => {
    let request: AskUserQuestionRequest | undefined;
    const deps = createTaskPluginWizardHostDeps({
      questionChannels: () => [{ name: 'telegram', ask: async (value) => {
        request = value;
        return { answers: {} };
      }, cancel: () => {} }],
      runMission: async () => ({ ok: false, error: 'unused' }),
    });

    await deps.ask?.(pluginWizardQuestions({ missing: 'csv-export', mission: 'monthly report' }));

    expect(request?.questions[1]?.options.map((option) => option.label)).toEqual(['마켓', '사이드탭']);
  });

  test('preserves the selected Other label when its free-text answer is empty', async () => {
    const deps = createTaskPluginWizardHostDeps({
      questionChannels: () => [{ name: 'telegram', ask: async () => ({
        answers: { plugin_wizard_1: 'Other' }, otherText: { plugin_wizard_1: '' },
      }), cancel: () => {} }],
      runMission: async () => ({ ok: false, error: 'unused' }),
    });

    expect(await deps.ask?.(['What should the tool do?'])).toEqual({ plugin_wizard_1: 'Other' });
  });

  test('preserves array answers when a channel does not provide free text', async () => {
    const deps = createTaskPluginWizardHostDeps({
      questionChannels: () => [{ name: 'telegram', ask: async () => ({
        answers: { plugin_wizard_1: ['CSV export', 'scheduled reports'] },
      }), cancel: () => {} }],
      runMission: async () => ({ ok: false, error: 'unused' }),
    });

    expect(await deps.ask?.(['What should the tool do?']))
      .toEqual({ plugin_wizard_1: 'CSV export, scheduled reports' });
  });

  test('uses the Claude/Codex mission host in the shared workspace and requires an explicit plugin path', async () => {
    const calls: Array<{ maker: string; prompt: string }> = [];
    const root = mkdtempSync(join(tmpdir(), 'plugin-host-spec-'));
    const workspace = join(root, 'workroom');
    const pluginPath = join(workspace, 'csv-export');
    mkdirSync(pluginPath, { recursive: true });
    const canonicalPluginPath = realpathSync(pluginPath);
    const deps = createTaskPluginWizardHostDeps({
      runMission: async ({ maker, prompt }) => {
        calls.push({ maker, prompt });
        return { ok: true, content: `Implemented plugin.\nPLUGIN_SPEC=${pluginPath}` };
      },
    });

    try {
      const result = await deps.develop?.({ maker: 'codex', goal: 'Build CSV export.', workspace });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.maker).toBe('codex');
      expect(calls[0]?.prompt).toContain('Build CSV export.');
      expect(calls[0]?.prompt).toContain(workspace);
      expect(calls[0]?.prompt).toContain('PLUGIN_SPEC=<absolute plugin directory>');
      expect(result).toEqual({ spec: canonicalPluginPath });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects successful side-tab output without a declared plugin directory', async () => {
    const deps = createTaskPluginWizardHostDeps({
      runMission: async () => ({ ok: true, content: 'Done.' }),
    });

    await expect(deps.develop?.({ maker: 'claude', goal: 'Build it.', workspace: '/tmp/workroom' }))
      .rejects.toThrow('PLUGIN_SPEC');
  });

  test('rejects a plugin directory outside the side-tab workroom', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-host-outside-'));
    const workspace = join(root, 'workroom');
    const pluginPath = join(root, 'unrelated-plugin');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(pluginPath, { recursive: true });
    const deps = createTaskPluginWizardHostDeps({
      runMission: async () => ({ ok: true, content: `PLUGIN_SPEC=${pluginPath}` }),
    });

    try {
      await expect(deps.develop?.({ maker: 'codex', goal: 'Build it.', workspace }))
        .rejects.toThrow('작업실 안');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses both paired maker results from the same workroom and keeps the valid candidate when the other is malformed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-host-pair-'));
    const workspace = join(root, 'workroom');
    const codexPath = join(workspace, 'codex-plugin');
    const claudePath = join(workspace, 'claude-plugin');
    mkdirSync(codexPath, { recursive: true });
    mkdirSync(claudePath, { recursive: true });
    let request: { makers: readonly string[]; prompt: string } | undefined;
    const deps = createTaskPluginWizardHostDeps({
      runMissionPair: async (value) => {
        request = value;
        return {
          codex: { ok: true, content: `PLUGIN_SPEC=${codexPath}` },
          claude: { ok: true, content: 'PLUGIN_SPEC=/outside/not-created' },
        };
      },
    });

    try {
      const result = await deps.developPair?.({ makers: ['claude', 'codex'], goal: 'Build CSV export.', workspace });

      expect(request?.makers).toEqual(['claude', 'codex']);
      expect(typeof request?.prompt).toBe('string');
      expect(JSON.stringify(request)).toContain(workspace);
      expect(JSON.stringify(request)).toContain('PLUGIN_SPEC=<absolute plugin directory>');
      expect(result).toEqual({ codex: { spec: realpathSync(codexPath) } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the tasks hand CLI uses fake host adapters for missing-tool wizard without outbound sends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task-plugin-host-cli-'));
    const installRoot = join(root, 'install');
    const workspace = join(root, 'workspace');
    const packagePath = join(workspace, 'csv-export');
    const compositionRoot = join(root, 'compositions');
    const workGraphs = join(compositionRoot, 'graphs', 'work');
    mkdirSync(packagePath, { recursive: true });
    mkdirSync(workGraphs, { recursive: true });
    const standardYaml = readFileSync(join(import.meta.dir, '../..', 'graphs/work/research-report.yaml'), 'utf8');
    writeFileSync(join(workGraphs, 'research-report.yaml'), standardYaml);
    writeFileSync(join(workGraphs, 'recipes.yaml'), readFileSync(join(import.meta.dir, '../..', 'graphs/work/recipes.yaml'), 'utf8'));
    writeFileSync(join(packagePath, 'plugin.json'), JSON.stringify({ id: 'csv-export', name: 'csv-export', version: '1.0.0',
      main: './plugin.ts', capabilities: ['fs:workdir'], contributes: { skills: ['export'] } }));
    writeFileSync(join(packagePath, 'plugin.ts'), 'export default {}');
    const questions: AskUserQuestionRequest[] = [];
    const missions: string[] = [];
    const promptFiles: string[] = [];
    const missionIds = new Map<string, string>();
    let missionSequence = 0;
    const reports: string[] = [];
    const lines: string[] = [];
    const program = new Command().name('elanous').exitOverride();
    registerTasksCommands(program, {
      taskStatePath: join(root, 'task-state.json'),
      taskCompositionRoot: compositionRoot,
      taskPluginInstallRoot: installRoot,
      taskComposeCallLLM: async () => `BASE: work-research-report-rehearsal\nSLUG: monthly-csv-report\nSUMMARY: CSV export\n\`\`\`yaml\n${standardYaml}\n\`\`\``,
      taskPluginWizardHostPorts: {
        questionChannels: () => [{ name: 'telegram', ask: async (request) => {
          questions.push(request);
          return { answers: { plugin_wizard_1: 'Other' }, otherText: { plugin_wizard_1: 'CSV export' } };
        }, cancel: () => {} }],
        searchMarket: async () => ({ candidates: [], unavailable: [] }),
        missionConsumerDeps: {
          runCli: async (args) => {
            if (args[0] === 'mission' && args[1] === 'run') {
              const agent = args[args.indexOf('--agent') + 1];
              const promptPath = args[args.indexOf('--prompt-file') + 1];
              const missionId = `00000000-0000-4000-8000-${String(++missionSequence).padStart(12, '0')}`;
              promptFiles.push(promptPath!);
              missions.push(`${agent}\n${readFileSync(promptPath!, 'utf8')}`);
              missionIds.set(missionId, packagePath);
              return { code: 0, stdout: JSON.stringify({ missionId, status: 'running' }), stderr: '' };
            }
            if (args[0] === 'mission' && args[1] === 'status') {
              const missionId = args[2]!;
              return { code: 0, stdout: JSON.stringify({ missionId, status: 'done', result: `PLUGIN_SPEC=${missionIds.get(missionId)}` }), stderr: '' };
            }
            throw new Error(`Unexpected mission CLI command: ${args.join(' ')}`);
          },
          delay: async () => {},
          now: () => 0,
        },
        sendReport: (report, kind) => { reports.push(`${kind}\n${report}`); },
      },
      handOpenPrRun: () => ({ status: 0, stdout: '[]' }),
      handOriginRepo: () => 'ElanvitalAI/elanous',
      output: (line) => lines.push(line),
    });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(['tasks', 'hand', 'csv export monthly report', '--completion', 'research-report',
        '--project', 'csv-export-test', '--target', workspace, '--missing-tool', 'csv-export'], { from: 'user' });
      expect(process.exitCode ?? 0).toBe(0);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.questions[0]?.id).toBe('plugin_wizard_1');
      expect(missions).toHaveLength(2);
      expect(missions.every((prompt) => prompt.includes(`세션 작업실: ${workspace}`))).toBe(true);
      expect(missions.map((mission) => mission.split('\n', 1)[0]).sort()).toEqual(['claude', 'codex']);
      expect(promptFiles).toHaveLength(2);
      expect(promptFiles.every((path) => !existsSync(path))).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toStartWith('report\n');
      expect(reports[0]).toContain('csv-export@1.0.0');
      expect(reports[0]).toContain('사용:');
      expect(listInstalledPlugins(installRoot).map((plugin) => plugin.name)).toEqual(['csv-export']);
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      process.exitCode = previousExitCode ?? 0;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
