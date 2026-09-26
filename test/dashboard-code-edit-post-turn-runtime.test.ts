import { describe, expect, test } from 'bun:test';

import { runDashboardCodeEditPostTurn } from '../src/dashboard/code-edit-post-turn-runtime.js';

describe('runDashboardCodeEditPostTurn', () => {
  test('renders source delta summary and closes diff/undo trackers', async () => {
    const events: string[] = [];

    await runDashboardCodeEditPostTurn({
      pushChatLine: (line) => { events.push(`line:${line}`); },
      setChatScrollBottom: () => { events.push('scroll'); },
      importCodeEdit: async () => ({
        getSourceDeltaManager: () => ({
          endTurn: () => ({ id: 'turn-1' }),
        }),
        renderSourceDeltaTurnSummary: () => ['summary-1', 'summary-2'],
        getTurnDiffTracker: () => ({
          endTurn: () => { events.push('diff-end'); },
        }),
      }),
      importUndoTurn: async () => ({
        endTurn: () => { events.push('undo-end'); },
      }),
    });

    expect(events).toEqual([
      'line:summary-1',
      'line:summary-2',
      'scroll',
      'diff-end',
      'undo-end',
    ]);
  });

  test('swallows bootstrap failures', async () => {
    await expect(runDashboardCodeEditPostTurn({
      pushChatLine: () => {},
      setChatScrollBottom: () => {},
      importCodeEdit: async () => {
        throw new Error('boom');
      },
      importUndoTurn: async () => {
        throw new Error('boom');
      },
    })).resolves.toBeUndefined();
  });
});
