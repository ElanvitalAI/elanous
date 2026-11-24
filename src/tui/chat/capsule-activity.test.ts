import { expect, test } from 'bun:test';
import { CapsuleActivity } from './capsule-activity.js';

test('folds repeated activity, isolates sessions and ignores stale updates', () => {
  const activity = new CapsuleActivity('s1');
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 1, line: 'Build · started' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 2, line: 'Build · #1 Bash' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 3, line: 'Build · #2 Bash' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 4, line: 'Build · #3 Bash' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 4, line: 'Build · #3 Bash' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 'other', kind: 'agent', at: 5, line: 'secret' });
  activity.accept({ type: 'capsule-progress', capsuleId: 'a', sessionId: 's1', kind: 'agent', at: 2, line: 'old' });
  expect(activity.lines()).toEqual(['🤖 Build · Bash ×3']);
  // CAPSULE-FOOTER-ONCE: the finished capsule is handed back once and leaves the running rows.
  expect(activity.accept({ type: 'capsule-done', capsuleId: 'a', sessionId: 's1', kind: 'agent', startedAt: 0, endedAt: 6000, status: 'ok', summary: 'Build · ok · 6s' }))
    .toEqual({ kind: 'agent', icon: '🤖', name: 'Build', status: 'ok', seconds: 6, line: '🤖 Build · ok · 6s' });
  expect(activity.lines()).toEqual([]);
  expect(activity.accept({ type: 'capsule-done', capsuleId: 'a', sessionId: 's1', kind: 'agent', startedAt: 0, endedAt: 6000, status: 'ok', summary: 'Build · ok · 6s' })).toBeNull();
  activity.setSessionId('s2');
  expect(activity.lines()).toEqual([]);
});
