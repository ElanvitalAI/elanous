// SIM-STEWARD-AB-1125 runner — writes raw artifacts to $SIM_OUT (default: a temp dir). Clock = setSystemTime (ledger created_at is wall time).
import { afterAll, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorld, runArm, HOUR_S, type Arm, type ArmResult } from './federation-steward-ab-world.js';
import { modelSeatAssign, modelSuggestWatch } from './federation-steward-ab-models.js';

const OUT = process.env.SIM_OUT || mkdtempSync(join(tmpdir(), 'sim-steward-'));
const SEED = Number(process.env.SIM_SEED || 20261125);
afterAll(() => { setSystemTime(); });

function metrics(r: ArmResult) {
  const inHour = r.turns.filter((t) => t.startS <= HOUR_S);
  const by = (o: string) => inHour.filter((t) => t.opener === o).length;
  const pay = inHour.reduce((s, t) => s + t.payloadTokens, 0);
  const st = inHour.reduce((s, t) => s + t.statusTokens, 0);
  const esc = r.escalations.filter((e) => e.atS <= HOUR_S + 900);
  const stewardEsc = esc.filter((e) => ['ladder', 'steward-exception', 'steward-table', 'watch', 'wait-contract'].includes(e.via));
  const lat = r.idle.map((i) => (i.assignedS === null ? null : Math.round((i.assignedS - i.idleS) / 60)));
  const done = lat.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    arm: r.arm, turns: inHour.length,
    openers: { mail: by('mail'), question: by('question'), digest: by('digest'), wake: by('wake'), watch: by('watch'), steward: by('steward'), handCrown: by('hand-crown') },
    // As the 11-25 report defined it (mail ⊕ question ⊕ digest) and without the explicit questions (turns by design).
    mailOpenedPct: Math.round((100 * (by('mail') + by('question') + by('digest'))) / Math.max(1, inHour.length)),
    ordinaryMailOpenedPct: Math.round((100 * (by('mail') + by('digest'))) / Math.max(1, inHour.length)),
    payloadTokPerTurn: Math.round(pay / Math.max(1, inHour.length)), statusSharePct: Math.round((100 * st) / Math.max(1, pay)),
    mailsToOp: r.mailsToOp, mailsInTurns: esc.filter((e) => e.via.startsWith('mail')).length, absorbed: r.mailsAbsorbed, digested: r.mailsDigested,
    escalations: esc.length, precisionPct: Math.round((100 * esc.filter((e) => e.needsOP).length) / Math.max(1, esc.length)),
    // The designed passive channel (a digest turn: batched passive mail, opened only after the passive window) apart.
    precisionExclDigestPct: (() => { const x = esc.filter((e) => e.via !== 'digest'); return Math.round((100 * x.filter((e) => e.needsOP).length) / Math.max(1, x.length)); })(),
    stewardEscalations: stewardEsc.length, stewardPrecisionPct: stewardEsc.length ? Math.round((100 * stewardEsc.filter((e) => e.needsOP).length) / stewardEsc.length) : null,
    missed: r.missed, idleAssigned: `${done.length}/${lat.length}`, idleLatencyMin: { median: done[Math.floor(done.length / 2)] ?? null, max: done.length ? done[done.length - 1] : null, unassigned: lat.filter((x) => x === null).length },
    receipts: r.receipts, assignments: r.assignments,
    notNeededByCat: Object.entries(esc.filter((e) => !e.needsOP).reduce<Record<string, number>>((a, e) => { a[`${e.cat}/${e.via}`] = (a[`${e.cat}/${e.via}`] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
  };
}

const ARMS = (process.env.SIM_ARMS || 'A,B,Bplus,Bprime').split(',').map((x) => x.trim()).filter(Boolean) as Arm[];

test('federation day hour — A vs B vs B+ vs B\'', async () => {
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(SEED);
  writeFileSync(join(OUT, 'world.json'), JSON.stringify({ seed: SEED, mails: world.mails, preAsks: world.preAsks, idleAt: [...world.idleAt], prs: world.prs, cells: world.cells, judge: world.judge }, null, 1));
  const all: unknown[] = [];
  for (const arm of ARMS) {
    const res = await runArm(arm, world, { storePath: join(OUT, `msg-${arm}.db`), setClock: (ms) => setSystemTime(new Date(ms)),
      seatAssign: modelSeatAssign, suggestWatch: modelSuggestWatch });
    setSystemTime();
    const m = metrics(res);
    all.push(m);
    writeFileSync(join(OUT, `turns-${arm}.json`), JSON.stringify(res.turns, null, 1));
    writeFileSync(join(OUT, `escalations-${arm}.json`), JSON.stringify(res.escalations, null, 1));
    writeFileSync(join(OUT, `log-${arm}.txt`), res.log.join('\n'));
    writeFileSync(join(OUT, `metrics-${arm}.json`), JSON.stringify({ ...m, idle: res.idle, reachedOpAt: res.reachedOpAt }, null, 1));
    console.log(JSON.stringify(m));
  }
  writeFileSync(join(OUT, 'metrics-all.json'), JSON.stringify(all, null, 1));
  expect(all.length).toBe(ARMS.length);
}, 120_000);
