/** Opt-in SI warm entry; the ordinary Pod spawn remains the default. */
import { podSelfImplementSpawn, type PodSpawnOptions } from './self-implement-pod.js';
import type { SiWarmChildAttempt } from './self-implement-pod.js';
import type { SelfImplementJobDone, SelfImplementJobSpawn } from './self-implement.js';
import type { SiWarmAcquireResult } from './pod-si-warm-provider.js';

export interface SiWarmEntryAdapter {
  acquire(input: Parameters<SelfImplementJobSpawn>[0], base: PodSpawnOptions): Promise<SiWarmAcquireResult>;
  postprocess(input: Parameters<SelfImplementJobSpawn>[0], result: SelfImplementJobDone,
    attempt: SiWarmChildAttempt, base: PodSpawnOptions): Promise<SelfImplementJobDone>;
}

export async function podSpawnWithSiWarm(base: PodSpawnOptions,
  env: NodeJS.ProcessEnv = process.env, adapter?: SiWarmEntryAdapter) {
  let configEnabled = false;
  try { configEnabled = base.warmReuseConfig?.()?.ta === true; }
  catch { /* An unreadable config must not open the warm transport. */ }
  if (env.ELANOUS_SI_WARM_REUSE !== '1' && !configEnabled) return podSelfImplementSpawn(base);
  const hooks = adapter ?? await import('./pod-si-warm-host.js').then(({ acquireSiWarmChild, postprocessSiWarmChild }) => ({
    acquire: acquireSiWarmChild,
    postprocess: postprocessSiWarmChild,
  }));
  return podSelfImplementSpawn({ ...base,
    siWarmAttempt: async input => {
      const result = await hooks.acquire(input, base);
      switch (result.status) {
        case 'acquired': return result.attempt;
        case 'no-entry': return null;
        case 'uncertain':
          // An uncertain lease may already be running this request. Never launch a fresh Job
          // until its fenced worker is reconciled, or the same goal can execute twice.
          throw new Error(`si-v1 lease state uncertain: ${result.reason}`);
        default: {
          const exhaustive: never = result;
          void exhaustive;
          throw new Error('si-v1 lease acquisition returned an unsupported state');
        }
      }
    },
    siWarmHostPostprocess: (result, attempt, input) =>
      hooks.postprocess(input, result, attempt, base),
  });
}
