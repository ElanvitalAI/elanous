/**
 * RELEASE-COUNTDOWN-IN-GRAPH — the Go/No-Go poll of RFC-release-loop-autonomy-and-coordinator §A1b.
 * A stage starts its T-0 only when every declared entry condition is GO; partial readiness is never promoted.
 * The evaluator is pure: probes observe, `evaluateCountdown` judges, the readiness node holds and re-evaluates.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';

export type CountdownStage = 'cut' | 'gate' | 'publish';

/** Stable machine reason codes (RFC §A2: codes, not free sentences). Never rename — receipts and cards key on them. */
export const HOLD_CODES = ['SCHEDULE_MISSING', 'BASE_SHA_MISMATCH', 'IMAGE_NOT_READY', 'TRAFFIC_NOT_PREPPED',
  'HOST_UNREACHABLE', 'CREDENTIAL_STALE', 'APPROVAL_MARKER_ABSENT'] as const;
export type HoldCode = typeof HOLD_CODES[number];
export interface CountdownHold { code: HoldCode; detail: string }

/** Observations. An absent field was not probed by this caller: it is listed in `skipped` and does not hold, so it counts toward GO.
 * The graph entry passes every probe; only callers without probes (tests, sims) skip conditions. */
export interface CountdownConditions {
  schedule?: { present: boolean; exempt: boolean };
  baseSha?: { expected: string; actual: string | undefined };
  image?: { ready: boolean; detail: string };
  traffic?: { prepped: boolean; detail: string };
  hosts?: Array<{ host: string; reachable: boolean }>;
  credentials?: { npmTokenFile: boolean; ghAuth: boolean };
  approvalMarker?: string | boolean | null;
}
export type ConditionName = keyof CountdownConditions;

/** RFC §A1b table: cut = schedule + fixed base · gate = image, hosts, credentials (+ T-1h traffic) · publish = approval. */
export const STAGE_CONDITIONS: Record<CountdownStage, ConditionName[]> = {
  cut: ['schedule', 'baseSha'],
  gate: ['schedule', 'baseSha', 'image', 'traffic', 'hosts', 'credentials'],
  publish: ['credentials', 'approvalMarker'],
};

export interface CountdownVerdict { stage: CountdownStage; go: boolean; holds: CountdownHold[]; skipped: ConditionName[] }

export function evaluateCountdown(stage: CountdownStage, c: CountdownConditions): CountdownVerdict {
  const holds: CountdownHold[] = [];
  const skipped: ConditionName[] = [];
  for (const name of STAGE_CONDITIONS[stage]) {
    if (name !== 'approvalMarker' && c[name] === undefined) { skipped.push(name); continue; }
    if (name === 'schedule' && !c.schedule!.present && !c.schedule!.exempt) {
      holds.push({ code: 'SCHEDULE_MISSING', detail: 'no release schedule row — eln release schedule set --version <v> --cut-at … --publish-at …' });
    } else if (name === 'baseSha' && c.baseSha!.expected.toLowerCase() !== (c.baseSha!.actual ?? '').toLowerCase()) {
      holds.push({ code: 'BASE_SHA_MISMATCH', detail: `cut base ${c.baseSha!.actual ?? 'unknown'} ≠ expected ${c.baseSha!.expected}` });
    } else if (name === 'image' && !c.image!.ready) {
      holds.push({ code: 'IMAGE_NOT_READY', detail: c.image!.detail });
    } else if (name === 'traffic' && !c.traffic!.prepped) {
      holds.push({ code: 'TRAFFIC_NOT_PREPPED', detail: c.traffic!.detail });
    } else if (name === 'hosts' && (c.hosts!.length === 0 || c.hosts!.some((h) => !h.reachable))) {
      const down = c.hosts!.filter((h) => !h.reachable).map((h) => h.host);
      holds.push({ code: 'HOST_UNREACHABLE', detail: down.length ? `pool host unreachable: ${down.join(', ')} (stopped pool? start it)` : 'no pool host declared' });
    } else if (name === 'credentials' && (!c.credentials!.npmTokenFile || !c.credentials!.ghAuth)) {
      const stale = [!c.credentials!.npmTokenFile && 'npm token file', !c.credentials!.ghAuth && 'gh auth'].filter(Boolean);
      holds.push({ code: 'CREDENTIAL_STALE', detail: `${stale.join(' + ')} not usable` });
    } else if (name === 'approvalMarker' && !(c.approvalMarker === true || (typeof c.approvalMarker === 'string' && c.approvalMarker.trim()))) {
      holds.push({ code: 'APPROVAL_MARKER_ABSENT', detail: 'publish requires an approval marker (input.opApprovalMarker)' });
    }
  }
  return { stage, go: holds.length === 0, holds, skipped };
}

