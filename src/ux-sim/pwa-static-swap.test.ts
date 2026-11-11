import { expect, test } from 'bun:test';
import { runPwaStaticSwapWorld } from './pwa-static-swap.js';

test('pwa-static-swap-world preserves the previously served generation when atomic swap fails', async () => {
  const result = await runPwaStaticSwapWorld();
  expect(result).toMatchObject({
    device: 'pwa-static-swap-world',
    verdict: 'pass',
    servedHtml: '<main>previous</main>',
    restartCalled: false,
    observed: false,
    expected: 'failed swap leaves previous generation serving',
  });
  expect(result.activeGeneration).toContain('.pwa-generations/previous');
});
