import { expect, test } from 'bun:test';
import { simBrowserHand } from './browser-hand.js';

const ISSUE_ID = 'c0ffee00-0000-4000-8000-000000000001';

test('BrowserHand production coordinator captures and attaches one real browser-act artifact to the requested subtask', async () => {
  const result = await simBrowserHand('attach');

  expect(result.result).toMatchObject({ ok: true, attachmentId: 'ux-sim-attachment-1', blocked: false, detoured: false });
  expect(result.pageReads).toEqual(['https://ir.example.test/filing']);
  expect(result.browserActions).toEqual(['https://ir.example.test/filing']);
  expect(result.linear.uploads).toEqual([{ filename: 'capture.png', contentType: 'image/png', bytes: 4 }]);
  expect(result.linear.attachments).toEqual([{
    issueId: ISSUE_ID,
    title: '브라우저 캡처',
    url: 'https://uploads.example.test/browser-hand.png',
  }]);
  expect(result.repairNodes).toHaveLength(0);
  expect(result.observedBrowserActionRunIds).toContain(result.runId);
  expect(result.linear.comments).toEqual([]);
});

test('a verified paywall takes one allowed alternate and records the production repair-node branch', async () => {
  const result = await simBrowserHand('paywall-fallback');

  expect(result.pageReads).toEqual([
    'https://ir.example.test/filing',
    'https://archive.example.test/filing',
  ]);
  expect(result.browserActions).toEqual(['https://archive.example.test/filing']);
  expect(result.result).toMatchObject({
    ok: true,
    blocked: true,
    detoured: true,
    repairNode: {
      branch: 'ASIDE-HAND-NODE·BROWSER-ROUNDTRIP-ASIDE',
      outcome: 'detoured',
      graphEvent: { type: 'node-added', kind: 'hand', decider: 'browser-hand' },
    },
  });
  expect(result.repairNodes).toHaveLength(1);
  expect(result.linear.uploads).toEqual([{ filename: 'capture.png', contentType: 'image/png', bytes: 4 }]);
  expect(result.linear.attachments).toEqual([{
    issueId: ISSUE_ID,
    title: '브라우저 캡처',
    url: 'https://uploads.example.test/browser-hand.png',
  }]);
});

test('only an explicit “이것도 반영” selection is reflected on the same Linear subtask', async () => {
  const result = await simBrowserHand('selection-roundtrip');

  expect(result.result).toMatchObject({ ok: true, selectionReflected: true });
  expect(result.linear.attachments[0]?.issueId).toBe(ISSUE_ID);
  expect(result.linear.comments).toEqual([{
    issueId: ISSUE_ID,
    body: '이것도 반영: Q3 filing — Revenue rose 12%',
  }]);
  expect(result.linear.uploads).toEqual([{ filename: 'capture.png', contentType: 'image/png', bytes: 4 }]);
  expect(result.repairNodes).toHaveLength(0);
});
