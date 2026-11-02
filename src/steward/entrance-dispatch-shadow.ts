/** Read-only graph shadow for the HQ TA dispatcher. It never starts or stops work. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  evaluateEntranceShadow,
  type EntranceShadowRecord,
  type EntranceShadowSnapshot,
} from '../task-agent/entrance-shadow.js';

export interface DispatcherEvent {
  at: string;
  kind: 'launch' | 'skip';
  cellId: string;
  detail: string;
}

export interface DispatcherCycle {
  startedAt: string;
  endedAt: string;
  events: DispatcherEvent[];
}

export interface ShadowInput {
  name: string;
  path: string;
  required: boolean;
}

export interface ShadowInputDigest {
  name: string;
  sha256: string | null;
  size: number | null;
  mtimeMs: number | null;
  readable: boolean;
  stable: boolean;
}

const LOG_EVENT = /^([0-2]\d:[0-5]\d:[0-5]\d) \[OP\] (겹침 발사|발사 실패|발사|건너뜀|넘김 보류) ([^\s(—]+)(?:\([^)]*\))?\s*(.*)$/;

interface TrafficConfig {
  versions?: string[];
  shareAll?: boolean;
  cycleSec?: number;
}

function parseTrafficConfig(text: string): { config: TrafficConfig | null; error: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { config: null, error: 'invalid-json' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { config: null, error: 'not-object' };
  const candidate = parsed as Record<string, unknown>;
  if (candidate.versions !== undefined
    && (!Array.isArray(candidate.versions) || candidate.versions.some(version => typeof version !== 'string')))
    return { config: null, error: 'invalid-versions' };
  if (candidate.shareAll !== undefined && typeof candidate.shareAll !== 'boolean')
    return { config: null, error: 'invalid-shareAll' };
  if (candidate.cycleSec !== undefined
    && (typeof candidate.cycleSec !== 'number' || !Number.isFinite(candidate.cycleSec) || candidate.cycleSec <= 0))
    return { config: null, error: 'invalid-cycleSec' };
  return {
    config: {
      versions: candidate.versions as string[] | undefined,
      shareAll: candidate.shareAll as boolean | undefined,
      cycleSec: candidate.cycleSec as number | undefined,
    },
    error: null,
  };
}

function localTimestamp(time: string, anchor: Date): string {
  const [hour, minute, second] = time.split(':').map(Number);
  const kstAnchor = new Date(anchor.getTime() + 9 * 60 * 60 * 1000);
  const at = new Date(Date.UTC(kstAnchor.getUTCFullYear(), kstAnchor.getUTCMonth(), kstAnchor.getUTCDate(), hour, minute, second) - 9 * 60 * 60 * 1000);
  // The dispatcher log has KST HH:MM:SS only. Correct midnight rollover relative to the anchor.
  if (at.getTime() - anchor.getTime() > 12 * 60 * 60 * 1000) at.setTime(at.getTime() - 24 * 60 * 60 * 1000);
  if (anchor.getTime() - at.getTime() > 12 * 60 * 60 * 1000) at.setTime(at.getTime() + 24 * 60 * 60 * 1000);
  return at.toISOString();
}

export function parseDispatcherEvents(text: string, anchor = new Date()): DispatcherEvent[] {
  const raw: Array<{ time: string; kind: DispatcherEvent['kind']; cellId: string; detail: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LOG_EVENT.exec(line);
    if (!match) continue;
    const action = match[2];
    const detail = match[4].trim().slice(0, 240);
    raw.push({
      time: match[1],
      kind: action === '발사' && !detail.includes('not launched') ? 'launch' : 'skip',
      cellId: match[3],
      detail,
    });
  }
  const reversed: DispatcherEvent[] = [];
  let nextAt: Date | undefined;
  for (const event of [...raw].reverse()) {
    const parsedAt = new Date(localTimestamp(event.time, nextAt ?? anchor));
    // Walking backward, a late-night timestamp before an early-morning timestamp belongs to yesterday.
    if (nextAt && parsedAt.getTime() > nextAt.getTime() + 12 * 60 * 60 * 1000) parsedAt.setTime(parsedAt.getTime() - 24 * 60 * 60 * 1000);
    nextAt = parsedAt;
    reversed.push({ at: parsedAt.toISOString(), kind: event.kind, cellId: event.cellId, detail: event.detail });
  }
  return reversed.reverse();
}

/** Log timestamps have no cycle id. A gap at least the configured sleep starts a new group. */
export function groupDispatcherCycles(events: DispatcherEvent[], cycleSeconds: number): DispatcherCycle[] {
  const cycles: DispatcherCycle[] = [];
  const threshold = Math.max(1, cycleSeconds) * 1000;
  for (const event of events) {
    const current = cycles.at(-1);
    if (!current || Date.parse(event.at) - Date.parse(current.endedAt) >= threshold) {
      cycles.push({ startedAt: event.at, endedAt: event.at, events: [event] });
      continue;
    }
    current.events.push(event);
    current.endedAt = event.at;
  }
  return cycles;
}

