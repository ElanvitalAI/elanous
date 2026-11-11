import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import { createPack } from '../knowledge/kgs/pack.js';
import { buildCliAgentTools, dispatchGuardedCliTool, isPotentiallyDestructiveShellCommand, runChatTurnCli, setCliConfirmBashCommandForTesting, setCliRunTurnForTesting } from './agent-cli.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleOnboardingRefusal, OnboardingRefusedError } from '../onboarding.js';
import { UNATTENDED_SETUP_COMMAND, unattendedSetupHint } from '../onboarding/entry-hints.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// Source: .rules/30-harness/testing-gates.md §R-TST36; deterministic dispatch fixtures use one accepted prompt and a short confirmation delay.
const dispatchFixture = {
  longPathRepeat: 140,
  readOffset: 123,
  zeroTokens: 0,
  confirmationCount: 2,
  acceptedPrompt: 1,
  // Source: .rules/30-harness/testing-gates.md §R-TST36; dispatch confirmation mutex allows only one active prompt.
  maxConcurrentConfirmations: 1,
  confirmDelayMs: 25,
} as const;

const root = new URL('../../', import.meta.url).pathname;
const fixture = new URL('./__fixtures__/agent-help-before/', import.meta.url);

test('CLI tool turn passes SIGINT cancellation to a running skill_exec result', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-cli-skill-cancel-'));
  const script = `
    const { runChatTurnCli } = await import('./src/cli/agent-cli.ts');
    const { setSkillExecIndexProvider } = await import('./src/tool-runtime/skill-exec-runtime.ts');
    const { setResearchInvoker } = await import('./src/research-bridge/invoke.ts');
    setSkillExecIndexProvider(() => [{
      name: 'omni-digest', description: 'test skill', triggers: [], extractedTriggers: [],
      triggerSource: 'none', autoTrigger: false, composes: [], skillDir: '/skills/omni-digest',
      rootDir: '/skills', sideEffects: 'none', cost: 'light',
    }]);
    setResearchInvoker(async () => new Promise(() => {}));
    await runChatTurnCli({
      cfg: { llm: { provider: 'auto', model: '' }, chat: { toolDeny: [] } },
      userText: 'research', explicitSessionId: undefined,
      reuseActive: false, forceNew: true, json: true, enableTools: true,
      runTurn: async ({ dispatchTool, sessionId }) => {
        const pending = dispatchTool('skill_exec', { skill: 'omni-digest', task: 'research' });
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 10);
        const result = await pending;
        return { text: JSON.stringify(result), provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] };
      },
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      // Source: .rules/30-harness/testing-gates.md §R-TST36; bound the cancellation subprocess under gate-pod load.
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: join(home, 'state') },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).reply).toContain('skill-exec-cancelled');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI chat keeps its default tools until a knowledge pack is installed, then cites that pack', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-cli-kpack-'));
  const dbPath = join(dir, 'kgs.db');
  const { setKgsDbPathOverride, _resetKgsStoreSingleton } = await import('../knowledge/kgs/sqlite-store.js');
  try {
    _resetKgsStoreSingleton();
    setKgsDbPathOverride(dbPath);
    expect(buildCliAgentTools().specs.some(spec => spec.name === 'KnowledgeQuery')).toBe(false);
    const store = new KgsSqliteStore(dbPath);
    try {
      const now = new Date().toISOString();
      store.writePack(createPack({ id: { slug: 'cli-sample', version: '0.1.0' }, title: 'CLI sample',
        intent: 'query test', audience: 'public', kind: 'generic', author: 'test', cards: [
          { schema_version: 2, id: 'content/source.md', createdAt: now, updatedAt: now,
            author: 'test', title: 'Sales source', body: 'CARD1 connects to CS1', nature: 'fact',
            kind: 'note', reliability: 'self-reported', source: { kind: 'external', url: 'https://example.org/' }, tags: [] },
        ] }));
    } finally { store.close(); }
    const tools = buildCliAgentTools();
    expect(tools.specs.some(spec => spec.name === 'KnowledgeQuery')).toBe(true);
    const result = await tools.dispatch('KnowledgeQuery', { pack_id: 'pack:cli-sample@0.1.0', question: 'CARD1' });
    expect(result).toMatchObject({ total: 1 });
    expect((result as { output: string }).output).toContain('[pack:cli-sample@0.1.0#content/source.md]');
  } finally {
    _resetKgsStoreSingleton();
    setKgsDbPathOverride(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt knowledge store does not break CLI chat tool assembly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-cli-kpack-corrupt-'));
  const dbPath = join(dir, 'kgs.db');
  writeFileSync(dbPath, 'this is not a sqlite database');
  const { setKgsDbPathOverride, _resetKgsStoreSingleton } = await import('../knowledge/kgs/sqlite-store.js');
  try {
    _resetKgsStoreSingleton();
    setKgsDbPathOverride(dbPath);
    const tools = buildCliAgentTools();
    expect(tools.specs.length).toBeGreaterThan(0);
    expect(tools.specs.some(spec => spec.name === 'KnowledgeQuery')).toBe(false);
  } finally {
    _resetKgsStoreSingleton();
    setKgsDbPathOverride(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

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
        // Source: .rules/30-harness/testing-gates.md §R-TST36; cap the real CLI subprocess duration.
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

  // FIRST-CHAT-NONTTY(#24511): a non-TTY first chat tries first run (subscription detection) instead of the old wizard
  // refusal. Detection must not reach the host — a Mac with a logged-in `claude` (keychain, not HOME) or `codex` on PATH
  // would read «ready» and call the LLM — so PATH keeps only bun and the system tools.
  test('unconfigured chat with closed stdin and no detectable LLM stops with the setup next step (rc 2), not the agent hint', () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-chat-cli-onboarding-'));
    const stateDir = join(home, 'state');
    const configDir = join(home, 'config');
    mkdirSync(stateDir);
    mkdirSync(configDir);
    try {
      // No host config or credential reaches the child: drop every elanous/provider variable, then add back only ours.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(ELANOUS_|ANTHROPIC_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CLAUDE|CODEX_|OPENROUTER_|LOCAL_LLM_)/.test(key)));
      // PATH holds only the tools the CLI needs (bun · git · sh) — never a logged-in `claude`/`codex` from the host.
      const bin = join(home, 'bin');
      mkdirSync(bin);
      for (const [name, target] of [['bun', process.execPath], ['git', Bun.which('git')], ['sh', Bun.which('sh')]] as const) {
        if (target) symlinkSync(target, join(bin, name));
      }
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${stateDir}`, 'chat', 'hi'], {
        cwd: root,
        env: { ...env, HOME: home, XDG_CONFIG_HOME: configDir, ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1', PATH: bin },
        // Source: .rules/30-harness/testing-gates.md §R-TST36; cap the real CLI subprocess duration.
        input: '', encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toContain(`다음: elanous setup llm (또는 ${UNATTENDED_SETUP_COMMAND})`);
      expect(`${result.stdout}${result.stderr}`).not.toContain('elanous agent needs a configured LLM');
      expect(result.stderr).not.toContain('unavailable');
      expect(result.stderr).not.toMatch(/^\s*at /m);
      expect(result.stdout).not.toMatch(/^\s*at /m);
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
      'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_KEY_CACHE_DIR',
    ]) delete withoutCredentials[key];
    // R4 (gate 0.2.30 pod-31): the gate baseline exports ELANOUS_TEST_FAKE_LLM=1 (scripts/lib/gate-test-env.ts), and the
    // fake provider is a real provider to resolveDefaultProvider — the «no provider» branch then never runs (exit 0).
    // '0' is the explicit opt-out the baseline preserves; this test is about the machine with nothing configured.
    withoutCredentials.ELANOUS_TEST_FAKE_LLM = '0';
    expect(withoutCredentials.XDG_CONFIG_HOME).toBeUndefined();
    try {
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${configDir}`, 'chat', '--new', '--json', 'hello'], {
        cwd: root,
        env: {
          ...withoutCredentials, HOME: home,
          ELANOUS_STATE_DIR: configDir, ELANOUS_SESSION_ROOT: join(home, 'sessions'),
        },
        // Source: .rules/30-harness/testing-gates.md §R-TST36; cap the provider-free CLI subprocess duration.
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
          // Source: .rules/30-harness/testing-gates.md §R-TST36; bound both JSON-mode subprocess probes.
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
    // 📏 10-22: #29738(필요할 때만 등록기 적재)이 정적 재수출을 lazy 래퍼(export const … = …import('./cli/agent-cli.js'))로 바꿨다 — 세 이름이 그대로 index 에서 나가는지 문다.
    for (const name of ['runChatTurnCli', 'buildCliAgentTools', 'setCliAgentDispatchForTesting']) {
      expect(index).toMatch(new RegExp(`export (?:const ${name}\\b|\\{[^}]*\\b${name}\\b)`));
    }
  });
});

test('agent --json exits after the completed turn even when a background handle remains', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-agent-cli-exit-'));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
  }));
  const script = `
    process.argv = ['bun', 'elanous', 'agent', '--json', 'hello'];
    const { Command } = await import('commander');
    const { registerAgentCommands, setCliRunTurnForTesting } = await import(${JSON.stringify(new URL('./agent-cli.ts', import.meta.url).href)});
    setCliRunTurnForTesting(async ({ sessionId }) => {
      setInterval(() => {}, 10_000);
      return { text: 'completed reply', provider: 'test', model: 'test',
        meta: { id: sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] };
    });
    const program = new Command();
    registerAgentCommands(program);
    await program.parseAsync(process.argv);
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', timeout: 8_000,
      env: { ...process.env, HOME: home, ELANOUS_CONFIG_DIR: stateDir,
        ELANOUS_STATE_DIR: stateDir, NODE_ENV: 'test', TEST_STATE_DIR: stateDir },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).reply).toBe('completed reply');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test('CLI goal-loop includes RFC-first discipline before the tool/model turn for a new-project request', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-cli-rfc-first-'));
  const stateDir = join(home, '.elanous-test');
  const capturePath = join(home, 'turn.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
  }));
  const request = '빈 저장소에서 책 기록 CLI를 만들어 줘. 책 제목과 저자를 추가하고 목록을 보고 읽음 상태를 바꾸고 삭제할 수 있게 해 줘. JSON 파일에 저장하고 시험과 실행 안내도 포함해 줘.';
  const script = `
    const { writeFileSync } = await import('node:fs');
    process.argv = ['bun', 'elanous', '--test=' + process.env.TEST_STATE_DIR,
      'chat', '--new', '--json', '--tools', '--goal-loop', ${JSON.stringify(request)}];
    const { setCliRunTurnForTesting } = await import(${JSON.stringify(new URL('./agent-cli.ts', import.meta.url).href)});
    setCliRunTurnForTesting(async (turn) => {
      writeFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify({
        systemPrompt: turn.systemPrompt,
        toolNames: turn.tools?.map((tool) => tool.name) ?? [],
        goalLoop: turn.goalLoop ?? false,
      }));
      return { text: 'RFC 초안을 제시하고 승인을 기다립니다.', provider: 'test', model: 'test',
        meta: { id: turn.sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] };
    });
    const { program } = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
    await program.parseAsync(process.argv);
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...process.env, HOME: home, ELANOUS_CONFIG_DIR: stateDir,
        ELANOUS_STATE_DIR: stateDir, NODE_ENV: 'test', ELANOUS_TEST_FAKE_LLM: '0',
        TEST_STATE_DIR: stateDir, TEST_CAPTURE_PATH: capturePath },
      // Source: .rules/30-harness/testing-gates.md §R-TST36; bound the production CLI process probe.
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const turn = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      systemPrompt: string; toolNames: string[]; goalLoop: boolean;
    };
    expect(turn.systemPrompt.includes('# 새 프로젝트 구현 요청 — RFC 먼저')).toBe(true);
    expect(turn.systemPrompt.includes('앱 코드·프로젝트 설정을 쓰거나 시험을 실행하기 전에')).toBe(true);
    expect(turn.systemPrompt.includes('명시적 승인을 요청하세요')).toBe(true);
    expect(turn.systemPrompt.includes('승인 전에는 애플리케이션 코드·설정을 만들거나 시험을 실행하지 마세요')).toBe(true);
    expect(turn.toolNames.length).toBeGreaterThan(0);
    expect(turn.goalLoop).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('terminal do destructive-command gate', () => {
  test('requires confirmation for unknown programs, shell composition, and mutation commands', () => {
    for (const command of [
      'kill 123', 'rm -rf ./cache', 'cp new.json config.json', 'echo data > config.json',
      'git reset --hard', 'git checkout .', 'python -c "import shutil; shutil.rmtree(\'data\')"',
      'find . -exec rm -rf {} +', 'find . -fprint0 output.txt', 'ps aux | grep node', 'ls\nrm -rf data', 'sort -oFILE input',
      'find . \'-delete\'', 'rg --pre rm needle file', 'rg --pre=rm needle file',
      "rg '--pre' rm needle file", "rg --p''re rm needle file", 'git diff --ext-diff', 'git diff --textconv',
      'git diff', 'git show --ext-diff HEAD', 'git log -p --ext-diff -1',
      'sort --compress-program=/tmp/evil -S1 input', 'sort --compress-program /tmp/evil -S1 input',
      'sort --compress-prog=/tmp/evil -S1 input', 'sort --compress-p /tmp/evil -S1 input',
      'sort', 'find . -exec rm -rf {} +', 'xargs rm', 'ls -R .', 'ps aux --forest', 'cat config.json',
    ]) {
      expect(isPotentiallyDestructiveShellCommand(command)).toBe(true);
    }
  });

  test('allows read-only inspection commands without a confirmation prompt', () => {
    for (const command of [
      'pwd', 'pwd -P', 'ls -lah src', 'ps aux', 'ps -ef', 'df -h', 'du -sh src', 'uname -a', 'which bun',
      'git status --short --branch', 'git branch --show-current', 'git rev-parse --show-toplevel',
    ]) {
      expect(isPotentiallyDestructiveShellCommand(command)).toBe(false);
    }
  });

  test('the shared do dispatcher blocks indirect writes on decline and dispatches after approval', async () => {
    const destructiveCommands = [
      "python3 -c \"import shutil; shutil.rmtree('data')\"", 'git checkout .', 'ls\nrm -rf data',
      'sort -oFILE input', 'find . -fprint0 output.txt',
    ];
    let dispatchCount = 0;
    let confirmationCount = 0;
    for (const command of destructiveCommands) {
      const result = await dispatchGuardedCliTool({
        name: 'Bash', args: { command }, allowedToolNames: ['Bash'],
        confirmBashCommand: async () => { confirmationCount += 1; return false; },
        dispatch: async () => { dispatchCount += 1; return 'ran'; },
      });
      expect(result).toEqual({ error: 'Execution declined by the user; do not retry or rephrase this destructive command.' });
    }
    expect(confirmationCount).toBe(destructiveCommands.length);
    expect(dispatchCount).toBe(0);

    const approved = await dispatchGuardedCliTool({
      name: 'Bash', args: { command: 'touch marker' }, allowedToolNames: ['Bash'],
      confirmBashCommand: async () => true,
      dispatch: async () => { dispatchCount += 1; return 'approved'; },
    });
    expect(approved).toBe('approved');
    expect(dispatchCount).toBe(1);
  });

  test('a declined command aborts the turn before a rewritten command can dispatch', async () => {
    const controller = new AbortController();
    let dispatchCount = 0;
    const declined = await dispatchGuardedCliTool({
      name: 'Bash', args: { command: 'rm -rf data' }, allowedToolNames: ['Bash'],
      signal: controller.signal, abortTurn: () => controller.abort(),
      confirmBashCommand: async () => false,
      dispatch: async () => { dispatchCount += 1; return 'ran'; },
    });
    const rewritten = await dispatchGuardedCliTool({
      name: 'Bash', args: { command: 'python3 -c "import shutil; shutil.rmtree(\'data\')"' },
      allowedToolNames: ['Bash'], signal: controller.signal,
      confirmBashCommand: async () => true,
      dispatch: async () => { dispatchCount += 1; return 'ran'; },
    });
    expect(declined).toEqual({ error: 'Execution declined by the user; do not retry or rephrase this destructive command.' });
    expect(rewritten).toEqual({ error: 'Execution stopped after a declined command; no further tools will be dispatched.' });
    expect(dispatchCount).toBe(0);
  });

  test('a concurrent approval cannot dispatch after another command is declined', async () => {
    const controller = new AbortController();
    let approveWaitingCall!: (accepted: boolean) => void;
    const waitingApproval = new Promise<boolean>(resolve => { approveWaitingCall = resolve; });
    let dispatchCount = 0;
    const waiting = dispatchGuardedCliTool({
      name: 'Bash', args: { command: 'rm first.txt' }, allowedToolNames: ['Bash'],
      signal: controller.signal, abortTurn: () => controller.abort(),
      confirmBashCommand: async () => waitingApproval,
      dispatch: async () => { dispatchCount += 1; return 'ran'; },
    });
    const declined = await dispatchGuardedCliTool({
      name: 'Bash', args: { command: 'rm second.txt' }, allowedToolNames: ['Bash'],
      signal: controller.signal, abortTurn: () => controller.abort(),
      confirmBashCommand: async () => false,
      dispatch: async () => { dispatchCount += 1; return 'ran'; },
    });
    approveWaitingCall(true);
    const lateApproval = await waiting;
    expect(declined).toEqual({ error: 'Execution declined by the user; do not retry or rephrase this destructive command.' });
    expect(lateApproval).toEqual({ error: 'Execution stopped after a declined command; no further tools will be dispatched.' });
    expect(dispatchCount).toBe(0);
  });

  test('agent CLI production dispatch confirms each obfuscated mutation through simCli', async () => {
    const dispatchHome = mkdtempSync(join(tmpdir(), 'elanous-do-dispatch-'));
    const marker = join(dispatchHome, 'must-not-exist');
    const tracked = join(dispatchHome, 'tracked.txt');
    writeFileSync(join(dispatchHome, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
    }));
    // Source: src/cli/agent-cli.ts truncateArgsForLog caps argument previews at 120 characters.
    const longReadPath = `read-${'x'.repeat(dispatchFixture.longPathRepeat)}.md`;
    writeFileSync(tracked, 'baseline\n');
    writeFileSync(join(dispatchHome, longReadPath), 'long read target\n');
    writeFileSync(tracked, 'modified\n');
    const commands = [
      `rg --p''re rm needle '${tracked}'`,
      `rg '--pre' rm needle '${tracked}'`,
      `rg --pre rm needle '${tracked}'`,
      `find . '-delete'`,
      `touch '${marker}'`,
      `python3 -c "from pathlib import Path; Path('${marker}').touch()"`,
      'printf safe\nprintf still-safe',
      `sort -o'${marker}' /dev/null`,
      `git diff --ext-diff --no-index /dev/null '${tracked}'`,
      'git show --ext-diff HEAD',
      'git log -p --ext-diff -1',
      'sort --compress-program=./compress-program -S1 /dev/null',
      'sort --compress-prog=./compress-program -S1 /dev/null',
      'git checkout .',
    ];
    const confirmations: string[] = [];
    const results: unknown[] = [];
    let readResult: unknown;
    let readArgs: { file_path: string; offset: number } | undefined;
    try {
      setCliConfirmBashCommandForTesting(async requested => { confirmations.push(requested); return false; });
      for (const [index, command] of commands.entries()) {
        setCliRunTurnForTesting(async ({ dispatchTool, onToolCall, onDelta, sessionId }) => {
          if (!dispatchTool) throw new Error('production tool dispatcher was not provided');
          onToolCall?.({ id: `textless-plan-${index}`, name: 'Bash', args: { command } });
          const dispatchResult = await dispatchTool('Bash', { command });
          results.push(dispatchResult);
          const reply = JSON.stringify(dispatchResult);
          onDelta?.(reply);
          return { text: reply, provider: 'test', model: 'test',
            meta: { id: sessionId }, usedTokens: dispatchFixture.zeroTokens, droppedMessages: dispatchFixture.zeroTokens, memoryIds: [] };
        });
        const result = await simCli(['agent', '--json', 'inspect safely'], {
          cwd: dispatchHome, configRoot: dispatchHome, allowPaths: [['agent']], env: {
            HOME: dispatchHome, NODE_ENV: 'test', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external',
            GIT_CONFIG_VALUE_0: `touch ${marker}`,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      }
      setCliRunTurnForTesting(async ({ dispatchTool, onToolCall, onDelta, sessionId }) => {
        if (!dispatchTool) throw new Error('production tool dispatcher was not provided');
        const args = { file_path: longReadPath, offset: dispatchFixture.readOffset };
        readArgs = args;
        onToolCall?.({ id: 'textless-read-plan', name: 'Read', args });
        readResult = await dispatchTool('Read', args);
        onDelta?.('Read plan displayed.');
        return { text: 'Read plan displayed.', provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: dispatchFixture.zeroTokens, droppedMessages: dispatchFixture.zeroTokens, memoryIds: [] };
      });
      const result = await simCli(['agent', '--json', 'inspect safely'], {
        cwd: dispatchHome, configRoot: dispatchHome, allowPaths: [['agent']], env: {
          HOME: dispatchHome, NODE_ENV: 'test', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external',
          GIT_CONFIG_VALUE_0: `touch ${marker}`,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(confirmations).toEqual(commands);
      expect(results).toHaveLength(commands.length);
      expect(results.every(item => (item as { error?: string }).error?.includes('Execution declined by the user'))).toBe(true);
      expect(readResult).toBeDefined();
      expect(readArgs).toEqual({ file_path: longReadPath, offset: dispatchFixture.readOffset });
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(tracked, 'utf8')).toBe('modified\n');
    } finally {
      setCliRunTurnForTesting(undefined);
      setCliConfirmBashCommandForTesting(undefined);
      rmSync(dispatchHome, { recursive: true, force: true });
    }
  });

  test('agent CLI serializes concurrent destructive confirmations through simCli', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-do-confirm-queue-'));
    const first = join(home, 'first-marker');
    const second = join(home, 'second-marker');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      llm: { provider: 'auto', model: '', memoryJudge: { enabled: false } },
    }));
    let active = 0;
    let maxActive = dispatchFixture.zeroTokens;
    let promptCount = 0;
    const dispatchResults: unknown[] = [];
    const commands = [`touch '${first}'`, `touch '${second}'`];
    try {
      setCliConfirmBashCommandForTesting(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const prompt = ++promptCount;
        await new Promise(resolve => setTimeout(resolve, dispatchFixture.confirmDelayMs));
        active -= 1;
        return prompt === dispatchFixture.acceptedPrompt;
      });
      setCliRunTurnForTesting(async ({ dispatchTool, onToolCall, onDelta, sessionId }) => {
        if (!dispatchTool) throw new Error('production tool dispatcher was not provided');
        const dispatched = await Promise.all(commands.map((command, index) => {
          onToolCall?.({ id: `concurrent-${index}`, name: 'Bash', args: { command } });
          return dispatchTool('Bash', { command });
        }));
        dispatchResults.push(...dispatched);
        const reply = JSON.stringify(dispatched);
        onDelta?.(reply);
        return { text: reply, provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: dispatchFixture.zeroTokens,
          droppedMessages: dispatchFixture.zeroTokens, memoryIds: [] };
      });
      const result = await simCli(['agent', '--json', 'inspect safely'], {
        cwd: home, configRoot: home, allowPaths: [['agent']], env: { HOME: home, NODE_ENV: 'test' },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(maxActive).toBe(dispatchFixture.maxConcurrentConfirmations);
      expect(promptCount).toBe(dispatchFixture.confirmationCount);
      expect(dispatchResults).toHaveLength(dispatchFixture.confirmationCount);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(false);
      expect((dispatchResults[1] as { error?: string }).error).toContain('Execution declined by the user');
    } finally {
      setCliRunTurnForTesting(undefined);
      setCliConfirmBashCommandForTesting(undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
