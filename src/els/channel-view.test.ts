// ELS-CHANNEL P3 minimal — the channel view tile's pure parts and the `open` command (create + a view tab).
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerChannelCommands, selfCommand, viewWorkspace } from './channel-cli.js';
import { formatChannelLine, parseViewInput, runChannelView, speaker } from './channel-view.js';
import type { ChannelMessage } from './channel-log.js';

const at = new Date(2026, 10, 27, 1, 5).getTime();
const m = (over: Partial<ChannelMessage>): ChannelMessage => ({ id: 'cm-1-aaaaaa', seq: 1, at, channel: 'ws:demo', type: 'say', from: { role: 'hand', pane: 'p3', seat: 'TC' }, body: 'hi', ...over });

test('speaker and line format (no colour)', () => {
  expect(speaker(m({}))).toBe('TC·p3');
  expect(speaker(m({ from: { role: 'loop', seat: 'loop:guardian' } }))).toBe('↻ loop:guardian');
  expect(speaker(m({ from: { role: 'operator' }, human: true }))).toBe('you');
  expect(speaker(m({ from: { role: 'server' } }))).toBe('·');
  expect(formatChannelLine(m({}), false)).toBe('01:05 TC·p3  hi');
  expect(formatChannelLine(m({ type: 'ask', to: ['loop:rr'], body: 'cut?' }), false)).toBe('01:05 TC·p3 ask → loop:rr  cut?');
  expect(formatChannelLine(m({ type: 'answer', from: { role: 'loop', seat: 'loop:rr' }, body: 'at 04:00', refs: ['run:9'] }), false)).toBe('01:05 ↻ loop:rr answer  at 04:00\n      run:9');
});

test('input line → action', () => {
  expect(parseViewInput('  hello there ')).toEqual({ kind: 'post', type: 'say', body: 'hello there' });
  expect(parseViewInput('/ask @loop:release-rocket when is the cut?')).toEqual({ kind: 'post', type: 'ask', body: 'when is the cut?', to: ['loop:release-rocket'] });
  expect(parseViewInput('@p4 look')).toEqual({ kind: 'post', type: 'say', body: 'look', to: ['p4'] });
  expect(parseViewInput('/hold')).toEqual({ kind: 'hold' });
  expect(parseViewInput('/resume')).toEqual({ kind: 'resume' });
  expect(parseViewInput('/q')).toEqual({ kind: 'quit' });
  expect(parseViewInput('   ')).toEqual({ kind: 'empty' });
  expect(parseViewInput('@p4 ')).toEqual({ kind: 'empty' });
});

test('the view tab runs this same program in the channel workspace', () => {
  expect(selfCommand(['/usr/bin/bun', '/repo/bin/elanous.mjs'], '/usr/bin/bun')).toEqual(['/usr/bin/bun', '/repo/bin/elanous.mjs']);
  expect(selfCommand(['/x/node', '/x/other.js'], '/x/node')).toEqual(['elanous']);
  expect(viewWorkspace('ws:demo', {})).toBe('demo');
  expect(viewWorkspace('loop:rr', { ELANOUS_ELS_WS: 'HQ' })).toBe('HQ');
  expect(viewWorkspace('pair:a+b', {})).toBe('channels');
});

test('els channel open ws:demo creates the channel (or reuses it) and opens a view tab', async () => {
  for (const exists of [false, true]) {
    const asked: unknown[] = [], tabs: unknown[] = [], out: Array<{ exitCode: number; message: string }> = [];
    const program = new Command().exitOverride();
    registerChannelCommands(program, {
      emit: (r) => { out.push(r); },
      request: async (r) => { asked.push(r); return exists ? { exitCode: 1, message: 'els channel: ws:demo already exists' } : { exitCode: 0, message: '{}' }; },
      newPane: async (r) => { tabs.push(r); return { exitCode: 0, message: '{"pane":"p9"}' }; },
    });
    await program.parseAsync(['channel', 'open', 'ws:demo'], { from: 'user' });
    expect(asked).toEqual([{ op: 'channel', action: 'open', channel: 'ws:demo', policy: {} }]);
    expect(tabs).toEqual([expect.objectContaining({ op: 'new', ws: 'demo', title: '# ws:demo', command: [...selfCommand(), 'side', 'channel', 'view', 'ws:demo'] })]);
    expect(JSON.parse(out[0]!.message)).toEqual({ channel: 'ws:demo', created: !exists, view: { pane: 'p9' } });
  }
});

test('the tile survives a lost server: one error line per outage, retry, catch up, keep going (Terra #40331 must-4)', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const written: string[] = [];
  const out = { write: (t: string) => { written.push(t); return true; }, isTTY: false };
  const msg = (seq: number, body: string): ChannelMessage => m({ id: `cm-${seq}-aaaaaa`, seq, body });
  let reads = 0, waits = 0;
  let release: () => void = () => {};
  const ask = async (r: { action: string }) => {
    if (r.action === 'read') {
      reads++;
      if (reads === 1) throw new Error('connect ECONNREFUSED');
      if (reads === 2) throw new Error('connect ECONNREFUSED');
      if (reads === 3) return { exitCode: 1 as const, message: 'els: the server is stopping' };
      return { exitCode: 0 as const, message: JSON.stringify({ messages: reads === 4 ? [msg(1, 'first')] : [msg(2, 'second')] }) };
    }
    if (r.action === 'wait') {
      waits++;
      if (waits === 1) throw new Error('socket closed');
      if (waits === 2) return { exitCode: 0 as const, message: JSON.stringify({ message: msg(2, 'second') }) };
      await new Promise<void>((res) => { release = res; });
      return { exitCode: 0 as const, message: JSON.stringify({ timeout: true }) };
    }
    return { exitCode: 0 as const, message: '{}' };
  };
  const running = runChannelView('ws:demo', ask as never, { out, input, sleep: async () => {} });
  for (let i = 0; i < 50 && waits < 3; i++) await new Promise((r) => setTimeout(r, 2));
  input.write('/quit\n');
  release();
  expect(await running).toBe(0);
  const text = written.join('');
  expect(text.split('els channel: connect ECONNREFUSED — retrying').length - 1).toBe(1);
  expect(text).toContain('els: the server is stopping');
  expect(text).toContain('els channel: socket closed — retrying');
  expect(text).toContain('01:05 TC·p3  first');
  expect(text).toContain('01:05 TC·p3  second');
  expect(text).toContain('reconnected');
});
