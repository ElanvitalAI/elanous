import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';

const PROVIDER_KEYS = [
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
] as const;

test('Next test-mode parent and REPL child share the PID-fallback session for one arithmetic turn', async () => {
  expect(ptyAvailable()).toBe(true);
  const home = mkdtempSync(join(tmpdir(), 'next-tui-session-child-'));
  const configRoot = join(home, '.elanous');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'config.json'), JSON.stringify({
    onboarding: { ready: true, completed: false }, errorReports: { enabled: false },
  }));
  const repo = join(import.meta.dir, '..', '..');
  const reply = '[fake-llm] 4';
  const pty = startPty({
    cmd: process.execPath,
    args: [join(repo, 'bin', 'elanous.mjs'), '--tui', 'next'],
    cols: 80, rows: 24, workdir: home,
    // PTY startup rehydrates a login-shell environment; clear inherited roots and credentials there too.
    unsetEnv: [...PROVIDER_KEYS, 'ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'ELANOUS_CONFIG_DIR'],
    env: { HOME: home, NODE_ENV: 'test', ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: reply },
  });
  try {
    const deadline = Date.now() + 45_000;
    let screen = '';
    while (Date.now() < deadline) {
      screen = await pty.renderScreen();
      if (screen.includes('Ctrl+Q 종료')) break;
      await Bun.sleep(200);
    }
    expect(screen).toContain('Ctrl+Q 종료');
    pty.write('2+2는?');
    await Bun.sleep(150);
    pty.write('\r');
    while (Date.now() < deadline) {
      screen = await pty.renderScreen();
      if (screen.includes(reply) && screen.includes('턴 완료')) break;
      await Bun.sleep(200);
    }
    expect(screen).toContain('2+2는?');
    expect(screen).toContain(reply);
    expect(screen).toContain('턴 완료');
    // The test run must not silently create a session under the isolated HOME's operating-style config root.
    expect(existsSync(join(configRoot, 'sessions', 'index.json'))).toBe(false);
  } finally {
    pty.write('\x11');
    await Bun.sleep(200);
    try { pty.kill(); } catch { /* already exited */ }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
