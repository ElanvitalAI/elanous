import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { ansi, splitKeys, KeyStreamParser, sliceAnsiByColumns } from './tui.js';

function runtimeImports(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const runtimeBinding = !clause?.isTypeOnly && (clause === undefined || clause.name !== undefined
        || (clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings)
          || clause.namedBindings.elements.some((element) => !element.isTypeOnly))));
      return runtimeBinding ? [statement.moduleSpecifier.text] : [];
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const runtimeBinding = !statement.isTypeOnly && (!statement.exportClause
        || ts.isNamespaceExport(statement.exportClause)
        || statement.exportClause.elements.some((element) => !element.isTypeOnly));
      return runtimeBinding ? [statement.moduleSpecifier.text] : [];
    }
    return [];
  });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      const specifier = node.arguments[0]!.text;
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword)
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) imports.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) visit(statement);
  return imports;
}

function resolveRuntimeImport(filePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = resolve(dirname(filePath), specifier.replace(/\.(?:js|ts|tsx)$/, ''));
  for (const candidate of [`${target}.ts`, `${target}.tsx`, `${target}.js`, join(target, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function runtimeImportPath(from: string, to: string, seen = new Set<string>()): string[] | undefined {
  if (from === to) return [from];
  if (seen.has(from)) return undefined;
  seen.add(from);
  for (const specifier of runtimeImports(from)) {
    const next = resolveRuntimeImport(from, specifier);
    if (!next) continue;
    const path = runtimeImportPath(next, to, seen);
    if (path) return [from, ...path];
  }
  return undefined;
}

test('TUI render cache imports terminal primitives from the neutral contract', () => {
  const renderCache = join(import.meta.dir, 'tui-render-cache.ts');
  const terminalContract = join(import.meta.dir, 'tui-terminal-contract.ts');
  const tui = join(import.meta.dir, 'tui.ts');
  const renderCacheImports = runtimeImports(renderCache);
  const tuiImports = runtimeImports(tui);

  expect(renderCacheImports).toContain('./tui-terminal-contract.js');
  expect(renderCacheImports).not.toContain('./tui.js');
  expect(tuiImports).toContain('./tui-terminal-contract.js');
  expect(tuiImports).toContain('./tui-render-cache.js');
  expect(runtimeImportPath(terminalContract, tui)).toBeUndefined();
});

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

describe('modal-preserving terminal row updates', () => {
  test('NEXT-TUI-TERM-IO-SPLIT: public key API delegates to the extracted production module', async () => {
    const { code, stdout } = await runChild(`
      const { mock } = await import('bun:test');
      const calls = [];
      mock.module(${JSON.stringify(join(import.meta.dir, 'tui-key.js'))}, () => ({
        KeyStreamParser: class { push() { return []; } reset() {} flushEscape() { return []; } },
        splitKeys: (input) => { calls.push(input); return [{ name: 'mock-key', ctrl: false, shift: false }]; },
        __resetDoubleClickState: () => {},
      }));
      const { splitKeys } = await import(${JSON.stringify(TUI_PATH)});
      const result = splitKeys('production-key-input');
      console.log(JSON.stringify({ calls, result }));
    `);

    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      calls: string[];
      result: Array<{ name: string; ctrl: boolean; shift: boolean }>;
    };
    expect(result.calls).toEqual(['production-key-input']);
    expect(result.result).toEqual([{ name: 'mock-key', ctrl: false, shift: false }]);
  }, 10_000);

  test('NEXT-TUI-TERM-IO-SPLIT: production key input and wide text reach the mocked terminal renderer', async () => {
    const { code, stdout } = await runChild(`
      const { splitKeys, render, resetRenderCache, visibleWidth } = await import(${JSON.stringify(TUI_PATH)});
      const { renderCacheRowIs: moduleCacheRowIs } = await import(${JSON.stringify(RENDER_CACHE_PATH)});
      const chunks = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.rows = 2;
      process.stdout.columns = 12;
      process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
      resetRenderCache();
      const keys = splitKeys('\\x1b[27;5;106~');
      render(['界面 ready'], { force: true });
      const firstRowCached = moduleCacheRowIs(0, '界面 ready');
      const firstFrame = chunks.at(-1);
      render(['界面 ready']);
      const cachedRowStillMatches = moduleCacheRowIs(0, '界面 ready');
      const cachedFrame = chunks.at(-1);
      const width = visibleWidth('界面');
      process.stdout.write = write;
      console.log(JSON.stringify({ keys, width, frame: firstFrame, cachedFrame, firstRowCached, cachedRowStillMatches }));
    `);

    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      keys: Array<{ name: string; ctrl: boolean; shift: boolean; alt: boolean; raw: string }>;
      width: number;
      frame: string;
      cachedFrame: string;
      firstRowCached: boolean;
      cachedRowStillMatches: boolean;
    };
    expect(result.keys).toEqual([{ name: 'j', ctrl: true, shift: false, alt: false, raw: '\u001b[27;5;106~' }]);
    expect(result.width).toBe(4);
    expect(result.frame).toContain('界面 ready');
    expect(result.cachedFrame).toBe('\x1b[?25l');
    expect(result.firstRowCached).toBe(true);
    expect(result.cachedRowStillMatches).toBe(true);
  }, 10_000);

  test('slices ANSI rows by visible columns and protects wide glyph edges', () => {
    expect(sliceAnsiByColumns('\x1b[31mAB界CD\x1b[0m', 1, 4)).toBe('\x1b[31mB界\x1b[0m');
    expect(sliceAnsiByColumns('A界B', 0, 2)).toBe('A ');
  });

  test('updates only the visible margins beneath an overlay in one render write', async () => {
    const { code, stdout } = await runChild(`
      const { render, resetRenderCache } = await import(${JSON.stringify(TUI_PATH)});
      const chunks = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.rows = 3;
      process.stdout.columns = 12;
      process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
      resetRenderCache();
      render(['abcdefghijkl'], { force: true });
      render(['ABCDEFGHIJKL'], {
        force: true,
        preserveBounds: { row: 1, col: 4, width: 4, height: 1 },
        overlay: 'POPUP',
      });
      render(['ABCDEFGHIJKL'], { force: true });
      process.stdout.write = write;
      console.log(JSON.stringify(chunks.slice(1)));
    `);

    expect(code).toBe(0);
    const [modalFrame, closedFrame] = JSON.parse(stdout.trim()) as string[];
    expect(modalFrame).toContain('\x1b[1;1HABC');
    expect(modalFrame).toContain('\x1b[1;8HHIJKL');
    expect(modalFrame).toEndWith('POPUP');
    expect(modalFrame).not.toContain('\x1b[1;1H\x1b[2K');
    expect(modalFrame).not.toContain('\x1b[J');
    expect(closedFrame).toContain('\x1b[J');
    expect(closedFrame).toContain('\x1b[1;1H\x1b[2KABCDEFGHIJKL');
  }, 10_000);
});

const REPO_ROOT = join(import.meta.dir, '..');
const TUI_PATH = join(REPO_ROOT, 'src/tui.ts');
const RENDER_CACHE_PATH = join(REPO_ROOT, 'src/tui-render-cache.ts');
const CHAT_PATH = join(REPO_ROOT, 'src/chat/index.ts');

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

  // ⭐ TUI-ESC-ABORT-TOOLS (2026-10-15) — 바깥 키(`pty key` · 제어 IPC input-key)는 `injectKey`
  //    큐로 들어온다. 턴 중 키를 받는 스트리밍 리스너가 그 큐를 비우지 않으면 Esc 가 escGate 에
  //    닿지 않고 턴 끝까지 잠든다(TUI 결함 #60 · #40). 반증: takeInjectedKeys 배수를 빼면 두 시험이 깨진다.
  test('PTY streaming listener receives an injected Escape within 1s', async () => {
    const { code, stdout } = await runPtyChild(`
      const { initTui, injectKey } = await import(${JSON.stringify(TUI_PATH)});
      const { attachStreamingKeys } = await import(${JSON.stringify(CHAT_PATH)});
      initTui(false);
      const got = [];
      const cleanup = attachStreamingKeys((key) => { got.push(key.name); });
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      injectKey({ name: 'escape', ctrl: false, shift: false });
      while (!got.includes('escape') && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
      cleanup();
      process.stdout.write('STREAM-KEYS:' + JSON.stringify({ got, withinMs: Date.now() - t0 }) + '\\n');
      process.exit(0);
    `, { signal: 'SIGTERM', timeoutMs: 45_000 });
    const marked = stdout.match(/STREAM-KEYS:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    expect(code).toBe(0);
    const parsed = JSON.parse(marked![1]!) as { got: string[]; withinMs: number };
    expect(parsed.got).toEqual(['escape']);
    expect(parsed.withinMs).toBeLessThan(1000);
  }, 60_000);

  test('PTY onEscAbort aborts the controller on an injected Escape within 1s (incl. key queued before attach)', async () => {
    const { code, stdout } = await runPtyChild(`
      const { initTui, injectKey } = await import(${JSON.stringify(TUI_PATH)});
      const { onEscAbort } = await import(${JSON.stringify(CHAT_PATH)});
      initTui(false);
      const live = new AbortController();
      const cleanupLive = onEscAbort(live);
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      injectKey({ name: 'escape', ctrl: false, shift: false });
      while (!live.signal.aborted && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
      const liveMs = Date.now() - t0;
      cleanupLive();
      // 턴 시작 «전»에 주입돼 큐에 남은 Esc — attach 직후 배수로 받는다.
      injectKey({ name: 'escape', ctrl: false, shift: false });
      const queued = new AbortController();
      const t1 = Date.now();
      const cleanupQueued = onEscAbort(queued);
      while (!queued.signal.aborted && Date.now() - t1 < 1000) await new Promise((r) => setTimeout(r, 10));
      cleanupQueued();
      process.stdout.write('ESC-ABORT:' + JSON.stringify({ live: live.signal.aborted, liveMs, queued: queued.signal.aborted, queuedMs: Date.now() - t1 }) + '\\n');
      process.exit(0);
    `, { signal: 'SIGTERM', timeoutMs: 45_000 });
    const marked = stdout.match(/ESC-ABORT:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    expect(code).toBe(0);
    const parsed = JSON.parse(marked![1]!) as { live: boolean; liveMs: number; queued: boolean; queuedMs: number };
    expect(parsed.live).toBe(true);
    expect(parsed.liveMs).toBeLessThan(1000);
    expect(parsed.queued).toBe(true);
    expect(parsed.queuedMs).toBeLessThan(1000);
  }, 60_000);

  test('PTY readKey keeps ownership of injected keys while it is awaiting', async () => {
    const { code, stdout } = await runPtyChild(`
      const { initTui, injectKey, readKey } = await import(${JSON.stringify(TUI_PATH)});
      const { attachStreamingKeys } = await import(${JSON.stringify(CHAT_PATH)});
      initTui(false);
      // 스트리밍 리스너가 «먼저» 붙어 있어도 readKey 가 걸려 있으면 주입 키는 readKey 몫이다.
      const streamed = [];
      const cleanup = attachStreamingKeys((key) => { streamed.push(key.name); });
      await new Promise((r) => setTimeout(r, 20));
      const pending = readKey();
      injectKey({ name: 'y', ctrl: false, shift: false });
      const key = await pending;
      await new Promise((r) => setTimeout(r, 50));
      cleanup();
      process.stdout.write('OWNED:' + JSON.stringify({ streamed, key: key.name }) + '\\n');
      process.exit(0);
    `, { signal: 'SIGTERM', timeoutMs: 45_000 });
    const marked = stdout.match(/OWNED:(\{.*\})/);
    expect(marked?.[1]).toBeTruthy();
    expect(code).toBe(0);
    expect(JSON.parse(marked![1]!)).toEqual({ streamed: [], key: 'y' });
  }, 60_000);

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
    for (const sequence of [ansi.kittyKbOn, ansi.modKeysOn, ansi.kittyKbOff, ansi.modKeysOff]) expect(stdout).toContain(sequence);
    expect(stdout).toContain('EXIT-NOTICE');
    expect(code).toBe(130);
  }, 10_000);

  test('PTY initTui then SIGTERM exits 143', async () => {
    const { code, stdout } = await runPtyChild(startedTuiSource(`JSON.stringify({
      isTTY: Boolean(process.stdin.isTTY),
    })`), { signal: 'SIGTERM' });
    expect(stdout).toContain('TUI-COUNTS:{"isTTY":true}');
    for (const sequence of [ansi.kittyKbOn, ansi.modKeysOn, ansi.kittyKbOff, ansi.modKeysOff]) expect(stdout).toContain(sequence);
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
