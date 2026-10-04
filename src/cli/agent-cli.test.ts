import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleOnboardingRefusal, OnboardingRefusedError } from '../onboarding.js';
import { unattendedSetupHint } from '../onboarding/entry-hints.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = new URL('../../', import.meta.url).pathname;
const fixture = new URL('./__fixtures__/agent-help-before/', import.meta.url);

describe('agent CLI onboarding refusal', () => {
  test('unconfigured agent with closed stdin exits 2 with one English stderr hint and no stack', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-agent-cli-onboarding-'));
    const stateDir = join(home, 'state');
    const configDir = join(home, 'config');
    mkdirSync(stateDir);
    mkdirSync(configDir);
    try {
      const env = { ...process.env };
      for (const key of ['XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR', 'ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_RUN_CONTEXT']) delete env[key];
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${stateDir}`, 'agent', 'hi'], {
        cwd: root,
        env: { ...env, HOME: home, XDG_CONFIG_HOME: configDir, ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
        input: '', encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toBe(`elanous agent needs a configured LLM. Run \`elanous onboarding\` in a terminal, or ${unattendedSetupHint()} for unattended setup.\n`);
      expect(result.stderr).not.toContain('onboarding.ts');
      expect(result.stderr).not.toMatch(/^\s*at /m);
      expect(result.stderr).not.toContain('Bun v');
      expect(result.stdout).not.toContain('onboarding.ts');
      expect(result.stdout).not.toMatch(/^\s*at /m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('unconfigured chat with closed stdin preserves its refusal instead of the agent hint', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-chat-cli-onboarding-'));
    const stateDir = join(home, 'state');
    const configDir = join(home, 'config');
    mkdirSync(stateDir);
    mkdirSync(configDir);
    try {
      const env = { ...process.env };
      for (const key of ['ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_RUN_CONTEXT']) delete env[key];
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${stateDir}`, 'chat', 'hi'], {
        cwd: root,
        env: { ...env, HOME: home, XDG_CONFIG_HOME: configDir, ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
        input: '', encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다.');
      expect(result.stderr).not.toContain('elanous agent needs a configured LLM');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('autonomous empty-universe refusal retains its materialization diagnosis', () => {
    const error = new OnboardingRefusedError('자식 우주가 물질화되지 않았다', 'autonomous-empty-universe');
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    try {
      expect(error.code).toBe('onboarding-refused');
      for (const entrance of ['agent', 'other'] as const) {
        expect(handleOnboardingRefusal(error, entrance)).toBe(true);
        expect(stderr).toHaveBeenCalledWith(error.message);
        expect(process.exitCode).toBe(2);
      }
    } finally {
      stderr.mockRestore();
      process.exitCode = before ?? 0;
    }
  });
});

test('unrelated errors are not handled as onboarding refusals', () => {
  const before = process.exitCode;
  try {
    expect(handleOnboardingRefusal(new Error('synthetic unrelated failure'), 'agent')).toBe(false);
    expect(process.exitCode).toBe(before);
  } finally {
    process.exitCode = before ?? 0;
  }
});

describe('agent CLI chat-turn errors', () => {
  const runFailure = (message: string) => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-agent-cli-error-'));
    const script = `
      const { runChatTurnCli } = await import('./src/cli/agent-cli.ts');
      await runChatTurnCli({
        cfg: { llm: { provider: 'auto', model: '' }, chat: { toolDeny: [] } },
        userText: 'hello', explicitSessionId: undefined,
        reuseActive: false, forceNew: true, json: true,
        runTurn: async () => { throw new Error(process.env.TEST_TURN_ERROR); },
      });
    `;
    try {
      return spawnSync(process.execPath, ['-e', script], {
        cwd: root,
        env: {
          ...process.env, HOME: home, ELANOUS_STATE_DIR: join(home, 'state'),
          TEST_TURN_ERROR: message,
        },
        encoding: 'utf8',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test('real chat CLI with no provider emits only setup guidance on stderr and exits 2', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-agent-cli-no-provider-'));
    const configDir = join(home, 'state');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
    }));
    const withoutCredentials = { ...process.env };
    delete withoutCredentials.XDG_CONFIG_HOME;
    for (const key of [
      'XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'OPENROUTER_API_KEY', 'LOCAL_LLM_URL', 'CODEX_HOME', 'ELANOUS_HARNESS_SPACE',
      'ELANOUS_HARNESS_SPACE_ID',
    ]) delete withoutCredentials[key];
    expect(withoutCredentials.XDG_CONFIG_HOME).toBeUndefined();
    try {
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${configDir}`, 'chat', '--new', '--json', 'hello'], {
        cwd: root,
        env: {
          ...withoutCredentials, HOME: home,
          ELANOUS_STATE_DIR: configDir, ELANOUS_SESSION_ROOT: join(home, 'sessions'),
        },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      // #22294: with --json the dev pipeline's «[dev] …» progress lines go to stderr; the guidance is everything else.
      expect(result.stderr.split('\n').filter((line) => !line.startsWith('[dev] ')).join('\n')).toBe('No LLM provider available. Run `elanous setup` — with a subscription, `elanous login openai-codex` then `elanous config set llm.provider openai-codex`; with API keys, set XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or LOCAL_LLM_URL.\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('unexpected errors starting with the setup guidance still propagate with a stack', () => {
    const result = runFailure('No LLM provider available. unexpected turn failure');
    expect(result.status).not.toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: No LLM provider available. unexpected turn failure');
    expect(result.stderr).toContain('at runChatTurnCli (');
  });

  test('unexpected turn errors still propagate with a stack and non-setup exit', () => {
    const result = runFailure('unexpected turn failure');
    expect(result.status).not.toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: unexpected turn failure');
    expect(result.stderr).toContain('at runChatTurnCli (');
  });
});

describe('CLI conversation-start project suggestion', () => {
  test('a matching folder prints one suggestion without assigning the session, while JSON stays one line', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-cli-project-suggestion-'));
    const folder = join(home, 'workspace');
    const configDir = join(home, 'state');
    const projectId = '15b877b0-82df-466a-9c94-374929ad2f7f';
    mkdirSync(folder);
    mkdirSync(join(configDir, 'projects'), { recursive: true });
    writeFileSync(join(configDir, 'projects', `${projectId}.yaml`),
      `id: ${projectId}\nname: Workspace\nprimaryFolder: ${folder}\ncreatedAt: '2026-01-01T00:00:00.000Z'\n`);
    const script = `
      const { runChatTurnCli } = await import(${JSON.stringify(new URL('./agent-cli.ts', import.meta.url).href)});
      await runChatTurnCli({
        cfg: { llm: { provider: 'auto', model: '' }, chat: { toolDeny: [] } },
        userText: 'hello', explicitSessionId: undefined,
        reuseActive: false, forceNew: true, json: process.env.TEST_JSON === '1',
        runTurn: async ({ sessionId }) => ({ text: 'reply', provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] }),
      });
    `;
    try {
      for (const json of [false, true]) {
        const result = spawnSync(process.execPath, ['-e', script], {
          cwd: folder, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, HOME: home, ELANOUS_CONFIG_DIR: configDir,
            ELANOUS_STATE_DIR: join(home, 'state'), TEST_JSON: json ? '1' : '0' },
        });
        expect(result.status, result.stderr).toBe(0);
        if (json) {
          expect(JSON.parse(result.stdout).reply).toBe('reply');
          expect(result.stdout.trim().split('\n')).toHaveLength(1);
          expect(result.stdout).not.toContain('Project suggestion:');
        } else {
          expect(result.stdout.split('Project suggestion: Workspace').length - 1).toBe(1);
          expect(result.stdout).toContain('reply');
        }
      }
      const sessions = JSON.parse(readFileSync(join(home, 'state', 'sessions', 'index.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(sessions).toHaveLength(2);
      for (const session of sessions) expect(session).not.toHaveProperty('projectId');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('agent CLI extraction', () => {
  for (const name of ['root', 'agent', 'registry', 'tier'] as const) {
    test(`${name} --help remains byte-identical`, () => {
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', ...(name === 'root' ? [] : [name]), '--help'], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      if (name === 'root') {
        // 루트 도움말은 명령이 늘 때마다 바뀐다 — 분리 회귀 가드가 보는 것은 «agent 줄이 그대로인가» 뿐이다.
        const agentLine = (text: string) => text.split('\n').filter((line) => /^\s+agent(\s|\||$)/.test(line));
        expect(agentLine(result.stdout.toString())).toEqual(agentLine(readFileSync(new URL('root.txt', fixture), 'utf8')));
        return;
      }
      expect(result.stdout.equals(readFileSync(new URL(`${name}.txt`, fixture)))).toBe(true);
    });
  }

  test('registration stays at the original slot, outside local, without an index import cycle', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const agent = readFileSync(new URL('./agent-cli.ts', import.meta.url), 'utf8');
    expect(index).toContain('registerAgentCommands(program);');
    expect(index.indexOf('registerAgentCommands(program);')).toBeLessThan(index.indexOf(".command('local')"));
    expect(index).not.toMatch(/\.command\('(agent|registry|tier)'\)/);
    expect(agent).not.toMatch(/from ['"]\.\.\/index\.js['"]/);
    expect(index).toContain("export { runChatTurnCli, buildCliAgentTools, setCliAgentDispatchForTesting");
  });
});
