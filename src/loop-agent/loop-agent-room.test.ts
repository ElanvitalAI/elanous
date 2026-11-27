// SUPERVISOR-REVIVE 3/3 — conversational supervisors: the els `loop-say` door (a loop speaks first), the agent's speaker
// (outbox ⊕ loop:<id> ⊕ ws:supervisors), the room (voices registered · intro lines), and an end-to-end round trip through
// the real channel hub with a v2 agent's voice (fake LLM): ask in ws:supervisors → answer from loop:<id> with evidence.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelHub, type ChannelCaller, type ChannelMessage, type LoopVoiceAdapter } from '../els/channel-log.js';
import { parseCard } from './card.js';
import { fileAgentMemory } from './memory.js';
import { tickAgent, voiceAgent, type AgentBody, type AgentPorts, type VoiceLlm } from './runtime.js';
import { toLoopVoiceReply, toVoiceMessage, type LoopVoiceInput } from './channel.js';
import { elsSpeaker, flushSpeakers, SUPERVISORS_CHANNEL } from './speak.js';
import { introLine, openRoom } from './room.js';

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));
const hand = (pane: string, ws = 'w1'): ChannelCaller => ({ role: 'hand', pane, seat: `HAND-${pane}`, workspaces: [ws] });
const operator: ChannelCaller = { role: 'operator', human: true };
const read = async (hub: ReturnType<typeof createChannelHub>, channel: string): Promise<ChannelMessage[]> =>
  (JSON.parse((await hub.apply({ action: 'read', channel, after: 0 }, { role: 'op', seat: 'OP' })).message) as { messages: ChannelMessage[] }).messages;

const CARD = parseCard(`runtime: v2
id: toy-watch
supervisor: OP
soul: { name: 장난감 감시, role: 맥박을 본다 }
subject: toy heartbeats
goal: 결손 0
kpi: { name: missing, at_most: 0 }
rights: { actions: [poke] }
escalate_after_min: 30
`);

function agent(seed: number, llm: VoiceLlm | null, speak?: (l: string) => void) {
  const root = tmp(`room-${seed}-`);
  let missing = 1 + (seed % 3);
  const body: AgentBody = {
    observe: () => ({ kpi: missing, subjects: Array.from({ length: missing }, (_, i) => ({ id: `w-${i}`, kind: 'watcher', summary: 'no beat 12m', ageMin: 12 })), facts: [] }),
    plan: obs => obs.subjects.slice(0, 1).map(s => ({ action: 'poke', target: s.id, why: 'dead' })),
    actions: { poke: { describe: '죽은 감시자의 트리거를 한 번 쏜다', run: (t) => { missing = Math.max(0, missing - 1); return { ok: true, line: `${t} 깨움`, ref: `watcher:${t}` }; } } },
  };
  const memory = fileAgentMemory(root, CARD.id, CARD.supervisor);
  const posts: Array<{ key: string; to: string }> = [];
  const ports: AgentPorts = { memory, post: (key, to) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return posts.length; }, beat: () => undefined, ...(speak ? { speak } : {}), llm };
  return { root, body, memory, ports, posts, missing: () => missing };
}