function digestFile(input: ShadowInput): ShadowInputDigest {
  try {
    const before = statSync(input.path);
    const bytes = readFileSync(input.path);
    const after = statSync(input.path);
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
    return {
      name: input.name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: after.size,
      mtimeMs: after.mtimeMs,
      readable: true,
      stable,
    };
  } catch {
    return { name: input.name, sha256: null, size: null, mtimeMs: null, readable: false, stable: false };
  }
}

export function collectDispatcherInputs(hqRoot: string, home: string, shareAll = true): ShadowInput[] {
  const state = join(hqRoot, 'seat-state', 'OP');
  const feeder = join(state, 'feeder');
  const seatKey = 'OP';
  const boardDir = join(feeder, `board-${seatKey}`);
  const trafficPath = join(state, 'traffic.json');
  let versions: string[] = [];
  try {
    versions = parseTrafficConfig(readFileSync(trafficPath, 'utf8')).config?.versions ?? [];
  } catch { /* unreadable traffic is reported by the required digest below */ }
  let boardFiles: string[] = [];
  try { boardFiles = readdirSync(boardDir).filter(file => /^board-.*\.json$/.test(file) && file !== 'board.tsv'); }
  catch { /* missing board directory is surfaced by required snapshot inputs */ }
  const inputs: ShadowInput[] = [
    { name: 'traffic', path: trafficPath, required: true },
    { name: 'board-tsv', path: join(boardDir, 'board.tsv'), required: true },
    ...versions.map(version => ({ name: `board-${version}`, path: join(boardDir, `board-${version}.json`), required: true })),
    ...boardFiles.filter(file => !versions.some(version => file === `board-${version}.json`))
      .map(file => ({ name: file.slice(0, -5), path: join(boardDir, file), required: true })),
    { name: 'task-agent-actions', path: join(home, '.elanous', 'task-agent-actions.json'), required: true },
    { name: 'handed', path: join(feeder, 'handed.txt'), required: false },
    { name: 'open-pr-files', path: join(feeder, `openpr-${seatKey}.json`), required: false },
    { name: 'landed-cells', path: join(feeder, 'landed-cells.txt'), required: false },
    { name: 'skip-memo', path: join(feeder, 'skip-memo.tsv'), required: false },
    { name: 'assign', path: join(feeder, 'assign.json'), required: false },
    { name: 'shell-picker-receipt', path: join(feeder, `pick-why-${seatKey}.txt`), required: false },
    ...(shareAll ? ['OP', 'TC', 'MK', 'UX'] : ['OP'])
      .map(seat => ({ name: `ta-ready-${seat}`, path: join(hqRoot, seat, 'ta-ready.txt'), required: false })),
    { name: 'dispatcher-pid', path: join(feeder, `dispatcher-${seatKey}.pid`), required: false },
    { name: 'dispatcher-OP', path: join(feeder, 'dispatcher-OP.out'), required: true },
  ];
  return inputs;
}

export interface EntranceShadowSummary {
  at: string;
  seat: 'OP';
  mode: 'shadow';
  launches: number;
  skips: number;
  cycles: number;
  stableInputs: boolean;
  missingInputs: string[];
  unstableInputs: string[];
  invalidInputs: string[];
  readErrors: Array<{ input: string; reason: 'unreadable-after-digest' }>;
  trafficConfigError: string | null;
  inputDigests: ShadowInputDigest[];
  decisionRecord: EntranceShadowRecord;
  graphPicks: string[];
  graphPickError: string | null;
  shellPickedCells: string[];
  skipMemoBaselineSha256: string | null;
  comparedCycles: number;
  exactPickAgreement: number | null;
  agreement: null;
  agreementReason: string;
}

