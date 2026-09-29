import { describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerSetupCommand, type SetupCliDeps } from './setup-cli.js';
import { planClaudePluginSetup, type ClaudePluginSetupPlan } from './claude-plugin-setup.js';
import { debug } from '../debug/log.js';
import type { UserConfig } from '../user-config.js';

const ELANOUS_AUTH = JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'access', refreshToken: 'refresh' } } } });
const CODEX_AUTH = JSON.stringify({ tokens: { access_token: 'access', refresh_token: 'refresh' } });
const config = (provider?: string) => ({ llm: { provider } }) as UserConfig;

type SetupState = { elanous?: boolean; provider?: string; codex?: boolean; externalReady?: boolean; elanousAuth?: string; codexAuth?: string; answer?: string; nonInteractive?: boolean; stdinTty?: boolean; runtimeProvider?: string };

async function runSetup(state: SetupState = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const writes: UserConfig[] = [];
  const prompts: string[] = [];
  let doctorCalls = 0;
  let currentProvider = state.provider;
  const files = new Map<string, string>();
  if (state.elanous) files.set('/home/fake/.elanous/auth.json', state.elanousAuth ?? ELANOUS_AUTH);
  if (state.codex) files.set('/home/fake/.codex/auth.json', state.codexAuth ?? CODEX_AUTH);
  const program = new Command();
  registerSetupCommand(program, {
    homeDir: () => '/home/fake',
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing fake file: ${path}`);
      return value;
    },
    getUserConfig: () => config(currentProvider),
    saveUserConfig: (next) => { writes.push(next); currentProvider = next.llm.provider; },
    runDoctor: () => {
      doctorCalls += 1;
      return {
        ok: true,
        credentials: [],
        externalCommands: [{ name: 'codex', tier: 'required', status: state.externalReady === false ? 'missing' : 'found', breaks: 'Codex app-server integration' }],
      };
    },
    prompt: async (message) => { prompts.push(message); return state.answer; },
    isStdinTty: () => state.stdinTty === true,
    out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
    resolveRuntimeProvider: () => state.runtimeProvider,
  });
  await program.parseAsync(['node', 'elanous', 'setup', ...(state.nonInteractive === false ? [] : ['--non-interactive'])]);
  return { text: output.join('\n'), output, errors, exitCodes, writes, prompts, doctorCalls };
}

function section(text: string, heading: string, nextHeading?: string): string {
  const start = text.indexOf(heading);
  const end = nextHeading === undefined ? text.length : text.indexOf(nextHeading, start);
  return text.slice(start, end < 0 ? text.length : end);
}

const marketplaceCommand = ['claude', 'plugin', 'marketplace', 'add', 'ElanvitalAI/elanous'];
const pluginCommand = ['claude', 'plugin', 'install', 'elanous@elanous'];
const pluginPlan: ClaudePluginSetupPlan = {
  source: 'ElanvitalAI/elanous', claudeCode: true, node: true, elanous: true,
  marketplaceInstalled: false, pluginInstalled: false,
  steps: [{ command: marketplaceCommand, needed: true }, { command: pluginCommand, needed: true }], ready: false,
};

async function runClaudeSetup(args: string[], overrides: Partial<SetupCliDeps> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const plans: Array<{ source?: string }> = [];
  const applies: ClaudePluginSetupPlan[] = [];
  const program = new Command();
  registerSetupCommand(program, {
    planClaudePluginSetup: async (options = {}) => { plans.push(options); return pluginPlan; },
    applyClaudePluginSetup: async (plan) => {
      applies.push(plan);
      return { verification: { ...plan, marketplaceInstalled: true, pluginInstalled: true, ready: true }, mcpVerified: true, executed: [marketplaceCommand, pluginCommand], ok: true };
    },
    runDoctor: () => { throw new Error('legacy doctor must not run'); },
    getUserConfig: () => { throw new Error('credentials must not be read'); },
    saveUserConfig: () => { throw new Error('config must not be written'); },
    out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
    ...overrides,
  });
  await program.parseAsync(['node', 'elanous', 'setup', 'claude-code', ...args]);
  return { output, errors, exitCodes, plans, applies };
}

describe('setup Claude Code CLI', () => {
  test('planning shows both missing steps, checks prerequisites and stays read-only', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await runClaudeSetup([]);
      expect(result.plans).toEqual([{ source: undefined }]);
      expect(result.applies).toEqual([]);
      expect(result.output.filter((line) => line.includes('할 일'))).toEqual([
        `→ 할 일: ${marketplaceCommand.join(' ')}`, `→ 할 일: ${pluginCommand.join(' ')}`,
      ]);
      expect(result.output.at(-1)).toBe('--apply 로 실행');
      expect(result.exitCodes).toEqual([0]);
      expect(log).toHaveBeenCalledWith('setup.claude-code', 'planned', { ready: false, needed: 2, executed: undefined, mcpVerified: undefined });
    } finally { log.mockRestore(); }
  });

  test('prints the real planner command with the original source as one shell argument', async () => {
    const source = "/tmp/local marketplace's files";
    const plan = await planClaudePluginSetup({ source }, {
      has: () => true,
      run: async () => ({ exitCode: 0, stdout: '[]' }),
    });
    expect(plan.steps.map((step) => step.needed)).toEqual([true, true]);
    const result = await runClaudeSetup(['--source', source], {
      planClaudePluginSetup: async (options) => {
        expect(options).toEqual({ source });
        return plan;
      },
    });
    const tasks = result.output.filter((line) => line.startsWith('→ 할 일: '));
    expect(tasks).toHaveLength(2);
    for (const [index, line] of tasks.entries()) {
      const displayed = line.slice('→ 할 일: '.length);
      const parsed = spawnSync('bash', ['-c', `claude() { printf '%s\\n' "$@"; }; ${displayed}`], { encoding: 'utf8' });
      expect(parsed.status).toBe(0);
      expect(parsed.stdout.trimEnd().split('\n')).toEqual(plan.steps[index]!.command.slice(1));
    }
    expect(result.applies).toEqual([]);
    expect(result.exitCodes).toEqual([0]);
  });

  test('apply prints both executed commands and MCP verification, returning success', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await runClaudeSetup(['--apply']);
      expect(result.applies).toEqual([pluginPlan]);
      expect(result.output).toEqual([`✓ 실행: ${marketplaceCommand.join(' ')}`, `✓ 실행: ${pluginCommand.join(' ')}`, 'MCP 확인: ✓ 완료']);
      expect(result.exitCodes).toEqual([0]);
      expect(log).toHaveBeenCalledWith('setup.claude-code', 'applied', { ready: true, needed: 2, executed: 2, mcpVerified: true });
    } finally { log.mockRestore(); }
  });

  test('apply errors have one line without a stack and return failure', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let applyCalls = 0;
    try {
      const result = await runClaudeSetup(['--apply'], {
        applyClaudePluginSetup: async () => { applyCalls++; throw new Error('Claude Code is not installed'); },
      });
      expect(applyCalls).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors).toEqual(['Claude Code is not installed']);
      expect(result.errors.join('\n')).not.toContain('at ');
      expect(result.exitCodes).toEqual([1]);
      expect(log).toHaveBeenCalledWith('setup.claude-code', 'failed', { ready: false, needed: 2, executed: undefined, mcpVerified: undefined });
    } finally { log.mockRestore(); }
  });

  test('JSON emits the unmodified plan or application result in a single line; non-ok apply exits 1', async () => {
    const planned = await runClaudeSetup(['--json']);
    expect(planned.output).toEqual([JSON.stringify(pluginPlan)]);
    expect(planned.applies).toEqual([]);
    const verification = { ...pluginPlan, marketplaceInstalled: true, pluginInstalled: true, ready: true };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const applied = await runClaudeSetup(['--json', '--apply'], {
        applyClaudePluginSetup: async () => ({ verification, mcpVerified: false, executed: [marketplaceCommand], ok: false }),
      });
      expect(applied.output).toEqual([JSON.stringify({ verification, mcpVerified: false, executed: [marketplaceCommand], ok: false })]);
      expect(applied.exitCodes).toEqual([1]);
      expect(log).toHaveBeenCalledWith('setup.claude-code', 'failed', { ready: true, needed: 2, executed: 1, mcpVerified: false });
    } finally { log.mockRestore(); }
  });

  test('ready plan and absent prerequisites display the matching status lines', async () => {
    const ready = await runClaudeSetup([], { planClaudePluginSetup: async () => ({ ...pluginPlan, steps: pluginPlan.steps.map((step) => ({ ...step, needed: false })), ready: true }) });
    expect(ready.output).toContain('✓ 완료: claude');
    expect(ready.output.at(-1)).toBe('준비됨');
    const blocked = await runClaudeSetup([], { planClaudePluginSetup: async () => ({ ...pluginPlan, claudeCode: false, node: false, elanous: false }) });
    expect(blocked.output.filter((line) => line.startsWith('✗ 막힘:'))).toHaveLength(3);
    expect(blocked.applies).toEqual([]);
  });

  test('planning errors are one line and never apply', async () => {
    const result = await runClaudeSetup([], { planClaudePluginSetup: async () => { throw new Error('bad source\nsecond line'); } });
    expect(result.errors).toEqual(['bad source second line']);
    expect(result.applies).toEqual([]);
    expect(result.exitCodes).toEqual([1]);
  });
});

describe('setup CLI', () => {
  test('non-interactive calls doctor, shows its detailed command report and all guidance, never prompts or writes, and succeeds', async () => {
    const result = await runSetup({ externalReady: false });
    const originalReport = [
      'Setup: external command check',
      'Setup: LLM credential steps',
      'Non-interactive: no questions were asked and no configuration was written.',
      'Available now:',
      'Unavailable until setup is complete:',
    ];
    for (const line of originalReport) expect(result.text).toContain(line);
    expect(result.doctorCalls).toBe(1);
    expect(result.exitCodes).toEqual([0]);
    expect(result.prompts).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(result.text).toContain('codex: missing (required)');
    expect(result.text).toContain('Breaks: Codex app-server integration');
    expect(result.text).toContain('`elanous login openai-codex`');
    expect(result.text).toContain('`elanous config set llm.provider openai-codex`');
    expect(result.text).toContain('`codex login`');
    expect(result.text).toContain('No LLM provider available');
    expect(result.text).toContain('codex app-server stdin drain timeout');
    expect(result.text).toContain('Would ask: Set llm.provider to openai-codex now? [y/N]');
  });

  test('has no child-process or Bun.spawn execution boundary for browser-login commands', () => {
    const source = readFileSync(fileURLToPath(new URL('./setup-cli.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(/);
    expect(source).not.toContain('Bun.spawn');
  });

  test('reports all eight independent credential combinations with exactly their missing steps', async () => {
    for (const [elanous, provider, codex] of [
      [false, false, false], [false, false, true], [false, true, false], [false, true, true],
      [true, false, false], [true, false, true], [true, true, false], [true, true, true],
    ] as const) {
      const result = await runSetup({ elanous, provider: provider ? 'openai-codex' : undefined, codex });
      const expectedMissing = [
        !elanous && 'elanous OpenAI Codex login',
        !provider && 'LLM provider configuration',
        !codex && 'Codex CLI login',
      ].filter(Boolean);
      for (const name of expectedMissing) expect(result.text).toContain(`missing: ${name}`);
      expect((result.text.match(/^missing:/gm) ?? []).length).toBe(expectedMissing.length);
    }
  });

  test('rejects empty, malformed, and wrong-provider auth files as incomplete', async () => {
    for (const state of [
      { elanous: true, codex: true, elanousAuth: '', codexAuth: CODEX_AUTH },
      { elanous: true, codex: true, elanousAuth: '{', codexAuth: CODEX_AUTH },
      { elanous: true, codex: true, elanousAuth: JSON.stringify({ providers: { anthropic: { tokens: { accessToken: 'a', refreshToken: 'r' } } } }), codexAuth: CODEX_AUTH },
      { elanous: true, codex: true, elanousAuth: ELANOUS_AUTH, codexAuth: '{}' },
      { elanous: true, codex: true, elanousAuth: ELANOUS_AUTH, codexAuth: '{' },
      { elanous: true, codex: true, elanousAuth: ELANOUS_AUTH, codexAuth: JSON.stringify({ tokens: { access_token: 'a' } }) },
    ]) {
      const result = await runSetup({ ...state, provider: 'openai-codex' });
      expect(result.text).toMatch(/missing: (elanous OpenAI Codex login|Codex CLI login)/);
    }
  });

  test('writes provider exactly once only after consent and recomputes the final capabilities after the write', async () => {
    const accepted = await runSetup({ elanous: true, codex: true, answer: 'y', nonInteractive: false, stdinTty: true });
    const declined = await runSetup({ elanous: true, codex: true, answer: 'n', nonInteractive: false, stdinTty: true });
    expect(accepted.prompts).toHaveLength(1);
    expect(accepted.writes).toHaveLength(1);
    expect(accepted.writes[0]!.llm.provider).toBe('openai-codex');
    expect(section(accepted.text, 'Available now:', 'Unavailable until')).toContain('- OpenAI Codex-backed elanous sessions');
    expect(declined.writes).toEqual([]);
    expect(declined.text).toContain('Not changed. To complete LLM provider configuration');
  });

  test('places each named capability in exactly one list and includes required external commands in app-server readiness', async () => {
    const ready = await runSetup({ elanous: true, provider: 'openai-codex', codex: true });
    const missingCommands = await runSetup({ elanous: true, provider: 'openai-codex', codex: true, externalReady: false });
    const readyAvailable = section(ready.text, 'Available now:', 'Unavailable until');
    const readyUnavailable = section(ready.text, 'Unavailable until');
    const missingAvailable = section(missingCommands.text, 'Available now:', 'Unavailable until');
    const missingUnavailable = section(missingCommands.text, 'Unavailable until');
    expect(readyAvailable).toContain('- Codex app-server integration');
    expect(readyUnavailable).not.toContain('Codex app-server integration');
    expect(missingAvailable).not.toContain('Codex app-server integration');
    expect(missingUnavailable).toContain('- Codex app-server integration');
    expect(missingAvailable).not.toContain('External command-dependent integrations');
    expect(missingUnavailable).toContain('- External command-dependent integrations');
  });

  test('refuses a non-TTY stdin before asking, with a non-zero exit and the existing onboarding sentence plus the named non-interactive path', async () => {
    const result = await runSetup({ nonInteractive: false, stdinTty: false });
    expect(result.prompts).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(result.output).toEqual([]);
    expect(result.exitCodes).toEqual([1]);
    expect(result.errors).toEqual(['대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다. 무인 설정은 `elanous setup --non-interactive`를 사용하라.']);
    expect(result.errors.join('\\n')).not.toContain('at ');
  });

  // ⛔ 2026-09-23 — provider 단계는 «런타임 최종 결정»으로 잰다(Phase 3 의 거짓 손 ③).
  test('provider=auto 가 런타임에서 openai-codex 로 풀리면 «완료» — 설정하라고 하지 않고, 묻지도 않는다', async () => {
    const r = await runSetup({ elanous: true, codex: true, provider: 'auto', runtimeProvider: 'auto:openai-codex' });
    expect(r.text).toContain('completed: LLM provider configuration');
    expect(r.text).not.toContain('`elanous config set llm.provider openai-codex`');
    expect(r.text).not.toContain('Would ask');
    expect(section(r.text, 'Available now:', 'Unavailable until setup is complete:')).toContain('OpenAI Codex-backed elanous sessions');
  });

  test('대조군 — provider=auto 가 다른 provider(grok)로 풀리면 여전히 «미완»이다', async () => {
    const r = await runSetup({ elanous: true, codex: true, provider: 'auto', runtimeProvider: 'auto:grok' });
    expect(r.text).toContain('missing: LLM provider configuration');
  });
});
