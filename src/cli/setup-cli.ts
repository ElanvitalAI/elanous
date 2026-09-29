import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { formatDoctorReport, runDoctor, type DoctorOptions, type DoctorReport } from './doctor-cli.js';
import { applyClaudePluginSetup, planClaudePluginSetup } from './claude-plugin-setup.js';
import { debug } from '../debug/log.js';
import { getUserConfig, saveUserConfig, type UserConfig } from '../user-config.js';

const ELANOUS_LOGIN_COMMAND = 'elanous login openai-codex';
const PROVIDER_COMMAND = 'elanous config set llm.provider openai-codex';
const CODEX_LOGIN_COMMAND = 'codex login';

type SetupStep = {
  name: string;
  complete: boolean;
  command: string;
  symptom: string;
};

export interface SetupCliDeps extends DoctorOptions {
  runDoctor?: (options: DoctorOptions) => DoctorReport;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  homeDir?: () => string;
  getUserConfig?: () => UserConfig;
  saveUserConfig?: (config: UserConfig) => void;
  planClaudePluginSetup?: typeof planClaudePluginSetup;
  applyClaudePluginSetup?: typeof applyClaudePluginSetup;
  prompt?: (message: string) => Promise<string | undefined>;
  isStdinTty?: () => boolean;
  out?: { log: (value: string) => void; error?: (value: string) => void };
  setExitCode?: (code: number) => void;
  /** 런타임이 이 config 로 «실제로» 고르는 provider(`decideProviderForConfig().provider`). 시험 seam. */
  resolveRuntimeProvider?: (config: UserConfig) => string | undefined;
}

/** ⛔ 2026-09-23 — provider 단계는 «문자열 비교»가 아니라 ***런타임의 최종 결정***으로 잰다.
 *  빈 config(=`auto`)도 codex OAuth 가 있으면 런타임은 `auto:openai-codex` 로 이미 고른다(실측).
 *  종전엔 `provider === 'openai-codex'` 만 «완료»로 봐서, setup 이 ***필요 없는 손***
 *  (`elanous config set llm.provider openai-codex`)을 요구하고 「Codex 세션 불가」라고 거짓 표시했다
 *  — Phase 3 「사람 손」 셈의 ③ 이 바로 이것이었다. */
function defaultResolveRuntimeProvider(config: UserConfig): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decideProviderForConfig } = require('../llm.js') as typeof import('../llm.js');
    return decideProviderForConfig(config).provider;
  } catch {
    return undefined;   // 못 풀면 «모른다» — 종전 문자열 판정으로 떨어진다
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function readJson(path: string, exists: (path: string) => boolean, readFile: (path: string) => string): unknown {
  if (!exists(path)) return undefined;
  try { return JSON.parse(readFile(path)); } catch { return undefined; }
}

function hasElanousCodexAuth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const provider = (value as { providers?: Record<string, unknown> }).providers?.['openai-codex'];
  if (typeof provider !== 'object' || provider === null) return false;
  const tokens = (provider as { tokens?: Record<string, unknown> }).tokens;
  return typeof tokens === 'object' && tokens !== null
    && hasNonEmptyString(tokens.accessToken) && hasNonEmptyString(tokens.refreshToken);
}

function hasCodexCliAuth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const tokens = (value as { tokens?: Record<string, unknown> }).tokens;
  return typeof tokens === 'object' && tokens !== null
    && hasNonEmptyString(tokens.access_token) && hasNonEmptyString(tokens.refresh_token);
}

function setupSteps(deps: SetupCliDeps): SetupStep[] {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const home = (deps.homeDir ?? homedir)();
  const config = (deps.getUserConfig ?? getUserConfig)();
  return [
    {
      name: 'elanous OpenAI Codex login',
      complete: hasElanousCodexAuth(readJson(join(home, '.elanous', 'auth.json'), exists, readFile)),
      command: ELANOUS_LOGIN_COMMAND,
      symptom: 'No LLM provider available can be caused by a missing elanous OpenAI Codex login or provider configuration; check both named steps.',
    },
    {
      name: 'LLM provider configuration',
      complete: config.llm.provider === 'openai-codex'
        || (config.llm.provider === 'auto'
          && (deps.resolveRuntimeProvider ?? defaultResolveRuntimeProvider)(config) === 'auto:openai-codex'),
      command: PROVIDER_COMMAND,
      symptom: 'No LLM provider available means this LLM provider configuration step is missing.',
    },
    {
      name: 'Codex CLI login',
      complete: hasCodexCliAuth(readJson(join(home, '.codex', 'auth.json'), exists, readFile)),
      command: CODEX_LOGIN_COMMAND,
      symptom: 'codex app-server stdin drain timeout can be caused by this missing Codex CLI login step; it is not quota exhaustion.',
    },
  ];
}

function missingRequiredCommands(doctor: DoctorReport): boolean {
  return doctor.externalCommands.some((command) => command.status === 'missing' && command.tier === 'required');
}

