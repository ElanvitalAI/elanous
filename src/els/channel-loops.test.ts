// ELS-CHANNEL P1b — loop agents as channel participants: a message to loop:<id> is one call of its voice adapter
// ({from, channel, text, refs} → {text, evidence[], actions[]}); the reply is appended as the loop itself.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelHub, loopTargets, parseChannelId, type ChannelCaller, type ChannelMessage, type LoopVoiceAdapter } from './channel-log.js';
import { commandVoice, loopVoiceResolver, parseVoiceReply, registerLoopVoice, writeLoopVoiceDecl } from './loop-voice.js';

const hand = (pane: string, ws = 'w1'): ChannelCaller => ({ role: 'hand', pane, seat: `HAND-${pane}`, workspaces: [ws] });
const tmp = (): string => mkdtempSync(join(tmpdir(), 'els-channel-loops-'));
const read = async (hub: ReturnType<typeof createChannelHub>, channel: string): Promise<ChannelMessage[]> =>
  (JSON.parse((await hub.apply({ action: 'read', channel, after: 0 }, { role: 'op', seat: 'OP' })).message) as { messages: ChannelMessage[] }).messages;

describe('addresses', () => {
  test('loop:<id> is a channel; loop targets come from the channel and from to; a loop never wakes itself', () => {
    expect(parseChannelId('loop:release-rocket')).toEqual({ kind: 'loop', loop: 'release-rocket' });
    expect(parseChannelId('loop:a:b')).toBeUndefined();
    expect(parseChannelId('pair:loop:x+p1')).toEqual({ kind: 'pair', a: 'loop:x', b: 'p1' });
    const from = { role: 'hand' as const, pane: 'p1' };
    expect(loopTargets({ channel: 'loop:rr', from, type: 'ask' })).toEqual(['rr']);
    expect(loopTargets({ channel: 'ws:w1', from, type: 'say', to: ['loop:guardian', 'p2', 'loop:bad id'] })).toEqual(['guardian']);
    expect(loopTargets({ channel: 'loop:rr', from: { role: 'loop', seat: 'loop:rr' }, type: 'answer' })).toEqual([]);
    expect(loopTargets({ channel: 'loop:rr', from: { role: 'server' }, type: 'system' })).toEqual([]);
  });
});

