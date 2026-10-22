// TUI-NEXT-NEW-SESSION — `/new` (alias `/session new`) opens a fresh session from inside next TUI.
// The decision runs through the same seam entry.ts calls; the store is the real session store
// pointed at a temp root, so «옛 세션 기록은 그대로» is read back from disk, not assumed.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { appendMessage, createSession, getActiveSessionId, listSessions, loadSession, setActiveSessionId } from '../session/index.js';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';
import { NEW_SESSION_BUSY_STATUS, isNewSessionCommand, nextTuiTitle, requestNewTuiSession } from './slash/new-session.js';

let dir = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-tui-new-session-'));
  for (const key of ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT']) saved[key] = process.env[key];
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function seedTwoTurnSession(): string {
  const id = createSession({ source: 'tui' }).id;
  appendMessage(id, { role: 'user', content: '첫 질문', ts: new Date().toISOString() });
  appendMessage(id, { role: 'assistant', content: '첫 답', ts: new Date().toISOString() });
  setActiveSessionId(id);
  return id;
}

describe('/new command shape', () => {
  test('accepts /new and /session new only', () => {
    for (const text of ['/new', ' /new ', '/session new', '/session   new']) expect(isNewSessionCommand(text)).toBe(true);
    for (const text of ['/newx', '/new 제목', '/session', '/sessions new', 'new', '/quit']) expect(isNewSessionCommand(text)).toBe(false);
  });

  test('a fresh session shows «새 대화» rather than the store placeholder', () => {
    expect(nextTuiTitle(null)).toBe('새 대화');
    expect(nextTuiTitle({ title: '(new session)' })).toBe('새 대화');
    expect(nextTuiTitle({ title: '' })).toBe('새 대화');
    expect(nextTuiTitle({ title: '첫 질문\n둘째 줄' })).toBe('첫 질문');
  });
});

describe('requestNewTuiSession', () => {
  test('idle: creates a tui session, makes it active, keeps the old history, and logs from→to', () => {
    const from = seedTwoTurnSession();
    const log = spyOn(debug, 'log');
    try {
      const result = requestNewTuiSession({ busy: false, from });
      expect(result.kind).toBe('started');
      if (result.kind !== 'started') return;
      expect(result.id).not.toBe(from);
      expect(getActiveSessionId()).toBe(result.id);
      expect(loadSession(result.id)?.meta.source).toBe('tui');
      expect(loadSession(result.id)?.messages).toEqual([]);
      expect(loadSession(from)?.messages.map((m) => m.content)).toEqual(['첫 질문', '첫 답']);
      expect(result.status).toBe(`새 대화 · 이전 = ${from.slice(0, 8)}`);
      expect(log).toHaveBeenCalledWith('tui.next', 'session-new', { from, to: result.id });
    } finally {
      log.mockRestore();
    }
  });

  test('idle with no prior session still starts one and says so', () => {
    const result = requestNewTuiSession({ busy: false, from: null });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(getActiveSessionId()).toBe(result.id);
    expect(result.status).toBe('새 대화 · 이전 = 없음');
  });

  test('busy: refuses without creating a session or moving the active marker', () => {
    const from = seedTwoTurnSession();
    const before = listSessions().length;
    const log = spyOn(debug, 'log');
    try {
      const result = requestNewTuiSession({ busy: true, from });
      expect(result).toEqual({ kind: 'rejected', status: NEW_SESSION_BUSY_STATUS });
      expect(listSessions().length).toBe(before);
      expect(getActiveSessionId()).toBe(from);
      expect(log).toHaveBeenCalledWith('tui.next', 'session-new-rejected', { from, reason: 'busy' });
    } finally {
      log.mockRestore();
    }
  });
});

// L3: the real `--tui next` CLI in a real PTY (node-pty) with the network-free fake LLM
// (src/ux-sim/fake-llm.ts). Screens come from that PTY's headless xterm (`renderScreen`).
// Set ELANOUS_NEW_SESSION_LIVE_OUT=<dir> to keep the universe and write the screens there.
// The fake LLM answers only after every real provider is unavailable (llm.ts), so the child
// gets a HOME without logins and no provider keys — a seat with credentials must not bill.
const PROVIDER_KEYS = [
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
] as const;
function credentialFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(_API_KEY|_TOKEN|_AUTH|_BASE_URL)$/i.test(key) || /^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

describe('next TUI /new in a real PTY (L3)', () => {
  const live = process.env.ELANOUS_NEW_SESSION_LIVE_OUT?.trim();
  test('two messages → /new → one message: the next turn lands in a new session and the old history stays', async () => {
    if (!ptyAvailable()) return;
    const iso = live ? join(live, 'iso') : dir;
    mkdirSync(iso, { recursive: true });
    // First-run onboarding would otherwise ask for a provider before the TUI opens.
    writeFileSync(join(iso, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const sessionsRoot = join(iso, 'sessions');
    process.env.ELANOUS_STATE_DIR = iso;
    process.env.ELANOUS_SESSION_ROOT = sessionsRoot;
    const repo = join(import.meta.dir, '..', '..');
    const reply = '[fake-llm] 답했습니다';
    const pty = startPty({
      cmd: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--config-dir', iso, '--test-state-dir', iso, '--tui', 'next'],
      cols: 80,
      rows: 24,
      workdir: iso,
      // The PTY env is rebuilt from the login-shell capture; dropping a key from `env` is not enough.
      unsetEnv: PROVIDER_KEYS,
      env: {
        ...credentialFreeEnv(),
        HOME: iso,
        // Without this the CLI re-imports provider keys from the login shell (shell-env-bootstrap.ts).
        ELANOUS_SKIP_LOGIN_ENV: '1',
        ELANOUS_STATE_DIR: iso,
        ELANOUS_SESSION_ROOT: sessionsRoot,
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
      },
    });
    const screens: string[] = [];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label: string, done: (screen: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 45_000;
      let screen = '';
      while (Date.now() < deadline) {
        screen = await pty.renderScreen();
        if (done(screen)) {
          screens.push(`===== ${label} =====\n${screen}`);
          return screen;
        }
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${label}\n${screen}`);
    };
    const count = (screen: string, text: string) => screen.split(text).length - 1;
    const send = async (text: string) => {
      pty.write(text);
      await sleep(150);
      pty.write('\r');
    };
    try {
      await waitFor('boot', (s) => s.includes('elanous next ·') && s.includes('Ctrl+Q 종료'));
      await send('첫 메시지');
      await waitFor('after message 1', (s) => count(s, reply) === 1 && s.includes('응답 완료'));
      await send('둘째 메시지');
      const before = await waitFor('before /new (2 messages)', (s) => count(s, reply) === 2 && s.includes('응답 완료'));
      expect(before).toContain('첫 메시지');
      const oldId = getActiveSessionId() ?? '';
      await send('/new');
      const after = await waitFor('after /new', (s) => s.includes(`새 대화 · 이전 = ${oldId.slice(0, 8)}`));
      expect(after).toContain('elanous next · 새 대화');
      expect(after).not.toContain('첫 메시지');
      expect(after).not.toContain(reply);
      await send('셋째 메시지');
      await waitFor('after message 3 (new session)', (s) => count(s, reply) === 1 && s.includes('응답 완료') && s.includes('셋째 메시지'));
      const newId = getActiveSessionId() ?? '';
      expect(newId).not.toBe(oldId);
      expect(loadSession(oldId)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['첫 메시지', '둘째 메시지']);
      expect(loadSession(newId)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['셋째 메시지']);
      screens.push(`===== store =====\nold ${oldId} user=${JSON.stringify(loadSession(oldId)?.messages.filter((m) => m.role === 'user').map((m) => m.content))}\nnew ${newId} user=${JSON.stringify(loadSession(newId)?.messages.filter((m) => m.role === 'user').map((m) => m.content))}`);
    } finally {
      pty.write('\x11');
      await sleep(1500);
      try { pty.kill(); } catch { /* already exited */ }
      if (live) writeFileSync(join(live, 'screens.txt'), `${screens.join('\n\n')}\n`);
    }
  }, 120_000);
});
