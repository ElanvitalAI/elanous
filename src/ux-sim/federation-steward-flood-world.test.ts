// SIM-STEWARD-AB «flood» — A (today) vs B' (receiver passive default) vs B'' (B' ⊕ sender E·F·G), seeds 20261125 · 7 · 42.
// The receiver route for B' and B'' is main's seat turn policy (#40084 `seatMailRoute`). Raw artifacts go to $SIM_OUT when set.
import { afterAll, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatMailRoute } from '../tui/seat-mail-turn-policy.js';
import { buildFloodWorld, floodMetrics, floodPasses, runFloodArm, type FloodArm, type FloodMetrics, type ReceiverRoute } from './federation-steward-flood-world.js';

afterAll(() => { setSystemTime(); });

// B' = the receiver turn policy on main (#40084 seatMailRoute) — the same route the seat TUI runs.
const bPrime: ReceiverRoute = (m) => seatMailRoute({ kind: m.kind, intent: m.intent, crownDirective: m.crownDirective, refs: m.refs, replyTo: m.replyTo,
  needsAck: m.needsAck, priority: m.priority, resultState: m.resultState, fromKind: m.fromKind, senderAbove: m.senderAbove, body: m.body }).route;

const OUT = process.env.SIM_OUT || mkdtempSync(join(tmpdir(), 'sim-flood-'));

async function runSeed(seed: number): Promise<FloodMetrics[]> {
  const world = buildFloodWorld(seed);
  const out: FloodMetrics[] = [];
  for (const arm of ['A', 'Bp', 'Bpp'] as FloodArm[]) {
    const dir = join(OUT, `seed-${seed}`, arm);
    mkdirSync(dir, { recursive: true });
    const res = await runFloodArm(arm, world, { storePath: join(dir, 'messages.db'), divertedRoot: join(dir, 'diverted'), setClock: (ms) => setSystemTime(new Date(ms)), route: bPrime });
    setSystemTime();
    const m = floodMetrics(res);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ ...m, passes: floodPasses(m), missedDetail: res.missed }, null, 1));
    out.push(m);
  }
  return out;
}

test('flood sim — B\'\' passes all seven criteria on three seeds; A and B\' do not', async () => {
  for (const seed of [20261125, 7, 42]) {
    const [a, bp, bpp] = await runSeed(seed);
    console.log(JSON.stringify({ seed, rows: [a, bp, bpp].map((m) => ({ arm: m!.arm, inbound: m!.opInboundPerH, kindless: m!.kindlessPct, kindlessRaw: m!.kindlessRawPct, kindlessStored: m!.kindlessStoredPct, selfCoach: m!.selfCoachPct, selfCoachRaw: m!.selfCoachRawPct, chain: m!.maxReplyChainDepth,
      turns: m!.turnsPerH, mailOpened: m!.mailOpenedTurnPct, precision: m!.escalationPrecisionPct, esc: m!.escalations, missed: m!.missed, diverted: m!.diverted, bp: m!.backpressureLogs })) }));
    expect(Object.values(floodPasses(bpp!)).every(Boolean)).toBe(true);
    expect(floodPasses(a!).inbound).toBe(false);
    expect(floodPasses(bp!).inbound).toBe(false);
    expect(bpp!.missed).toBe(0);
  }
}, 120_000);
