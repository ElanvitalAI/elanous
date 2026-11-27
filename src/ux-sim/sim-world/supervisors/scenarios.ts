// SIM-WORLD supervisors — LOOP-AGENTS (대표 11-27 11:3x «시뮬월드에서 충분히 검증»): the new loop agents replayed on the
// kernel contract. Each scenario drives the REAL code path that is on main — the real trigger registry ticking the
// real graphs/triggers/judge-butler.yaml, the real butler tick.lock, the real MsgStore write door (SIGNAL-DIET digest)
// and the real `msg post` CLI (DORMANT-ADDRESS REROUTE). Only the outside (clock · graph runner · herdr census) is faked.
// No real seat ledger, trigger registry or butler home is ever opened: everything lives under ctx.universeRoot.
//
// Loop agents whose body is not on main yet are listed in `simWorldSkipped` with the exact PR that brings them — a
// scenario is never faked for code that does not exist.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerMsgCommands } from '../../../cli/msg-cli.js';
import { acquireTickLock } from '../../../judge-butler/tick-lock.js';
import { listFires, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from '../../../loops/trigger-registry.js';
import type { ConditionProbes } from '../../../loops/trigger-conditions.js';
import type { WakeDeps } from '../../../loops/msg-wake.js';
import { MsgStore } from '../../../msg/msg-store.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const T0 = Date.parse('2026-11-27T02:00:00Z');
const MIN = 60_000;

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** A loop agent whose code is not on origin/main yet — recorded, not faked. */
export interface SimWorldSkippedScenario { readonly id: string; readonly title: string; readonly reason: string }
export const simWorldSkipped: readonly SimWorldSkippedScenario[] = [
  { id: 'LA-G1', title: 'guardian pulse: a supervisor whose heartbeat is lost is detected and restarted', reason: '코드 없음(PR #40362 미착지 · src/guardian-agent/pulse.ts)' },
  { id: 'LA-G2', title: 'guardian route: a host with load/ncpu > 1.0 is excluded from pregate placement', reason: '코드 없음(PR #40352 미착지 · src/guardian-agent/hosts.ts)' },
  { id: 'LA-G3', title: 'guardian reaper: orphan reap kills exact PIDs only', reason: '코드 없음(PR #40352 미착지 · src/guardian-agent/reaper.ts)' },
  { id: 'LA-L1', title: 'land steward: a stale-head / hot-file land refusal goes to the land steward, not mailed to TC/OP', reason: '코드 없음(PR #40367 미착지 · main fixFor(stale-head) → author)' },
];

// ── judge-butler cadence (graphs/triggers/judge-butler.yaml on the real trigger registry) ─────────────────────────

/** Probes for a quiet world: no receipt / ledger / checklist file ever changes. */
const quietProbes = (now: () => Date): ConditionProbes => ({
  now, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
  publishedVersions: async () => [], installedVersion: async () => null,
});

function butlerWorld(ctx: SimWorldScenarioContext, opts: { writesHeartbeat: boolean }) {
  const stateRoot = join(ctx.universeRoot, 'state');
  const seatState = join(ctx.universeRoot, 'seat-state');
  mkdirSync(seatState, { recursive: true });
  const db = openTriggerRegistry(stateRoot);
  let clock = T0;
  const decl = readTriggerDecl(join('graphs', 'triggers', 'judge-butler.yaml'), REPO);
  registerTrigger(db, decl, { now: new Date(clock) });
  const runs: number[] = [];
  const cards: Array<{ owner: string; body: string }> = [];
  const heartbeat = join(stateRoot, 'loop-agents', 'judge-butler', 'last-tick.json');
  const deps: TriggerTickDeps = {
    now: () => new Date(clock), vars: { seatState, stateRoot }, probes: quietProbes(() => new Date(clock)),
    runGraph: async (_d, _input, runId) => {
      runs.push((clock - T0) / MIN);
      if (opts.writesHeartbeat) { // the tick body writes last-tick.json (butler-cli.ts) — mtime = the virtual clock
        mkdirSync(join(stateRoot, 'loop-agents', 'judge-butler'), { recursive: true });
        writeFileSync(heartbeat, '{}');
        utimesSync(heartbeat, new Date(clock), new Date(clock));
      }
      return { status: 'done', runId };
    },
    postCard: async (owner, body) => { cards.push({ owner, body }); return `card-${cards.length}`; },
    scheduleAction: async () => {},
  };
  const at = async (minute: number) => { clock = T0 + minute * MIN; return tickTriggers(db, deps, { only: 'judge-butler' }); };
  return { db, at, runs, cards, close: () => db.close() };
}

/** LA-B1 · BUTLER-TICK-CADENCE: in a quiet world the butler ticks once on register, then once every 10 min (max_wait). */
const laB1: SimWorldScenario = {
  id: 'LA-B1',
  title: 'judge-butler ticks on its 10-min cadence in a quiet world — one tick per window, no extra tick',
  async run(ctx) {
    const w = butlerWorld(ctx, { writesHeartbeat: true });
    try {
      for (let m = 1; m <= 31; m += 1) await w.at(m);
      const statuses = listFires(w.db, 'judge-butler').map((f) => f.status);
      ctx.recorder.event('la-b1', { runs: w.runs, statuses });
      if (JSON.stringify(w.runs) === '[1,11,21,31]' && w.cards.length === 0) return { ok: true };
      const doubled = w.runs.some((m, i) => i > 0 && m - w.runs[i - 1]! === 2);
      return fail(doubled ? 'duplicate tick 2 min after each max-wait fire' : 'butler cadence broken',
        `runs at minutes ${JSON.stringify(w.runs)} (want [1,11,21,31]) · fires ${JSON.stringify(statuses)} · cards ${w.cards.length} · state-changed is always met; a max-wait fire overwrites fired_key, so the unchanged state key re-fires after the 2-min cooldown`);
    } finally { w.close(); }
  },
};

/** LA-B2 · a stalled butler (tick returns but last-tick.json never moves · a crashed tick's lock) is noticed. */
const laB2: SimWorldScenario = {
  id: 'LA-B2',
  title: 'a stalled judge-butler is noticed: missed heartbeat → retry → exception card to OP · stale tick.lock taken over · live lock refuses overlap',
  async run(ctx) {
    const w = butlerWorld(ctx, { writesHeartbeat: false });
    try {
      for (let m = 1; m <= 90; m += 1) await w.at(m);
      const statuses = listFires(w.db, 'judge-butler').map((f) => f.status);
      const card = w.cards[0] ?? null;
      // A crashed tick left its lock: 16 min old (pid still alive) and a dead pid 1 min old are both taken over.
      const homeA = join(ctx.universeRoot, 'home-a');
      const homeB = join(ctx.universeRoot, 'home-b');
      mkdirSync(homeA, { recursive: true });
      mkdirSync(homeB, { recursive: true });
      acquireTickLock(homeA, new Date(T0), { pid: 111, isAlive: () => true });
      const afterAge = acquireTickLock(homeA, new Date(T0 + 16 * MIN), { pid: 222, isAlive: () => true });
      acquireTickLock(homeB, new Date(T0), { pid: 333, isAlive: () => true });
      const afterDeath = acquireTickLock(homeB, new Date(T0 + MIN), { pid: 444, isAlive: (pid) => pid !== 333 });
      // One tick at a time: a second tick 4 s into a live tick is refused; after release the next tick takes the lock.
      const homeC = join(ctx.universeRoot, 'home-c');
      mkdirSync(homeC, { recursive: true });
      const first = acquireTickLock(homeC, new Date(T0), { pid: 101, isAlive: () => true });
      const overlap = acquireTickLock(homeC, new Date(T0 + 4_000), { pid: 202, isAlive: () => true });
      if (!first.held) first.release();
      const next = acquireTickLock(homeC, new Date(T0 + 10 * MIN), { pid: 303, isAlive: () => true });
      ctx.recorder.event('la-b2', { runs: w.runs, statuses, cardOwner: card?.owner ?? null, staleTaken: !afterAge.held, deadTaken: !afterDeath.held, overlapHeld: overlap.held });
      const ok = card !== null && card.owner === 'OP' && card.body.includes('[graph-trigger exception] judge-butler') && card.body.includes('goal not met by deadline')
        && statuses.includes('exception') && afterAge.held === false && afterDeath.held === false
        && first.held === false && overlap.held === true && next.held === false;
      if (ok) return { ok: true };
      return fail('stalled butler not noticed', `cards ${JSON.stringify(w.cards.map((c) => [c.owner, c.body.slice(0, 120)]))} · fires ${JSON.stringify(statuses)} · runs ${JSON.stringify(w.runs)} · stale lock taken ${!afterAge.held} · dead-pid lock taken ${!afterDeath.held} · lock first/overlap/next held ${first.held}/${overlap.held}/${next.held} (want false/true/false)`);
    } finally { w.close(); }
  },
};

// ── SIGNAL-DIET-OP-DIGEST (real MsgStore write door) ───────────────────────────────────────────────────────────────

function digestStore(ctx: SimWorldScenarioContext) {
  let clock = T0;
  const store = new MsgStore(join(ctx.universeRoot, 'messages.db'), { now: () => new Date(clock) });
  const opRows = () => store.list('OP', 0, 500).map((m) => ({ from: m.from, body: m.body }));
  return { store, opRows, set: (minute: number) => { clock = T0 + minute * MIN; } };
}

/** LA-D1 · machine mail to OP folds into ONE 30-min digest; 🚨 and a human's mail pass straight through. */
const laD1: SimWorldScenario = {
  id: 'LA-D1',
  title: 'machine mail to OP is batched into one 30-min digest, not one row per event (🚨 and humans stay direct)',
  async run(ctx) {
    const d = digestStore(ctx);
    try {
      const senders = ['LAND-GRAPH', 'JUDGE-BUTLER', 'GUARDIAN', 'LAND-GRAPH', 'BOARD-STEWARD', 'LAND-GRAPH'];
      senders.forEach((from, i) => { d.set(i * 4); d.store.post({ from, to: 'OP', kind: 'report', body: `status tick ${i}` }); });
      d.set(21); d.store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'report', body: '🚨 main broken at merge 1234' });
      d.set(22); d.store.post({ from: 'TC', to: 'OP', kind: 'report', body: 'TC hand report' });
      const before = d.opRows();
      d.set(31); d.store.post({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign cell X?' });
      const after = d.opRows();
      const digests = after.filter((r) => r.from === 'SIGNAL-DIGEST');
      ctx.recorder.event('la-d1', { before: before.map((r) => r.from), after: after.map((r) => r.from), pending: d.store.pendingOpDigest().length });
      const ok = JSON.stringify(before.map((r) => r.from)) === '["LAND-GRAPH","TC"]' && before[0]!.body.startsWith('🚨')
        && digests.length === 1 && digests[0]!.body.includes('7 mails') && digests[0]!.body.includes('LAND-GRAPH 3')
        && digests[0]!.body.includes('sign cell X?') && d.store.pendingOpDigest().length === 0 && after.length === 3;
      if (ok) return { ok: true };
      return fail('machine mail not batched', `OP rows before flush ${JSON.stringify(before.map((r) => r.from))} (want ["LAND-GRAPH"(🚨),"TC"]) · after ${JSON.stringify(after.map((r) => r.from))} · digest head ${JSON.stringify(digests[0]?.body.split('\n')[0] ?? null)}`);
    } finally { d.store.close(); }
  },
};

/** LA-D2 · quiet half hour: parked machine mail is due at 30 min even when nobody writes to OP afterwards. */
const laD2: SimWorldScenario = {
  id: 'LA-D2',
  title: 'a due digest reaches OP when no further OP-bound write happens (quiet window)',
  async run(ctx) {
    const d = digestStore(ctx);
    try {
      d.set(0); d.store.post({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign cell Y?' });
      d.set(45);
      const seen = d.opRows(); // OP reads its inbox 45 min later; no one else wrote to OP in between
      ctx.recorder.event('la-d2', { seen: seen.map((r) => r.from), pending: d.store.pendingOpDigest().length });
      if (seen.some((r) => r.from === 'SIGNAL-DIGEST' && r.body.includes('sign cell Y?'))) return { ok: true };
      return fail('due digest waits for the next OP-bound write', `OP inbox at +45 min ${JSON.stringify(seen.map((r) => r.from))} · still parked ${d.store.pendingOpDigest().length} (the only flush is inside an OP-bound write · no reader/timer flush)`);
    } finally { d.store.close(); }
  },
};

// ── DORMANT-ADDRESS REROUTE (real `msg post` CLI) ──────────────────────────────────────────────────────────────────

async function postVia(ctx: SimWorldScenarioContext, argv: readonly string[], wakeDeps?: WakeDeps) {
  const msgPath = join(ctx.universeRoot, 'messages.db');
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(msgPath),
    out: { log: () => {}, error: (line) => { stderr.push(line); } },
    readStdin: async () => '',
    setExitCode: (code) => { exits.push(code); },
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    spawnMailFallback: () => {},
    postOfficeStateRoot: ctx.universeRoot,
    ...(wakeDeps ? { wakeDeps } : {}),
  });
  await program.parseAsync(['msg', 'post', ...argv], { from: 'user' });
  const store = new MsgStore(msgPath);
  try {
    const rows = store.db.query('SELECT sender, recipient, body FROM msg_messages ORDER BY id').all() as Array<{ sender: string; recipient: string; body: string }>;
    return { rows, parked: store.pendingOpDigest(), stderr, exits };
  } finally { store.close(); }
}

/** LA-R1 · mail to a dormant seat is rerouted to a live reader instead of sinking in an unread box. */
const laR1: SimWorldScenario = {
  id: 'LA-R1',
  title: 'mail to dormant RES / REVIEW-2 is rerouted (RES → GUARDIAN postoffice · REVIEW-2 → JUD · REL 🚨 → OP) instead of sinking',
  async run(ctx) {
    const a = await postVia(ctx, ['--from', 'TC', '--to', 'RES', '--kind', 'report', '--body', 'node-b disk 95% — please clean']);
    const b = await postVia(ctx, ['--from', 'TC', '--to', 'REVIEW-2', '--kind', 'report', '--body', 'review PR 1 head abc']);
    const c = await postVia(ctx, ['--from', 'TC', '--to', 'REL', '--kind', 'report', '--body', '🚨 release blocked: notes empty']);
    const toRes = b.rows.filter((r) => r.recipient === 'RES').length + c.rows.filter((r) => r.recipient === 'RES').length;
    const parked = c.parked.map((p) => ({ sender: p.sender, refs: p.refs }));
    const jud = c.rows.filter((r) => r.recipient === 'JUD').map((r) => r.body);
    const opDirect = c.rows.filter((r) => r.recipient === 'OP').map((r) => r.body);
    ctx.recorder.event('la-r1', { parked, jud, opDirect, toRes, notes: [...a.stderr, ...b.stderr, ...c.stderr].filter((l) => l.includes('rerouted')) });
    const toGuardian = c.rows.filter((r) => r.recipient === 'GUARDIAN').map((r) => r.body);
    const ok = toRes === 0 && c.rows.every((r) => r.recipient !== 'REVIEW-2' && r.recipient !== 'REL')
      && parked.length === 0 && JSON.stringify(toGuardian) === JSON.stringify(['[rerouted from RES · no live tab] node-b disk 95% — please clean'])
      && JSON.stringify(jud) === JSON.stringify(['[rerouted from REVIEW-2 · no live tab] review PR 1 head abc'])
      && JSON.stringify(opDirect) === JSON.stringify(['[rerouted from REL · no live tab] 🚨 release blocked: notes empty'])
      && a.stderr.some((l) => l.includes('RES has no live tab — rerouted to GUARDIAN')) && [...a.exits, ...b.exits, ...c.exits].length === 0;
    if (ok) return { ok: true };
    return fail('dormant mail sank', `rows ${JSON.stringify(c.rows.map((r) => [r.sender, r.recipient]))} · parked ${JSON.stringify(parked)} · stderr ${JSON.stringify([...a.stderr, ...b.stderr, ...c.stderr])} · exits ${JSON.stringify([...a.exits, ...b.exits, ...c.exits])}`);
  },
};

/** LA-R3 · a reroute never lands back in the sender's own inbox (live bug #191271: OP → dormant RES came back to OP). */
const laR3: SimWorldScenario = {
  id: 'LA-R3',
  title: 'a reroute never bounces to the sender: OP → RES lands at GUARDIAN · GUARDIAN → RES goes to the OP digest · OP → REL stays at REL',
  async run(ctx) {
    const a = await postVia(ctx, ['--from', 'OP', '--to', 'RES', '--kind', 'request', '--body', 'node-b disk 95% — please clean']);
    const b = await postVia(ctx, ['--from', 'GUARDIAN', '--to', 'RES', '--kind', 'report', '--body', 'need RES approval: start aws1']);
    const c = await postVia(ctx, ['--from', 'OP', '--to', 'REL', '--kind', 'request', '--body', 'cut at 04:00']);
    const rows = c.rows.map((r) => [r.sender, r.recipient]);
    const parked = c.parked.map((p) => [p.sender, p.refs.includes('rerouted-from:RES')]);
    ctx.recorder.event('la-r3', { rows, parked, notes: [...a.stderr, ...b.stderr, ...c.stderr].filter((l) => l.includes('rerouted')) });
    const self = c.rows.filter((r) => r.sender === r.recipient).length;
    const ok = self === 0 && JSON.stringify(rows) === JSON.stringify([['OP', 'GUARDIAN'], ['OP', 'REL']])
      && JSON.stringify(parked) === JSON.stringify([['GUARDIAN', true]])
      && a.stderr.some((l) => l.includes('RES has no live tab — rerouted to GUARDIAN'))
      && b.stderr.some((l) => l.includes('RES has no live tab — rerouted to OP')) && [...a.exits, ...b.exits, ...c.exits].length === 0;
    if (ok) return { ok: true };
    return fail('reroute bounced to the sender', `rows ${JSON.stringify(rows)} · parked ${JSON.stringify(parked)} · stderr ${JSON.stringify([...a.stderr, ...b.stderr, ...c.stderr])}`);
  },
};

/** LA-R2 · a revived RES tab (live herdr pane in the seat registry) receives its mail directly again (수복과 인계). */
const laR2: SimWorldScenario = {
  id: 'LA-R2',
  title: 'a revived RES tab (live pane in the seat registry) gets its mail directly — no reroute',
  async run(ctx) {
    const wakeDeps = {
      stateRoot: ctx.universeRoot, seatStateRoot: join(ctx.universeRoot, 'seat-state'), live: false, now: () => T0,
      readRegistry: () => ({ status: 'ready' as const, registry: { version: 1 as const, seats: [{ address: 'RES', host: 'local', target: 'wR:p1', wake: 'herdr' as const, replyBody: 'agent' as const, optIn: true, runtime: 'codex' as const }] } }),
      listHerdrPanes: () => [{ paneId: 'wR:p1', status: 'idle' }], listPtys: () => [], readPane: () => null, hasOptIn: () => false,
    };
    const r = await postVia(ctx, ['--from', 'TC', '--to', 'RES', '--kind', 'report', '--body', 'RES is back — disk report'], wakeDeps as WakeDeps);
    const toRes = r.rows.filter((row) => row.recipient === 'RES').length;
    ctx.recorder.event('la-r2', { toRes, parked: r.parked.length, stderr: r.stderr });
    if (toRes === 1 && r.parked.length === 0) return { ok: true };
    return fail('revived seat still rerouted', `rows to RES ${toRes} · parked for OP digest ${r.parked.length} · stderr ${JSON.stringify(r.stderr)} (msg post calls dormantReroute without an isLive probe)`);
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [laB1, laB2, laD1, laD2, laR1, laR2, laR3];
