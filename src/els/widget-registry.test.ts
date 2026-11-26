// BURST-BOARD-GENERAL: board widgets as els tabs — registry literals · ElsControl widget through the new door (fake els socket).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { boardHeader } from '../cli/burst-board-cli.js';
import { DEFAULT_BURST_CONFIG } from '../loops/op-pulse-burst.js';
import { runElsControl } from './els-control-tool.js';
import { resolveWidget, widgetLaunch, widgetListing, widgetWorkspace } from './widget-registry.js';

describe('widget registry', () => {
  test('names and aliases resolve to read-only board commands with a «▦» title', () => {
    expect(widgetLaunch('burst-board', {})).toEqual({ ok: true, name: 'burst-board', title: '▦ burst-board', command: ['elanous', 'burst-board'] });
    expect(widgetLaunch('Burst', {})).toMatchObject({ ok: true, name: 'burst-board' });
    expect(widgetLaunch('invest', {})).toMatchObject({ ok: true, command: ['elanous', 'demo', 'invest', 'board', '--replay'] });
    expect(widgetLaunch('release', {})).toMatchObject({ ok: true, title: '▦ release-board', command: ['elanous', 'release', 'graph', 'board'] });
    expect(resolveWidget('federation board')?.name).toBe('fed-board');
  });
  test('the burst-board widget never carries an operational flag', () => {
    const w = widgetLaunch('burst-board', {});
    expect(w.ok && w.command.some((x) => /test-universe|all-in|prewarm/.test(x))).toBe(false);
  });
  test('unknown widget and a missing fed-board script are refusals with a reason', () => {
    expect(widgetLaunch('nope', {})).toEqual({ ok: false, reason: 'unknown widget «nope» — one of: burst-board, fed-board, invest-board, release-board' });
    const home = mkdtempSync(join(tmpdir(), 'wh-'));
    expect(widgetLaunch('fed-board', { HOME: home })).toMatchObject({ ok: false });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPS', 'tools'), { recursive: true });
    writeFileSync(join(home, 'elanous-hq', 'seat-state', 'OPS', 'tools', 'fed-board.sh'), '#!/bin/zsh\n');
    expect(widgetLaunch('fed-board', { HOME: home })).toEqual({ ok: true, name: 'fed-board', title: '▦ fed-board', command: ['zsh', join(home, 'elanous-hq', 'seat-state', 'OPS', 'tools', 'fed-board.sh')] });
    expect(widgetListing({ HOME: home }).split('\n').length).toBe(4);
  });
  test('workspace: --ws, else the els workspace of this shell, else the folder name', () => {
    expect(widgetWorkspace('BURST', { ELANOUS_ELS_WS: 'OP' }, '/a/b')).toBe('BURST');
    expect(widgetWorkspace(undefined, { ELANOUS_ELS_WS: 'OP' }, '/a/b')).toBe('OP');
    expect(widgetWorkspace(undefined, {}, '/a/b')).toBe('b');
  });
});

describe('ElsControl widget', () => {
  const listing = { workspaces: [{ id: 'w1', name: 'one' }], tabs: [{ id: 't1', workspaceId: 'w1' }], panes: [{ pane: 'p1', tab: 't1', kind: 'agent' }] };
  async function fake(dir: string): Promise<{ received: Record<string, unknown>[]; close: () => Promise<void> }> {
    const received: Record<string, unknown>[] = [];
    const server = createServer((socket: Socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += String(chunk);
        let i = buf.indexOf('\n');
        while (i >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); i = buf.indexOf('\n');
          if (!line) continue;
          const req = JSON.parse(line) as Record<string, unknown>;
          if (req.op === 'auth') { socket.write(`${JSON.stringify({ exitCode: 0, message: 'auth' })}\n`); continue; }
          received.push(req);
          socket.write(`${JSON.stringify(req.op === 'ls' ? { exitCode: 0, message: JSON.stringify(listing) } : { exitCode: 0, message: 'opened' })}\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(join(dir, 'ctl.sock'), () => r()));
    return { received, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  test('opens the board as op new in the caller pane workspace, titled «▦ <name>»', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wctl-'));
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: 'w1', pane: '*', actions: ['new'] }] }));
    const f = await fake(dir);
    const out = await runElsControl({ action: 'widget', pane: 'p1', widget: 'burst' }, { socketPath: join(dirname(join(dir, 's.sock')), 's.sock'), stateDir: dir });
    expect(out.action).toBe('widget');
    expect(out.allowed).toBe(true);
    const req = f.received.find((r) => r.op === 'new') as { ws: string; command: string[]; title: string };
    expect(req).toMatchObject({ ws: 'w1', command: ['elanous', 'burst-board'], title: '▦ burst-board' });
    await f.close();
  });
  test('an unknown widget opens nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wctl-'));
    const f = await fake(dir);
    const out = await runElsControl({ action: 'widget', pane: 'p1', widget: 'nope' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('unknown-widget');
    expect(f.received.length).toBe(0);
    await f.close();
  });
});

describe('burst-board header (monitor tab)', () => {
  test('read-only by default · budget and ceilings from the burst config · cloud needs a card', () => {
    expect(boardHeader({ testUniverse: null, config: DEFAULT_BURST_CONFIG, active: null }))
      .toBe(' MONITOR · read-only (b/x print the OP command) · 4h preset budget $80 · ceilings hands≤8 review≤4 pregate≤4 · cloud $0 auto (VM = card + person)');
    expect(boardHeader({ testUniverse: '/tmp/tu', config: DEFAULT_BURST_CONFIG, active: null }).startsWith(' TEST UNIVERSE /tmp/tu · b/x enabled')).toBe(true);
  });
});
