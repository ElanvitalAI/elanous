import { NEXT_TUI_TITLE } from './core/render.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyAvailable, startPty } from '../pty-shell/registry.js';

let tempRoot = '';
afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

// Source: the L3 PTY harness uses this boot/poll window; the test waits for two fake-LLM turns.
const BOOT_WAIT_MS = 45_000;
// Source: established L3 PTY harness poll cadence in entry-new-session.test.ts.
const POLL_INTERVAL_MS = 200;
// Source: two real-PTY turns plus fake-LLM response; existing L3 tests allow 120 seconds.
const TEST_TIMEOUT_MS = 120_000;
// Source: this scenario pastes two images before switching the clipboard to text-only mode.
const IMAGE_PROBE_COUNT = 2;

type CapturedMessage = { role?: string; content?: Array<{ type?: string; text?: string }> };
type CapturedRequest = { messages?: CapturedMessage[] };

function blockTypes(message: CapturedMessage | undefined): string[] {
  return (message?.content ?? []).map((block) => block.type ?? 'unknown');
}

describe('Next TUI clipboard image paste through fake LLM', () => {
  test('two image pastes attach both images; deleting one token excludes it and text paste still works', async () => {
    if (!ptyAvailable() || process.platform !== 'darwin') return;
    tempRoot = mkdtempSync(join(tmpdir(), 'next-tui-clipboard-image-'));
    const iso = join(tempRoot, 'iso');
    const fakeBin = join(tempRoot, 'fake-bin');
    const sessionsRoot = join(iso, 'sessions');
    const capturePath = join(iso, 'recordings', 'fake-llm.jsonl');
    const sourceImage = join(import.meta.dir, '..', '..', 'apps/pwa/public/icons/elanous-512.png');
    mkdirSync(iso, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(iso, 'recordings'), { recursive: true });
    writeFileSync(join(iso, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const osascriptPath = join(fakeBin, 'osascript');
    writeFileSync(osascriptPath, `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const expression = process.argv.at(-1) ?? '';
const root = process.env.ELANOUS_TEST_CLIPBOARD_ROOT;
if (!root) throw new Error('missing fake clipboard root');
if (expression.includes('set outPath to')) {
  const destination = expression.match(/set outPath to "([^"]+)"/u)?.[1];
  const source = process.env.ELANOUS_TEST_CLIPBOARD_IMAGE_SOURCE;
  if (!destination || !source) throw new Error('missing fake clipboard image path');
  copyFileSync(source, destination);
  process.stdout.write('ok:PNG\\n');
} else if (expression.includes('get the clipboard as')) {
  const probes = join(root, 'image-probes');
  appendFileSync(probes, 'x');
  const count = readFileSync(probes, 'utf8').length;
  process.stdout.write(count <= Number(process.env.ELANOUS_TEST_CLIPBOARD_IMAGE_PROBES) ? 'yes\\n' : 'no\\n');
} else {
  throw new Error('unexpected fake clipboard command');
}
`);
    const pbpastePath = join(fakeBin, 'pbpaste');
    writeFileSync(pbpastePath, `#!/usr/bin/env bun
process.stdout.write(process.env.ELANOUS_TEST_CLIPBOARD_TEXT ?? '');
`);
    // Source: PATH-resolved fake clipboard commands must be executable by the PTY child.
    chmodSync(osascriptPath, 0o755);
    chmodSync(pbpastePath, 0o755);

    const savedStateDir = process.env.ELANOUS_STATE_DIR;
    const savedSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_STATE_DIR = iso;
    process.env.ELANOUS_SESSION_ROOT = sessionsRoot;
    const repo = join(import.meta.dir, '..', '..');
    const reply = '[fake-llm] clipboard checked';
    const pty = startPty({
      cmd: process.execPath,
      args: [join(repo, 'bin/elanous.mjs'), '--config-dir', iso, '--test-state-dir', iso, '--tui', 'next'],
      cols: 80,
      rows: 24,
      workdir: iso,
      env: {
        HOME: iso,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ELANOUS_SKIP_LOGIN_ENV: '1',
        ELANOUS_STATE_DIR: iso,
        ELANOUS_SESSION_ROOT: sessionsRoot,
        ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20',
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_LLM_MODE: 'fake',
        ELANOUS_TEST_FAKE_LLM_CAPTURE: capturePath,
        ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
        ELANOUS_TEST_CLIPBOARD_ROOT: iso,
        ELANOUS_TEST_CLIPBOARD_IMAGE_SOURCE: sourceImage,
        ELANOUS_TEST_CLIPBOARD_IMAGE_PROBES: String(IMAGE_PROBE_COUNT),
        ELANOUS_TEST_CLIPBOARD_TEXT: 'copied/path.txt',
      },
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label: string, done: (screen: string) => boolean): Promise<string> => {
      const deadline = Date.now() + BOOT_WAIT_MS;
      let screen = '';
      while (Date.now() < deadline) {
        screen = await pty.renderScreen();
        if (done(screen)) return screen;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(`timed out waiting for ${label}\n${screen}`);
    };
    const ctrlV = async () => {
      pty.write('\x16');
      await sleep(POLL_INTERVAL_MS);
    };
    const send = async (text: string) => {
      pty.write(text);
      await sleep(POLL_INTERVAL_MS);
      pty.write('\r');
    };
    try {
      await waitFor('Next TUI boot', (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료'));
      await ctrlV();
      await waitFor('first clipboard image token', (screen) => screen.includes('[Image #1]'));
      await ctrlV();
      await waitFor('second clipboard image token', (screen) => screen.includes('[Image #2]'));
      await send('Compare both pasted images.');
      await waitFor('two-image fake response', (screen) => screen.includes(reply) && screen.includes('응답 완료'));

      pty.write('[Image #1] [Image #2] ');
      await sleep(POLL_INTERVAL_MS);
      pty.write('\x7f'.repeat('[Image #2] '.length));
      await sleep(POLL_INTERVAL_MS);
      await ctrlV();
      await waitFor('text clipboard fallback', (screen) => screen.includes('copied/path.txt'));
      await send('Describe the remaining image and copied path.');
      await waitFor('one-image text-fallback fake response', (screen) => screen.split(reply).length > 2 && screen.includes('응답 완료'));

      const requests = readFileSync(capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as CapturedRequest);
      const userMessages = requests.map((request) => (request.messages ?? []).filter((message) => message.role === 'user').at(-1));
      expect(blockTypes(userMessages[0])).toEqual(['image', 'image', 'text']);
      expect(blockTypes(userMessages[1])).toEqual(['image', 'text']);
      expect(JSON.stringify(userMessages[1]?.content?.filter((block) => block.type === 'text'))).toContain('copied/path.txt');
    } finally {
      pty.write('\x11');
      await sleep(POLL_INTERVAL_MS);
      try { pty.kill(); } catch { /* already exited */ }
      if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = savedStateDir;
      if (savedSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = savedSessionRoot;
    }
  }, TEST_TIMEOUT_MS);
});
