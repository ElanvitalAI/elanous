import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot, treeDerivedRootFor } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { buildUserConfig, getUserConfig, type UserConfig } from '../user-config.js';
import { resolveCodexQuotaPolicy } from '../oauth/codex-quota-policy.js';

/** Key-order-insensitive JSON so equal per-account caps written in another order do not warn. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v);
}

function readOperationalLaunchConfig(path: string): UserConfig | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) {
    // Only a missing file (fresh install, CI, isolated fixtures) means «no operational policy»; permission or I/O errors refuse.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`launch policy: 운영 config 를 읽을 수 없다 — ${path}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`launch policy: 운영 config 를 읽을 수 없다 — ${path}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`launch policy: 운영 config 형식이 잘못됐다 — ${path}`);
  return buildUserConfig(path);
}

/** Launch policy belongs to the host, not to the materialized config in a derived worktree.
 * Explicit test/config universes remain isolated; this only applies to tree-derived launches. */
export function harnessLaunchPolicyConfig(options: {
  derived?: UserConfig;
  operationalRoot?: string;
  derivedRoot?: string;
  warn?: (line: string) => void;
  /** Reads the operational config at `path`; injected by tests so they never touch the host's real config. */
  readOperational?: (path: string) => UserConfig | null;
} = {}): UserConfig {
  const derived = options.derived ?? getUserConfig();
  const operationalRoot = options.operationalRoot ?? prodInstanceRoot();
  const derivedRoot = options.derivedRoot ?? effectiveInstanceRoot();
  const isDerived = options.derivedRoot !== undefined
    ? derivedRoot !== operationalRoot
    : derivedRoot !== operationalRoot && !getElanousConfigDirOverride() && (
      process.env.ELANOUS_STATE_DIR_SOURCE === 'derived'
      || derivedRoot === treeDerivedRootFor(process.cwd())
    );
  if (!isDerived) return derived;
  const path = join(operationalRoot, 'config.json');
  const operational = (options.readOperational ?? readOperationalLaunchConfig)(path);
  if (!operational) {
    (options.warn ?? console.error)(`⚠️ launch policy: 운영 config 가 없다 (${path}) — 이 우주의 정책으로 발사`);
    return derived;
  }
  const policy = (config: UserConfig) => ({
    quota: resolveCodexQuotaPolicy(config.llm).policy,
    accountLimits: config.llm?.codexAccountRotationThresholdPercentByAccount,
    fallbackChain: config.llm?.fallbackChain,
    childLlm: config.tools?.selfImplement?.childLlm,
    budgetGate: config.harness?.budgetGate,
    podPool: config.harness?.podPool ?? config.pod?.pool,
    grokApiKeyOptIn: config.harness?.pod?.grokApiKeyOptIn === true,
  });
  const actual = policy(derived);
  const expected = policy(operational);
  if (derived.llm?.codexQuotaPolicy === undefined && derived.llm?.codexCreditsAllowed === undefined
    || stableJson(actual) !== stableJson(expected)) {
    (options.warn ?? console.error)('⚠️ launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다 — 운영 정책으로 발사');
  }
  return operational;
}

export type HarnessSubstrate = 'local' | 'pod';
export interface ResolvedHarnessSubstrate {
  substrate: HarnessSubstrate;
  pool: string | null;
  source: 'flag' | 'config' | 'default';
}

/** Only inspect the current context when no explicit pool is available. Never turn a failed Pod selection into local. */
export function resolveHarnessSubstrate({ flag, config, env, currentContext = () => {
  const result = spawnSync('kubectl', ['config', 'current-context'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout?.trim() : undefined;
} }: {
  flag?: { substrate?: HarnessSubstrate; podPool?: string };
  config?: Pick<UserConfig, 'harness' | 'pod'>;
  env?: NodeJS.ProcessEnv;
  currentContext?: () => string | undefined;
}): ResolvedHarnessSubstrate {
  const substrate = flag?.substrate ?? config?.harness?.substrate ?? 'local';
  if (substrate !== 'local' && substrate !== 'pod') throw new Error('harness.substrate: local 또는 pod 만 허용한다');
  const source = flag?.substrate ? 'flag' : config?.harness?.substrate ? 'config' : 'default';
  if (substrate === 'local') return { substrate, pool: null, source };
  const pool = flag?.podPool?.trim() || env?.ELANOUS_POD_POOL?.trim() || config?.harness?.podPool?.trim() || config?.pod?.pool?.trim() || currentContext()?.trim();
  if (!pool) throw new Error('harness.substrate=pod: Pod 풀 또는 현재 컨텍스트에 닿지 못했다 — 풀을 설정하거나 `--substrate local` 로 명시하라');
  return { substrate, pool, source };
}

/** `dev --ask` → Pod dispatch input. Carries `--no-auto-merge` (commander: autoMerge === false) like the
 *  other Pod entrance, so a remote run never merges when the caller asked it not to. */
export function devAskPodDispatchInput(opts: { base?: string; autoMerge?: boolean }, goalFile: string, podPool: string): {
  entrance: 'cli-harness-ask'; input: string; podPool: string; base?: string; autoMerge?: false;
} {
  return {
    entrance: 'cli-harness-ask', input: goalFile, podPool,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.autoMerge === false ? { autoMerge: false as const } : {}),
  };
}
