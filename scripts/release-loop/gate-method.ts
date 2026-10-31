import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type ReleaseGateExecutor = 'pod' | 'host';
export interface ReleaseGateRehearsal {
  version: string;
  outcome: string;
  executor?: string | null;
  commit?: string;
}

export interface ReleaseOpsPolicy {
  schemaVersion: 1;
  gate: {
    default: { executor: ReleaseGateExecutor; poolSource: 'config.release.loop.gatePodPool'; imagePin: 'cut-commit' };
    rehearsalDecisions: Array<{
      id: string;
      when: { outcome: string; executor?: string };
      executor: ReleaseGateExecutor;
      poolSource: 'config.release.loop.gatePodPool';
      imagePin: 'cut-commit';
    }>;
  };
  knownInterferences: Array<{
    id: string;
    observedVersion: string;
    issue: string;
    workaround: { executor: ReleaseGateExecutor; expiresAfterVersion: string; clearCondition: string };
  }>;
}

export interface ReleaseGateMethodDecision {
  executor: ReleaseGateExecutor;
  pool: string;
  imagePin: 'cut-commit';
  decision: string;
  rehearsalVersion: string | null;
  expiredWorkarounds: string[];
}

const DEFAULT_RELEASE_OPS_POLICY = join(import.meta.dir, '../../packs/release-ops/policy.yaml');
const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function compareReleaseVersions(a: string, b: string): number {
  if (!RELEASE_VERSION.test(a) || !RELEASE_VERSION.test(b)) throw new Error(`release policy version must be x.y.z: ${a} / ${b}`);
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (aa[i]! < bb[i]!) return -1;
    if (aa[i]! > bb[i]!) return 1;
  }
  return 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read and validate the checked-in release policy. A workaround without both a clear condition and expiry is invalid. */
export function readReleaseOpsPolicy(path = DEFAULT_RELEASE_OPS_POLICY): ReleaseOpsPolicy {
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (!object(raw) || raw.schemaVersion !== 1 || !object(raw.gate) || !object(raw.gate.default)
    || !Array.isArray(raw.gate.rehearsalDecisions) || !Array.isArray(raw.knownInterferences)) {
    throw new Error('release ops policy has an unsupported or incomplete schema');
  }
  const validExecutor = (value: unknown): value is ReleaseGateExecutor => value === 'pod' || value === 'host';
  const checkMethod = (method: unknown): boolean =>
    object(method) && validExecutor(method.executor) && method.poolSource === 'config.release.loop.gatePodPool' && method.imagePin === 'cut-commit';
  if (!checkMethod(raw.gate.default)) throw new Error('release ops policy default must pin executor, config pool, and cut commit image');
  const defaultMethod = raw.gate.default as ReleaseOpsPolicy['gate']['default'];
  const rehearsalDecisions: ReleaseOpsPolicy['gate']['rehearsalDecisions'] = [];
  for (const decision of raw.gate.rehearsalDecisions) {
    if (!object(decision) || typeof decision.id !== 'string' || !decision.id.trim() || !object(decision.when)
      || typeof decision.when.outcome !== 'string' || (decision.when.executor !== undefined && !validExecutor(decision.when.executor))
      || !checkMethod(decision)) throw new Error('release ops policy has an invalid rehearsal decision');
    const valid = decision as ReleaseOpsPolicy['gate']['rehearsalDecisions'][number];
    rehearsalDecisions.push({ id: valid.id, when: { outcome: valid.when.outcome,
      ...(valid.when.executor !== undefined ? { executor: valid.when.executor } : {}) },
    executor: valid.executor, poolSource: valid.poolSource, imagePin: valid.imagePin });
  }
  const knownInterferences: ReleaseOpsPolicy['knownInterferences'] = [];
  for (const item of raw.knownInterferences) {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.observedVersion !== 'string'
      || !RELEASE_VERSION.test(item.observedVersion) || typeof item.issue !== 'string' || !item.issue.trim() || !object(item.workaround)) {
      throw new Error('release ops policy has an invalid known interference');
    }
    const workaround = item.workaround;
    if (!validExecutor(workaround.executor) || typeof workaround.expiresAfterVersion !== 'string'
      || !RELEASE_VERSION.test(workaround.expiresAfterVersion) || typeof workaround.clearCondition !== 'string' || !workaround.clearCondition.trim()) {
      throw new Error('workaround must declare expiresAfterVersion and clearCondition');
    }
    knownInterferences.push({ id: item.id, observedVersion: item.observedVersion, issue: item.issue,
      workaround: { executor: workaround.executor, expiresAfterVersion: workaround.expiresAfterVersion, clearCondition: workaround.clearCondition } });
  }
  return { schemaVersion: 1, gate: { default: defaultMethod, rehearsalDecisions }, knownInterferences };
}

