import { NEXT_TUI_TITLE } from '../core/render.js';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Terminal } from '@xterm/headless';
import { bunSpawnPty } from '../../pty-shell/bun-native-pty.js';

/** Real next-TUI input and screen: a picker hidden by resize must not consume Tab. */
test('small next TUI shows the selected slash row and ignores Tab while the picker is hidden', async () => {
  const repo = resolve(import.meta.dir, '../../..');
  const root = mkdtempSync(join(tmpdir(), 'next-slash-small-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const terminal = new Terminal({ cols: 30, rows: 8, scrollback: 0, allowProposedApi: true });
  const pty = bunSpawnPty(process.execPath,
    [join(repo, 'bin/elanous.mjs'), `--test=${root}`, '--config-dir', root, '--test-state-dir', root, '--tui', 'next'],
    { cols: 30, rows: 8, cwd: root, env: {
      PATH: process.env.PATH ?? '', HOME: root, XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'), XDG_CACHE_HOME: join(root, '.cache'),
      ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', TERM: 'xterm-256color',
    } });
  let pending = Promise.resolve();
  let exitCode: number | null | undefined;
  const data = pty.onData((chunk) => { pending = pending.then(() => new Promise<void>((done) => terminal.write(chunk, done))); });
  const exit = pty.onExit(({ exitCode: code }) => { exitCode = code; });
  const screen = async (): Promise<string> => {
    await pending;
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
  };
  const waitFor = async (contains: string): Promise<string> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const shown = await screen();
      if (shown.includes(contains)) return shown;
      if (exitCode !== undefined || Date.now() > deadline) throw new Error(`waiting for ${contains}; exit=${exitCode}; screen=${shown}`);
      await Bun.sleep(75);
    }
  };
  try {
    expect((await waitFor('Enter 전송')).split('\n')).toContain(NEXT_TUI_TITLE);
    pty.write('/mo');
    expect(await waitFor('▸ /model')).toContain('❯ /mo');
    pty.write('\x1b[B');
    expect(await waitFor('▸ /memory')).toContain('❯ /mo');
    terminal.resize(30, 5); pty.resize(30, 5);
    expect(await waitFor('터미널이 너무 작습니다')).not.toContain('/memory');
    pty.write('\t');
    await Bun.sleep(200);
    terminal.resize(30, 8); pty.resize(30, 8);
    const restored = await waitFor('▸ /memory');
    expect(restored).toContain('❯ /mo');
    expect(restored).not.toContain('❯ /memory ');
    pty.write('\t');
    expect(await waitFor('❯ /memory ')).not.toContain('▸ /memory');
    pty.write('\x11');
    const deadline = Date.now() + 5_000;
    while (exitCode === undefined && Date.now() < deadline) await Bun.sleep(75);
    expect(exitCode).toBe(0);
  } finally {
    data.dispose(); exit.dispose(); pty.kill(); terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
