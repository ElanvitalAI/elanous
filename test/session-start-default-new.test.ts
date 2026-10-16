// TUI-H8-SESSION-NEW-DEFAULT (대표 10-16 #73) — 인자 없음 = 깨끗한 새 세션 · 이어하기는 명시 인자일 때만.
//
// 판정 신호: ① 인자 없음 → 새 세션(활성 세션 id 와 다름) ② --continue/--resume → 이어감
//           ③ /session new → ACP sessionId 바뀜 ④ 깨진 기록 resume → 400 대신 잘림/거부
//           ⑤ 새 세션 첫 턴에 자리 맥락 실림(자리 문서가 싣는다 — 세션과 무관) · 반증.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideSessionStart, looksLikeSessionId, resolveLatestSessionId, resolveRootResumeSessionId, splitResumeArgument,
  tokenizeResumeArgv,
} from '../src/session/session-start.js';
import { filterDashboardArgs, rootResumeIdAt } from '../src/index.js';
import { resumeInProcessDashboardSession } from '../src/dashboard/index.js';
import type { ChatMessage } from '../src/chat/index.js';
import * as llmModule from '../src/llm.js';
import { debug } from '../src/debug/log.js';

const root = new URL('../', import.meta.url).pathname;

afterEach(() => { mock.restore(); });

describe('decideSessionStart — 단일 결정', () => {
  const active = () => 'active-1';
  test('인자 없음 → 새 세션(활성 세션이 있어도 이어받지 않는다)', () => {
    expect(decideSessionStart({ continueActive: false, forceNew: false, activeSessionId: active }))
      .toEqual({ origin: 'new', reason: 'default-new' });
  });
  test('--continue/--resume → 활성 세션 이어감 · 없으면 새 세션', () => {
    expect(decideSessionStart({ continueActive: true, forceNew: false, activeSessionId: active }))
      .toEqual({ origin: 'resume', reason: 'continue-active', sessionIdHint: 'active-1' });
    expect(decideSessionStart({ continueActive: true, forceNew: false, activeSessionId: () => null }))
      .toEqual({ origin: 'new', reason: 'continue-no-active' });
  });
  test('명시 id 가 이기고 --new 는 이어하기를 이긴다', () => {
    expect(decideSessionStart({ explicitSessionId: 'x', continueActive: true, forceNew: true, activeSessionId: active }))
      .toEqual({ origin: 'resume', reason: 'explicit-session', sessionIdHint: 'x' });
    expect(decideSessionStart({ continueActive: true, forceNew: true, activeSessionId: active }))
      .toEqual({ origin: 'new', reason: 'force-new' });
  });
  test('resolveLatestSessionId — 활성 표지 ⊕ 없으면 최신 · 읽기 실패는 null', () => {
    expect(resolveLatestSessionId({ activeSessionId: () => null, latestSessionId: () => 'latest' })).toBe('latest');
    expect(resolveLatestSessionId({ activeSessionId: () => 'a', latestSessionId: () => 'latest' })).toBe('a');
    expect(resolveLatestSessionId({ activeSessionId: () => { throw new Error('x'); }, latestSessionId: () => 'l' })).toBe('l');
    expect(resolveLatestSessionId({ activeSessionId: () => null, latestSessionId: () => { throw new Error('y'); } })).toBeNull();
  });
});

