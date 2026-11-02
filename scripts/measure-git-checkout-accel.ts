#!/usr/bin/env bun
/**
 * Deterministic E4 comparison contract for checkout acceleration candidates.
 * Production paths remain unchanged: worktree.ts owns `git worktree add`,
 * gate-node.ts owns clean remote `git clone --no-checkout`, and
 * pod-source-receive.ts owns Pod image/mirror source selection (the image
 * context archive is built by docker/harness/build.sh). This CLI runs the same
 * injected measurement contract used by those route probes; its JSON input is
 * a deterministic probe fixture, not a live host measurement.
 *
 * Input: { cutSha, observations: one measured or explicitly unavailable row
 * for every route × candidate × cold/warm combination }.
 */
import { readFileSync } from 'node:fs';

export const CHECKOUT_ROUTES = ['worktree-add', 'remote-gate-clone', 'pod-source-image'] as const;
export const CHECKOUT_CANDIDATES = ['reference', 'partial', 'sparse'] as const;
export const CHECKOUT_CONDITIONS = ['cold', 'warm'] as const;

export type CheckoutRoute = typeof CHECKOUT_ROUTES[number];
export type CheckoutCandidate = typeof CHECKOUT_CANDIDATES[number];
export type CheckoutCondition = typeof CHECKOUT_CONDITIONS[number];

export interface CheckoutProbeObservation {
  route: CheckoutRoute;
  candidate: CheckoutCandidate;
  condition: CheckoutCondition;
  durationMs: number;
  bytesWritten: number;
  fileCount: number;
  fseventCount?: number;
  fseventUnavailableReason?: string;
  usesAlternates: boolean;
  alternatesGcSafe?: boolean;
  sparseCheckoutEnabled: boolean;
  sparseDependenciesMet?: boolean;
}

export type CheckoutProbeResult =
  | Pick<CheckoutProbeObservation, 'bytesWritten' | 'fileCount' | 'fseventCount' | 'fseventUnavailableReason' | 'usesAlternates' | 'alternatesGcSafe' | 'sparseCheckoutEnabled' | 'sparseDependenciesMet'>
  | { unavailableReason: string; fseventUnavailableReason?: string; usesAlternates?: boolean; alternatesGcSafe?: boolean; sparseCheckoutEnabled?: boolean; sparseDependenciesMet?: boolean };

export interface CheckoutMeasurementRow {
  route: CheckoutRoute;
  candidate: CheckoutCandidate;
  condition: CheckoutCondition;
  cutSha: string;
  measurementStatus: 'measured' | 'unavailable';
  durationMs: number | null;
  bytesWritten: number | null;
  fileCount: number | null;
  fseventCount: number | null;
  fseventUnavailableReason: string | null;
  usesAlternates: boolean | null;
  alternatesGcSafe: boolean | null;
  sparseCheckoutEnabled: boolean | null;
  sparseDependenciesMet: boolean | null;
  usable: boolean;
  unusableReasons: string[];
}

export interface CheckoutProbe {
  measure(input: { route: CheckoutRoute; candidate: CheckoutCandidate; condition: CheckoutCondition; cutSha: string }): Promise<CheckoutProbeResult>;
}

export interface CheckoutClock { now(): number }

const SHA = /^[0-9a-f]{40}$/i;
const VALID = (value: number) => Number.isFinite(value) && value >= 0;
const matrixKey = (route: CheckoutRoute, candidate: CheckoutCandidate, condition: CheckoutCondition) => `${route}/${candidate}/${condition}`;

function reasonsFor(input: {
  candidate: CheckoutCandidate;
  measurementStatus: 'measured' | 'unavailable';
  unavailableReason?: string;
  usesAlternates: boolean | null;
  alternatesGcSafe: boolean | null;
  sparseCheckoutEnabled: boolean | null;
  sparseDependenciesMet: boolean | null;
}): string[] {
  const reasons: string[] = [];
  if (input.measurementStatus === 'unavailable') reasons.push(input.unavailableReason ?? 'measurement-unavailable');
  if (input.usesAlternates === true && input.alternatesGcSafe !== true) reasons.push('alternates-gc-safety-unproven');
  if (input.candidate === 'sparse' && input.sparseCheckoutEnabled !== true) reasons.push('sparse-checkout-not-used');
  if (input.sparseCheckoutEnabled === true && input.sparseDependenciesMet !== true) reasons.push('sparse-dependencies-unmet');
  return reasons;
}

