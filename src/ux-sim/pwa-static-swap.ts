import { simulatePwaFormalUpdateSwapFailure } from '../../scripts/release-loop/pwa-formal-update.js';

export interface PwaStaticSwapWorldObservation {
  readonly device: 'pwa-static-swap-world';
  readonly verdict: 'pass';
  readonly activeGeneration: string;
  readonly servedHtml: string;
  readonly restartCalled: false;
  readonly observed: false;
  readonly expected: 'failed swap leaves previous generation serving';
}

/** Run the production publisher and release-loop decision path with only pointer-rename failure injected. */
export async function runPwaStaticSwapWorld(): Promise<PwaStaticSwapWorldObservation> {
  const result = await simulatePwaFormalUpdateSwapFailure();
  const restartCalled = result.restartCalled;
  const observed = result.observed;
  if (restartCalled || observed) throw new Error('failed PWA static swap restarted Nexus or observed the client');
  return {
    device: 'pwa-static-swap-world',
    verdict: 'pass',
    activeGeneration: result.activeGeneration,
    servedHtml: result.activeHtml,
    restartCalled,
    observed,
    expected: 'failed swap leaves previous generation serving',
  };
}
