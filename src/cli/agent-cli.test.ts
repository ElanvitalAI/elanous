import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import { createPack } from '../knowledge/kgs/pack.js';
import { buildCliAgentTools, runChatTurnCli } from './agent-cli.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleOnboardingRefusal, OnboardingRefusedError } from '../onboarding.js';
import { UNATTENDED_SETUP_COMMAND, unattendedSetupHint } from '../onboarding/entry-hints.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = new URL('../../', import.meta.url).pathname;
const fixture = new URL('./__fixtures__/agent-help-before/', import.meta.url);

test('CLI tool turn passes SIGINT cancellation to a running skill_exec result', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-cli-skill-cancel-'));
  const script = `
    const { runChatTurnCli } = await import('./src/cli/agent-cli.ts');
    const { setResearchInvoker } = await import('./src/research-bridge/invoke.ts');
    setResearchInvoker(async () => new Promise(() => {}));
    await runChatTurnCli({
      cfg: { llm: { provider: 'auto', model: '' }, chat: { toolDeny: [] } },
      userText: 'research', explicitSessionId: undefined,
      reuseActive: false, forceNew: true, json: true, enableTools: true,
      runTurn: async ({ dispatchTool, sessionId }) => {
        const pending = dispatchTool('skill_exec', { skill: 'omni-digest', task: 'research' });
        setTimeout(() => process.emit('SIGINT'), 10);
        const result = await pending;
        return { text: JSON.stringify(result), provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] };
      },
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
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
