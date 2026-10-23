// TUI-HERDR-NAMED-AGENT — next TUI 가 herdr 밖에서 넣은 한 턴을 받는다(L3 · 실 PTY · fake LLM · fake herdr).
// `eln herdr prompt` 는 herdr `pane run` 으로 넣는다 — pane 이 bracketed-paste 를 켰으면 바이트는
// `ESC[200~문장ESC[201~` ⊕ CR(격리 herdr 세션 실측 10-22). 그래서 이 시험은 그 바이트를 그대로 쓴다.
// 판정 둘: ① 그 문장이 사용자 말로 들어간다(옛 판은 «paste» 라는 낱말을 넣었다)
//          ② 턴 시작·끝이 herdr 에 working → idle 로 신고된다(옛 판 next TUI 는 턴을 신고하지 않아 --wait 가 stalled).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSession, getActiveSessionId } from '../session/index.js';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';
import { createFakeBins } from '../ux-sim/fake-bin.js';

let dir = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-tui-herdr-'));
  for (const key of ['ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_SESSION_ROOT']) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const PROVIDER_KEYS = [
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
] as const;
function credentialFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(_API_KEY|_TOKEN|_AUTH|_BASE_URL)$/i.test(key) || /^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX|HERDR)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

describe('next TUI × herdr prompt (L3)', () => {
  test('bracketed-paste 로 들어온 문장이 턴이 되고 working → idle 이 herdr 에 신고된다', async () => {
    if (!ptyAvailable()) return;
    const iso = join(dir, 'iso');
    mkdirSync(iso, { recursive: true });
    writeFileSync(join(iso, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const sessionsRoot = join(iso, 'sessions');
    process.env.ELANOUS_STATE_DIR = iso;
    process.env.ELANOUS_STATE_DIR_SOURCE = 'test';
    process.env.ELANOUS_SESSION_ROOT = sessionsRoot;
    const fake = createFakeBins({ herdr: {} });
    const paneId = `w${process.pid}:p1`;
    const repo = join(import.meta.dir, '..', '..');
    const reply = '[fake-llm] herdr 답';
    const prompt = 'herdr 로 깨운 문장';
    const pty = startPty({
      cmd: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--config-dir', iso, '--test-state-dir', iso, '--tui', 'next'],
      cols: 80,
      rows: 24,
      workdir: iso,
      unsetEnv: PROVIDER_KEYS,
      env: {
        ...credentialFreeEnv(),
        HOME: iso,
        TMPDIR: dir,
        ELANOUS_SKIP_LOGIN_ENV: '1',
        ELANOUS_STATE_DIR: iso,
        ELANOUS_STATE_DIR_SOURCE: 'test',
        ELANOUS_SESSION_ROOT: sessionsRoot,
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
        HERDR_ENV: '1',
        HERDR_PANE_ID: paneId,
        HERDR_BIN_PATH: fake.bin('herdr'),
      },
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label: string, done: (screen: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 45_000;
      let screen = '';
      while (Date.now() < deadline) {
        screen = await pty.renderScreen();
        if (done(screen)) return screen;
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${label}\n${screen}`);
    };
    const states = (): string[] => fake.calls()
      .filter((c) => c.argv[0] === 'pane' && c.argv[1] === 'report-agent')
      .map((c) => c.argv[c.argv.indexOf('--state') + 1] ?? '?');
    try {
      await waitFor('boot', (s) => s.includes('elanous next ·') && s.includes('Ctrl+Q 종료'));
      const deadline = Date.now() + 10_000;
      while (!states().includes('idle') && Date.now() < deadline) await sleep(100);
      expect(states()[0]).toBe('idle');
      // herdr `pane run` 이 bracketed-paste 모드 pane 에 쓰는 바이트 그대로.
      pty.write(`\x1b[200~${prompt}\x1b[201~\r`);
      const after = await waitFor('reply', (s) => s.includes(reply) && s.includes('응답 완료'));
      expect(after).toContain(prompt);
      const id = getActiveSessionId() ?? '';
      expect(loadSession(id)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([prompt]);
      const until = Date.now() + 5_000;
      while (states().slice(1).join(',') !== 'working,idle' && Date.now() < until) await sleep(100);
      expect(states()).toEqual(['idle', 'working', 'idle']);
    } finally {
      pty.write('\x11');
      await sleep(1500);
      try { pty.kill(); } catch { /* already exited */ }
      fake.cleanup();
    }
  }, 120_000);
});