/** Pick the executor from the release policy; the rehearsal can select a declared row but never create a new override. */
export function selectReleaseGateMethod(input: { policy: ReleaseOpsPolicy; targetVersion: string; configuredPool?: string; rehearsal?: ReleaseGateRehearsal }): ReleaseGateMethodDecision {
  const { policy, targetVersion, configuredPool, rehearsal } = input;
  compareReleaseVersions(targetVersion, targetVersion);
  const method = rehearsal
    ? policy.gate.rehearsalDecisions.find((row) => row.when.outcome === rehearsal.outcome
      && (row.when.executor === undefined || row.when.executor === rehearsal.executor))
    : undefined;
  const selected = method ?? policy.gate.default;
  const expiredWorkarounds = policy.knownInterferences.filter((item) =>
    compareReleaseVersions(targetVersion, item.workaround.expiresAfterVersion) > 0).map((item) => item.id);
  return { executor: selected.executor, pool: selected.executor === 'pod' && typeof configuredPool === 'string' ? configuredPool.trim() : '',
    imagePin: selected.imagePin, decision: method?.id ?? 'policy-default', rehearsalVersion: rehearsal?.version ?? null, expiredWorkarounds };
}

/** Read the latest hard rehearsal for a published version; malformed or mismatched stamps are not evidence. */
export function readReleaseGateRehearsal(ledgerRoot: string, version: string): ReleaseGateRehearsal | undefined {
  const dir = join(ledgerRoot, 'release', version, 'rehearsal');
  let files: string[];
  try { files = readdirSync(dir).filter((file) => /^hard-[a-z0-9-]+\.json$/.test(file)); }
  catch { return undefined; }
  const stamps: Array<{ endedAt: number; rehearsal?: ReleaseGateRehearsal }> = [];
  for (const file of files) {
    const path = join(dir, file);
    const step = file.slice(0, -'.json'.length);
    try {
      const stamp = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const gate = stamp.hardGate as Record<string, unknown> | undefined;
      const endedAt = typeof stamp.endedAt === 'string' ? Date.parse(stamp.endedAt) : NaN;
      if (stamp.version !== version || stamp.step !== step || !Number.isFinite(endedAt)) return undefined;
      const usable = ['ok', 'regression', 'error'].includes(String(gate?.outcome))
        && typeof gate?.commit === 'string' && /^[a-f0-9]{40}$/i.test(gate.commit)
        && (gate.executor === 'pod' || gate.executor === 'host');
      stamps.push({ endedAt, ...(usable ? { rehearsal: { version, outcome: String(gate!.outcome), executor: gate!.executor as string, commit: gate!.commit as string } } : {}) });
    } catch { return undefined; }
  }
  if (!stamps.length) return undefined;
  stamps.sort((a, b) => b.endedAt - a.endedAt);
  if (stamps.length > 1 && stamps[0]!.endedAt === stamps[1]!.endedAt) return undefined;
  return stamps[0]!.rehearsal;
}

/** File seconds are recorded on the outer testsuite of each JUnit file, not its nested describe suites. */
export function readJunitFileSeconds(xml: string): Map<string, number> {
  const secondsByFile = new Map<string, number>();
  const entities: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  let depth = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) break;
      cursor = end + 2;
      continue;
    }
    let quote = '';
    let brackets = 0;
    let end = start + 1;
    for (; end < xml.length; end++) {
      const char = xml[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '[' && xml.startsWith('<!', start)) brackets++;
      else if (char === ']' && brackets) brackets--;
      else if (char === '>' && !brackets) break;
    }
    if (end === xml.length) break;
    cursor = end + 1;
    const tag = xml.slice(start + 1, end);
    const suite = /^(\/?)testsuite(?=[\s/]|$)/.exec(tag);
    if (!suite) continue;
    if (suite[1]) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      const file = /\bfile="([^"]+)"/.exec(tag)?.[1];
      const rawTime = /\btime="([^"]+)"/.exec(tag)?.[1];
      if (file && rawTime !== undefined) {
        const seconds = Number(rawTime);
        if (Number.isFinite(seconds) && seconds >= 0) {
          const path = file.replace(/&(?:amp|quot|apos|lt|gt);/g, (entity) => entities[entity]!);
          secondsByFile.set(path, Math.max(secondsByFile.get(path) ?? 0, seconds));
        }
      }
    }
    if (!/\/\s*$/.test(tag)) depth++;
  }
  return secondsByFile;
}