describe('els loop-say door', () => {
  test('host door or OP may speak as a loop that has a voice; a pane may not; no voice → refused; the line wakes no loop', async () => {
    const dir = tmp('els-loop-say-');
    try {
      const asked: string[] = [];
      const voice: LoopVoiceAdapter = async (i) => { asked.push(i.loop); return { text: 'x' }; };
      const hub = createChannelHub({ dir, loopVoice: (l) => (l === 'toy-watch' || l === 'other' ? voice : undefined) });
      const said = await hub.apply({ action: 'loop-say', channel: SUPERVISORS_CHANNEL, loop: 'toy-watch', body: '⚠️ missing 2 (목표 ≤ 0) 위반 · to: loop:other' }, operator);
      expect(said.exitCode).toBe(0);
      expect((await hub.apply({ action: 'loop-say', channel: 'loop:toy-watch', loop: 'toy-watch', body: 'hi' }, { role: 'op', seat: 'OP' })).exitCode).toBe(0);
      expect((await hub.apply({ action: 'loop-say', channel: 'loop:toy-watch', loop: 'toy-watch', body: 'fake' }, hand('p1'))).exitCode).toBe(1);
      expect((await hub.apply({ action: 'loop-say', channel: 'loop:ghost', loop: 'ghost', body: 'boo' }, operator)).exitCode).toBe(1);
      expect((await hub.apply({ action: 'loop-say', channel: 'loop:toy-watch', loop: 'bad id', body: 'x' }, operator)).exitCode).toBe(2);
      await hub.idle();
      const room = await read(hub, SUPERVISORS_CHANNEL);
      expect(room).toHaveLength(1);
      expect(room[0]).toMatchObject({ type: 'say', from: { role: 'loop', seat: 'loop:toy-watch' } });
      expect(asked).toEqual([]); // a loop's own line never calls another loop's voice
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('proactive voice: KPI breach → one line in loop:<id> and ws:supervisors (seeds)', () => {
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}`, async () => {
      const dir = tmp('els-speak-');
      try {
        const hub = createChannelHub({ dir, loopVoice: (l) => (l === 'toy-watch' ? async () => ({ text: 'ok' }) : undefined) });
        const root = tmp('speak-root-');
        const speak = elsSpeaker(root, 'toy-watch', (req) => hub.apply(req as never, operator));
        const a = agent(seed, null, speak);
        const t0 = new Date('2026-11-27T10:00:00Z');
        await tickAgent(CARD, a.body, a.ports, t0);
        let t = t0;
        while (a.missing() > 0) { t = new Date(t.getTime() + 5 * 60_000); await tickAgent(CARD, a.body, a.ports, t); }
        await tickAgent(CARD, a.body, a.ports, new Date(t.getTime() + 5 * 60_000));
        await flushSpeakers();
        const own = await read(hub, 'loop:toy-watch'); const room = await read(hub, SUPERVISORS_CHANNEL);
        expect(own.map(m => m.body.slice(0, 1))).toEqual(['⚠', '✅']); // breach once, recovery once — not every tick
        expect(room.map(m => m.from.seat)).toEqual(['loop:toy-watch', 'loop:toy-watch']);
        expect(readFileSync(join(root, 'loop-agents', 'toy-watch', 'speak.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
        hub.dispose();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe('round trip through the real hub: @loop:<id> in ws:supervisors → the v2 voice answers with evidence (fake LLM)', () => {
  test('ask «why did KPI drop» · multi-turn memory per channel · policy from L0 only', async () => {
    const dir = tmp('els-rt-');
    try {
      const prompts: string[] = [];
      const llm: VoiceLlm = { async complete(_s, user) {
        prompts.push(user);
        const said = user.slice(user.lastIndexOf('## 받은 말'));
        if (/초점/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '초점을 바꾼다.', actions: [{ cmd: 'set-policy', key: 'focus', value: 'node-b 먼저' }] }) };
        return { model: 'fake', text: JSON.stringify({ reply: `결손 ${/missing (\d+)/u.exec(user)?.[1]} — w-0 이 12분째 맥박이 없다.`, actions: [] }) };
      } };
      const a = agent(4, llm);
      const voice: LoopVoiceAdapter = async (input) => toLoopVoiceReply(await voiceAgent({ card: CARD, body: a.body, ports: a.ports, now: new Date('2026-11-27T10:00:00Z') }, toVoiceMessage(input as LoopVoiceInput, new Date('2026-11-27T10:00:00Z'))));
      const hub = createChannelHub({ dir, loopVoice: (l) => (l === 'toy-watch' ? voice : undefined) });
      const ws: ChannelCaller = { role: 'hand', pane: 'p1', seat: 'OPC', workspaces: ['supervisors'] };
      await hub.apply({ action: 'post', channel: SUPERVISORS_CHANNEL, type: 'ask', body: '왜 KPI 가 떨어졌어?', to: ['loop:toy-watch'] }, ws);
      await hub.idle();
      await hub.apply({ action: 'post', channel: SUPERVISORS_CHANNEL, type: 'ask', body: '초점을 node-b 로', to: ['loop:toy-watch'] }, ws);
      await hub.idle();
      await hub.apply({ action: 'post', channel: SUPERVISORS_CHANNEL, type: 'ask', body: '초점을 node-b 로', to: ['loop:toy-watch'] }, { role: 'op', seat: 'OP', pane: 'p0' });
      await hub.idle();
      const answers = (await read(hub, SUPERVISORS_CHANNEL)).filter(m => m.type === 'answer');
      expect(answers).toHaveLength(3);
      expect(answers[0]!.from.seat).toBe('loop:toy-watch');
      expect(answers[0]!.body).toContain('결손 2');
      expect(answers[0]!.refs?.some(r => r.startsWith('els:ws:supervisors:'))).toBe(true);
      expect(prompts[1]).toContain('왜 KPI 가 떨어졌어?'); // the second turn sees the first (thread = channel)
      expect(answers[1]!.refs).toContain('action:set-policy-refused:focus'); // OPC is not L0
      expect(answers[2]!.refs).toContain('action:set-policy:focus');          // OP is
      expect(a.memory.policy().focus).toBe('node-b 먼저');
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('room', () => {
  test('registers a voice per agent with a body and each introduces itself in ws:supervisors', async () => {
    const decls: Array<{ id: string; command: readonly string[] }> = []; const said: Array<Record<string, unknown>> = [];
    const other = parseCard(`runtime: v2\nid: no-body\nsupervisor: OP\nkpi: { name: k, at_most: 0 }\nrights: { actions: [x] }\n`);
    const r = await openRoom({ cards: () => [CARD, other], hasBody: id => id === 'toy-watch', writeDecl: (id, command) => decls.push({ id, command }),
      ask: async (req) => { said.push(req); return { exitCode: 0 }; }, selfCommand: () => ['elanous'], kpiOf: () => 'missing 0 (목표 ≤ 0) 충족' });
    expect(r).toEqual({ registered: ['toy-watch'], skipped: ['no-body'], spoken: ['toy-watch'], refused: [] });
    expect(decls).toEqual([{ id: 'toy-watch', command: ['elanous', 'loop', 'agent', 'toy-watch', 'voice'] }]);
    expect(said[0]).toMatchObject({ action: 'loop-say', channel: 'ws:supervisors', loop: 'toy-watch' });
    expect(introLine(CARD, 'k')).toContain('@loop:toy-watch');
  });
});
