// ELS-PANE-AGENT-DETECT literals (OP #102878): sh → a child «eln» → kind eln; it exits → shell again. Through the real
// server: the probe, `els ls` (kind · fgCommand), `els status` (kind · pid) and the tab row's emoji and name.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePaneRows } from './attach-view.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { foregroundOf, kindOfCommand, parsePs } from './foreground.js';
import { elsSocketPath, probeForegrounds, startElsServer } from './server.js';
import { buildTabRow, withCommands } from './space-tabs-view.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('kind from the command line: the first word past runtime wrappers decides, never an argument', () => {
  expect([
    kindOfCommand(['-zsh']), kindOfCommand(['/bin/sh']), kindOfCommand(['bun', '/opt/x/elanous.mjs', '--resume', 'abc']),
    kindOfCommand(['/usr/local/bin/eln']), kindOfCommand(['node', '/usr/lib/codex']), kindOfCommand(['claude']),
    kindOfCommand(['grok']), kindOfCommand(['vim', 'claude']), kindOfCommand(['ssh', 'box', 'codex']),
  ]).toEqual(['shell', 'shell', 'eln', 'eln', 'codex', 'claude', 'grok', 'other', 'other']);
});

test('the foreground is the shell\'s terminal foreground group: the shell itself, or the child it runs', () => {
  const idle = parsePs('  4242  4242 -zsh\n  999   -1 /usr/sbin/syslogd\n');
  expect(foregroundOf(4242, idle)).toEqual({ kind: 'shell', command: ['-zsh'], pid: 4242 });
  const running = parsePs('  4242  5000 -zsh\n  5000  5000 bun /opt/x/elanous.mjs\n  5001  5000 git status\n');
  expect(foregroundOf(4242, running)).toEqual({ kind: 'eln', command: ['bun', '/opt/x/elanous.mjs'], pid: 5000 });
  expect(foregroundOf(7, running)).toBeUndefined();
});

test('server: sh → a child «eln» → kind eln (ls · status · tab «💬 eln»); it exits → shell again (tab back to the shell)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-fg-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pty: ElsPty = { id: 'pty_1', pid: 4242, isAlive: () => true, write: () => {}, renderScreen: async () => '$ ', onExit: () => {}, kill: () => {} };
  let table = '  4242  4242 /bin/sh\n';
  const started = await startElsServer({ stateRoot: root, spawn: () => pty, ps: async () => table });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const pane = (JSON.parse((await requestEls(socket, { op: 'new', ws: 'OP', cwd: '/work', command: ['/bin/sh'], title: '/bin/sh' })).message) as { pane: string }).pane;
  const tabOf = async () => { const ls = (await requestEls(socket, { op: 'ls' })).message; return buildTabRow(withCommands(parsePaneRows(ls), ls), undefined, 20).line!.trimEnd(); };

  expect(await probeForegrounds(started.core, async () => table)).toEqual([pane]);
  expect(await tabOf()).toBe('\u001b[100;37m ⌨️ SH \u001b[49;39m +');
  table = '  4242  5000 /bin/sh\n  5000  5000 bun /opt/x/elanous.mjs\n';
  expect(await probeForegrounds(started.core, async () => table)).toEqual([pane]);
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { kind?: string; fgCommand?: string[] }[] };
  expect([listed.panes[0]!.kind, listed.panes[0]!.fgCommand]).toEqual(['eln', ['bun', '/opt/x/elanous.mjs']]);
  expect(JSON.parse((await requestEls(socket, { op: 'status', pane })).message)).toMatchObject({ kind: 'eln', pid: 5000 });
  expect(await tabOf()).toBe('\u001b[100;37m 💬 ELN \u001b[49;39m +');
  table = '  4242  4242 /bin/sh\n';
  expect(await probeForegrounds(started.core, async () => table)).toEqual([pane]);
  expect(await tabOf()).toBe('\u001b[100;37m ⌨️ SH \u001b[49;39m +');
});