describe('TUI-H8-FOLLOW ① — 활성 표지가 사라진 세션이면 최신 세션으로', () => {
  const alive = new Set(['latest-1']);
  const exists = (id: string) => alive.has(id);
  test('decideSessionStart — 낡은 표지 → 최신 세션(continue-latest) · 산 표지는 그대로 · 최신도 없으면 새 세션', () => {
    const logSpy = spyOn(debug, 'log');
    expect(decideSessionStart({
      continueActive: true, forceNew: false, activeSessionId: () => 'gone', sessionExists: exists, latestSessionId: () => 'latest-1',
    })).toEqual({ origin: 'resume', reason: 'continue-latest', sessionIdHint: 'latest-1' });
    expect(logSpy.mock.calls.some(([cat, ev]) => cat === 'session' && ev === 'active-marker-stale')).toBe(true);
    expect(decideSessionStart({
      continueActive: true, forceNew: false, activeSessionId: () => 'latest-1', sessionExists: exists, latestSessionId: () => 'x',
    })).toEqual({ origin: 'resume', reason: 'continue-active', sessionIdHint: 'latest-1' });
    expect(decideSessionStart({
      continueActive: true, forceNew: false, activeSessionId: () => 'gone', sessionExists: exists, latestSessionId: () => 'gone',
    })).toEqual({ origin: 'new', reason: 'continue-no-active' });
    // 반증: 인자 없음은 표지와 무관하게 새 세션.
    expect(decideSessionStart({
      continueActive: false, forceNew: false, activeSessionId: () => 'gone', sessionExists: exists, latestSessionId: () => 'latest-1',
    })).toEqual({ origin: 'new', reason: 'default-new' });
  });
  test('resolveLatestSessionId(TUI 루트) — 낡은 표지를 건너뛴다 · 존재 확인 실패는 «없다»', () => {
    expect(resolveLatestSessionId({ activeSessionId: () => 'gone', latestSessionId: () => 'latest-1', sessionExists: exists })).toBe('latest-1');
    expect(resolveLatestSessionId({ activeSessionId: () => 'latest-1', latestSessionId: () => 'x', sessionExists: exists })).toBe('latest-1');
    expect(resolveLatestSessionId({
      activeSessionId: () => 'a', latestSessionId: () => 'latest-1', sessionExists: (id) => { if (id === 'a') throw new Error('io'); return exists(id); },
    })).toBe('latest-1');
  });
});