/** Runs every route × candidate × temperature case; unavailable probes remain visible rows. */
export async function measureCheckoutAcceleration(options: {
  cutSha: string;
  probe: CheckoutProbe;
  clock?: CheckoutClock;
}): Promise<CheckoutMeasurementRow[]> {
  const { cutSha, probe, clock = { now: () => performance.now() } } = options;
  if (!SHA.test(cutSha)) throw new Error('cutSha must be a full 40-character commit SHA');
  const rows: CheckoutMeasurementRow[] = [];
  for (const route of CHECKOUT_ROUTES) for (const candidate of CHECKOUT_CANDIDATES) for (const condition of CHECKOUT_CONDITIONS) {
    const started = clock.now();
    const result = await probe.measure({ route, candidate, condition, cutSha });
    const elapsed = clock.now() - started;
    if ('unavailableReason' in result) {
      if (!result.unavailableReason.trim()) throw new Error(`unavailable probe needs a reason: ${matrixKey(route, candidate, condition)}`);
      const fields = {
        candidate, measurementStatus: 'unavailable' as const, unavailableReason: result.unavailableReason,
        usesAlternates: result.usesAlternates ?? null, alternatesGcSafe: result.alternatesGcSafe ?? null,
        sparseCheckoutEnabled: result.sparseCheckoutEnabled ?? null, sparseDependenciesMet: result.sparseDependenciesMet ?? null,
      };
      const reasons = reasonsFor(fields);
      rows.push({ route, candidate, condition, cutSha: cutSha.toLowerCase(), measurementStatus: 'unavailable', durationMs: null,
        bytesWritten: null, fileCount: null, fseventCount: null, fseventUnavailableReason: result.fseventUnavailableReason ?? result.unavailableReason, usesAlternates: fields.usesAlternates, alternatesGcSafe: fields.alternatesGcSafe,
        sparseCheckoutEnabled: fields.sparseCheckoutEnabled, sparseDependenciesMet: fields.sparseDependenciesMet,
        usable: false, unusableReasons: reasons });
      continue;
    }
    if (!VALID(elapsed) || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 0 ||
        !Number.isSafeInteger(result.fileCount) || result.fileCount < 0 ||
        (result.fseventCount !== undefined && (!Number.isSafeInteger(result.fseventCount) || result.fseventCount < 0)) ||
        (result.fseventUnavailableReason !== undefined && !result.fseventUnavailableReason.trim()) ||
        (result.fseventCount !== undefined && result.fseventUnavailableReason !== undefined)) {
      throw new Error(`invalid probe measurement: ${matrixKey(route, candidate, condition)}`);
    }
    const fields = {
      candidate, measurementStatus: 'measured' as const, usesAlternates: result.usesAlternates,
      alternatesGcSafe: result.alternatesGcSafe ?? null, sparseCheckoutEnabled: result.sparseCheckoutEnabled,
      sparseDependenciesMet: result.sparseDependenciesMet ?? null,
    };
    const reasons = reasonsFor(fields);
    rows.push({ route, candidate, condition, cutSha: cutSha.toLowerCase(), measurementStatus: 'measured', durationMs: elapsed,
      bytesWritten: result.bytesWritten, fileCount: result.fileCount, fseventCount: result.fseventCount ?? null,
      fseventUnavailableReason: result.fseventUnavailableReason ?? (result.fseventCount === undefined ? 'fsevent counter not supplied by probe' : null), usesAlternates: result.usesAlternates,
      alternatesGcSafe: result.alternatesGcSafe ?? null, sparseCheckoutEnabled: result.sparseCheckoutEnabled,
      sparseDependenciesMet: result.sparseDependenciesMet ?? null, usable: reasons.length === 0, unusableReasons: reasons });
  }
  return rows;
}

interface FixtureObservation {
  route: CheckoutRoute;
  candidate: CheckoutCandidate;
  condition: CheckoutCondition;
  durationMs?: number;
  bytesWritten?: number;
  fileCount?: number;
  usesAlternates?: boolean;
  alternatesGcSafe?: boolean;
  sparseCheckoutEnabled?: boolean;
  sparseDependenciesMet?: boolean;
  fseventCount?: number;
  fseventUnavailableReason?: string;
  unavailableReason?: string;
}

