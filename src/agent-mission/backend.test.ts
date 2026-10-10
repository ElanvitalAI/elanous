import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../acp/client.js';
import { asideBackend, codexBackend, claudeBackend, geminiBackend, grokBackend, refuseNestedElanousOnBackend, resolveBackend, resolveBackendSpawn, prepareClaudeChildSpawn, agentBackendNames, type AgentBackend } from './driver.js';
import { CODEX_NESTED_DEPTH_CONFIG_KEY } from '../harness/nested-elanous-policy.js';

describe('Claude nested deny child args', () => {
  it('uses strict MCP config with no elanous server, keeps user settings untouched through child lifetime', () => {
    const home = mkdtempSync(join(tmpdir(), 'nested-claude-home-'));
    const settings = join(home, '.claude.json');
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir);
    writeFileSync(settings, '{"mcpServers":{"elanous":{"command":"elanous"}}}');
    writeFileSync(join(claudeDir, 'settings.json'), '{"keep":true}');
    try {
      const spawn = resolveBackendSpawn(claudeBackend, { HOME: home });
      const child = prepareClaudeChildSpawn(spawn, { backendName: 'claude', depth: 0, allowNestedElanous: false, tempRoot: home });
      try {
        expect(child.args).toEqual([...spawn.args, '--strict-mcp-config', '--mcp-config', child.configPath!]);
        expect(existsSync(child.configPath!)).toBe(true);
        expect(JSON.parse(readFileSync(child.configPath!, 'utf8'))).toEqual({ mcpServers: {} });
      } finally { child.cleanup(); }
      expect(existsSync(child.configPath!)).toBe(false);
      expect(readFileSync(settings, 'utf8')).toBe('{"mcpServers":{"elanous":{"command":"elanous"}}}');
      expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe('{"keep":true}');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('explicit depth-0 allow retains Claude spawn arguments', () => {
    const spawn = resolveBackendSpawn(claudeBackend, { PATH: '/usr/bin' });
    const child = prepareClaudeChildSpawn(spawn, { backendName: 'claude', depth: 0, allowNestedElanous: true });
    expect(child.args).toEqual(spawn.args);
    expect(child.configPath).toBeUndefined();
    child.cleanup();
  });
});

describe('NESTED-GUARD2 — Claude deny follows backend identity', () => {
  it('an absolute-path claude command still gets the strict MCP config; another backend never does', () => {
    const base = resolveBackendSpawn(claudeBackend, { PATH: '/usr/bin' });
    const absolute = { ...base, cmd: '/opt/homebrew/bin/claude' };
    const child = prepareClaudeChildSpawn(absolute, { backendName: 'claude', depth: 0, allowNestedElanous: false });
    try {
      expect(child.args).toContain('--strict-mcp-config');
      expect(child.args).toContain('--mcp-config');
    } finally { child.cleanup(); }
    const codex = prepareClaudeChildSpawn({ ...base, cmd: 'claude' }, { backendName: 'codex', depth: 0, allowNestedElanous: false });
    expect(codex.args).toEqual(base.args);
    expect(codex.configPath).toBeUndefined();
  });
});

describe('AgentBackend — agent-agnostic PTY 추상화', () => {
  it('codexBackend = codex --yolo·구독 스크럽·trust=1', () => {
    expect(codexBackend.name).toBe('codex');
    expect(codexBackend.cmd).toBe('codex');
    expect(codexBackend.args).toEqual(['--yolo', '-c', 'check_for_update_on_startup=false']);   // 09-26: 자식이 업데이트 창에서 스스로 brew upgrade 를 돌렸다
    expect(codexBackend.scrubEnv).toContain('OPENAI_API_KEY');
  });

  it('codex spawn 인자에 자식 깊이 표지가 실린다 (inherit=core 가 env 를 버려도 argv 로 간다)', () => {
    const prev = process.env.ELANOUS_NEST_DEPTH;
    delete process.env.ELANOUS_NEST_DEPTH;
    try {
      const spawn = resolveBackendSpawn(codexBackend, { PATH: '/usr/bin' });
      expect(spawn.args).toContain('-c');
      expect(spawn.args).toContain(`${CODEX_NESTED_DEPTH_CONFIG_KEY}="1"`);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_NEST_DEPTH;
      else process.env.ELANOUS_NEST_DEPTH = prev;
    }
  });

  it('codex 가 아닌 백엔드는 깊이 표지 인자를 싣지 않는다', () => {
    for (const backend of [claudeBackend, geminiBackend, grokBackend, asideBackend]) {
      const spawn = resolveBackendSpawn(backend, { PATH: '/usr/bin' });
      expect(spawn.args.some((arg) => arg.includes('ELANOUS_NESTED_DEPTH'))).toBe(false);
    }
  });

  it('표지를 못 싣는 백엔드는 중첩 발사를 요청했을 때만 거부하고 일반 스폰은 막지 않는다', () => {
    const unset = {};
    for (const backend of [claudeBackend, geminiBackend, grokBackend, asideBackend]) {
      const ordinary = refuseNestedElanousOnBackend({
        backendName: backend.name,
        nestedLaunchRequested: false,
        env: unset,
      });
      expect(ordinary.refused).toBe(false);
      expect(ordinary.depth).toBe(0);
      const requested = refuseNestedElanousOnBackend({
        backendName: backend.name,
        nestedLaunchRequested: true,
        allow: true,
        env: unset,
      });
      expect(requested.refused).toBe(true);
      expect(requested.reason).toBe('depth-unknown');
    }
    const codex = refuseNestedElanousOnBackend({
      backendName: 'codex',
      nestedLaunchRequested: true,
      allow: true,
      env: unset,
    });
    expect(codex.refused).toBe(false);
    expect(codex.depth).toBe(0);
  });

  it('the mission refusal caller enforces the depth cap for Codex, even with allow', () => {
    expect(refuseNestedElanousOnBackend({
      backendName: 'codex', nestedLaunchRequested: true, allow: true,
      env: { ELANOUS_NESTED_DEPTH: '2' },
    })).toEqual({ refused: true, reason: 'depth-cap', depth: 2 });
  });

  it('U3: claudeBackend = claude --dangerously-skip-permissions·ANTHROPIC 키 스크럽', () => {
    expect(claudeBackend.name).toBe('claude');
    expect(claudeBackend.cmd).toBe('claude');
    expect(claudeBackend.args).toEqual(['--dangerously-skip-permissions']);
    expect(claudeBackend.scrubEnv).toContain('ANTHROPIC_API_KEY');
  });

  // ⭐ 2026-08-18(대표 결정) — 이름은 `gemini` 로 두고 «실행체»만 Antigravity CLI(`agy`) 로 바꿨다.
  //   ⛔ `gemini` CLI 는 라이브에서 «죽었다» — IneligibleTierError · free-tier UNSUPPORTED_CLIENT.
  //     그래서 이 단언은 「이름 ≠ 실행체」를 «고정»한다. 둘이 다시 같아지면 죽은 CLI 로 돌아간 것이다.
  it('U3: geminiBackend — 이름은 gemini, 실행체는 agy · GEMINI/GOOGLE 키 스크럽', () => {
    expect(geminiBackend.name).toBe('gemini');
    expect(geminiBackend.cmd).toBe('agy');
    expect(geminiBackend.cmd).not.toBe('gemini');
    expect(geminiBackend.args).toEqual(['--dangerously-skip-permissions']);
    // ⚠️ agy 도 GEMINI_API_KEY 를 «본다»(CHANGELOG 1.1.13) ⇒ 스크럽 목록이 여전히 필요하다.
    expect(geminiBackend.scrubEnv).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_API_KEY']));
  });

  it('U3: grokBackend = grok --always-approve·XAI/GROK 키 스크럽', () => {
    expect(grokBackend.name).toBe('grok');
    expect(grokBackend.cmd).toBe('grok');
    expect(grokBackend.args).toEqual(['--always-approve']);
    expect(grokBackend.scrubEnv).toEqual(expect.arrayContaining(['XAI_API_KEY', 'GROK_API_KEY']));
  });

  it('Aside browser backend = aside exec·low effort·계정 인증은 CLI 플래그로 제어', () => {
    expect(asideBackend.name).toBe('aside');
    expect(asideBackend.cmd).toBe('aside');
    expect(asideBackend.args).toEqual(['exec', '--effort', 'low']);
    expect(asideBackend.args).not.toContain('ultrabrowse');
    expect(asideBackend.scrubEnv).toEqual([]);
  });

  it('handleTrust — 신뢰 프롬프트면 1 입력·처리 true', () => {
    let sent = '';
    const trustScreen = 'Do you trust the files in this workspace? 1. Yes 2. No';
    const handled = codexBackend.handleTrust?.(trustScreen, (s) => { sent += s; });
    expect(handled).toBe(true);
    expect(sent).toBe('1\r');
  });

  it('handleTrust — 신뢰 프롬프트 아니면 미처리·입력 없음', () => {
    let sent = '';
    const handled = codexBackend.handleTrust?.('그냥 작업 중 화면', (s) => { sent += s; });
    expect(handled).toBe(false);
    expect(sent).toBe('');
  });

  it('resolveBackend — 미지정 → 디폴트 codex, codex 명시 → codex', () => {
    // 미지정은 기본 경로다. 기본 체인이면 codex 이고, codex 가 소진돼 체인이 grok 으로
    // 넘기면 grok 이다(resolveDefaultBackend). 이름을 명시한 쪽은 그 백엔드 그대로다.
    expect([codexBackend.name, grokBackend.name]).toContain(resolveBackend().name);
    expect(resolveBackend('codex').name).toBe('codex');
  });

  it('U3: resolveBackend — claude/gemini/grok/aside 명시 지정 시 각 backend 반환(더 이상 에러 아님)', () => {
    expect(resolveBackend('claude').name).toBe('claude');
    expect(resolveBackend('gemini').name).toBe('gemini');
    expect(resolveBackend('grok').name).toBe('grok');
    expect(resolveBackend('aside').name).toBe('aside');
  });

  it('resolveBackend — U1 정직화: 미등록 backend 명시 지정 시 조용한 폴백 대신 명시 에러', () => {
    // 조용한 codex 폴백은 "애그노스틱한 척·실배선 단일"을 은폐 → 명시 에러로 차단(대표 지적).
    expect(() => resolveBackend('nope')).toThrow(/알 수 없는 agent backend 'nope'/);
    expect(() => resolveBackend('claude-code')).toThrow(/등록된 backend: codex, claude, gemini, grok/);
  });

  it('agentBackendNames — Aside를 포함한 다섯 backend', () => {
    expect(agentBackendNames()).toEqual(['codex', 'claude', 'gemini', 'grok', 'aside']);
  });
});

describe('resolveBackendSpawn — 선택→PTY spawn 파라미터 실행경로(U3 선택 실증)', () => {
  // driver 의 실 spawn(startPty)이 이 seam 결과의 cmd/args/env 를 그대로 넘긴다(TERM·ELANOUS_RUN_ID 만 덧댐).
  const base = { PATH: '/usr/bin', HOME: '/home/x', FOO: 'keep' };

  it('선택된 backend 의 cmd/args 가 spawn 파라미터로 전달', () => {
    const cases: Array<[AgentBackend, string, string[]]> = [
      [codexBackend, 'codex', ['--yolo', '-c', 'check_for_update_on_startup=false', '-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}="${(Number(process.env.ELANOUS_NEST_DEPTH) || 0) + 1}"`]],
      [claudeBackend, 'claude', ['--dangerously-skip-permissions']],
      [geminiBackend, 'agy', ['--dangerously-skip-permissions']],
      [grokBackend, 'grok', ['--always-approve']],
      [asideBackend, 'aside', ['exec', '--effort', 'low']],
    ];
    for (const [b, cmd, args] of cases) {
      const s = resolveBackendSpawn(b, base);
      expect(s.cmd).toBe(cmd);
      expect(s.args).toEqual(args);
      expect(s.env.FOO).toBe('keep'); // 비-scrub env 는 보존
    }
  });

  it('구독모드 보장 — API 키 + 대체 과금경로가 spawn env 에서 전부 제거', () => {
    // claude: API 키 + 대체 인증 토큰 + 프로바이더 스위치(Bedrock/Vertex)
    const claudeEnv = resolveBackendSpawn(claudeBackend, {
      ...base, ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'parent',
    }).env;
    expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(claudeEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(claudeEnv.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // 부모 Claude Code 세션 토큰은 자식에 안 간다
    expect(claudeEnv.FOO).toBe('keep');

    // gemini: API 키 + Vertex/ADC 트리거
    const geminiEnv = resolveBackendSpawn(geminiBackend, {
      ...base, GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g2',
      GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_APPLICATION_CREDENTIALS: '/adc.json',
    }).env;
    expect(geminiEnv.GEMINI_API_KEY).toBeUndefined();
    expect(geminiEnv.GOOGLE_API_KEY).toBeUndefined();
    expect(geminiEnv.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(geminiEnv.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();

    // grok: XAI/GROK API 키
    const grokEnv = resolveBackendSpawn(grokBackend, {
      ...base, XAI_API_KEY: 'x', GROK_API_KEY: 'x2', GROK_CODE_XAI_API_KEY: 'x3',
    }).env;
    expect(grokEnv.XAI_API_KEY).toBeUndefined();
    expect(grokEnv.GROK_API_KEY).toBeUndefined();
    expect(grokEnv.GROK_CODE_XAI_API_KEY).toBeUndefined();
  });

  it('grok 구독 강제 — API 키 인증 차단 env를 스크럽 뒤에 넣고 이름만 보고', () => {
    const spawn = resolveBackendSpawn(grokBackend, {
      ...base, XAI_API_KEY: 'x', GROK_API_KEY: 'x2', GROK_CODE_XAI_API_KEY: 'x3',
    });
    expect(spawn.env.GROK_DISABLE_API_KEY_AUTH).toBe('1');
    expect(spawn.forcedEnv).toEqual(['GROK_DISABLE_API_KEY_AUTH']);
    expect(spawn.forcedEnv).not.toContain('1');
    expect(spawn.env.XAI_API_KEY).toBeUndefined();
    expect(spawn.env.GROK_API_KEY).toBeUndefined();
    expect(spawn.env.GROK_CODE_XAI_API_KEY).toBeUndefined();
  });

  it('grok 구독 강제 — 바깥에서 주어진 값은 덮어쓰지 않고 강제로 보고하지 않음', () => {
    const spawn = resolveBackendSpawn(grokBackend, {
      ...base, GROK_DISABLE_API_KEY_AUTH: 'outer-policy',
    });
    expect(spawn.env.GROK_DISABLE_API_KEY_AUTH).toBe('outer-policy');
    expect(spawn.forcedEnv).toEqual([]);
  });

  it('다른 backend 는 grok 인증 차단 env를 추가하지 않음', () => {
    for (const backend of [claudeBackend, codexBackend, geminiBackend]) {
      const spawn = resolveBackendSpawn(backend, base);
      expect(spawn.env.GROK_DISABLE_API_KEY_AUTH).toBeUndefined();
      expect(spawn.forcedEnv).toEqual([]);
    }
  });

  it('중첩 표지 — CLAUDECODE 와 공용 차단 목록 키를 PTY 자식 env 에서 제거하고 개수를 보고', () => {
    const spawn = resolveBackendSpawn(codexBackend, {
      ...base, CLAUDECODE: 'nested', ELANOUS_GUARDIAN: 'parent-only',
    });
    expect(spawn.env.CLAUDECODE).toBeUndefined();
    expect(spawn.env.ELANOUS_GUARDIAN).toBeUndefined();
    expect(spawn.nestedEnvRemovedCount).toBe(2);
  });

  it('중첩 표지 부재 — 기존 env 를 보존하고 제거 개수를 0으로 보고', () => {
    const spawn = resolveBackendSpawn(codexBackend, base);
    expect(spawn.env).toEqual(base);
    expect(spawn.nestedEnvRemovedCount).toBe(0);
  });

  it('입력 baseEnv 를 변형하지 않음(순수)', () => {
    const input = { ...base, ANTHROPIC_API_KEY: 'sk', CLAUDECODE: 'nested' };
    resolveBackendSpawn(claudeBackend, input);
    expect(input.ANTHROPIC_API_KEY).toBe('sk'); // 원본 불변
    expect(input.CLAUDECODE).toBe('nested');
  });

  it('name→spawn 전체 경로 — resolveBackendSpawn(resolveBackend(name)) 가 레지스트리 오배선을 잡는다', () => {
    // resolveBackend(레지스트리)와 resolveBackendSpawn(spawn 구성)을 합성해 검증 →
    // AGENT_BACKENDS 의 name→cmd/args 매핑이 어긋나면(오배선) 여기서 실패.
    const expected: Record<string, [string, string[]]> = {
      codex: ['codex', ['--yolo', '-c', 'check_for_update_on_startup=false', '-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}="${(Number(process.env.ELANOUS_NEST_DEPTH) || 0) + 1}"`]],
      claude: ['claude', ['--dangerously-skip-permissions']],
      // ⭐ 이름 gemini → 실행체 agy (2026-08-18 대표 결정 · 죽은 CLI 로 되돌아가면 여기서 잡힌다)
      gemini: ['agy', ['--dangerously-skip-permissions']],
      grok: ['grok', ['--always-approve']],
      aside: ['aside', ['exec', '--effort', 'low']],
    };
    for (const [name, [cmd, args]] of Object.entries(expected)) {
      const s = resolveBackendSpawn(resolveBackend(name), base);
      expect(s.cmd).toBe(cmd);
      expect(s.args).toEqual(args);
    }
  });
});

import { buildAgentMissionPtySpawnOptions } from './driver.js';
describe('agent-mission → PTY: 스크럽 키를 이름으로 넘긴다(캡처본 부활 방지 · 09-26)', () => {
  it('codex 는 scrubEnv 키를 unsetEnv 로 싣는다', () => {
    const s = resolveBackendSpawn(codexBackend, { PATH: '/bin', OPENAI_API_KEY: 'x' });
    expect(s.env.OPENAI_API_KEY).toBeUndefined();
    expect(s.unsetEnv).toContain('OPENAI_API_KEY');
    const o = buildAgentMissionPtySpawnOptions({ backend: codexBackend, spawn: s, workdir: '/w', nickname: 'n' });
    expect(o.unsetEnv).toContain('OPENAI_API_KEY');
  });
  it('강제 env 로 다시 넣은 키는 unset 에서 뺀다(grok)', () => {
    const s = resolveBackendSpawn(grokBackend, { PATH: '/bin' });
    for (const k of s.unsetEnv) expect(Object.hasOwn(s.env, k)).toBe(false);
  });
});
