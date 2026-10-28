import { createHash } from 'node:crypto';
import type { UserConfig } from '../../user-config.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type SnapshotSource = 'host-effective' | 'runtime';
type Allowlist = { readonly [key: string]: true | Allowlist };

const ROLE = { provider: true, tier: true, model: true, effort: true } as const;
/** Adding a setting requires naming its path here. Arbitrary host config never reaches a Pod. */
const POD_CONFIG_ALLOWLIST = {
  llm: {
    provider: true, model: true, streamIdleTimeoutMs: true,
    codexAccountRotation: true, codexQuotaPolicy: true, codexCreditReserve: true,
    grokWeeklyCapPct: true, fallbackChain: true,
    zaiCodingPlan: { overage: true, maxConcurrent: true },
    openrouter: { fallbackModel: true },
  },
  roleLlm: { implement: ROLE, review: ROLE, research: ROLE, planning: ROLE, audit: ROLE, classify: ROLE },
  harness: { worktreeAddTimeoutSec: true, knowhowChildInjection: true, authorGrade: true,
    exposeGate: true, difficultyPlacement: true, substrate: true, authorOnPod: true },
  tools: { selfImplement: { childInstanceMode: true, observeOnly: true, fabricDecompose: true,
    autoOpenPr: true } },
  loops: { orchestrator: { enabled: true, mode: true, trafficMode: true, idleRequest: true,
    finishGate: true, handToTaskAgent: true, degradationSignal: true, maxDelegatePerTick: true,
    dispatch: { podTarget: true, localLane: true } } },
} as const satisfies Allowlist;

function scalar(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(scalar);
    return items.every((item) => item !== undefined) ? items as JsonValue[] : undefined;
  }
  return undefined;
}

function allowed(value: unknown, schema: true | Allowlist): JsonValue | undefined {
  if (schema === true) return scalar(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: JsonObject = {};
  for (const key of Object.keys(schema).sort()) {
    const item = allowed((value as Record<string, unknown>)[key], schema[key]!);
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function objectAt(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonical(value[key]!);
      if (typeof item !== 'object' || item === null || Array.isArray(item) || Object.keys(item).length > 0) out[key] = item;
    }
    return out;
  }
  return value;
}

function sourcesOf(value: JsonValue, path: string, sources: Record<string, SnapshotSource>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) sourcesOf(value[key]!, path ? `${path}.${key}` : key, sources);
  } else sources[path] = 'host-effective';
}

/** A Pod receives only these effective, non-credential settings. The envelope is evidence;
 * configJson is the plain config consumed by the child. Neither contains host credentials. */
export function buildPodConfigSnapshot(config: UserConfig, runtime: {
  steps: readonly string[];
  overage: 'stop' | 'balance' | 'openrouter';
  worktreeAddTimeoutSec: number;
}): {
  version: 1;
  keys: JsonObject & { llm: JsonObject; harness: JsonObject };
  sources: Record<string, SnapshotSource>;
  hash: string;
  envelopeJson: string;
  configJson: string;
  keyCount: number;
} {
  const host = config as unknown as Record<string, unknown>;
  const selected = objectAt(allowed(host, POD_CONFIG_ALLOWLIST));
  const tools = objectAt(selected.tools);
  const loops = objectAt(selected.loops);
  const keys = {
    harness: objectAt(selected.harness),
    llm: objectAt(selected.llm),
    loops: { orchestrator: objectAt(loops.orchestrator) },
    roleLlm: objectAt(selected.roleLlm),
    tools: { selfImplement: objectAt(tools.selfImplement) },
  };
  const rawDefault = objectAt(host.tools).selfImplement;
  const preference = objectAt(rawDefault).podChildDefault;
  if (preference === 'off' || preference === false) keys.tools.selfImplement.podChildDefault = 'off';
  else if (preference && typeof preference === 'object' && !Array.isArray(preference)) {
    const raw = preference as Record<string, unknown>;
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (provider) keys.tools.selfImplement.podChildDefault = { provider, ...(model ? { model } : {}) };
  }
  keys.llm.fallbackChain = [...runtime.steps];
  const zai = objectAt(keys.llm.zaiCodingPlan);
  zai.overage = runtime.overage;
  keys.llm.zaiCodingPlan = zai;
  keys.harness.worktreeAddTimeoutSec = runtime.worktreeAddTimeoutSec;
  const canonicalKeys = canonical(keys) as JsonObject & { llm: JsonObject; harness: JsonObject };
  const sources: Record<string, SnapshotSource> = {};
  sourcesOf(canonicalKeys, '', sources);
  sources['llm.fallbackChain'] = 'runtime';
  sources['llm.zaiCodingPlan.overage'] = 'runtime';
  sources['harness.worktreeAddTimeoutSec'] = 'runtime';
  const version = 1 as const;
  const body = { version, keys: canonicalKeys, sources };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, hash, envelopeJson: JSON.stringify({ ...body, hash }), configJson: JSON.stringify(canonicalKeys), keyCount: Object.keys(sources).length };
}