describe('TUI-H8-FOLLOW ② — id 없는 --resume 뒤 프롬프트 첫 낱말을 세션 id 로 먹지 않는다', () => {
  test('looksLikeSessionId — uuid·hex 접두(숫자 포함)만 id', () => {
    expect(looksLikeSessionId('3f2a9c1e-7b4d-4e2a-9f10-0c1d2e3f4a5b')).toBe(true);
    expect(looksLikeSessionId('3f2a')).toBe(true);
    expect(looksLikeSessionId('3f2a9c1e-7b4d')).toBe(true);
    expect(looksLikeSessionId('3F2A9C1E-7B4D-4E2A-9F10-0C1D2E3F4A5B')).toBe(true);
    // 반례(r1 must-fix): 하이픈이 uuid 자리가 아니면 id 가 아니다.
    for (const word of ['질문', 'fix', 'face', 'deadbeef', 'hello', 'a1', 'what is 42', '--json', '----1', '12-34', '3f2a9c1e7', '3f2a9c1e-7b4d-4e2a-9f10-0c1d2e3f4a5b0']) {
      expect(looksLikeSessionId(word)).toBe(false);
    }
  });
  test('splitResumeArgument — 낱말은 프롬프트로 되돌리고 id 꼴은 그대로', () => {
    expect(splitResumeArgument('질문', ['계속'], 'chat')).toEqual({ resume: true, parts: ['질문', '계속'] });
    expect(splitResumeArgument('세션 목록 보여줘', [], 'agent')).toEqual({ resume: true, parts: ['세션 목록 보여줘'] });
    expect(splitResumeArgument('3f2a9c1e', ['hi'], 'chat')).toEqual({ resume: '3f2a9c1e', parts: ['hi'] });
    expect(splitResumeArgument(true, ['hi'], 'chat')).toEqual({ resume: true, parts: ['hi'] });
    expect(splitResumeArgument(undefined, ['hi'], 'chat')).toEqual({ resume: undefined, parts: ['hi'] });
    expect(splitResumeArgument('----1', [], 'chat')).toEqual({ resume: true, parts: ['----1'] });
  });
  test('splitResumeArgument — argv 를 주면 입력 순서를 지킨다(r1 should-fix)', () => {
    expect(splitResumeArgument('world', ['hello'], 'chat', ['chat', 'hello', '--resume', 'world']))
      .toEqual({ resume: true, parts: ['hello', 'world'] });
    expect(splitResumeArgument('world', ['hello', 'again'], 'chat', ['chat', 'hello', '--json', '--resume', 'world', 'again']))
      .toEqual({ resume: true, parts: ['hello', 'world', 'again'] });
    expect(splitResumeArgument('질문', ['계속'], 'agent', ['--test=/x', 'agent', '--resume', '질문', '계속']))
      .toEqual({ resume: true, parts: ['질문', '계속'] });
    // r2 must-fix: 명령 낱말 자체·--session 값은 위치 인자로 세지 않는다.
    expect(splitResumeArgument('world', ['chat'], 'chat', ['chat', '--resume', 'world', 'chat']))
      .toEqual({ resume: true, parts: ['world', 'chat'] });
    expect(splitResumeArgument('b', ['a'], 'agent', ['agent', '--session', 'a', '--resume', 'b', 'a']))
      .toEqual({ resume: true, parts: ['b', 'a'] });
  });
  // r3 TF 결정 — 순서 보존을 argv 토큰화로 일반화하고 꼴을 표로 한 번에 덮는다.
  const argvTable: Array<{ name: string; argv: string[]; positionals: string[]; resumeValue: string | null; at: number | null }> = [
    { name: '--resume X', argv: ['chat', 'hello', '--resume', 'world'], positionals: ['hello'], resumeValue: 'world', at: 1 },
    { name: '--resume=X', argv: ['chat', 'hello', '--resume=world'], positionals: ['hello'], resumeValue: 'world', at: 1 },
    { name: '--resume=X 맨 앞', argv: ['chat', '--resume=world', 'hello'], positionals: ['hello'], resumeValue: 'world', at: 0 },
    { name: '명령 낱말과 같은 값', argv: ['chat', '--resume', 'world', 'chat'], positionals: ['chat'], resumeValue: 'world', at: 0 },
    { name: '루트 옵션은 명령 앞', argv: ['--test=/x', 'agent', '--resume', '질문', '계속'], positionals: ['계속'], resumeValue: '질문', at: 0 },
    { name: '-- 뒤는 위치 인자', argv: ['chat', 'a', '--resume', 'b', '--', '--resume', 'c'], positionals: ['a', '--resume', 'c'], resumeValue: 'b', at: 1 },
    { name: '-- 바로 뒤 --resume 은 값이 아니다', argv: ['chat', '--', '--resume', 'x'], positionals: ['--resume', 'x'], resumeValue: null, at: null },
    { name: '값 없는 --resume 이 끝', argv: ['chat', 'hello', '--resume'], positionals: ['hello'], resumeValue: null, at: null },
    { name: '값 없는 --resume 뒤 플래그', argv: ['chat', '--resume', '--json', 'hi'], positionals: ['hi'], resumeValue: null, at: null },
    { name: '다른 옵션 사이', argv: ['chat', '--json', 'a', '--new', '--resume', 'b', '--tools', 'c'], positionals: ['a', 'c'], resumeValue: 'b', at: 1 },
    { name: '--session 값 건너뜀', argv: ['agent', '--session', 'a', '--resume', 'b', 'a'], positionals: ['a'], resumeValue: 'b', at: 0 },
    { name: '--session=값 건너뜀', argv: ['agent', 'x', '--session=a', '--resume=b', 'y'], positionals: ['x', 'y'], resumeValue: 'b', at: 1 },
  ];
  test.each(argvTable)('tokenizeResumeArgv — $name', ({ argv, positionals, resumeValue, at }) => {
    const surface = argv.includes('agent') ? 'agent' : 'chat';
    expect(tokenizeResumeArgv(argv, surface)).toEqual({ positionals, resumeValue, resumeValueAt: at });
  });
  test('splitResumeArgument — Commander 결과와 토큰화가 어긋나면 맨 앞(옛 동작)으로 접는다', () => {
    expect(splitResumeArgument('world', ['hello'], 'chat', ['chat', 'hello', '--resume=world']))
      .toEqual({ resume: true, parts: ['hello', 'world'] });
    expect(splitResumeArgument('world', ['hello'], 'chat', ['chat', 'other']))
      .toEqual({ resume: true, parts: ['world', 'hello'] });
  });
  test('active-marker-stale 관측은 실제 결과대로(r1 should-fix)', () => {
    const logSpy = spyOn(debug, 'log');
    resolveLatestSessionId({ activeSessionId: () => 'gone', latestSessionId: () => null, sessionExists: () => false });
    expect(logSpy.mock.calls.find(([cat, ev]) => cat === 'session' && ev === 'active-marker-stale')?.[2]).toMatchObject({ fallback: 'none' });
  });
});

