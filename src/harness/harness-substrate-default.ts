import { spawnSync } from 'node:child_process';
import type { UserConfig } from '../user-config.js';

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