function fixtureProbe(value: unknown): { cutSha: string; probe: CheckoutProbe; clock: CheckoutClock } {
  if (!value || typeof value !== 'object') throw new Error('fixture must be an object');
  const fixture = value as { cutSha?: unknown; observations?: unknown };
  if (typeof fixture.cutSha !== 'string' || !SHA.test(fixture.cutSha)) throw new Error('fixture cutSha must be a full 40-character commit SHA');
  if (!Array.isArray(fixture.observations)) throw new Error('fixture observations must be an array');
  const observations = new Map<string, FixtureObservation>();
  for (const value of fixture.observations) {
    if (!value || typeof value !== 'object') throw new Error('observation must be an object');
    const row = value as FixtureObservation;
    if (!(CHECKOUT_ROUTES as readonly unknown[]).includes(row.route) || !(CHECKOUT_CANDIDATES as readonly unknown[]).includes(row.candidate) || !(CHECKOUT_CONDITIONS as readonly unknown[]).includes(row.condition)) {
      throw new Error('observation has unknown route, candidate, or condition');
    }
    const key = matrixKey(row.route, row.candidate, row.condition);
    if (observations.has(key)) throw new Error(`duplicate observation: ${key}`);
    for (const fact of [row.usesAlternates, row.alternatesGcSafe, row.sparseCheckoutEnabled, row.sparseDependenciesMet]) {
      if (fact !== undefined && typeof fact !== 'boolean') throw new Error(`invalid safety fact: ${key}`);
    }
    if (typeof row.unavailableReason === 'string') {
      if (!row.unavailableReason.trim()) throw new Error(`unavailable observation needs a reason: ${key}`);
    } else {
      const hasFseventCount = Number.isSafeInteger(row.fseventCount) && row.fseventCount! >= 0;
      const hasFseventReason = typeof row.fseventUnavailableReason === 'string' && Boolean(row.fseventUnavailableReason.trim());
      if (hasFseventCount === hasFseventReason || !VALID(row.durationMs!) || !Number.isSafeInteger(row.bytesWritten) || row.bytesWritten! < 0 ||
          !Number.isSafeInteger(row.fileCount) || row.fileCount! < 0 || typeof row.usesAlternates !== 'boolean' || typeof row.sparseCheckoutEnabled !== 'boolean') {
        throw new Error(`invalid observation costs or route facts: ${key}`);
      }
    }
    observations.set(key, row);
  }
  const expected = new Set<string>();
  for (const route of CHECKOUT_ROUTES) for (const candidate of CHECKOUT_CANDIDATES) for (const condition of CHECKOUT_CONDITIONS) expected.add(matrixKey(route, candidate, condition));
  const missing = [...expected].filter((key) => !observations.has(key));
  if (missing.length) throw new Error(`fixture missing ${missing.length} matrix observation(s): ${missing.join(', ')}`);
  let pendingDuration = 0;
  let atMeasurementEnd = false;
  return {
    cutSha: fixture.cutSha,
    clock: { now: () => {
      if (!atMeasurementEnd) { atMeasurementEnd = true; return 0; }
      atMeasurementEnd = false;
      return pendingDuration;
    } },
    probe: { async measure({ route, candidate, condition }) {
      const row = observations.get(matrixKey(route, candidate, condition))!;
      if (row.unavailableReason) {
        pendingDuration = 0;
        return { unavailableReason: row.unavailableReason, fseventUnavailableReason: row.fseventUnavailableReason, usesAlternates: row.usesAlternates,
          alternatesGcSafe: row.alternatesGcSafe, sparseCheckoutEnabled: row.sparseCheckoutEnabled, sparseDependenciesMet: row.sparseDependenciesMet };
      }
      pendingDuration = row.durationMs!;
      return { bytesWritten: row.bytesWritten!, fileCount: row.fileCount!, fseventCount: row.fseventCount, fseventUnavailableReason: row.fseventUnavailableReason, usesAlternates: row.usesAlternates!,
        alternatesGcSafe: row.alternatesGcSafe, sparseCheckoutEnabled: row.sparseCheckoutEnabled!, sparseDependenciesMet: row.sparseDependenciesMet };
    } },
  };
}

export function formatCheckoutMeasurementTable(rows: readonly CheckoutMeasurementRow[]): string {
  const header = ['route', 'candidate', 'condition', 'cutSha', 'status', 'durationMs', 'bytesWritten', 'fileCount', 'fseventCount', 'fseventUnavailableReason', 'usesAlternates', 'alternatesGcSafe', 'sparseCheckoutEnabled', 'sparseDependenciesMet', 'usable', 'unusableReasons'];
  const values = rows.map((row) => [row.route, row.candidate, row.condition, row.cutSha, row.measurementStatus, String(row.durationMs ?? ''), String(row.bytesWritten ?? ''), String(row.fileCount ?? ''), String(row.fseventCount ?? ''), row.fseventUnavailableReason ?? '', String(row.usesAlternates ?? ''), String(row.alternatesGcSafe ?? ''), String(row.sparseCheckoutEnabled ?? ''), String(row.sparseDependenciesMet ?? ''), String(row.usable), row.unusableReasons.join(',')]);
  const widths = header.map((name, index) => Math.max(name.length, ...values.map((row) => row[index]!.length)));
  const line = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')} |`;
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...values.map(line)].join('\n');
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const inputAt = args.indexOf('--input');
    if (inputAt < 0 || !args[inputAt + 1]) throw new Error('usage: bun scripts/measure-git-checkout-accel.ts --input <probe-fixture.json> [--table]');
    const fixture = fixtureProbe(JSON.parse(readFileSync(args[inputAt + 1]!, 'utf8')) as unknown);
    const rows = await measureCheckoutAcceleration(fixture);
    process.stdout.write(args.includes('--table') ? `Measurement source: deterministic fixture; durations and byte/file costs are supplied inputs, not live host measurements.\n${formatCheckoutMeasurementTable(rows)}\n` : `${JSON.stringify(rows)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
