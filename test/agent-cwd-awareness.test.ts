import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUniversalPreamble } from '../src/prompt-library/universal-preamble.js';
import { buildReplSystemPrompt, buildReplTools, runRepl } from '../src/repl/index.js';
import { dispatchGlob } from '../src/skills/tools/glob.js';
import { __resetSessionWorkingDir, getSessionCwd, initSessionWorkingDir, setSessionCwd } from '../src/session/working-dir.js';
import { buildUserConfig } from '../src/user-config.js';
import * as chatModule from '../src/session/chat.js';
import type { UserConfig } from '../src/user-config/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'elanous-cwd-awareness-')); });
afterEach(() => {
  __resetSessionWorkingDir();
  rmSync(root, { recursive: true, force: true });
});

function environment(cwd: string): string {
  return buildUniversalPreamble({ cwd })
    .map(message => String(message.content))
    .find(content => content.includes('## Environment\n'))!;
}

test('Environment names the absolute session directory separately from its Git root and branch', () => {
  const nested = join(root, 'src', 'feature');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/cwd\n');
  const text = environment(nested);
  expect(text).toContain(`Working directory: ${JSON.stringify(nested)}`);
  expect(text).toContain(`Git root: ${JSON.stringify(root)}`);
  expect(text).toContain('Branch: "feature/cwd"');
  expect(text).toContain('"Here" and relative file paths refer to the working directory above');
});

