import { describe, expect, test } from 'bun:test';
import { runLandWorld } from './land-graph-world.js';

// Expected strings are independent literals (rule 11) — the world's own `expected` field is not used as the oracle.
const EXPECTED: Record<string, string> = {
  'clean-land': 'landed · notice 1 · rows 1',
  'head-moves-after-receipt': 'refuse stale-head · card TC',
  'head-moves-during-land': 'not landed · head-moved',
  'same-file-race-2-slots': 'landed 1 · other main-moved-overlap',
  'slot-cap': 'landed 2 of 3 · then 1',
  'main-moves-mid-land': 'refuse merge-conflict · card TC · landings 1',
  'draft-flip-mid-run': 'not landed',
  'closed-mid-run': 'not landed',
  'jud-hold-mid-land': 'not landed · held',
  'jud-hold-before': 'hold · card TC',
  'terra-security-late': 'refuse security-finding',
  'receipt-missing': 'wait no-receipt',
  'focused-unreadable': 'wait focused-unreadable · card TC',
  'gh-rate-limit': 'no decision · error recorded',
  'duplicate-tick-lock': 'locked · no land',
  'crash-after-merge-resume': 'merges 1 · notices 1',
  'stacked-pr': 'refuse base-not-main',
  'revert-pr': 'landed',
  'doc-only': 'landed (L0 doc-only)',
  'code-pr-empty-focused': 'refuse no-focused-stage',
  'hot-file-entry': 'refuse review-required · card TC',
  'focused-fail': 'refuse baseline-failing-focused',
  'isolation-gate': 'refuse isolation-gate · card TC',
  'test-interference': 'refuse test-interference',
  'shadow-never-merges': 'merges 0 · would-land 1',
  'tc-hold-ignored': 'landed · no class',
  'jud-security-veto-blocks': 'hold · held',
  'stale-base-revert-refused': 'refuse stale-base-revert · landings 0',
  'base-changed-retry-once-lands': 'landed · land calls 2',
  'two-prs-one-slot': 'tick1 1 · tick2 1 · double 0',
  'org-rollback-restores-routing': 'split TC · rollback JUD',
};

describe('land-graph-world', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}: every edge case matches · no invariant violation`, async () => {
      const { results, violations } = await runLandWorld(seed);
      expect(violations).toEqual([]);
      expect(Object.fromEntries(results.map(r => [r.id, r.actual]))).toEqual(EXPECTED);
    });
  }
});