export function runEntranceDispatchShadow(deps: {
  hqRoot: string;
  home: string;
  cycleSeconds?: number;
  now?: Date;
  /** Deterministic read seam for race tests; production uses readFileSync. */
  readText?: (path: string) => string;
  /** Mock-only snapshot injection. Without a production producer, the default snapshot is entirely unknown. */
  snapshot?: EntranceShadowSnapshot;
  log?: (event: string, data: Record<string, unknown>) => void;
}): EntranceShadowSummary {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((event, data) => debug.log('steward.entrance-dispatch-shadow', event, data));
  const seat = 'OP';
  const inputs = collectDispatcherInputs(deps.hqRoot, deps.home, true);
  const before = inputs.map(digestFile);
  const beforeByName = new Map(before.map(digest => [digest.name, digest]));
  const logPath = inputs.find(input => input.name === 'dispatcher-OP')!.path;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const readErrors: Array<{ input: string; reason: 'unreadable-after-digest' }> = [];
  const capture = (name: string, path: string, readable: boolean): string => {
    if (!readable) return '';
    try { return readText(path); }
    catch {
      readErrors.push({ input: name, reason: 'unreadable-after-digest' });
      return '';
    }
  };
  const dispatcherText = capture('dispatcher-OP', logPath, beforeByName.get('dispatcher-OP')?.readable === true);
  const trafficDigest = beforeByName.get('traffic');
  const trafficBytes = capture('traffic', inputs.find(input => input.name === 'traffic')!.path, trafficDigest?.readable === true);
  const after = inputs.map(digestFile);
  const afterByName = new Map(after.map(digest => [digest.name, digest]));
  const inputDigests = before.map(digest => {
    const latest = afterByName.get(digest.name)!;
    return { ...digest, stable: digest.stable && latest.stable && digest.sha256 === latest.sha256 && digest.mtimeMs === latest.mtimeMs };
  });
  const byName = new Map(inputDigests.map(digest => [digest.name, digest]));
  const missingInputs = inputs.filter(input => input.required && !byName.get(input.name)?.readable).map(input => input.name);
  const unstableInputs = inputDigests.filter(digest => digest.readable && !digest.stable).map(digest => digest.name);
  for (const readError of readErrors) {
    if (!unstableInputs.includes(readError.input)) unstableInputs.push(readError.input);
  }
  const parsedTraffic = parseTrafficConfig(trafficBytes);
  const signal = parsedTraffic.config ?? {};
  const trafficConfigError = parsedTraffic.error;
  const invalidInputs = trafficConfigError ? ['traffic'] : [];
  let cycleSeconds = deps.cycleSeconds ?? 300;
  if (signal.cycleSec !== undefined) cycleSeconds = signal.cycleSec;
  const logMtime = byName.get('dispatcher-OP')?.mtimeMs;
  const events = parseDispatcherEvents(dispatcherText, logMtime ? new Date(logMtime) : now)
    .filter(event => Date.parse(event.at) >= now.getTime() - 24 * 60 * 60 * 1000 && Date.parse(event.at) <= now.getTime() + 5 * 60 * 1000);
  const cycles = groupDispatcherCycles(events, cycleSeconds);
  const stableInputs = missingInputs.length === 0 && unstableInputs.length === 0 && invalidInputs.length === 0;
  const observedAt = now.toISOString();
  const unknownObservation = (source: string) => ({
    state: 'unknown' as const,
    reason: 'production snapshot producer is not implemented',
    source,
    observedAt,
  });
  const decisionRecord = evaluateEntranceShadow(deps.snapshot ?? {
    cycleId: 'unmeasured', cellId: 'ENTRANCE-DISPATCH-SHADOW', version: 'unknown', observedAt,
    checklist: unknownObservation('release-checklist'),
    hold: unknownObservation('traffic-hold'),
    openPullRequests: unknownObservation('open-pr-inventory'),
    capacity: unknownObservation('substrate-capacity'),
  });
  const summary: EntranceShadowSummary = {
    at: now.toISOString(), seat, mode: 'shadow',
    launches: events.filter(event => event.kind === 'launch').length,
    skips: events.filter(event => event.kind === 'skip').length,
    cycles: cycles.length,
    stableInputs, missingInputs, unstableInputs, invalidInputs, readErrors, trafficConfigError, inputDigests,
    decisionRecord,
    graphPicks: [], graphPickError: 'contract-only: production snapshot producer and isolated picker fixture are not implemented',
    shellPickedCells: [],
    skipMemoBaselineSha256: null,
    comparedCycles: 0, exactPickAgreement: null,
    agreement: null,
    agreementReason: 'unmeasured: contract-only module has mock coverage but no production snapshot producer or isolated picker fixture',
  };
  log('snapshot', summary as unknown as Record<string, unknown>);
  for (const [index, cycle] of cycles.slice(-20).entries()) {
    log('shell-cycle', { cycle: index, ...cycle, mode: 'baseline-only' });
  }
  log(stableInputs ? 'parity-unmeasured' : 'snapshot-incomplete', {
    at: summary.at,
    stableInputs,
    missingInputs,
    unstableInputs,
    invalidInputs,
    readErrors,
    trafficConfigError,
    exactPickAgreement: null,
    comparedCycles: 0,
    reason: summary.agreementReason,
    actualLaunchesByGraph: 0,
    mode: 'shadow',
  });
  return summary;
}

if (import.meta.main) {
  const home = process.env.HOME ?? '';
  const hqRoot = process.env.ENTRANCE_SHADOW_HQ_ROOT ?? join(home, 'elanous-hq');
  try {
    const ready = await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('steward');
    if (!ready) throw new Error('durable log sink unavailable');
    const result = runEntranceDispatchShadow({ hqRoot, home });
    console.log(`entrance dispatch shadow: launches=${result.launches} skips=${result.skips} cycles=${result.cycles} picks=${result.graphPicks.length} snapshot=${result.stableInputs ? 'stable' : 'incomplete'} parity=${result.exactPickAgreement ?? 'unmeasured'}${result.graphPickError ? ` picker-error=${result.graphPickError.slice(-1200)}` : ''}`);
  } catch (error) {
    console.error(`entrance dispatch shadow failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
