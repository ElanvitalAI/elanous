// SUBSCRIPTION-EXHAUST-REROUTE — runtime wiring of the `self review` action: the real commander action must hand
//   `runSelfReviewCliCommand` a `roleFallbackModel` seam that answers GLM on OpenRouter when a key exists, else nothing.
//   (Seam-only unit tests in self-review-cli.test.ts would still pass if index.ts dropped the seam.)
import { afterEach, expect, spyOn, test } from 'bun:test';
import { program } from '../index.js';
import * as cli from './self-review-cli.js';
import * as config from '../config.js';

const restore: Array<() => void> = [];
afterEach(() => { for (const r of restore.splice(0)) r(); });

test('self review action wires roleFallbackModel: OR key → glm-5.3 · no key → undefined', async () => {
  const seen: Array<cli.SelfReviewCliDeps> = [];
  const run = spyOn(cli, 'runSelfReviewCliCommand').mockImplementation((async (_prs: string[], _opts: unknown, deps: cli.SelfReviewCliDeps) => {
    seen.push(deps);
    return { results: [] };
  }) as never);
  restore.push(() => run.mockRestore());
  const key = spyOn(config, 'getOpenRouterApiKey').mockReturnValue('fixture-openrouter-key');
  restore.push(() => key.mockRestore());
  await program.parseAsync(['node', 'elanous', 'self', 'review', '1', '--intent', 'wiring probe']);
  expect(seen).toHaveLength(1);
  expect(typeof seen[0]!.roleFallbackModel).toBe('function');
  expect(seen[0]!.roleFallbackModel!()).toBe(cli.ROLE_REVIEWER_FALLBACK_MODEL);
  key.mockReturnValue(undefined);
  expect(seen[0]!.roleFallbackModel!()).toBeUndefined();
}, 60_000);
