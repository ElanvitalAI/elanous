import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const fixture = new URL('./__fixtures__/agent-help-before/', import.meta.url);

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
      expect(result.stderr).toBe('No LLM provider available. Run `elanous setup` — with a subscription, `elanous login openai-codex` then `elanous config set llm.provider openai-codex`; with API keys, set XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or LOCAL_LLM_URL.\n');
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
