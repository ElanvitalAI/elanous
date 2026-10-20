import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses, type HarnessProcessRecord } from '../../harness/harness-cli-command.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { devVersion, listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { withFileLockSync } from '../../storage/file-lock.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorLoopConfig, type OrchestratorSeat } from '../../user-config.js';
import { finishAdvice, measureFinish, type FinishAdvice, type FinishMetrics, type MeasureFinishDeps } from './finish-rate.js';
import { collectAuthorDepth, type AuthorDepthResult, type CollectAuthorDepthDeps } from './author-depth.js';
import { probeDegradation, type DegradationSignal } from './degradation.js';
import { budgetTrafficTick, computeTrafficMetrics24h, readTrafficSamples24h, recordTrafficSample24h, type TrafficSampleDeps } from '../budget.js';

export const TRAFFIC_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TrafficCell = Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status'>;
export type TrafficProcess = Pick<HarnessProcessRecord, 'command' | 'elapsedSeconds' | 'cwd'> & { seat: OrchestratorSeat | null };
export type TrafficSeatRow = { seat: OrchestratorSeat; running: number; cap: number; baseShare: number | null; borrowed: number; lent: number; launchCap: number; idleFor: number | null; idle: boolean; nextCell: TrafficCell | null };
export type TrafficResult = { seats: TrafficSeatRow[]; unassigned: number; now: Date; idleMinutes: number; finish?: { metrics: FinishMetrics; advice: FinishAdvice } };

/** A reason from a previous turn never blocks recovered supply; only active holds do. */
export function isLaunchEligible(row: Pick<TrafficSeatRow, 'nextCell' | 'running' | 'launchCap'>,
  skipReason?: string): boolean {
  return row.nextCell !== null && row.running < row.launchCap &&
    skipReason !== 'degraded-skip' && skipReason !== 'cap-deferred';
}

export type DispatchCycle = {
  at: string; source: 'traffic' | 'tick'; mode: 'shadow' | 'live'; runId: string;
  supply: number; capacity: number; eligible: number; skipped: Record<string, number>;
  dispatch: OrchestratorLoopConfig['dispatch'];
};

/** Separate journal: never extend or reinterpret seat-requests or per-run state rows. */
export function recordDispatchCycle(root: string, cycle: DispatchCycle,
  log: (category: string, event: string, data: Record<string, unknown>) => void = debug.log.bind(debug)): void {
  // 상시 게이트 관측: tick launch 노드와 runTrafficTick 이 지나는 이 배선 자체가 항상 켜져 있으므로
  // 24h halt 저널은 이 자리에서 쌓인다 — `--metrics` 수동 읽기에만 매달면 관측 부재로 지표가
  // 언제나 0이 되는 Goodhart 구조가 된다. 관측 전용: append 아래 원장 기록은 절대 막지 않는다.
  try { observeGateHalt(root, { log }); }
  catch { /* 게이트 저널은 관측일 뿐 — dispatch 원장은 관측 실패와 무관하게 기록된다 */ }
  const path = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const appended = withFileLockSync(`${path}.lock`, () => {
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (previous.split('\n').some(line => {
        if (!line) return false;
        let row: Partial<DispatchCycle>;
        try { row = JSON.parse(line) as Partial<DispatchCycle>; }
        catch {
          // A torn append must not permanently stop later cycles. Keep the line for forensic inspection.
          try { log('loop.orchestrator', 'dispatch-cycle-malformed', { path }); }
          catch { /* Observation must not stop a valid append. */ }
          return false;
        }
        return row && row.source === cycle.source && row.runId === cycle.runId && row.mode === cycle.mode;
      })) return false;
      // A torn final line has no newline; separate it from the next valid JSONL row.
      appendFileSync(path, `${previous && !previous.endsWith('\n') ? '\n' : ''}${JSON.stringify(cycle)}\n`);
      return true;
    });
    if (appended) try { log('loop.orchestrator', 'dispatch-cycle', cycle); }
    catch { /* Observation cannot change a recorded decision. */ }
  } catch (error) {
    try { debug.log('loop.orchestrator', 'dispatch-cycle-failed', { error: String(error).slice(0, 200) }, { level: 'warn' }); }
    catch { /* Observation cannot change a recorded decision. */ }
  }
}

