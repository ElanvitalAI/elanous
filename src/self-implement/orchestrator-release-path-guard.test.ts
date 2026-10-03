import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { releasePathHold, releasePrFilePaths } from '../self-dev/release-path-guard.js';

const passingReview = {
  verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'clean', reviewed: true,
  diffTruncated: false, diffShownChars: 10, diffTotalChars: 10, diffOmittedFiles: 0,
};

describe('opened PR release-path hold', () => {
  test.each([
    'scripts/release-loop/publish.ts',
    'graphs/release/check.yaml',
    'src/release-loop/manifest.ts',
  ])('%s forces OP approval and annotates the opened PR', async (path) => {
    const old = debug.log;
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    let merges = 0;
    const labels: string[] = [];
    const comments: string[] = [];
    const openedLabels: string[][] = [];
    const openedDrafts: boolean[] = [];
    try {
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        events.push({ category, event, data });
      }) as typeof debug.log;
      const result = await runSelfImplement({
        feature: 'release guard', autoMerge: true, autoReview: true,
        seams: seams({
          reviewDiff: async () => passingReview,
          openPr: async ({ labels: initial, draft }) => { openedLabels.push(initial ?? []); openedDrafts.push(draft ?? false); return { url: 'https://pr/7', number: 7 }; },
          readPrFiles: async () => ['src/ordinary.ts', path],
          addPrLabel: async ({ label }) => { labels.push(label); },
          postPrComment: async ({ body }) => { comments.push(body); },
          mergePr: async () => { merges++; return { merged: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(result.mergeReason).toBe('release-path-hold');
      expect(result.detail).toContain(path);
      expect(merges).toBe(0);
      expect(openedLabels[0]).not.toContain('auto-review');
      expect(openedDrafts).toEqual([false]);
      expect(labels).toEqual(['elanous:release-path']);
      expect(comments).toContain(`OP approval required: automatic merge held because this PR changes ${path}.`);
      expect(events).toContainEqual(expect.objectContaining({ category: 'self-dev.merge', event: 'release-path-hold', data: expect.objectContaining({ path }) }));
    } finally {
      (debug as { log: typeof debug.log }).log = old;
    }
  });

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/check.yaml', 'src/release-loop/manifest.ts'])(
    'rename from %s to an ordinary location forces OP approval', async (path) => {
      const labels: string[] = [];
      const comments: string[] = [];
      let merges = 0;
      const result = await runSelfImplement({ feature: 'rename release file', autoMerge: true,
        seams: seams({ reviewDiff: async () => passingReview,
          readPrFiles: async () => releasePrFilePaths([[{ filename: 'src/ordinary.ts', status: 'renamed', previous_filename: path }]]),
          addPrLabel: async ({ label }) => { labels.push(label); },
          postPrComment: async ({ body }) => { comments.push(body); },
          mergePr: async () => { merges++; return { merged: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(result.mergeReason).toBe('release-path-hold');
      expect(merges).toBe(0);
      expect(labels).toEqual(['elanous:release-path']);
      expect(comments).toContain(`OP approval required: automatic merge held because this PR changes ${path}.`);
    },
  );

  test('unprotected PR preserves automatic merge; a similar prefix is not protected', async () => {
    let merges = 0;
    let labels = 0;
    let initialDraft: boolean | undefined;
    const comments: string[] = [];
    expect(releasePathHold(['src/release-notes/change.ts', 'scripts/release-loop-extra/thing.ts'])).toBeUndefined();
    const result = await runSelfImplement({
      feature: 'ordinary PR', autoMerge: true,
      seams: seams({
        reviewDiff: async () => passingReview,
        openPr: async ({ draft }) => { initialDraft = draft; return { url: 'https://pr/7', number: 7 }; },
        readPrFiles: async () => ['src/ordinary.ts'],
        addPrLabel: async () => { labels++; },
        postPrComment: async ({ body }) => { comments.push(body); },
        mergePr: async () => { merges++; return { merged: true }; },
      }),
    });
    expect(result.stage).toBe('merged');
    expect(initialDraft).toBe(false);
    expect(merges).toBe(1);
    expect(labels).toBe(0);
    expect(comments.some((comment) => comment.includes('OP approval required: automatic merge held'))).toBe(false);
  });

  test('unprotected auto-review PR opts in only after file inspection', async () => {
    const order: string[] = [];
    const result = await runSelfImplement({ feature: 'auto-review ordinary PR', autoMerge: true, autoReview: true,
      seams: seams({ reviewDiff: async () => passingReview,
        openPr: async ({ labels }) => { expect(labels).not.toContain('auto-review'); order.push('open'); return { url: 'https://pr/7', number: 7 }; },
        readPrFiles: async () => { order.push('inspect'); return ['src/ordinary.ts']; },
        addPrLabel: async ({ label }) => { expect(label).toBe('auto-review'); order.push('label'); },
        mergePr: async () => { order.push('merge'); return { merged: true }; },
      }),
    });
    expect(result.stage).toBe('merged');
    expect(order).toEqual(['open', 'inspect', 'label', 'merge']);
  });

  test('release-path annotation is independent of the launch auto-merge flag', async () => {
    const labels: string[] = [];
    const comments: string[] = [];
    const result = await runSelfImplement({ feature: 'manual release PR', autoMerge: false,
      seams: seams({
        readPrFiles: async () => ['graphs/release/prepare.yaml'],
        addPrLabel: async ({ label }) => { labels.push(label); },
        postPrComment: async ({ body }) => { comments.push(body); },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(result.mergeReason).toBe('release-path-hold');
    expect(labels).toEqual(['elanous:release-path']);
    expect(comments).toContain('OP approval required: automatic merge held because this PR changes graphs/release/prepare.yaml.');
  });

  test('protected PR stays held even if adding its label fails; comment still posts', async () => {
    const comments: string[] = [];
    let merges = 0;
    const result = await runSelfImplement({ feature: 'release label unavailable', autoMerge: true,
      seams: seams({ reviewDiff: async () => passingReview,
        readPrFiles: async () => ['src/release-loop/release-note.ts'],
        addPrLabel: async () => { throw new Error('label rejected'); },
        postPrComment: async ({ body }) => { comments.push(body); },
        mergePr: async () => { merges++; return { merged: true }; },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(merges).toBe(0);
    expect(comments).toContain('OP approval required: automatic merge held because this PR changes src/release-loop/release-note.ts.');
  });

  test('PR file-list lookup failure fails closed before merge', async () => {
    let merges = 0;
    const result = await runSelfImplement({
      feature: 'unknown PR files', autoMerge: true,
      seams: seams({
        reviewDiff: async () => passingReview,
        readPrFiles: async () => { throw new Error('files unavailable'); },
        mergePr: async () => { merges++; return { merged: true }; },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(result.mergeReason).toBe('release-path-inspection-failed');
    expect(merges).toBe(0);
  });
});
