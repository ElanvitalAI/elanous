import { redactSecretText } from '../../debug/log.js';

/** The work that owns a Pod. Job metadata is the current view; pod.provenance events retain history. */
export interface PodProvenance {
  actorKind: string;
  actor: string;
  kind: string;
  run: string;
  phase: string;
  requestedAt: string;
  character?: string;
  launchHost?: string;
  entrance?: string;
  graphNode?: string;
  cell?: string;
  version?: string;
  commit?: string;
  shard?: string;
  reason?: string;
  /** Parent runId / lease id — whose child this Pod is. Label keeps the first 8 characters like run/commit. */
  parent?: string;
  pool?: string;
  cpuReq?: string;
  memReq?: string;
  warmReused?: boolean;
  argv?: string;
}

const required = ['actorKind', 'actor', 'kind', 'run', 'phase', 'requestedAt'] as const;
const names: Record<keyof PodProvenance, string> = {
  actorKind: 'actor-kind', actor: 'actor', kind: 'kind', run: 'run', phase: 'phase', requestedAt: 'requested-at',
  character: 'character', launchHost: 'launch-host', entrance: 'entrance', graphNode: 'graph-node', cell: 'cell',
  version: 'version', commit: 'commit', shard: 'shard', reason: 'reason', parent: 'parent',
  pool: 'pool', cpuReq: 'cpu-req', memReq: 'mem-req',
  warmReused: 'warm-reused', argv: 'argv',
};

/** Every child env name the set can carry (`ELANOUS_POD_<KEY>`). */
export const POD_PROVENANCE_ENV_NAMES: readonly string[] = Object.values(names)
  .map((name) => `ELANOUS_POD_${name.toUpperCase().replaceAll('-', '_')}`);

const labelValue = (value: string): string => {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return cleaned.slice(0, 63).replace(/[^a-z0-9]+$/g, '') || 'unknown';
};

export interface PodProvenanceMetadata {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  env: Array<{ name: string; value: string }>;
  missing: string[];
}

/** A gate reports missing identity as `unknown`; every other launch refuses it before kubectl apply. */
export function podProvenanceMetadata(input: Partial<PodProvenance> | undefined, gate = false): PodProvenanceMetadata {
  const missing = required.filter((key) => typeof input?.[key] !== 'string' || !input?.[key]?.trim());
  if (missing.length && !gate) throw new Error(`pod provenance missing: ${missing.map((key) => names[key]).join(', ')}`);
  const values: Record<string, string> = {};
  for (const [key, name] of Object.entries(names) as Array<[keyof PodProvenance, string]>) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = String(raw).trim();
    if (!value) continue;
    // Metadata and env are observable by many users. Never carry a raw secret through an identity field.
    const redacted = redactSecretText(value);
    if (redacted !== value && key !== 'reason' && key !== 'argv') throw new Error(`pod provenance secret in ${name}`);
    values[name] = redacted;
  }
  for (const key of missing) values[names[key]] = 'unknown';
  // The launch reason is observable even when the caller cannot supply one.
  values.reason ??= 'unknown';
  const labels: Record<string, string> = {};
  const annotations: Record<string, string> = {};
  const env: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(values)) {
    const label = name === 'run' || name === 'commit' || name === 'parent' ? value.slice(0, 8) : value;
    if (name !== 'reason' && name !== 'argv') labels[`elanous.ai/${name}`] = labelValue(label);
    annotations[`elanous.ai/${name}`] = value;
    env.push({ name: `ELANOUS_POD_${name.toUpperCase().replaceAll('-', '_')}`, value });
  }
  return { labels, annotations, env, missing: missing.map((key) => names[key]) };
}
