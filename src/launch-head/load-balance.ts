import type { ResourceView } from '../control-plane/ledger.js';

export interface RankMachinesInput {
  machines: readonly ResourceView[];
  required: readonly string[];
  nowMs: number;
  staleMs?: number;
}

export interface RankedMachine {
  machine: string;
  score: number | null;
  loadPerCpu: number | null;
  freeMemRatio: number | null;
}

export interface RankMachinesResult {
  outcome: 'ranked' | 'skipped';
  candidates: RankedMachine[];
  reasons: string[];
}

const DEFAULT_STALE_MS = 3 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Pure ranking: only fresh, unexpired machine records count toward the multi-machine gate. */
export function rankMachines({ machines, required, nowMs, staleMs = DEFAULT_STALE_MS }: RankMachinesInput): RankMachinesResult {
  const live = machines.filter((row) => {
    const age = nowMs - row.observedAt;
    return row.kind === 'machine' && row.expired !== true &&
      Number.isFinite(age) && age >= 0 && age <= staleMs && age < row.ttlMs;
  });
  if (live.length < 2) {
    return { outcome: 'skipped', candidates: [], reasons: [`기계 ${live.length}대`] };
  }

  const reasons: string[] = [];
  const candidates: RankedMachine[] = [];
  for (const row of live) {
    const attrs = record(row.attrs);
    const capabilities = Array.isArray(attrs.capabilities) ? attrs.capabilities : [];
    const missing = required.filter((capability) => !capabilities.includes(capability));
    if (missing.length) {
      reasons.push(`${row.machine}: 능력 없음 (${missing.join(', ')})`);
      continue;
    }

    const load = record(attrs.load);
    const loadAge = nowMs - (typeof load.observedAt === 'number' ? load.observedAt : row.observedAt);
    const firstLoad = Array.isArray(load.loadAvg) ? nonNegative(load.loadAvg[0]) : null;
    const cpuCount = nonNegative(load.cpuCount);
    const loadPerCpu = loadAge >= 0 && loadAge <= staleMs && firstLoad !== null && cpuCount !== null && cpuCount > 0
      ? firstLoad / cpuCount : null;
    const freeMem = nonNegative(load.freeMem);
    const totalMem = nonNegative(load.totalMem);
    const freeMemRatio = freeMem !== null && totalMem !== null && totalMem > 0
      ? freeMem / totalMem : null;
    candidates.push({ machine: row.machine, score: loadPerCpu, loadPerCpu, freeMemRatio });
  }
  candidates.sort((a, b) => {
    if (a.loadPerCpu === null && b.loadPerCpu !== null) return 1;
    if (b.loadPerCpu === null && a.loadPerCpu !== null) return -1;
    if (a.loadPerCpu !== null && b.loadPerCpu !== null && a.loadPerCpu !== b.loadPerCpu) {
      return a.loadPerCpu - b.loadPerCpu;
    }
    if (a.freeMemRatio === null && b.freeMemRatio !== null) return 1;
    if (b.freeMemRatio === null && a.freeMemRatio !== null) return -1;
    if (a.freeMemRatio !== null && b.freeMemRatio !== null && a.freeMemRatio !== b.freeMemRatio) {
      return b.freeMemRatio - a.freeMemRatio;
    }
    return a.machine.localeCompare(b.machine);
  });
  return { outcome: 'ranked', candidates, reasons };
}
