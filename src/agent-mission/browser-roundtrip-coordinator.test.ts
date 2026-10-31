import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinateBrowserRoundtrip } from './browser-roundtrip-coordinator.js';
import { dispatchBrowserHand } from '../tool-runtime/browser-hand-runtime.js';
import { createFakeBrowserPage } from '../ux-sim/fake-browser-page.js';
import { createFakeLinearDevice } from '../ux-sim/fake-linear-device.js';

const ISSUE = 'c0ffee00-0000-4000-8000-000000000001';
const source = 'https://ir.example.test/blocked';
const alternate = 'https://archive.example.test/report';
const artifactDirs: string[] = [];
afterEach(() => { for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('browser roundtrip coordinator', () => {
  test('requires a human-selected Linear subtask before touching the browser', async () => {
    let runs = 0;
    const result = await coordinateBrowserRoundtrip({ url: source, target: 'body', armed: true }, {}, async () => {
      runs += 1;
      throw new Error('runner should not be called without human selection');
    });
    expect(runs).toBe(0);
    expect(result.result).toMatchObject({ ok: false, reason: 'human-selection-required' });
  });

  test('preserves an explicit negative selection flag and invalid blank IDs', async () => {
    const seen: unknown[] = [];
    const result = await coordinateBrowserRoundtrip({
      url: source,
      target: 'body',
      armed: true,
      humanSelection: { linearSubtaskId: ISSUE, includeThisToo: false },
      includeThisToo: false,
    }, {}, async args => {
      seen.push(args);
      return { ok: false, output: 'not run' };
    });
    expect(seen).toEqual([expect.objectContaining({ linearSubtaskId: ISSUE, includeThisToo: false })]);
    expect(result.result).toMatchObject({ ok: false, output: 'not run' });

    const invalid = await coordinateBrowserRoundtrip({
      url: source, target: 'body', armed: true, humanSelection: { linearSubtaskId: ' ' },
    }, {}, async () => { throw new Error('runner should not receive a blank ID'); });
    expect(invalid).toMatchObject({ selectedSubtaskId: null, result: { ok: false, reason: 'invalid-input' } });
  });

  test('uses the real BrowserHand safety path for one alternate source, capture, attachment, and explicit selection', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'browser-roundtrip-sim-'));
    artifactDirs.push(artifactDir);
    const browser = createFakeBrowserPage({ pages: { [source]: 'Login required to continue', [alternate]: 'Public article' }, artifactDir });
    const linear = createFakeLinearDevice();

    const result = await coordinateBrowserRoundtrip({
      url: source,
      alternateUrl: alternate,
      target: 'article',
      armed: true,
      persona: 'demo-browser',
      humanSelection: { linearSubtaskId: ISSUE, includeThisToo: true, selection: { tab: 'Public article', text: 'Save this passage' } },
    }, { ...browser.deps, ...linear.deps }, dispatchBrowserHand);

    expect(result).toMatchObject({ scene: 'browser-roundtrip', selectedSubtaskId: ISSUE, sourceUrl: alternate, result: { ok: true, blocked: true, detoured: true, selectionReflected: true } });
    expect(browser.visits).toEqual([alternate]);
    expect(browser.inspections).toEqual([source, alternate]);
    expect(browser.clicks).toEqual([{ url: alternate, target: 'article' }]);
    expect(browser.confirmations).toEqual([{ url: source, target: 'article' }]);
    expect(linear.uploads).toHaveLength(1);
    expect(linear.uploads[0]?.body.toString()).toBe('fake page screenshot');
    expect(linear.attachments).toEqual([{ issueId: ISSUE, title: '브라우저 캡처', url: 'https://linear-sim.invalid/files/1' }]);
    expect(linear.comments).toEqual([{ issueId: ISSUE, body: '이것도 반영: Public article — Save this passage' }]);
  });

  test('keeps an unarmed request closed and makes no Linear calls', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'browser-roundtrip-sim-'));
    artifactDirs.push(artifactDir);
    const browser = createFakeBrowserPage({ pages: { [source]: 'Public article' }, artifactDir });
    const linear = createFakeLinearDevice();
    const result = await coordinateBrowserRoundtrip({
      url: source, target: 'article', armed: false, persona: 'demo-browser',
      humanSelection: { linearSubtaskId: ISSUE },
    }, { ...browser.deps, ...linear.deps }, dispatchBrowserHand);
    expect(result.result).toMatchObject({ ok: false, reason: 'unarmed' });
    expect(browser.inspections).toEqual([]);
    expect(browser.visits).toEqual([]);
    expect(linear.uploads).toEqual([]);
    expect(linear.attachments).toEqual([]);
  });

  test('a human denial stops before inspecting or navigating', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'browser-roundtrip-sim-'));
    artifactDirs.push(artifactDir);
    const browser = createFakeBrowserPage({ pages: { [source]: 'Public article' }, artifactDir, approved: false });
    const linear = createFakeLinearDevice();
    const result = await coordinateBrowserRoundtrip({
      url: source, target: 'article', armed: true, persona: 'demo-browser',
      humanSelection: { linearSubtaskId: ISSUE },
    }, { ...browser.deps, ...linear.deps }, dispatchBrowserHand);
    expect(result.result).toMatchObject({ ok: false, reason: 'human-approval-required' });
    expect(browser.confirmations).toEqual([{ url: source, target: 'article' }]);
    expect(browser.inspections).toEqual([]);
    expect(browser.visits).toEqual([]);
    expect(linear.uploads).toEqual([]);
  });
});