/** Same bounded walk as the CTX1 hook: a marker at the git root is checked before stopping. */
export function seatOfTree(cwd: string | undefined, cfg: Pick<OrchestratorLoopConfig, 'seatTrees'>): OrchestratorSeat | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  let dir = resolve(cwd);
  for (let level = 0; level <= 6; level++) {
    const marker = join(dir, '.claude', 'seat');
    if (existsSync(marker)) {
      const seat = readFileSync(marker, 'utf8').trim();
      return TRAFFIC_SEATS.some(id => id === seat) ? seat as OrchestratorSeat : null;
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Compare real paths: on macOS a process cwd under /var reports as /private/var (10-04 MK: UX trees under $TMPDIR
  // never matched their configured /var/folders/... paths).
  const path = realOrResolved(cwd);
  for (const seat of TRAFFIC_SEATS) {
    if (cfg.seatTrees[seat]?.some(tree => {
      if (!isAbsolute(tree)) return false;
      const root = realOrResolved(tree);
      return path === root || path.startsWith(root + sep);
    })) return seat;
  }
  return null;
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** A `harness ask|say` launch command line — the only processes `trafficTick` counts. */
export { isTrafficLaunch } from '../budget.js';

/** Process observation stays at the boundary; the shared resource loop owns the decision. */
export function trafficTick(input: Parameters<typeof budgetTrafficTick>[0]): TrafficResult {
  return budgetTrafficTick(input);
}

export function withFinishAdvice(result: TrafficResult, deps: MeasureFinishDeps = {}): TrafficResult {
  const metrics = measureFinish(deps, result.now);
  const totalSlots = result.seats.reduce((total, row) => total + row.cap, 0);
  return { ...result, finish: { metrics, advice: finishAdvice(metrics, totalSlots) } };
}

export type TrafficRequest = { key: string; receiptId: string; seat: OrchestratorSeat; text: string; status: 'queued'; queuedAt: string; source: 'orchestrator-traffic' };
export interface TrafficApplyDeps {
  mode?: 'shadow' | 'live';
  root?: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** Only the live branch opens the journal. The lock serializes hourly-key checks across CLI processes. */
export function applyTraffic(result: TrafficResult, deps: TrafficApplyDeps = {}): number {
  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  const mode = deps.mode ?? 'shadow';
  log('loop.orchestrator', 'tick', { mode, seats: result.seats.map(({ seat, running, cap, baseShare, borrowed, lent, launchCap, idleFor, idle }) =>
    ({ seat, running, cap, baseShare, borrowed, lent, launchCap, idleFor, idle })), unassigned: result.unassigned });
  if (result.finish) {
    const { finishSlots, launchSlots, state, reasons } = result.finish.advice;
    log('loop.orchestrator', 'would-rebalance', { finishSlots, launchSlots, state, reasons });
  }
  let queued = 0;
  for (const row of result.seats) {
    if (!row.idle) continue;
    const data = { seat: row.seat, running: row.running, cap: row.cap, idleMinutes: row.idleFor, nextCell: row.nextCell };
    if (mode !== 'live') {
      log('loop.orchestrator', 'would-nudge', data);
      continue;
    }
    if (!row.nextCell) {
      log('loop.orchestrator', 'exchange', { ...data, outcome: 'no-cell' });
      continue;
    }
    const path = join(deps.root ?? effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
    const key = `orch-traffic:${row.seat}:${result.now.toISOString().slice(0, 13)}`;
    mkdirSync(dirname(path), { recursive: true });
    const appended = withFileLockSync(`${path}.lock`, () => {
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (previous.split('\n').some(line => {
        if (!line) return false;
        try { return (JSON.parse(line) as { key?: string }).key === key; } catch { throw new Error('invalid seat request journal'); }
      })) return false;
      const request: TrafficRequest = { key, receiptId: key, seat: row.seat,
        text: `다음 칸 쏘라: ${row.nextCell!.id} ${row.nextCell!.title.slice(0, 60)} (지금 ${row.running}/${row.cap} · ${row.idleFor}분 놂)`,
        status: 'queued', queuedAt: result.now.toISOString(), source: 'orchestrator-traffic' };
      appendFileSync(path, JSON.stringify(request) + '\n');
      return true;
    });
    if (appended) queued++;
    log('loop.orchestrator', 'exchange', { ...data, key, outcome: appended ? 'queued' : 'duplicate' });
  }
  return queued;
}

export function trafficLine(result: TrafficResult, mode: 'shadow' | 'live'): string {
  const parts = result.seats.map(row => `${row.seat} ${row.running}/${row.cap}`);
  const idle = result.seats.filter(row => row.idle).map(row => row.seat);
  const prefix = `traffic ${parts.join(' · ')} · idle=${idle.length ? idle.join(',') : '없음'} · mode=${mode}`;
  if (!result.finish) return prefix;
  const { metrics, advice } = result.finish;
  const rate = (value: number | null) => value === null ? '?' : value.toFixed(2);
  return `${prefix} · finish rate=${rate(metrics.landingRate)} stale=${metrics.staleDrafts ?? '?'} conflict=${rate(metrics.conflictRatio)} → finish=${advice.finishSlots}/${advice.finishSlots + advice.launchSlots}`;
}

export type AuthorShadow = { cells: number; held: number; queuedForAuthor: number; status: 'complete' | 'incomplete'; receiptFailures: number };

/** Traffic stays authoritative: shadow collection and its ledger cannot change its decision or exit status. */
export function runTrafficTick({ processes, now, caps, openCells, nextRound, totalSlots, mode, finishDeps, applyDeps, authorDeps, collectAuthor = collectAuthorDepth, log = debug.log.bind(debug) }: {
  processes: readonly TrafficProcess[];
  now: Date;
  caps: Readonly<Record<OrchestratorSeat, number>>;
  openCells: readonly TrafficCell[];
  nextRound?: readonly TrafficCell[];
  totalSlots?: number;
  mode: 'shadow' | 'live';
  finishDeps?: MeasureFinishDeps;
  applyDeps?: TrafficApplyDeps;
  authorDeps?: Omit<CollectAuthorDepthDeps, 'caps' | 'running' | 'now'>;
  collectAuthor?: (deps: CollectAuthorDepthDeps) => AuthorDepthResult;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}): { result: TrafficResult; queued: number; authorShadow: AuthorShadow | null } {
  const metrics = measureFinish(finishDeps, now);
  const advice = finishAdvice(metrics, TRAFFIC_SEATS.reduce((sum, seat) => sum + caps[seat], 0));
  const result = { ...trafficTick({ processes, now, caps, openCells, nextRound, totalSlots: totalSlots ?? advice.launchSlots }),
    finish: { metrics, advice } };
  const root = applyDeps?.root ?? effectiveInstanceRoot();
  const queued = applyTraffic(result, { ...applyDeps, root, mode });
  {
    const skipped: Record<string, number> = {};
    const suppliedSeats = new Set(openCells.filter(cell => cell.status !== 'done').map(cell => cell.owner?.split('/')[0]));
    for (const row of result.seats) {
      const reason = !suppliedSeats.has(row.seat) ? 'no-supply' : row.running >= row.launchCap ? 'capacity'
        : !row.idle ? 'not-idle' : undefined;
      if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
    recordDispatchCycle(root, {
      at: now.toISOString(), source: 'traffic', mode, runId: now.toISOString(),
      supply: result.seats.filter(row => suppliedSeats.has(row.seat)).length,
      capacity: result.seats.reduce((sum, row) => sum + Math.max(0, row.launchCap - row.running), 0),
      eligible: result.seats.filter(row => row.idle && isLaunchEligible(row)).length,
      skipped, dispatch: getUserConfig().loops?.orchestrator?.dispatch ?? ORCHESTRATOR_DEFAULTS.dispatch,
    });
  }
  // 24h metrics journal: observation only, silent on the decision log, never read for this decision path.
  recordTrafficSample24h(root, { at: now.toISOString(), seats: result.seats }, { log: () => {} });
  // 게이트 관측은 위 recordDispatchCycle 상시 배선(과 tick launch 노드의 동일 호출)에서 매 사이클
  // 쌓인다 — 이 틱에서 중복 관측을 또 하지 않는다. 관측 전용, 이 판정 경로는 이 저널을 읽지 않는다.
  let authorShadow: AuthorShadow | null = null;
  let shadowFailure: Record<string, unknown> | null = null;
  try {
    const depth = collectAuthor({ ...authorDeps, now, caps: () => caps,
      running: () => Object.fromEntries(result.seats.map(row => [row.seat, row.running])) });
    const receiptFailures = depth.receiptFailures ?? depth.unreadable.filter(item => item.source === 'author-ledger').length;
    const incomplete = depth.unreadable.length > 0 || !depth.receiptCounts;
    authorShadow = { cells: depth.seats.reduce((total, row) => total + row.wouldAuthor.length, 0),
      held: depth.receiptCounts?.held ?? 0, queuedForAuthor: depth.receiptCounts?.queuedForAuthor ?? 0,
      status: incomplete ? 'incomplete' : 'complete', receiptFailures };
    if (incomplete) shadowFailure = { unreadable: depth.unreadable, ...(depth.receiptCounts ? {} : { reason: 'receipt counts unavailable' }) };
  } catch (error) {
    shadowFailure = { reason: error instanceof Error ? error.message : String(error) };
  }
  if (shadowFailure) {
    try { log('loops.author-depth', 'shadow-failed', shadowFailure); }
    catch { /* Shadow logging cannot change traffic's outcome. */ }
  }
  return { result, queued, authorShadow };
}

export type GateObservation = { at: string; level: 'L1' | 'L2' | null };

/** Map a degradation probe to the gate level that stops place/delegate/launch; L2 is the stronger gate. */
export function gateLevelOf(signal: Pick<DegradationSignal, 'llm' | 'board'>): 'L1' | 'L2' | null {
  if (!signal.board) return 'L2';
  if (!signal.llm) return 'L1';
  return null;
}

export interface GateHaltDeps {
  signal?: Pick<DegradationSignal, 'llm' | 'board'>;
  probe?: (root: string) => Pick<DegradationSignal, 'llm' | 'board'>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** Observation-only journal for the 24h gate metric: probe the degradation gates and append the level. */
export function observeGateHalt(root: string, deps: GateHaltDeps = {}): GateObservation {
  const log = deps.log ?? debug.log.bind(debug);
  const signal = deps.signal ?? deps.probe?.(root) ?? probeDegradation(root);
  const observation: GateObservation = { at: new Date().toISOString(), level: gateLevelOf(signal) };
  const path = join(root, 'orchestrator', 'gate-halt-24h.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(`${path}.lock`, () => {
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
      const separator = previous === '' || previous.endsWith('\n') ? '' : '\n';
      appendFileSync(path, `${separator}${JSON.stringify(observation)}\n`);
    });
    log('loop.orchestrator', 'gate-halt-24h', { ...observation, path });
  } catch (error) {
    try { log('loop.orchestrator', 'gate-halt-24h-failed', { error: String(error).slice(0, 200) }); }
    catch { /* Observation cannot change a recorded decision. */ }
  }
  return observation;
}

/** Read the 24h gate journal; torn lines are skipped (same rule as the dispatch ledger). */
export function readGateObservations24h(root: string, now: Date, windowMinutes = 1440): GateObservation[] {
  const path = join(root, 'orchestrator', 'gate-halt-24h.jsonl');
  if (!existsSync(path)) return [];
  const floor = now.getTime() - windowMinutes * 60_000;
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as GateObservation;
      const at = Date.parse(parsed.at);
      if (!Number.isFinite(at) || at < floor || at > now.getTime()) return [];
      if (parsed.level !== null && parsed.level !== 'L1' && parsed.level !== 'L2') return [];
      return [parsed];
    } catch { return []; }
  });
}

/** Read the dispatch ledger verbatim journal; torn lines are skipped, kept only for forensics. */
export function readDispatchLedger(root: string, now: Date, windowMinutes = 1440): DispatchCycle[] {
  const path = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  if (!existsSync(path)) return [];
  const floor = now.getTime() - windowMinutes * 60_000;
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as DispatchCycle;
      const at = Date.parse(parsed.at);
      if (!Number.isFinite(at) || at < floor || at > now.getTime()) return [];
      return [parsed];
    } catch { return []; }
  });
}