describe('the hub calls the voice', () => {
  test('a pane asks loop:rr; the adapter gets {from, channel, text, refs}; the reply is an answer from the loop with evidence and actions', async () => {
    const dir = tmp();
    try {
      const seen: unknown[] = [];
      const voice: LoopVoiceAdapter = async (input) => { seen.push(input); return { text: 'cut is at 04:00 · rehearsal PASS', evidence: ['run:rel-77', 'file:receipt.json'], actions: ['status', 'bad action!'] }; };
      const hub = createChannelHub({ dir, loopVoice: (loop) => (loop === 'rr' ? voice : undefined) });
      const asked = JSON.parse((await hub.apply({ action: 'post', channel: 'loop:rr', type: 'ask', body: 'when is the cut?', refs: ['pr:1'] }, hand('p1'))).message) as { id: string };
      await hub.idle();
      expect(seen).toEqual([{ loop: 'rr', from: { role: 'hand', pane: 'p1', seat: 'HAND-p1' }, channel: 'loop:rr', text: 'when is the cut?', refs: ['pr:1'], messageId: asked.id }]);
      const messages = await read(hub, 'loop:rr');
      expect(messages[1]).toMatchObject({ type: 'answer', from: { role: 'loop', seat: 'loop:rr' }, replyTo: asked.id, body: 'cut is at 04:00 · rehearsal PASS', refs: ['run:rel-77', 'file:receipt.json', 'action:status'] });
      const open = (JSON.parse((await hub.apply({ action: 'read', channel: 'loop:rr' }, hand('p9', 'w9'))).message) as { open: string[] }).open;
      expect(open).toEqual([]);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('@loop on a workspace channel replies in that channel; no voice → one notice per channel until a voice exists', async () => {
    const dir = tmp();
    try {
      let muteVoice: LoopVoiceAdapter | undefined;
      const hub = createChannelHub({ dir, loopVoice: (loop) => (loop === 'guardian' ? async () => ({ text: 'node-b is full: 3 pods' }) : loop === 'mute' ? muteVoice : undefined) });
      await hub.apply({ action: 'post', channel: 'ws:w1', body: 'why is node-b busy?', to: ['loop:guardian'] }, hand('p1'));
      await hub.apply({ action: 'post', channel: 'loop:mute', body: 'hello' }, hand('p1'));
      await hub.idle();
      await hub.apply({ action: 'post', channel: 'loop:mute', body: 'hello again' }, hand('p2'));
      await hub.idle();
      expect((await read(hub, 'ws:w1')).map((m) => `${m.from.seat ?? m.from.role}:${m.body}`)).toEqual(['HAND-p1:why is node-b busy?', 'loop:guardian:node-b is full: 3 pods']);
      await hub.apply({ action: 'post', channel: 'loop:mute', body: 'third try' }, hand('p3'));
      await hub.idle();
      // Terra #40331 must-1/3: ONE notice for consecutive voiceless posts, not one per post.
      expect((await read(hub, 'loop:mute')).map((m) => m.type)).toEqual(['say', 'system', 'say', 'say']);
      expect((await read(hub, 'loop:mute'))[1]!.body).toBe('loop:mute has no voice yet — the message is kept in this channel for it');
      // A different channel naming the same loop gets its own single notice.
      await hub.apply({ action: 'post', channel: 'ws:w1', body: 'mute, are you there?', to: ['loop:mute'] }, hand('p1'));
      await hub.idle();
      expect((await read(hub, 'ws:w1')).filter((m) => m.type === 'system')).toHaveLength(1);
      // Once the loop has a voice it answers; if it loses it again, the notice is said once more.
      muteVoice = async () => ({ text: 'here now' });
      await hub.apply({ action: 'post', channel: 'loop:mute', body: 'now?' }, hand('p1'));
      await hub.idle();
      muteVoice = undefined;
      await hub.apply({ action: 'post', channel: 'loop:mute', body: 'gone again?' }, hand('p2'));
      await hub.idle();
      expect((await read(hub, 'loop:mute')).slice(4).map((m) => `${m.type}:${m.body}`)).toEqual(['say:now?', 'answer:here now', 'say:gone again?', 'system:loop:mute has no voice yet — the message is kept in this channel for it']);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a voice that fails or exceeds the deadline leaves a system line; calls to one loop run one at a time, in order', async () => {
    const dir = tmp();
    try {
      const timers: Array<() => void> = [];
      let running = 0, maxRunning = 0;
      const order: string[] = [];
      const hub = createChannelHub({
        dir, setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {},
        loopVoice: (loop) => loop === 'slow' ? () => new Promise(() => {}) : loop === 'boom' ? async () => { throw new Error('graph runner down'); }
          : async (input) => { running++; maxRunning = Math.max(maxRunning, running); await Promise.resolve(); order.push(input.text); running--; return { text: `ok ${input.text}` }; },
      });
      await hub.apply({ action: 'post', channel: 'loop:boom', body: 'go' }, hand('p1'));
      await hub.idle();
      expect((await read(hub, 'loop:boom'))[1]).toMatchObject({ type: 'system', body: 'loop:boom voice failed: graph runner down' });
      await hub.apply({ action: 'post', channel: 'loop:slow', body: 'go' }, hand('p1'));
      await new Promise((r) => setTimeout(r, 5));
      timers[timers.length - 1]!();
      await hub.idle();
      expect((await read(hub, 'loop:slow'))[1]).toMatchObject({ type: 'system', body: 'loop:slow voice failed: timed out' });
      await hub.apply({ action: 'post', channel: 'loop:q', body: 'one' }, hand('p1'));
      await hub.apply({ action: 'post', channel: 'loop:q', body: 'two' }, hand('p2'));
      await hub.idle();
      expect([order, maxRunning]).toEqual([['one', 'two'], 1]);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a pane and a loop cannot ping-pong forever: the loop reply that completes the window is refused and the channel pauses', async () => {
    const dir = tmp();
    let t = 0;
    try {
      const hub = createChannelHub({ dir, now: () => (t += 20_000), loopVoice: () => async (input) => ({ text: `echo ${input.text}` }) });
      let refused = '';
      for (let i = 0; i < 20 && !refused; i++) {
        const r = await hub.apply({ action: 'post', channel: 'loop:echo', body: `round ${i}` }, hand('p1'));
        await hub.idle();
        if (r.exitCode !== 0) refused = (JSON.parse(r.message) as { refused: string }).refused;
      }
      // Terra #40331 must-2: the 12th alternating message is the loop's reply — it is judged, not appended, and the channel pauses.
      expect(refused).toBe('paused');
      const log = await read(hub, 'loop:echo');
      expect(log.filter((m) => m.from.role === 'loop')).toHaveLength(5);
      expect(log.at(-1)).toMatchObject({ type: 'system', from: { role: 'server' } });
      expect(log.at(-1)!.body.startsWith('paused: ping-pong')).toBe(true);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('voice registration', () => {
  test('parseVoiceReply takes the last JSON line with a text', () => {
    expect(parseVoiceReply('log line\n{"text":"a"}\n{"text":"b","evidence":["x"],"actions":["status",3]}\n')).toEqual({ text: 'b', evidence: ['x'], actions: ['status'] });
    expect(parseVoiceReply('no json here')).toBeUndefined();
  });

  test('a declared command voice: JSON line in on stdin, JSON line out; in-process registration wins', async () => {
    const dir = tmp();
    try {
      const script = join(dir, 'voice.sh');
      writeFileSync(script, '#!/bin/sh\nread line\nprintf "%s\\n" "$line" > "$(dirname "$0")/got.json"\necho "thinking…"\necho "{\\"text\\":\\"heard $ELANOUS_LOOP_ID\\",\\"evidence\\":[\\"run:1\\"]}"\n');
      chmodSync(script, 0o755);
      const loops = join(dir, 'loops');
      writeLoopVoiceDecl(loops, 'board-steward', [script]);
      expect(JSON.parse(readFileSync(join(loops, 'board-steward.json'), 'utf8'))).toEqual({ voice: { command: [script] } });
      const resolve = loopVoiceResolver(loops);
      expect(resolve('nobody')).toBeUndefined();
      const reply = await resolve('board-steward')!({ loop: 'board-steward', from: { role: 'operator' }, channel: 'loop:board-steward', text: 'status?', refs: [], messageId: 'cm-1-aaaaaa' }, new AbortController().signal);
      expect(reply).toEqual({ text: 'heard board-steward', evidence: ['run:1'], actions: [] });
      expect(JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8'))).toMatchObject({ loop: 'board-steward', text: 'status?', channel: 'loop:board-steward' });
      const off = registerLoopVoice('board-steward', async () => ({ text: 'in-process' }));
      expect((await resolve('board-steward')!({ loop: 'board-steward', from: { role: 'operator' }, channel: 'loop:board-steward', text: 'x', refs: [], messageId: 'cm-2-aaaaaa' }, new AbortController().signal)).text).toBe('in-process');
      off();
      expect(() => writeLoopVoiceDecl(loops, '../evil', ['x'])).toThrow();
      // Terra #40331 must-5: megabytes of log lines (and one over-long line) before the reply do not lose the reply.
      const chatty = await commandVoice(['/bin/sh', '-c', 'i=0; while [ $i -lt 3000 ]; do echo "log line $i padding padding padding padding padding padding"; i=$((i+1)); done; head -c 70000 /dev/zero | tr "\\0" x; echo; echo \'{"text":"final answer"}\''])({ loop: 'x', from: { role: 'operator' }, channel: 'loop:x', text: '', refs: [], messageId: 'm' }, new AbortController().signal);
      expect(chatty.text).toBe('final answer');
      await expect(commandVoice(['/bin/sh', '-c', 'exit 3'])({ loop: 'x', from: { role: 'operator' }, channel: 'loop:x', text: '', refs: [], messageId: 'm' }, new AbortController().signal)).rejects.toThrow('voice exited 3');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