function displayCommand(command: string[]): string {
  return command.map((arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
}

export function formatSetupReport(doctor: DoctorReport, steps: SetupStep[], nonInteractive: boolean): string {
  const elanousLogin = steps[0]!.complete;
  const provider = steps[1]!.complete;
  const codexLogin = steps[2]!.complete;
  const externalReady = doctor.ok && !missingRequiredCommands(doctor);
  const capabilities = [
    { name: 'OpenAI Codex-backed elanous sessions', ready: elanousLogin && provider },
    { name: 'Codex app-server integration', ready: codexLogin && externalReady },
    { name: 'External command-dependent integrations', ready: externalReady },
  ];
  return [
    'Setup: external command check',
    formatDoctorReport(doctor),
    'Setup: LLM credential steps',
    ...steps.map((step) => step.complete
      ? `completed: ${step.name}`
      : `missing: ${step.name} — run \`${step.command}\`\n  ${step.symptom}`),
    // 대화형 경로도 provider 가 «미완»일 때만 묻는다 — 비대화형 문면을 그것과 맞춘다.
    ...(nonInteractive ? ['Non-interactive: no questions were asked and no configuration was written.', ...(provider ? [] : ['Would ask: Set llm.provider to openai-codex now? [y/N]'])] : []),
    'Available now:',
    ...capabilities.filter((capability) => capability.ready).map((capability) => `- ${capability.name}`),
    'Unavailable until setup is complete:',
    ...capabilities.filter((capability) => !capability.ready).map((capability) => `- ${capability.name}`),
  ].join('\n');
}

export function registerSetupCommand(program: Command, deps: SetupCliDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value), error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const doctorRunner = deps.runDoctor ?? runDoctor;
  const isStdinTty = deps.isStdinTty ?? (() => process.stdin.isTTY === true);
  const prompt = deps.prompt ?? (async (message: string) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(message); } finally { rl.close(); }
  });

  const setup = program.command('setup')
    .description('Check OpenAI Codex setup and guide each missing credential step')
    .option('--non-interactive', 'Report setup state without prompts or writes')
    .action(async (opts: { nonInteractive?: boolean }) => {
      const doctor = doctorRunner(deps);
      if (opts.nonInteractive) {
        out.log(formatSetupReport(doctor, setupSteps(deps), true));
        setExitCode(0);
        return;
      }
      if (!isStdinTty()) {
        (out.error ?? out.log)('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다. 무인 설정은 `elanous setup --non-interactive`를 사용하라.');
        setExitCode(1);
        return;
      }
      let steps = setupSteps(deps);
      const provider = steps[1]!;
      if (!provider.complete) {
        const answer = await prompt('Set llm.provider to openai-codex now? [y/N] ');
        if (answer?.trim().toLowerCase() === 'y') {
          const config = (deps.getUserConfig ?? getUserConfig)();
          (deps.saveUserConfig ?? saveUserConfig)({ ...config, llm: { ...config.llm, provider: 'openai-codex' } });
          steps = setupSteps(deps);
        } else {
          out.log(`Not changed. To complete LLM provider configuration, run \`${PROVIDER_COMMAND}\`.`);
        }
      }
      out.log(formatSetupReport(doctor, steps, false));
      setExitCode(0);
    });

  setup.command('claude-code')
    .description('Plan or install the elanous Claude Code plugin')
    .option('--apply', 'Install missing steps and verify the MCP connection')
    .option('--source <URL|경로|owner/repo>', 'Claude plugin marketplace source')
    .option('--json', 'Print the plan or result as one JSON line')
    .action(async (opts: { apply?: boolean; source?: string; json?: boolean }) => {
      let ready: boolean | undefined;
      let needed: number | undefined;
      let executed: number | undefined;
      let mcpVerified: boolean | undefined;
      try {
        const plan = await (deps.planClaudePluginSetup ?? planClaudePluginSetup)({ source: opts.source });
        ready = plan.ready;
        needed = plan.steps.filter((step) => step.needed).length;
        debug.log('setup.claude-code', 'planned', { ready, needed, executed, mcpVerified });
        if (opts.apply) {
          const result = await (deps.applyClaudePluginSetup ?? applyClaudePluginSetup)(plan);
          executed = result.executed.length;
          mcpVerified = result.mcpVerified;
          ready = result.verification.ready;
          if (opts.json) out.log(JSON.stringify(result));
          else {
            for (const command of result.executed) out.log(`✓ 실행: ${displayCommand(command)}`);
            out.log(`MCP 확인: ${mcpVerified ? '✓ 완료' : '✗ 실패'}`);
          }
          debug.log('setup.claude-code', result.ok ? 'applied' : 'failed', { ready, needed, executed, mcpVerified });
          setExitCode(result.ok ? 0 : 1);
          return;
        }
        if (opts.json) out.log(JSON.stringify(plan));
        else {
          for (const binary of [
            { available: plan.claudeCode, name: 'claude', reason: 'Claude Code is not installed' },
            { available: plan.node, name: 'node', reason: 'node is not on PATH' },
            { available: plan.elanous, name: 'elanous', reason: 'elanous is not on PATH' },
          ]) {
            out.log(binary.available ? `✓ 완료: ${binary.name}` : `✗ 막힘: ${binary.reason}`);
          }
          for (const step of plan.steps) {
            out.log(step.needed ? `→ 할 일: ${displayCommand(step.command)}` : `✓ 완료: ${displayCommand(step.command)}`);
          }
          out.log(plan.ready ? '준비됨' : '--apply 로 실행');
        }
        setExitCode(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug.log('setup.claude-code', 'failed', { ready, needed, executed, mcpVerified });
        (out.error ?? out.log)(message.replace(/\r?\n/g, ' '));
        setExitCode(1);
      }
    });
}
