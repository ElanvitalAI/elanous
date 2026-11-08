/** Data-driven PWA host recovery recipes. The caller owns SSH probes and the production PWA node invocation. */
export interface PwaHostHealRecipe {
  readonly id: string;
  readonly signatures: readonly RegExp[];
  readonly needs: readonly ('bun' | 'chrome' | 'repository' | 'load' | 'capacity')[];
}

export const PWA_HOST_HEAL_KNOWHOW: readonly PwaHostHealRecipe[] = [
  { id: 'pwa-host-environment-v1', signatures: [
    /no-chrome-binary|chrome unavailable|cdp unavailable/i,
    /bun install|lockfile.*frozen|node_modules|cannot find package|err_module_not_found/i,
    /permission denied|eacces|operation not permitted/i,
  ], needs: ['bun', 'chrome', 'repository', 'load', 'capacity'] },
];

export interface PwaHostProbe {
  readonly host: string;
  readonly bun: boolean;
  readonly chrome: boolean;
  readonly repository: boolean;
  readonly loadAverage: number;
  readonly activeRuns: number;
  readonly slots: number;
  readonly detail?: string;
}

export interface PwaHostRunResult {
  readonly exitCode: 0 | 1 | 2;
  readonly output: Record<string, unknown>;
}

export interface PwaHostHealReceipt {
  readonly schema: 'elanous.release.pwa-host-heal.v1';
  readonly runId: string;
  readonly recipe: string;
  readonly failedHost: string;
  readonly initial: Record<string, unknown>;
  readonly candidates: readonly PwaHostProbe[];
  readonly selectedHost?: string;
  readonly outcome: 'recovered' | 'unrecovered' | 'not-applicable';
  readonly retry?: Record<string, unknown>;
}

export function pwaHostHealRecipe(errorText: string): PwaHostHealRecipe | undefined {
  return PWA_HOST_HEAL_KNOWHOW.find((recipe) => recipe.signatures.some((signature) => signature.test(errorText)));
}

export function selectPwaHealHost(probes: readonly PwaHostProbe[], failedHost: string, maxLoadAverage: number,
  needs: readonly PwaHostHealRecipe['needs'][number][] = ['bun', 'chrome', 'repository', 'load', 'capacity']): PwaHostProbe | undefined {
  const satisfies = (probe: PwaHostProbe, need: PwaHostHealRecipe['needs'][number]): boolean => {
    switch (need) {
      case 'bun': return probe.bun;
      case 'chrome': return probe.chrome;
      case 'repository': return probe.repository;
      case 'load': return Number.isFinite(probe.loadAverage) && probe.loadAverage <= maxLoadAverage;
      case 'capacity': return Number.isSafeInteger(probe.activeRuns) && probe.activeRuns >= 0
        && Number.isSafeInteger(probe.slots) && probe.slots > probe.activeRuns;
    }
  };
  return probes.filter((probe) => probe.host !== failedHost && needs.every((need) => satisfies(probe, need)))
    .sort((a, b) => a.loadAverage - b.loadAverage || a.activeRuns / a.slots - b.activeRuns / b.slots || a.host.localeCompare(b.host))[0];
}

/** Reruns the production PWA invocation once, in the same release run, and returns its durable node-output receipt. */
export async function healPwaHostFailure(input: {
  readonly runId: string;
  readonly failedHost: string;
  readonly initial: PwaHostRunResult;
  readonly probe: (host: string, slots: number) => Promise<PwaHostProbe>;
  readonly candidates: Readonly<Record<string, number>>;
  readonly maxLoadAverage: number;
  readonly run: (host: string) => Promise<PwaHostRunResult>;
}): Promise<{ result: PwaHostRunResult; receipt: PwaHostHealReceipt }> {
  if (!input.runId.trim()) throw new Error('PWA host healing requires the active release runId');
  const errorText = String(input.initial.output.error ?? '');
  const recipe = input.initial.exitCode === 2 ? pwaHostHealRecipe(errorText) : undefined;
  if (!recipe) return { result: input.initial, receipt: { schema: 'elanous.release.pwa-host-heal.v1', runId: input.runId,
    recipe: 'none', failedHost: input.failedHost, initial: input.initial.output, candidates: [], outcome: 'not-applicable' } };
  const probes = await Promise.all(Object.entries(input.candidates).filter(([host]) => host !== input.failedHost)
    .map(([host, slots]) => input.probe(host, slots)));
  const selected = selectPwaHealHost(probes, input.failedHost, input.maxLoadAverage, recipe.needs);
  if (!selected) {
    const receipt: PwaHostHealReceipt = { schema: 'elanous.release.pwa-host-heal.v1', runId: input.runId,
      recipe: recipe.id, failedHost: input.failedHost, initial: input.initial.output, candidates: probes, outcome: 'unrecovered' };
    return { result: { exitCode: input.initial.exitCode, output: { ...input.initial.output, hostHeal: receipt } }, receipt };
  }
  const retry = await input.run(selected.host);
  const receipt: PwaHostHealReceipt = { schema: 'elanous.release.pwa-host-heal.v1', runId: input.runId,
    recipe: recipe.id, failedHost: input.failedHost, initial: input.initial.output, candidates: probes, selectedHost: selected.host,
    outcome: retry.exitCode === 0 ? 'recovered' : 'unrecovered', retry: retry.output };
  return { result: { exitCode: retry.exitCode, output: { ...retry.output, hostHeal: receipt } }, receipt };
}
