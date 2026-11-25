// `eln pulse …` — the OP pulse control surface (OP-PULSE · CEO 11-25 20:0x–20:2x).
//   status                     phase now · its rhythm row · last pulse · active burst
//   verify --window <w>        goal check: beat mails `[pulse <w>]` from OP in the msg store → goal line
//   burst plan                 pressure → per-lane scale plan + forecast (what it would scale and why) — read only
//   burst start                --goal implement|land|green --until <ISO> --scope <spaces> (--preset 2h|4h|8h | --budget-usd N)
//                              [--ceo-msg <id> --crown <id>] — state only; actuators listed in the plan
//   burst launched             --lane <lane> --id <exact id> [--host h] [--cost-usd n] — record a launch (budget-guarded)
//   burst stop                 --reason <text> — clean exit: close every recorded launch by exact id, receipt
//   burst status
import type { Command } from 'commander';
import { join } from 'node:path';
import { pulsePaths, readPulseState, rhythmLine, rhythmRow } from './op-pulse.js';
import { BURST_LANES, exitBurst, planScale, pressures, recordLaunch, startBurst, type BurstGoal, type BurstLane, type BurstLaunch } from './op-pulse-burst.js';
import { currentPhase, loadRhythmAndBurst, readActiveBurst, verifyBeats, writeBurst } from './op-pulse-run.js';

const RHYTHM = join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml');
const seatState = () => process.env.ELANOUS_SEAT_STATE ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function stateRoot(): Promise<string> { return (await import('../instance/resolve.js')).effectiveInstanceRoot(); }
async function paths(now = new Date()) { return pulsePaths(seatState(), await stateRoot(), day(now)); }

/** Closer for a burst launch — existing commands only; a lane without one throws (kept in the receipt as closeFailed). */
async function liveCloser(l: BurstLaunch): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  if (l.lane === 'hands' || l.lane === 'remote') {
    const r = spawnSync('els', ['close', l.id], { encoding: 'utf8', timeout: 30_000 }); // Source: one exact pane close per launch.
    if (r.status !== 0) throw new Error(`els close ${l.id} exit ${r.status}: ${String(r.stderr).trim().slice(0, 120)}`);
    return;
  }
  if (l.lane === 'ta' || l.lane === 'review') return; // A harness/review child ends on its own; nothing to kill (in-flight work finishes).
  // TODO(OP-PULSE-BURST-VM-STOP): no `eln hosts stop` yet — the receipt lists the VM so OP stops it by hand.
  throw new Error(`${l.lane} ${l.id}: no stop command wired — stop it by hand`);
}