/** Gate-halted minutes: gate-active spans where the verbatim ledger shows zero launch attempts AND the gate's
 * own skip reason (degraded-skip) — a gate-active span with no demand is not halted time. */
export function gateHaltedLaunchMinutes({ gate, ledger }: {
  gate: readonly GateObservation[];
  ledger?: readonly DispatchCycle[];
}): { minutes: number; launchAttempts: number; haltedTicks: number; activeObservations: number } {
  const points = gate.map(observation => ({ observation, t: Date.parse(observation.at) }))
    .filter(point => Number.isFinite(point.t)).sort((a, b) => a.t - b.t);
  const cycles = (ledger ?? []).map(cycle => ({ cycle, t: Date.parse(cycle.at) }))
    .filter(entry => Number.isFinite(entry.t));
  let minutes = 0;
  let launchAttempts = 0;
  let haltedTicks = 0;
  let activeObservations = 0;
  for (const point of points) {
    if (point.observation.level !== null) activeObservations++;
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].observation.level === null || points[i - 1].observation.level === null) continue;
    const from = points[i - 1].t;
    const to = points[i].t;
    const inSpan = cycles.filter(entry => entry.t >= from && entry.t <= to);
    const attempts = inSpan.reduce((sum, entry) => sum + entry.cycle.eligible, 0);
    // Only the ledger's own skip reason proves the gate stopped launches: eligible is structurally 0 while the
    // gate skips, so attempts === 0 alone would also count zero-demand spans as «halted» (Goodhart).
    const gateSkipped = inSpan.reduce((sum, entry) => sum + (entry.cycle.skipped['degraded-skip'] ?? 0), 0);
    launchAttempts += attempts;
    if (attempts === 0 && gateSkipped > 0) {
      haltedTicks++;
      minutes += Math.max(0, (to - from) / 60_000);
    }
  }
  return { minutes, launchAttempts, haltedTicks, activeObservations };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--metrics')) {
      if (args.some(arg => arg !== '--metrics' && arg !== '--json'))
        throw new Error('usage: traffic.ts [--version <판>] [--json] | --metrics [--json]');
      const root = effectiveInstanceRoot();
      const now = new Date();
      const observation = observeGateHalt(root);
      const gate = gateHaltedLaunchMinutes({ gate: readGateObservations24h(root, now), ledger: readDispatchLedger(root, now) });
      const traffic = computeTrafficMetrics24h(readTrafficSamples24h(root, now));
      const report = { at: now.toISOString(), version: devVersion().replace(/-dev\.\d+$/, ''), traffic,
        gate: { ...gate, observation } };
      if (args.includes('--json')) console.log(JSON.stringify(report));
      else {
        const wait = traffic.meanWaitMinutes === null ? '?' : `${traffic.meanWaitMinutes}분`;
        console.log(`traffic-24h utilization=${traffic.utilizationRate} (${traffic.running}/${traffic.capacity}) · mean-wait=${wait} (표본 ${traffic.waitSamples}) · preemptions=${traffic.preemptedSeatTicks} · gate-halt=${gate.minutes}분 (발사시도 ${gate.launchAttempts}) · ticks=${traffic.sampledTicks} · window=${traffic.windowMinutes}분`);
      }
    } else {
    const versionFlag = args.indexOf('--version');
    const version = versionFlag < 0 ? devVersion().replace(/-dev\.\d+$/, '') : args[versionFlag + 1];
    if (!version || version.startsWith('--')
      || args.some((arg, i) => arg !== '--json' && i !== versionFlag && (versionFlag < 0 || i !== versionFlag + 1))) {
      throw new Error('usage: traffic.ts [--version <판>] [--json]');
    }
    const cfg = getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
    const observation = defaultListHarnessProcesses();
    if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
    const now = new Date();
    const processes = observation.records.map(process => ({ ...process, seat: seatOfTree(process.cwdStatus === 'unknown' ? undefined : process.cwd, cfg) }));
    const upcoming = listSchedules(releaseLedgerRoot()).filter(row => Date.parse(row.cutAt) > now.getTime())
      .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
    const currentIndex = upcoming.findIndex(row => row.version === version);
    const nextVersion = currentIndex < 0 ? upcoming[0]?.version : upcoming[currentIndex + 1]?.version;
    const { result, queued, authorShadow } = runTrafficTick({
      processes, now, caps: cfg.seatCaps, openCells: listChecklist(version).items,
      ...(nextVersion ? { nextRound: listChecklist(nextVersion).items } : {}), mode: cfg.trafficMode,
      applyDeps: { root: effectiveInstanceRoot() },
    });
    if (args.includes('--json')) console.log(JSON.stringify({ ...result, mode: cfg.trafficMode, queued, version, authorShadow }));
    else console.log(trafficLine(result, cfg.trafficMode));
    }
  } catch (error) {
    console.error(`traffic: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
