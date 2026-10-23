/** Opt-in SI warm entry; the ordinary Pod spawn remains the default. */
import { podSelfImplementSpawn, type PodSpawnOptions } from './self-implement-pod.js';

export async function podSpawnWithSiWarm(base: PodSpawnOptions,
  env: NodeJS.ProcessEnv = process.env) {
  if (env.ELANOUS_SI_WARM_REUSE !== '1') return podSelfImplementSpawn(base);
  const { acquireSiWarmChild, postprocessSiWarmChild } = await import('./pod-si-warm-host.js');
  return podSelfImplementSpawn({ ...base,
    siWarmAttempt: async input => {
      const result = await acquireSiWarmChild(input, base);
      return result.status === 'acquired' ? result.attempt : null;
    },
    siWarmHostPostprocess: (result, attempt, input) =>
      postprocessSiWarmChild(input, result, attempt, base),
  });
}