describe('대시보드 TUI 루트 이어하기 우선순위(r1 must-fix)', () => {
  const latest = () => 'latest-1';
  test('인자 없음 ∧ env 없음 → 새 세션', () => {
    expect(resolveRootResumeSessionId({ continueLatest: false, readEnvId: () => null, latest })).toEqual({ source: 'none' });
  });
  test('--resume <id> 가 이기고, --continue·id 없는 --resume 은 env 보다 앞선다', () => {
    let envReads = 0;
    const readEnvId = () => { envReads += 1; return 'env-1'; };
    expect(resolveRootResumeSessionId({ flagId: 'flag-1', continueLatest: false, readEnvId, latest }))
      .toEqual({ sessionId: 'flag-1', source: 'flag' });
    expect(resolveRootResumeSessionId({ continueLatest: true, readEnvId, latest }))
      .toEqual({ sessionId: 'latest-1', source: 'continue' });
    expect(resolveRootResumeSessionId({ continueLatest: true, readEnvId, latest: () => null }))
      .toEqual({ source: 'continue-none' });
    // r2 must-fix — 명시 인자가 있으면 폐기 예정 env 를 읽지도 않는다(경고가 안 나온다).
    expect(envReads).toBe(0);
  });
  test('(폐기 예정) env 는 명시 인자가 하나도 없을 때만', () => {
    expect(resolveRootResumeSessionId({ continueLatest: false, readEnvId: () => ' env-1 ', latest }))
      .toEqual({ sessionId: 'env-1', source: 'env' });
  });
});

describe('대시보드 TUI 루트 인자 — --continue · id 없는 --resume', () => {
  test('--resume <id> 는 id 와 함께 벗기고, id 없는 --resume 은 뒤 플래그를 먹지 않는다', () => {
    expect(rootResumeIdAt(['--resume', 'abc'], 0)).toBe('abc');
    expect(rootResumeIdAt(['--resume'], 0)).toBeUndefined();
    expect(rootResumeIdAt(['--resume', '--yolo'], 0)).toBeUndefined();
    expect(filterDashboardArgs(['--resume', 'abc', '--debug'])).toEqual([]);
    expect(filterDashboardArgs(['--resume', '--remote', 'host'])).toEqual(['--remote', 'host']);
    expect(filterDashboardArgs(['--continue'])).toEqual([]);
    // 반증: 하위 명령의 --continue 는 그 명령 몫이다.
    expect(filterDashboardArgs(['chat', '--continue', 'hi'])).toEqual(['chat', '--continue', 'hi']);
  });
});

describe('진입점 배선 — 모든 기본이 «새 세션»', () => {
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  test('chat(dev 파이프라인 포함)·agent·repl 은 명시 이어하기 인자로만 활성 세션을 쓴다', () => {
    const index = read('src/index.ts');
    // 반증: 옛 배선(--new 가 없으면 활성 세션 재사용)이 남아 있으면 안 된다.
    expect(index).not.toContain('reuseActive: !chat.forceNew');
    expect(index.split('reuseActive: chat.continueActive === true').length - 1).toBe(2);
    expect(index).toContain("continueActive: opts.continue === true || opts.resume === true,");
    const agent = read('src/cli/agent-cli.ts');
    expect(agent).not.toContain('reuseActive: opts.new !== true');
    expect(agent).toContain('reuseActive: opts.continue === true || opts.resume === true');
    const repl = read('src/repl/index.ts');
    expect(repl).not.toContain('} else if (!opts.forceNew) {');
    expect(repl).toContain('continueActive: opts.continueActive === true');
  });
  test('ask 는 원래 새 세션(--reuse 명시) — 그대로', () => {
    expect(read('src/index.ts')).toContain('reuseActive: opts.reuse === true,');
  });
});