test('linked worktree HEAD is read without requiring a Git command', () => {
  const gitDir = join(root, 'worktree-gitdir');
  const checkout = join(root, 'checkout');
  mkdirSync(gitDir);
  mkdirSync(checkout);
  writeFileSync(join(checkout, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/res/cwd-awareness\n');
  const text = environment(checkout);
  expect(text).toContain(`Git root: ${JSON.stringify(checkout)}`);
  expect(text).toContain('Branch: "res/cwd-awareness"');
});

test('non-Git directory remains an explicit working directory without inventing a branch', () => {
  const text = environment(root);
  expect(text).toContain(`Working directory: ${JSON.stringify(root)}`);
  expect(text).toContain('Git root: (none)');
  expect(text).toContain('Branch: (none)');
});

test('a Git root with unreadable HEAD reports an unknown branch', () => {
  mkdirSync(join(root, '.git'));
  const text = environment(root);
  expect(text).toContain(`Git root: ${JSON.stringify(root)}`);
  expect(text).toContain('Branch: (unknown)');
});

test('REPL prompt uses its supplied session directory rather than the process boot directory', () => {
  const nested = join(root, 'active');
  mkdirSync(nested);
  const cfg = { llm: { model: '' }, chat: { conciseness: 'balanced', toolDeny: [] } } as unknown as UserConfig;
  const prompt = buildReplSystemPrompt({ cfg, enabledToolNames: [], cwd: nested }) ?? '';
  expect(prompt).toContain(`Working directory: ${JSON.stringify(nested)}`);
});

test('a later turn reflects a changed session directory and branch without process.chdir', () => {
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(join(first, '.git'), { recursive: true });
  mkdirSync(second);
  writeFileSync(join(first, '.git', 'HEAD'), 'ref: refs/heads/old\n');
  const cfg = { llm: { model: '' }, chat: { conciseness: 'balanced', toolDeny: [] } } as unknown as UserConfig;
  setSessionCwd(first, 'user');
  const firstPrompt = buildReplSystemPrompt({ cfg, enabledToolNames: [], cwd: getSessionCwd() }) ?? '';
  expect(firstPrompt).toContain('Branch: "old"');
  writeFileSync(join(first, '.git', 'HEAD'), 'ref: refs/heads/new\n');
  const nextPrompt = buildReplSystemPrompt({ cfg, enabledToolNames: [], cwd: getSessionCwd() }) ?? '';
  expect(nextPrompt).toContain('Branch: "new"');
  setSessionCwd(second, 'user');
  const movedPrompt = buildReplSystemPrompt({ cfg, enabledToolNames: [], cwd: getSessionCwd() }) ?? '';
  expect(movedPrompt).toContain(`Working directory: ${JSON.stringify(second)}`);
  expect(movedPrompt).not.toContain(`Working directory: ${JSON.stringify(first)}`);
});

test('REPL Bash dispatch uses session cwd even though process cwd stays at boot', async () => {
  const active = join(root, 'active');
  mkdirSync(active);
  setSessionCwd(active, 'user');
  let dispatchedCwd: string | undefined;
  const repl = buildReplTools({
    dispatchBash: async (_args, options) => {
      dispatchedCwd = options.cwd;
      return { ok: true };
    },
  });
  expect(await repl.dispatch('Bash', { command: 'pwd' })).toEqual({ ok: true });
  expect(dispatchedCwd).toBe(active);
  expect(process.cwd()).not.toBe(active);
});

test('Glob resolves a relative path from session cwd and preserves an explicit absolute path', async () => {
  const active = join(root, 'active');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(join(active, 'src'), { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(join(active, 'src', 'active.ts'), 'export {};\n');
  writeFileSync(join(elsewhere, 'elsewhere.ts'), 'export {};\n');
  setSessionCwd(active, 'user');
  expect(getSessionCwd()).toBe(active);
  const relative = await dispatchGlob({ pattern: '*.ts', path: 'src' });
  expect(relative.output).toContain(join(active, 'src', 'active.ts'));
  expect(relative.output).not.toContain('elsewhere.ts');
  const absolute = await dispatchGlob({ pattern: '*.ts', path: elsewhere });
  expect(absolute.output).toContain(join(elsewhere, 'elsewhere.ts'));
  expect(absolute.output).not.toContain('active.ts');
});

test('actual runRepl refreshes the prompt between two turns after a session cwd switch', async () => {
  const first = join(root, 'first');
  const second = join(root, 'second');
  const state = join(root, 'state');
  mkdirSync(first);
  mkdirSync(second);
  mkdirSync(state);
  const cfgPath = join(root, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ onboarding: { completed: true }, llm: { provider: 'local', model: 'fake-local' } }));
  const cfg = buildUserConfig(cfgPath);
  expect(cfg.llm.provider).toBe('local');
  const scenarioPath = join(root, 'two-turns.yaml');
  writeFileSync(scenarioPath, 'turns:\n  - id: first\n    prompt: first fake turn\n  - id: second\n    prompt: second fake turn\n');
  const priorState = process.env.ELANOUS_STATE_DIR;
  const priorConfig = process.env.ELANOUS_CONFIG_DIR;
  const priorMode = process.env.ELANOUS_LLM_MODE;
  const priorFake = process.env.ELANOUS_TEST_FAKE_LLM;
  process.env.ELANOUS_STATE_DIR = state;
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_LLM_MODE = 'fake';
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  initSessionWorkingDir(first);
  const prompts: string[] = [];
  const runTurn = spyOn(chatModule, 'runTurn').mockImplementation(async options => {
    prompts.push(options.systemPrompt ?? '');
    if (prompts.length === 1) setSessionCwd(second, 'tool');
    return { text: 'fake reply', provider: 'test-stub', model: 'fake-local' } as never;
  });
  try {
    const exitCode = await runRepl({
      cfg, initialSessionId: undefined, forceNew: true, enableTools: true,
      scenarioPath, scriptedFromStdin: false, jsonOutput: true, exitAfterScenario: true,
    });
    expect(exitCode).toBe(0);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain(`Working directory: ${JSON.stringify(first)}`);
    expect(prompts[1]).toContain(`Working directory: ${JSON.stringify(second)}`);
    expect(prompts[1]).not.toContain(`Working directory: ${JSON.stringify(first)}`);
  } finally {
    runTurn.mockRestore();
    if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorState;
    if (priorConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = priorConfig;
    if (priorMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = priorMode;
    if (priorFake === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
    else process.env.ELANOUS_TEST_FAKE_LLM = priorFake;
  }
}, 15_000);
