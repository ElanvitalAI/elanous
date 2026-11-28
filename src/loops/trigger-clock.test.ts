import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseTriggerClockPolicy, runTriggerClock, triggerClockPolicyPath, type TriggerClockPorts, type TriggerClockState } from './trigger-clock';

// Expected values are literals, independent of the product (rule 11).
const T0 = Date.parse('2026-11-28T06:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const POLICY = { staleAfterMin: 6, wakeEveryMin: 10, cardAfterMin: 20, cardEveryH: 6, owner: 'OP' };

function world(o: { last: () => string | null | undefined; installed?: boolean; registry?: boolean; wakeOk?: boolean }) {
  let state: TriggerClockState = { staleSince: null, lastWakeAt: null, lastCardAt: null };
  const wakes: string[] = []; const cards: Array<{ to: string; body: string }> = [];
  const ports = (min: number): TriggerClockPorts => ({
    now: new Date(T0 + min * 60_000), lastTickAt: o.last, installed: () => o.installed ?? true, hasRegistry: () => o.registry ?? true,
    wake: async () => { wakes.push(iso(min)); return { ok: o.wakeOk ?? true, line: 'rc=0' }; },
    card: async (to, body) => { cards.push({ to, body }); return `msg#${cards.length}`; },
    readState: () => state, writeState: (s) => { state = s; },
  });
  return { ports, wakes, cards, state: () => state };
}

describe('trigger-clock — the outside clock of the registry tick', () => {
  test('the shipped policy pack parses to the documented numbers', () => {
    expect(parseTriggerClockPolicy(readFileSync(triggerClockPolicyPath(), 'utf8'))).toEqual({ staleAfterMin: 6, wakeEveryMin: 10, cardAfterMin: 20, cardEveryH: 6, owner: 'OP' });
  });

  test('a malformed pack is refused, never a silent default', () => {
    expect(() => parseTriggerClockPolicy('version: 1\nclock: { owner: OP, stale_after_min: 0 }')).toThrow('trigger-clock policy: clock.stale_after_min must be a positive number');
    expect(() => parseTriggerClockPolicy('version: 2')).toThrow('trigger-clock policy: version must be 1');
  });

  test('fresh beat → nothing; a host without the schedule entry is never ticked', async () => {
    const w = world({ last: () => iso(-2) });
    expect((await runTriggerClock(POLICY, w.ports(0))).status).toBe('ok');
    const off = world({ last: () => iso(-300), installed: false });
    expect((await runTriggerClock(POLICY, off.ports(0))).status).toBe('not-installed');
    expect([w.wakes, off.wakes]).toEqual([[], []]);
  });

  test('stale: one wake per window · one card after 20 min · fresh again → recovered and forgotten', async () => {
    let last: string = iso(-30);
    const w = world({ last: () => last });
    const r0 = await runTriggerClock(POLICY, w.ports(0));
    const r5 = await runTriggerClock(POLICY, w.ports(5));
    const r10 = await runTriggerClock(POLICY, w.ports(10));
    const r20 = await runTriggerClock(POLICY, w.ports(20));
    const r25 = await runTriggerClock(POLICY, w.ports(25));
    expect([r0.status, r5.status, r10.status, r20.status, r25.status]).toEqual(['woke', 'stale', 'woke', 'carded', 'stale']);
    expect(w.wakes).toEqual(['2026-11-28T06:00:00.000Z', '2026-11-28T06:10:00.000Z', '2026-11-28T06:20:00.000Z']);
    expect(w.cards.map(c => c.to)).toEqual(['OP']);
    expect(w.cards[0]!.body).toContain('[trigger-clock · 레지스트리 틱 멈춤] eln loop trigger tick: last beat 50m ago (stale since 2026-11-28T06:00:00.000Z)');
    last = iso(29);
    const r30 = await runTriggerClock(POLICY, w.ports(30));
    expect(r30.status).toBe('recovered');
    expect(w.state()).toEqual({ staleSince: null, lastWakeAt: null, lastCardAt: null });
  });

  test('never beat: stale only when a registry exists · unreadable ledger = unknown (no wake)', async () => {
    const none = world({ last: () => null, registry: false });
    expect((await runTriggerClock(POLICY, none.ports(0))).line).toBe('no registry yet');
    const fresh = world({ last: () => null });
    expect((await runTriggerClock(POLICY, fresh.ports(0))).line).toBe('trigger-tick never beat · ran the schedule entry once (rc=0)');
    const blind = world({ last: () => undefined });
    expect((await runTriggerClock(POLICY, blind.ports(0))).status).toBe('unknown');
    expect([none.wakes.length, fresh.wakes.length, blind.wakes.length]).toEqual([0, 1, 0]);
  });

  test('a failing port is a line, not a throw', async () => {
    const w = world({ last: () => iso(-30) });
    const p = { ...w.ports(0), wake: async () => { throw new Error('spawn EACCES'); } };
    expect(await runTriggerClock(POLICY, p)).toEqual({ status: 'unknown', line: 'trigger-clock failed — spawn EACCES', woke: false, carded: null });
  });
});