describe('실물 진입점 — elanous chat · agent (가짜 로컬 LLM · 격리 HOME)', () => {
  test('인자 없음 → 매번 새 세션 · --continue → 직전 활성 세션 · --resume <id> → 그 세션 · agent 도 같은 기본', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-h8-cli-'));
    const configDir = join(home, 'state');
    const readyPath = join(home, 'llm-ready.txt');
    const serverPath = join(home, 'llm-server.ts');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      llm: { provider: 'local', model: 'h8-test', memoryJudge: { enabled: false } },
    }));
    const bodyPath = join(home, 'llm-bodies.jsonl');
    writeFileSync(serverPath, `const readyPath = process.argv[2]!; const bodyPath = process.argv[3]!; const server = Bun.serve({ port: 0, async fetch(req) { (await import('node:fs')).appendFileSync(bodyPath, await req.text() + '\\n'); return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } }); } }); await Bun.write(readyPath, String(server.port));`);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of [
      'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'CODEX_HOME', 'ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID',
    ]) delete env[key];
    const server = Bun.spawn([process.execPath, serverPath, readyPath, bodyPath], { env: env as Record<string, string> });
    try {
      for (let attempts = 0; !existsSync(readyPath) && attempts < 100; attempts += 1) await Bun.sleep(30);
      const port = readFileSync(readyPath, 'utf8').trim();
      const run = (args: string[], tail: string[] = ['--json', 'hello'], input?: string): string => {
        const result = spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${configDir}`, ...args, ...tail], {
          ...(input !== undefined ? { input } : {}),
          cwd: root,
          env: {
            ...env, HOME: home, LOCAL_LLM_URL: `http://127.0.0.1:${port}/v1`,
            ELANOUS_STATE_DIR: configDir, ELANOUS_SESSION_ROOT: join(home, 'sessions'),
          },
          encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, `args=${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        const line = result.stdout.trim().split('\n').filter((row) => row.startsWith('{')).at(-1)!;
        return (JSON.parse(line) as { sessionId: string }).sessionId;
      };
      const first = run(['chat']);
      const second = run(['chat']);
      const continued = run(['chat', '--continue']);
      const resumed = run(['chat', '--resume', first]);
      const agentFresh = run(['agent']);
      expect(first).toBeTruthy();
      // ① 인자 없음 → 새 세션(직전 활성 세션 first 와 다르다).
      expect(second).not.toBe(first);
      // ② --continue → 직전 활성 세션(second)을 이어간다.
      expect(continued).toBe(second);
      // --resume <id> → 그 세션.
      expect(resumed).toBe(first);
      // agent 도 인자 없음 = 새 세션(직전 활성 = first 와 다르다).
      expect(agentFresh).not.toBe(first);
      expect(agentFresh).not.toBe(second);

      // ── TUI-H8-FOLLOW ② — id 없는 --resume 바로 뒤 프롬프트: 첫 낱말이 id 로 먹히지 않고 프롬프트로 간다.
      // 마지막 요청의 «마지막 사용자 메시지»만 본다(r3 should-fix — 누적 본문 전체를 보면 앞 요청이 단언을 공짜로 채운다).
      const lastBody = (): string => {
        const rows = readFileSync(bodyPath, 'utf8').trim().split('\n').filter(Boolean);
        const body = JSON.parse(rows.at(-1)!) as { messages?: Array<{ role: string; content: unknown }> };
        const user = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
        const content = user?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('');
        return '';
      };
      const resumedWord = run(['chat', '--json', '--resume', '질문하나', '이어서'], []);
      expect(resumedWord).toBe(agentFresh); // id 없는 --resume = 활성 세션(직전 agent) 이어하기
      expect(lastBody()).toContain('질문하나 이어서');
      const agentWord = run(['agent', '--json', '--no-tools', '--resume', '다음일'], []);
      expect(agentWord).toBe(agentFresh);
      expect(lastBody()).toContain('다음일');
      // 옵션 앞에도 프롬프트가 있으면 순서를 지킨다(r1 should-fix).
      run(['chat', '앞말', '--json', '--resume', '뒷말'], []);
      expect(lastBody()).toContain('앞말 뒷말');
      // --resume=값 꼴도 순서를 지킨다(r3 must-fix).
      run(['chat', '앞', '--json', '--resume=뒤'], []);
      expect(lastBody()).toContain('앞 뒤');
      expect(lastBody()).not.toContain('뒤 앞');
      // 프롬프트 낱말이 명령 이름과 같아도 순서가 그대로다(r2 must-fix).
      run(['chat', '--json', '--resume', '말끝', 'chat'], []);
      expect(lastBody()).toContain('말끝 chat');
      // id 꼴(uuid 접두 — 버전 숫자 4 포함)은 여전히 id 다.
      const byPrefix = run(['chat', '--json', '--resume', first.slice(0, 15), 'hi'], []);
      expect(byPrefix).toBe(first);

      // ── TUI-H8-FOLLOW ① — 활성 표지가 사라진 세션을 가리키면 --continue 는 최신 세션으로.
      writeFileSync(join(configDir, 'elanous', 'active'), '00000000-0000-4000-8000-000000000000');
      const afterStale = run(['chat', '--continue']);
      expect(afterStale).toBe(byPrefix); // 최신(방금 쓴) 세션 = first
      // 반증: 표지가 살아 있으면 그 세션.
      expect(run(['chat', '--continue'])).toBe(afterStale);
      // agent 도 같은 공용 결정(r2 should-fix) — 낡은 표지 → 최신 세션.
      writeFileSync(join(configDir, 'elanous', 'active'), '00000000-0000-4000-8000-000000000001');
      expect(run(['agent', '--no-tools', '--continue'])).toBe(afterStale);

      // ── TUI-H8-FOLLOW ③ — repl 실물: 인자 없음 두 번 = 서로 다른 새 세션 · --continue = 직전 세션.
      const turn = '{"prompt":"hi"}\n';
      const replA = run(['repl', '--no-tools', '--json'], [], turn);
      const replB = run(['repl', '--no-tools', '--json'], [], turn);
      expect(replA).not.toBe(afterStale);
      expect(replB).not.toBe(replA);
      expect(run(['repl', '--no-tools', '--json', '--continue'], [], turn)).toBe(replB);
      // repl 도 낡은 표지 → 최신 세션(r2 should-fix).
      writeFileSync(join(configDir, 'elanous', 'active'), '00000000-0000-4000-8000-000000000002');
      expect(run(['repl', '--no-tools', '--json', '--continue'], [], turn)).toBe(replB);
    } finally {
      server.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('④ 깨진 기록 resume — 고아 도구 짝을 잘라 이어받거나 거부한다', () => {
  const sys: ChatMessage = { role: 'system', content: 'dashboard prompt' };
  const deps = (history: ChatMessage[], chatHistory: ChatMessage[]) => ({
    resolveSessionId: (id: string) => id,
    historyFromSession: () => ({ history }),
    chatHistory,
    setAttachedSessionId: () => {},
    setActiveSessionId: () => {},
  });

  test('도구 호출 도중 죽은 꼬리(결과 없는 tool_use)는 잘리고 나머지는 그대로 이어받는다', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '일감' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'RunShell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: '다음' }, { type: 'tool_use', id: 'c2', name: 'RunShell', input: {} }] },
    ] as ChatMessage[];
    const chatHistory: ChatMessage[] = [sys];
    const result = resumeInProcessDashboardSession('s1', deps(history, chatHistory));
    expect(result).toMatchObject({ resumed: true, sessionId: 's1', repaired: { removedCalls: 1, removedResults: 0 } });
    const blocks = JSON.stringify(chatHistory);
    expect(blocks).toContain('"c1"');
    expect(blocks).not.toContain('"c2"');
    expect(chatHistory[0]).toBe(sys);
  });

  test('같은 id 가 겹쳐 짝을 못 가리면 이어받지 않는다(새 세션 권고) — 대화 기록 불변', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: {} }] },
    ] as ChatMessage[];
    const chatHistory: ChatMessage[] = [sys];
    const result = resumeInProcessDashboardSession('s2', deps(history, chatHistory));
    expect(result.resumed).toBe(false);
    if (!result.resumed) expect(result.reason).toContain('새 세션');
    expect(chatHistory).toEqual([sys]);
  });

  test('반증: 짝이 맞는 기록은 손대지 않는다(repaired 없음)', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const chatHistory: ChatMessage[] = [sys];
    expect(resumeInProcessDashboardSession('s3', deps(history, chatHistory)))
      .toEqual({ resumed: true, sessionId: 's3', turns: 2 });
  });
});

describe('③ /session new → 백엔드(ACP) 세션까지 새로', () => {
  test('DashboardSession.renew — 실제 in-process ACP 에서 새 sessionId 를 받고, 그 세션으로 턴이 돈다', async () => {
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation((async (_m: unknown, handlers: llmModule.StreamWithToolsHandlers) => {
      handlers.onText('ok', 'ok');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'ok' }]);
      return 'ok';
    }) as unknown as typeof llmModule.streamLLMWithTools);
    const { DashboardSession } = await import('../src/tui-client/dashboard-session.js');
    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [{ name: 'echo', description: '', parameters: { type: 'object', properties: {} } }],
      dispatchTool: async () => null,
    });
    try {
      const before = session.currentSessionId;
      const renewed = await session.renew('/tmp');
      expect(renewed).not.toBe(before);
      expect(session.currentSessionId).toBe(renewed);
      const { stopReason } = await session.send({ userText: 'hi' });
      expect(stopReason).toBe('end_turn');
    } finally {
      await session.close();
    }
  }, 60_000);

  test('/session new 핸들러가 acpRenew 를 부르고 session/start(session-new) 를 남긴다 · 실패해도 기록 비우기는 그대로', async () => {
    const { buildDashboardSlashRegistry } = await import('../src/dashboard/slash-runtime/dashboard-handlers.js');
    const events: Array<{ event: string; data: unknown }> = [];
    const origLog = debug.log.bind(debug);
    spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'session') events.push({ event, data });
      return origLog(category, event, data);
    }) as typeof debug.log);
    const run = async (acpRenew: (cwd: string) => Promise<string>) => {
      const lines: string[] = [];
      const history: Array<{ role: string; content: unknown }> = [{ role: 'system', content: 'p' }, { role: 'user', content: 'old' }];
      const id = (t: string) => t;
      const ctx = {
        chatLines: lines,
        pushChatLine: (l: string) => { lines.push(l); },
        accent: id, warning: id, error: id, success: id, muted: id, text: id,
        setChatScrollOffset: () => {},
        draw: () => {},
        getAttachedSessionId: () => null,
        setAttachedSessionId: () => {},
        setAttachedChatId: () => {},
        compactSlash: { chatHistory: history },
        sessionSlash: { remoteDaemon: () => null, acpRenew },
      } as unknown as Parameters<ReturnType<typeof buildDashboardSlashRegistry>['dispatch']>[2];
      await buildDashboardSlashRegistry().dispatch('session', ['new'], ctx);
      return { lines, history };
    };
    try {
      let called = 0;
      const ok = await run(async () => { called += 1; return 'acp-new-2'; });
      expect(called).toBe(1);
      expect(ok.lines.join('\n')).toContain('new backend session: acp-new-2');
      expect(ok.history).toEqual([{ role: 'system', content: 'p' }]);
      const failed = await run(async () => { throw new Error('boom'); });
      expect(failed.lines.join('\n')).toContain('backend session renew failed: boom');
      expect(failed.history).toEqual([{ role: 'system', content: 'p' }]);
      expect(events.some((e) => e.event === 'start' && (e.data as { reason?: string }).reason === 'session-new')).toBe(true);
      expect(events.some((e) => e.event === 'renew-failed')).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
