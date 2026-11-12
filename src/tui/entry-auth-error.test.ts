import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';

test('Next TUI ends a first turn with a visible auth error within five seconds', async () => {
  expect(ptyAvailable()).toBe(true);
  const iso = mkdtempSync(join(tmpdir(), 'next-tui-auth-error-'));
  writeFileSync(join(iso, 'config.json'), JSON.stringify({
    onboarding: { ready: true, completed: false },
    llm: { provider: 'openai-codex' }, errorReports: { enabled: false },
  }));
  const repo = join(import.meta.dir, '..', '..');
  const pty = startPty({
    cmd: process.execPath,
    args: [join(repo, 'bin/elanous.mjs'), '--config-dir', iso, '--tui', 'next'],
    cols: 90, rows: 30, workdir: iso,
    unsetEnv: ['OPENAI_API_KEY', 'CODEX_HOME', 'XDG_CONFIG_HOME',
      'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_RESPONSE'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(CODEX|OPENAI|ANTHROPIC|XAI|GROK|GEMINI|GOOGLE|ELANOUS_TEST_FAKE_LLM|ELANOUS_LLM_MODE|ELANOUS_SIM_UNIVERSE)/.test(key)
        && !/(_API_KEY|_TOKEN|_AUTH|_BASE_URL)$/.test(key))),
      HOME: iso, NODE_ENV: 'production', ELANOUS_STATE_DIR: iso,
      ELANOUS_SESSION_ROOT: join(iso, 'sessions'), ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_REMOTE_CODEX_ACCESS_ONLY: '1',
      ELANOUS_REMOTE_CODEX_MIRROR_PATH: join(iso, 'missing-auth.json'),
    },
  });
  const waitFor = async (accept: (screen: string) => boolean, deadline: number): Promise<string> => {
    let screen = '';
    while (Date.now() < deadline) {
      screen = await pty.renderScreen();
      if (accept(screen)) return screen;
      await Bun.sleep(100);
    }
    throw new Error(`Next TUI screen timed out: ${screen}`);
  };
  try {
    await waitFor((screen) => screen.includes('Ctrl+Q 종료'), Date.now() + 20_000);
    pty.write('첫 턴 인증 오류 확인');
    await Bun.sleep(100);
    const submittedAt = Date.now();
    pty.write('\r');
    const screen = await waitFor((value) => value.includes('응답 실패') && value.includes('Codex 인증이 준비되지 않았습니다'), submittedAt + 5_000);
    expect(screen).toContain('접근 미러를 갱신하세요');
    expect(screen).toContain('턴 응답 실패');
  } finally {
    pty.write('\x11');
    await Bun.sleep(150);
    try { pty.kill(); } catch { /* already exited */ }
    rmSync(iso, { recursive: true, force: true });
  }
}, 30_000);