/** Long-hold notice: the manual path that absorbed 0.3.28–0.3.30. The operator decides; the graph keeps holding. */
export function quickpassHint(version: string): string {
  return `QUICKPASS: graph path held — fix the hold, or switch to \`eln release critpath --version ${version}\` (manual publish sheet)`;
}

export interface CountdownProbes {
  trafficPrep: (version: string, at: { now: Date; cutAt: string | null }) => { prepped: boolean; detail: string };
  hostReachable: (host: string) => boolean;
  credentials: () => { npmTokenFile: boolean; ghAuth: boolean };
}

/**
 * Receipt of RELEASE-TRAFFIC-PREP-T1H (producer: PR #39160 scripts/release-loop/traffic-prep.ts, read-only here).
 * Read locally with the same field names until #39160 lands; then switch to its checkTrafficPrepReceipt.
 */
export const TRAFFIC_PREP_SCHEMA = 'release-traffic-prep/v1';

export function trafficPrepMarkerPath(root: string, version: string): string {
  return join(root, 'release', version, 'traffic-prep.json');
}

/** GO only for a live receipt of this exact run version: applied, not restored, not past validUntil, same cutAt as the schedule row. */
export function readTrafficPrepMarker(path: string, version: string, at: { now: Date; cutAt: string | null }): { prepped: boolean; detail: string } {
  if (!existsSync(path)) return { prepped: false, detail: `T-1h traffic receipt missing: ${path}` };
  let r: Record<string, unknown>;
  try { r = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { return { prepped: false, detail: `T-1h traffic receipt unreadable: ${path}` }; }
  const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const fail = (why: string) => ({ prepped: false, detail: `T-1h traffic receipt ${why}: ${path}` });
  if (!r || typeof r !== 'object' || r.schema !== TRAFFIC_PREP_SCHEMA) return fail('schema mismatch');
  if (r.version !== version) return fail(`for ${String(r.version)}, not ${version}`);
  if (!Number.isFinite(time(r.appliedAt))) return fail('not applied');
  if (r.restoredAt) return fail('void (restored)');
  if (!Number.isFinite(time(r.validUntil)) || at.now.getTime() > time(r.validUntil)) return fail('expired');
  if (at.cutAt !== null && time(r.cutAt) !== Date.parse(at.cutAt)) return fail(`cutAt ${String(r.cutAt)} ≠ schedule ${at.cutAt}`);
  return { prepped: true, detail: `traffic prepped at ${String(r.appliedAt)}` };
}

/** SSH hosts of the run's gate pool; local members have no host to reach. */
export function poolHosts(spec: unknown): string[] {
  if (typeof spec !== 'string' || !spec.trim()) return [];
  return [...new Set(parsePodPool(spec).flatMap((m) => m.sshHost ? [m.sshHost] : []))];
}

export function defaultCountdownProbes(root: string, input: Record<string, unknown>): CountdownProbes {
  return {
    trafficPrep: (version, at) => readTrafficPrepMarker(trafficPrepMarkerPath(root, version), version, at),
    hostReachable: (host) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) return false;
      // Source: RFC §A1b T-10 host check + .rules/30-harness/testing-gates.md — a bounded SSH probe fails closed on timeout.
      const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true'], { stdio: 'ignore', timeout: 10_000 });
      return !r.error && r.status === 0;
    },
    credentials: () => {
      // Same resolution order as npm-publish-node; only presence and size are read — never the value.
      const candidates = typeof input.npmTokenFile === 'string' ? [input.npmTokenFile]
        : [join(effectiveInstanceRoot(), 'secrets', 'npm-token'), join(prodInstanceRoot(), 'secrets', 'npm-token')];
      const npmTokenFile = candidates.some((p) => { try { return statSync(p).size > 0; } catch { return false; } });
      const gh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 15_000 });
      return { npmTokenFile, ghAuth: !gh.error && gh.status === 0 };
    },
  };
}

export function countdownReceiptPath(root: string, version: string): string {
  return join(root, 'release', version, 'countdown.json');
}

export function writeCountdownReceipt(path: string, receipt: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