export function registerPulseCommands(program: Command): void {
  const pulse = program.command('pulse').description('OP structural pulse — phase · rhythm · gaps · burst (replaces the pinned standing goal)');
  pulse.command('status').option('--json').action(async (o: { json?: boolean }) => {
    const now = new Date(); const p = await paths(now);
    const { rhythm } = loadRhythmAndBurst(RHYTHM);
    const { livePulseProbes } = await import('./op-pulse-live.js');
    const phase = currentPhase(livePulseProbes(), rhythm, p, now);
    const row = rhythmRow(rhythm, phase.phase); const state = readPulseState(p.state); const burst = readActiveBurst(p.burst);
    if (o.json) { console.log(JSON.stringify({ phase, row, state, burst })); return; }
    console.log(`국면 ${phase.phase} — ${phase.evidence}\n리듬 ${rhythmLine(row)} (출처 ${row.source})\n마지막 펄스 ${state.lastPulseAt ?? '없음'} (${state.lastPhase ?? '-'})\n버스트 ${burst ? `${burst.id} ${burst.trigger} until ${burst.until}` : '없음'}`);
  });
  pulse.command('verify').requiredOption('--window <w>').action(async (o: { window: string }) => {
    const now = new Date(); const p = await paths(now);
    const { MsgStore, defaultMsgStorePath } = await import('../msg/msg-store.js');
    const store = new MsgStore(defaultMsgStorePath());
    let mails;
    try { mails = store.listCreatedBetween(new Date(Date.parse(o.window) - 60_000).toISOString(), new Date(now.getTime() + 1000).toISOString()); } finally { store.close(); }
    const r = verifyBeats({ ledger: p.ledger, window: o.window, mails, now });
    console.log(r.ok ? `pulse ${o.window}: beats ${r.beats.map(b => `#${b.id}→${b.to}`).join(' ')} — goal met` : `pulse ${o.window}: no beat mail with [pulse ${o.window}] yet`);
    process.exitCode = r.ok ? 0 : 3;
  });
  const burst = pulse.command('burst').description('Pressure-driven elastic mode (local first · front-to-back · anticipate)');
  burst.command('plan').option('--json').action(async (o: { json?: boolean }) => {
    const now = new Date(); const p = await paths(now);
    const { rhythm, burst: cfg } = loadRhythmAndBurst(RHYTHM);
    const { livePulseProbes } = await import('./op-pulse-live.js');
    const probes = livePulseProbes();
    const { measure, extra } = await probes.measure(now);
    const active = readActiveBurst(p.burst);
    const row = rhythmRow(rhythm, active ? 'burst' : currentPhase(probes, rhythm, p, now).phase);
    const press = pressures({ targetGapRatio: measure.landedPerH && row.targets.landedPerH ? row.targets.landedPerH / Math.max(0.1, measure.landedPerH) : null,
      readyBacklog: extra.readyBacklog, hands: measure.spaces.reduce((n, s) => n + (s.hands ?? 0), 0) || null, readyPerHand: row.targets.readyPerHand ?? 2,
      judgeWaitMin: measure.judgeWaitMedianMin, judgeWaitTargetMin: row.targets.judgeWaitMedianMin ?? 30, judgeQueue: measure.judgeQueue,
      gateWaitMin: extra.gateWaitMin, gateWaitTargetMin: 10, reviewWaitMin: extra.reviewWaitMin, reviewWaitTargetMin: 20, landQueue: extra.landQueue, landQueueTarget: 6, hoursToDeadline: null });
    const plan = planScale({ levels: active?.levels ?? {}, lastChangeAt: active?.lastChangeAt ?? {}, pressures: press, now, config: cfg, spentUsd: active?.spentUsd ?? 0,
      budgetUsd: active?.budgetUsd ?? Infinity, cloudApprovedUsd: active?.cloudApprovedUsd ?? 0, hoursLeft: active ? (Date.parse(active.until) - now.getTime()) / 3_600_000 : 4,
      forecastMisses: true, ...(active?.allIn ? { allIn: true } : {}), ...(extra.hosts ? { hosts: extra.hosts } : {}) });
    if (o.json) { console.log(JSON.stringify({ pressures: press, plan })); return; }
    for (const x of press) console.log(`압력 ${x.lane.padEnd(7)} ${x.pressure ?? '?'} · ${x.why}`);
    console.log(plan.length ? plan.map(d => `→ ${d.lane}: ${d.from} → ${d.to}${d.blocked ? ` (막힘 ${d.blocked})` : ''} · ${d.why}`).join('\n') : '→ 확장 없음 (압력 목표 안)');
    console.log('actuators: hands = els new (wired) · ta = eln harness ask (wired) · review = eln self review --model gpt-6.1-terra (wired) · vm = eln hosts start (wired, stop TODO) · remote/pregate/judge/land = TODO');
  });
  burst.command('start').requiredOption('--goal <g>', 'implement | land | green').requiredOption('--until <iso>').option('--scope <spaces>', 'comma list of spaces/cells', 'ALL')
    .option('--preset <p>', '2h | 4h | 8h').option('--budget-usd <n>').option('--by <seat>', 'who declares it', 'OP').option('--ceo-msg <id>').option('--crown <id>')
    .action(async (o: { goal: string; until: string; scope: string; preset?: string; budgetUsd?: string; by: string; ceoMsg?: string; crown?: string }) => {
      try {
        if (!['implement', 'land', 'green'].includes(o.goal)) throw new Error('--goal must be implement | land | green');
        const now = new Date(); const p = await paths(now);
        const { burst: cfg } = loadRhythmAndBurst(RHYTHM);
        const preset = o.preset ? cfg.presets.find(x => x.name === o.preset) ?? (() => { throw new Error(`unknown preset ${o.preset}`); })() : null;
        const state = startBurst({ goal: o.goal as BurstGoal, until: o.until, scope: o.scope.split(',').map(s => s.trim()).filter(Boolean), by: o.by, now, preset,
          ...(o.budgetUsd !== undefined ? { budgetUsd: Number(o.budgetUsd) } : {}), trigger: o.ceoMsg ? 'ceo-urgent' : `manual:${o.by}`,
          ...(o.ceoMsg ? { ceoLine: { msgId: Number(o.ceoMsg), crownDirective: o.crown ?? '?' } } : {}) }, readActiveBurst(p.burst));
        writeBurst(p.burst, state);
        console.log(`burst ${state.id} started · ${state.goal} · until ${state.until} · budget $${state.budgetUsd} · levels ${JSON.stringify(state.levels)} — record each launch: eln pulse burst launched --lane <lane> --id <exact id>`);
      } catch (e) { console.error(`pulse burst start: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 2; }
    });
  burst.command('launched').requiredOption('--lane <lane>').requiredOption('--id <id>').option('--host <h>').option('--cost-usd <n>', 'estimated cost', '0')
    .action(async (o: { lane: string; id: string; host?: string; costUsd: string }) => {
      try {
        if (!BURST_LANES.includes(o.lane as BurstLane)) throw new Error(`--lane must be one of ${BURST_LANES.join(', ')}`);
        const now = new Date(); const p = await paths(now);
        const active = readActiveBurst(p.burst); if (!active) throw new Error('no active burst');
        writeBurst(p.burst, recordLaunch(active, { lane: o.lane as BurstLane, id: o.id, ...(o.host ? { host: o.host } : {}) }, now, Number(o.costUsd)));
        console.log(`recorded ${o.lane} ${o.id}`);
      } catch (e) { console.error(`pulse burst launched: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 2; }
    });
  burst.command('stop').option('--reason <text>', 'why', 'manual').action(async (o: { reason: string }) => {
    const now = new Date(); const p = await paths(now);
    const active = readActiveBurst(p.burst);
    if (!active) { console.log('no active burst'); return; }
    const { appendPulseLedger } = await import('./op-pulse.js');
    const { state, receipt } = await exitBurst(active, { now, reason: o.reason, closer: liveCloser, landedNow: null, greenNow: null });
    writeBurst(p.burst, state); appendPulseLedger(p.burstLedger, { ...receipt });
    console.log(`burst ${receipt.id} exited (${receipt.reason}) · launched ${receipt.launched} · closed ${receipt.closed}${receipt.closeFailed.length ? ` · close failed: ${receipt.closeFailed.map(f => `${f.lane} ${f.id}`).join(', ')}` : ''} · $${receipt.costUsd} · ${receipt.minutes}m${receipt.ceoLine ? ` · CEO #${receipt.ceoLine.msgId}` : ''}`);
  });
  burst.command('status').action(async () => {
    const p = await paths(); const b = readActiveBurst(p.burst);
    console.log(b ? JSON.stringify(b, null, 2) : 'no active burst');
  });
}
