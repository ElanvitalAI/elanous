import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { splitKeys, KeyStreamParser } from './tui.js';

describe('raw terminal control keys', () => {
  test('LF is Ctrl+J, not Enter', () => {
    expect(splitKeys('\n')).toEqual([{ name: 'j', ctrl: true, shift: false, alt: false, raw: '\n' }]);
  });

  test('CR remains Enter', () => {
    expect(splitKeys('\r')).toEqual([{ name: 'enter', ctrl: false, shift: false, alt: false, raw: '\r' }]);
  });

  test('FS is Ctrl+\\, not Ctrl+4', () => {
    expect(splitKeys('\x1c')).toEqual([{ name: '\\', ctrl: true, shift: false, alt: false, raw: '\x1c' }]);
  });

  test('bracketed paste keeps LF as text, not a Ctrl+J keystroke', () => {
    expect(new KeyStreamParser().push('\x1b[200~a\nb\x1b[201~')).toEqual([{
      name: 'paste', ctrl: false, shift: false,
      raw: '\x1b[200~a\nb\x1b[201~', paste: 'a\nb',
    }]);
  });
});

const REPO_ROOT = join(import.meta.dir, '..');
const TUI_PATH = join(REPO_ROOT, 'src/tui.ts');

function runChild(source: string, opts?: {
  signal?: NodeJS.Signals;
  afterReadyMs?: number;
  timeoutMs?: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (opts?.signal && stdout.includes('READY\n') && !child.killed) {
        setTimeout(() => child.kill(opts.signal), opts.afterReadyMs ?? 20);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(child.exitCode);
    }, opts?.timeoutMs ?? 8000);
  });
}

type BunTerminalProc = {
  kill: (signal?: string) => void;
  exited: Promise<number | null>;
};

function bunSpawn(): (cmd: string[], opts: Record<string, unknown>) => BunTerminalProc {
  const bun = (globalThis as { Bun?: { spawn?: (cmd: string[], opts: Record<string, unknown>) => BunTerminalProc } }).Bun;
  if (!bun?.spawn) throw new Error('Bun.spawn is required for PTY tests');
  return bun.spawn;
}

function runPtyChild(source: string, opts: {
  signal: NodeJS.Signals;
  afterReadyMs?: number;
  timeoutMs?: number;
}): Promise<{ code: number | null; stdout: string }> {
  const spawnPty = bunSpawn();
  return new Promise((resolve, reject) => {
    let stdout = '';
    let killed = false;
    let settled = false;
    const decoder = new TextDecoder();
    const proc = spawnPty([process.execPath, '-e', source], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      terminal: {
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
        data(_t: unknown, chunk: Uint8Array) {
          stdout += decoder.decode(chunk, { stream: true });
          if (!killed && stdout.includes('READY')) {
            killed = true;
            setTimeout(() => proc.kill(opts.signal), opts.afterReadyMs ?? 40);
          }
        },
      },
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      finish(null);
    }, opts.timeoutMs ?? 8000);
    Promise.resolve(proc.exited).then(
      (code) => finish(typeof code === 'number' ? code : null),
      reject,
    );
  });
}

