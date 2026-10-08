import { afterAll, afterEach, expect, test } from 'bun:test';
import { setSelfImplementSoftStopSpaceObserver } from './index.js';
import { selfImplementRuntime, _setSelfImplementSeamsFactoryForTesting, _setSelfImplementGoalAuthorForTesting } from '../self-implement/self-implement-runtime.js';
import { _setAutoOpenPrConfigReaderForTesting } from '../self-implement/auto-open-pr.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = mkdtempSync(join(tmpdir(), 'esc-stop-export-'));
const goalFile = join(directory, 'goal.md');
writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n- GoalType: implement\n');

afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

afterEach(() => {
  setSelfImplementSoftStopSpaceObserver(null);
  _setSelfImplementSeamsFactoryForTesting(null);
  _setSelfImplementGoalAuthorForTesting(null);
  _setAutoOpenPrConfigReaderForTesting();
});

test('public runtime export routes the TUI call id to the created harness stop space only', async () => {
  const seen: Array<[string, string]> = [];
  setSelfImplementSoftStopSpaceObserver((callId, spaceId) => { seen.push([callId, spaceId]); });
  _setSelfImplementGoalAuthorForTesting(async () => ({ path: goalFile }));
  _setAutoOpenPrConfigReaderForTesting(() => false);
  _setSelfImplementSeamsFactoryForTesting((options) => ({
    async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
    async implement() { return { ok: true, summary: 'implemented' }; },
    async gate() { return { passed: true }; },
    async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    ...(options.onSoftStopSpaceReady ? { onSoftStopSpaceReady: options.onSoftStopSpaceReady } : {}),
  }));
  const result = await selfImplementRuntime.run({ feature: 'stop' }, { surface: 'tui', toolCallId: 'call-1', signal: new AbortController().signal });
  expect(result.stage).toBeDefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]![0]).toBe('call-1');
  expect(seen[0]![1]).toBeTruthy();
});
