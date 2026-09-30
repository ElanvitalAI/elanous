import { describe, expect, test } from 'bun:test';
import { startPty } from '../../src/pty-shell/registry.js';
import { buildPtyEnv } from '../../src/agent/identity-env.js';
import { resetCapturedEnvForTesting, setCapturedEnvForTesting } from '../../src/shell-env-bootstrap.js';
import { cleanPtyUnsetEnv } from '../tui-sim.js';
import { resolveKeyBytes, resolveKeyInput, writeKeyInput } from './tui-sim-keys.js';

describe('resolveKeyBytes', () => {
  test('control letters, punctuation and newline preserve their distinct bytes', () => {
    expect(resolveKeyBytes('ctrl-q')).toBe('\x11');
    expect(resolveKeyBytes('ctrl-\\')).toBe('\x1c');
    expect(resolveKeyBytes('ctrl-]')).toBe('\x1d');
    expect(resolveKeyBytes('ctrl-j')).toBe('\n');
    for (let i = 0; i < 26; i++) {
      expect(resolveKeyBytes(`ctrl-${String.fromCharCode(97 + i)}`)).toBe(String.fromCharCode(i + 1));
    }
  });

  test('raw hex and modified keys', () => {
    expect(resolveKeyBytes('enter')).toBe('\r');
    expect(resolveKeyBytes('hex:1b5b41')).toBe('\x1b[A');
    expect(resolveKeyBytes('hex:1c')).toBe('\x1c');
    expect(resolveKeyInput('hex:e9')).toEqual(Buffer.from([0xe9]));
    expect(resolveKeyInput('hex:00ff80')).toEqual(Buffer.from([0, 255, 128]));
    expect(resolveKeyBytes('alt-x')).toBe('\x1bx');
    expect(resolveKeyBytes('alt-up')).toBe('\x1b\x1b[A');
    expect(resolveKeyBytes('alt-ctrl-q')).toBe('\x1b\x11');
    expect(resolveKeyBytes('alt-한')).toBe('\x1b한');
    expect(resolveKeyBytes('shift-enter')).toBe('\x1b[13;2u');
  });

  async function readHexFromPty(count: number, send: (handle: { write(chars: string): void }) => void): Promise<string> {
    const h = startPty({
      cmd: 'sh', args: ['-c', `stty raw -echo; printf READY; od -An -tx1 -N${count}`],
      cols: 80, rows: 24, workdir: process.cwd(),
    });
    try {
      for (let i = 0; i < 100 && !h.snapshot().includes('READY'); i++) await Bun.sleep(10);
      expect(h.snapshot()).toContain('READY');
      send(h);
      for (let i = 0; i < 100 && h.isAlive(); i++) await Bun.sleep(10);
      expect(h.isAlive()).toBe(false);
      return h.snapshot().split('READY')[1]!.trim().replace(/\s+/g, ' ');
    } finally {
      h.kill();
    }
  }

  test('hex:e9 reaches startPty handle as one raw byte, not UTF-8 c3 a9', async () => {
    expect(await readHexFromPty(1, h => writeKeyInput(h, resolveKeyInput('hex:e9')!))).toBe('e9');
  });

  test('hex:00ff80 writes NUL and high bytes without UTF-8 expansion', async () => {
    expect(await readHexFromPty(3, h => writeKeyInput(h, resolveKeyInput('hex:00ff80')!))).toBe('00 ff 80');
  });

  test('unknown and malformed key names are not sent', () => {
    expect(resolveKeyBytes('not-a-key')).toBeNull();
    expect(resolveKeyBytes('hex:1')).toBeNull();
    expect(resolveKeyBytes('hex:zz')).toBeNull();
    expect(resolveKeyBytes('alt-unknown')).toBeNull();
  });

  test('existing named keys retain their bytes', () => {
    expect(resolveKeyBytes('ctrl-c')).toBe('\x03');
    expect(resolveKeyBytes('ctrl-d')).toBe('\x04');
    expect(resolveKeyBytes('ctrl-u')).toBe('\x15');
    expect(resolveKeyBytes('ctrl-a')).toBe('\x01');
    expect(resolveKeyBytes('ctrl-e')).toBe('\x05');
    expect(resolveKeyBytes('tab')).toBe('\t');
    expect(resolveKeyBytes('shift-tab')).toBe('\x1b[Z');
    expect(resolveKeyBytes('up')).toBe('\x1b[A');
    expect(resolveKeyBytes('backspace')).toBe('\x7f');
  });
});

test('--clean-env removes credentials from both PTY captured env and process identity overlay', () => {
  const captured = {
    PATH: '/usr/bin', HOME: '/tmp/old-home', LANG: 'C.UTF-8',
    STRIPE_SECRET_KEY: 'stripe-secret', DATABASE_URL: 'postgres://secret',
    NPM_CONFIG__AUTH: 'npm-secret', OPENAI_API_KEY: 'openai-secret',
  };
  const parent = {
    STRIPE_SECRET_KEY: 'parent-stripe', DATABASE_URL: 'parent-db',
    NPM_CONFIG__AUTH: 'parent-npm', GH_TOKEN: 'parent-gh',
    ELANOUS_RUN_ID: 'private-run', UNRECOGNIZED_SECRET: 'private',
  };
  setCapturedEnvForTesting(captured);
  try {
    const unset = cleanPtyUnsetEnv(captured, parent);
    const env = buildPtyEnv({ HOME: '/tmp/empty-home', ELANOUS_DRIVE_TUI: '1' }, parent, { unset });
    for (const key of ['STRIPE_SECRET_KEY', 'DATABASE_URL', 'NPM_CONFIG__AUTH', 'OPENAI_API_KEY', 'GH_TOKEN', 'ELANOUS_RUN_ID']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.HOME).toBe('/tmp/empty-home');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ELANOUS_DRIVE_TUI).toBe('1');
    expect(unset).toContain('UNRECOGNIZED_SECRET');
    expect(cleanPtyUnsetEnv(captured, parent)).toEqual(unset);
  } finally {
    resetCapturedEnvForTesting();
  }
});