function startedTuiSource(signalReadyJson: string): string {
  return `
    const { initTui, setExitNotice } = await import(${JSON.stringify(TUI_PATH)});
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    setExitNotice(() => process.stdout.write('EXIT-NOTICE\\n'));
    initTui(false);
    const once = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    initTui(false);
    const twice = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    process.stdout.write('TUI-COUNTS:' + ${signalReadyJson} + '\\n');
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
}

describe('tui exit handlers are start-gated', () => {
  test('import-only does not register exit/SIGINT/SIGTERM listeners', async () => {
    const { code, stdout, stderr } = await runChild(`
      const before = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };
      await import(${JSON.stringify(TUI_PATH)});
      const after = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };
      process.stdout.write(JSON.stringify({ before, after }));
      process.exit(0);
    `);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const counts = JSON.parse(stdout) as {
      before: { exit: number; sigint: number; sigterm: number };
      after: { exit: number; sigint: number; sigterm: number };
    };
    expect(counts.after).toEqual(counts.before);
  });

  test('import-only own SIGINT handler runs and the process does not exit immediately', async () => {
    const { code, stdout } = await runChild(`
      await import(${JSON.stringify(TUI_PATH)});
      process.on('SIGINT', () => {
        process.stdout.write('HANDLER-RAN\\n');
      });
      process.stdout.write('READY\\n');
      setTimeout(() => {
        process.stdout.write('STILL-ALIVE\\n');
        process.exit(0);
      }, 150);
    `, { signal: 'SIGINT' });
    expect(stdout).toContain('HANDLER-RAN');
    expect(stdout).toContain('STILL-ALIVE');
    expect(code).toBe(0);
  });

  test('non-TTY initTui does not register exit/SIGINT/SIGTERM listeners', async () => {
    const { code, stdout, stderr } = await runChild(`
      const { initTui } = await import(${JSON.stringify(TUI_PATH)});
      const before = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };
      initTui(false);
      initTui(false);
      const after = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
        isTTY: Boolean(process.stdin.isTTY),
      };
      process.stdout.write(JSON.stringify({ before, after }));
      process.exit(0);
    `);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const counts = JSON.parse(stdout) as {
      before: { exit: number; sigint: number; sigterm: number };
      after: { exit: number; sigint: number; sigterm: number; isTTY: boolean };
    };
    expect(counts.after.isTTY).toBe(false);
    expect(counts.after.exit).toBe(counts.before.exit);
    expect(counts.after.sigint).toBe(counts.before.sigint);
    expect(counts.after.sigterm).toBe(counts.before.sigterm);
  });

  test('non-TTY readKey rejects with a named input-unavailable error instead of Enter', async () => {
    const { code, stdout, stderr } = await runChild(`
      const { initTui, readKey, InputUnavailableError } = await import(${JSON.stringify(TUI_PATH)});
      initTui(false);
      try {
        await readKey();
        process.stdout.write('RESOLVED\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({
          isTTY: Boolean(process.stdin.isTTY),
          named: error instanceof InputUnavailableError,
          name: error.name,
          message: error.message,
        }));
      }
      process.exit(0);
    `);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { isTTY: boolean; named: boolean; name: string; message: string };
    expect(result.isTTY).toBe(false);
    expect(result.named).toBe(true);
    expect(result.name).toBe('InputUnavailableError');
    expect(result.message).toBe('Terminal input is unavailable');
  });

  test('non-TTY readKey rejection terminates an awaiting selection loop', async () => {
    const { code, stdout, stderr } = await runChild(`
      const { initTui, readKey, InputUnavailableError } = await import(${JSON.stringify(TUI_PATH)});
      initTui(false);
      let reads = 0;
      try {
        while (true) {
          reads++;
          await readKey();
        }
      } catch (error) {
        process.stdout.write(JSON.stringify({ named: error instanceof InputUnavailableError, reads }));
      }
      process.exit(0);
    `);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ named: true, reads: 1 });
  });

  test('PTY readKey still returns an injected ordinary key in raw TUI mode', async () => {
    const { code, stdout } = await runPtyChild(`
      const { initTui, injectKey, readKey } = await import(${JSON.stringify(TUI_PATH)});
      initTui(false);
      injectKey({ name: 'x', ctrl: false, shift: false });
      const key = await readKey();
      process.stdout.write('TUI-KEY:' + JSON.stringify({ isTTY: Boolean(process.stdin.isTTY), key }) + '\\n');
      process.exit(0);
    `, { signal: 'SIGTERM' });
    const marked = stdout.match(/TUI-KEY:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    expect(code).toBe(0);
    expect(JSON.parse(marked![1]!)).toEqual({
      isTTY: true,
      key: { name: 'x', ctrl: false, shift: false },
    });
  }, 10_000);

  test('PTY initTui registers handlers once and SIGINT exits 130', async () => {
    const { code, stdout } = await runPtyChild(startedTuiSource(`JSON.stringify({
      isTTY: Boolean(process.stdin.isTTY),
      before,
      once,
      twice,
    })`), { signal: 'SIGINT' });
    const marked = stdout.match(/TUI-COUNTS:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    const counts = JSON.parse(marked![1]!) as {
      isTTY: boolean;
      before: { exit: number; sigint: number; sigterm: number };
      once: { exit: number; sigint: number; sigterm: number };
      twice: { exit: number; sigint: number; sigterm: number };
    };
    expect(counts.isTTY).toBe(true);
    expect(counts.once.exit).toBe(counts.before.exit + 1);
    expect(counts.once.sigint).toBe(counts.before.sigint + 1);
    expect(counts.once.sigterm).toBe(counts.before.sigterm + 1);
    expect(counts.twice).toEqual(counts.once);
    expect(stdout).toContain('EXIT-NOTICE');
    expect(code).toBe(130);
  }, 10_000);

  test('PTY initTui then SIGTERM exits 143', async () => {
    const { code, stdout } = await runPtyChild(startedTuiSource(`JSON.stringify({
      isTTY: Boolean(process.stdin.isTTY),
    })`), { signal: 'SIGTERM' });
    expect(stdout).toContain('TUI-COUNTS:{"isTTY":true}');
    expect(stdout).toContain('EXIT-NOTICE');
    expect(code).toBe(143);
  }, 10_000);

  test('initTui registers handlers immediately after the TTY guard and before terminal side effects', async () => {
    const src = await Bun.file(TUI_PATH).text();
    const start = src.indexOf('export function initTui');
    const end = src.indexOf('export function closeTui');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const init = src.slice(start, end);
    const ttyGuard = init.search(/if\s*\(\s*!process\.stdin\.isTTY\s*\)\s*return/);
    const register = init.indexOf('registerExitHandlers()');
    const setRawMode = init.indexOf('setRawMode');
    const stdoutWrite = init.indexOf('process.stdout.write');
    expect(ttyGuard).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(ttyGuard);
    expect(setRawMode).toBeGreaterThan(register);
    expect(stdoutWrite).toBeGreaterThan(register);
    expect(init.indexOf('registerExitHandlers()', register + 1)).toBe(-1);
  });

  test('PTY initTui has handlers registered by the first setRawMode call', async () => {
    const { code, stdout } = await runPtyChild(`
      const { initTui } = await import(${JSON.stringify(TUI_PATH)});
      const before = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };
      let atRaw = null;
      const origSetRawMode = process.stdin.setRawMode.bind(process.stdin);
      process.stdin.setRawMode = (mode) => {
        if (!atRaw) {
          atRaw = {
            exit: process.listenerCount('exit'),
            sigint: process.listenerCount('SIGINT'),
            sigterm: process.listenerCount('SIGTERM'),
          };
        }
        return origSetRawMode(mode);
      };
      initTui(false);
      process.stdout.write('TUI-ORDER:' + JSON.stringify({ before, atRaw }) + '\\n');
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `, { signal: 'SIGINT' });
    const marked = stdout.match(/TUI-ORDER:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    const order = JSON.parse(marked![1]!) as {
      before: { exit: number; sigint: number; sigterm: number };
      atRaw: { exit: number; sigint: number; sigterm: number } | null;
    };
    expect(order.atRaw).not.toBeNull();
    expect(order.atRaw!.exit).toBe(order.before.exit + 1);
    expect(order.atRaw!.sigint).toBe(order.before.sigint + 1);
    expect(order.atRaw!.sigterm).toBe(order.before.sigterm + 1);
    expect(code).toBe(130);
  }, 10_000);
});
