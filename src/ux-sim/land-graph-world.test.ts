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
  'hot-file-entry': 'landed · no JUD review',
  'focused-fail': 'refuse baseline-failing-focused',
  'isolation-gate': 'refuse isolation-gate · card TC',
  'test-interference': 'refuse test-interference',
  'shadow-never-merges': 'merges 0 · would-land 1',
  'tc-hold-ignored': 'landed · no class',
  'jud-security-veto-blocks': 'hold · held',
  'stale-base-revert-refused': 'refuse stale-base-revert · landings 0',
  'base-changed-retry-once-lands': 'landed · land calls 2',
  'two-prs-one-slot': 'tick1 1 · tick2 1 · double 0',
  'org-rollback-restores-routing': 'split TC · rollback TC,JUD',
  'swept-raw-exit0-lands': 'landed · no headTestRun counts',
  'swept-raw-exit1-refused': 'refuse baseline-failing-focused',
  'baseline-name-diff-ok-lands': 'landed · nd passed to land',
  'l0-receipt-doc-only-lands': 'landed · lane L0-doc-only',
  'l0-receipt-code-refused': 'refuse no-focused-stage',
  'security4-no-terra-waits': 'wait review-required · card TC',
  'security4-terra-warn-lands': 'landed',
  'security4-terra-fail-waits': 'wait review-required',
  'security4-terra-security-finding': 'refuse security-finding',
  'non-security-terra-fail-lands': 'landed',
  'jud-hold-verdict-file-vetoes': 'hold · held',
};

describe('land-graph-world', () => {
  for (const seed of [1, 7, 42, 1126, 38038]) {
    test(`seed ${seed}: every edge case matches · no invariant violation`, async () => {
      const { results, violations } = await runLandWorld(seed);
      expect(violations).toEqual([]);
      expect(Object.fromEntries(results.map(r => [r.id, r.actual]))).toEqual(EXPECTED);
    });
  }
});
