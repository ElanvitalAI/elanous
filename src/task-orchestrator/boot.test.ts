import { describe, expect, test } from 'bun:test';
import { wireTox } from './boot.js';
import { getToxRuntimeDeps } from './runtime-deps.js';
import { TaskStore } from './store.js';
import { inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { migrateJobToTrigger } from '../domains/schedule-migrate.js';
import type { WorkflowEntry } from '../workflow-runtime/types.js';

describe('wireTox workflow daemon runtime getter', () => {
  test('returns null until the late-bound daemon exists, then returns the live daemon', () => {
    let daemon: { registerWorkflow: (entry: unknown) => void } | null = null;
    const handle = wireTox({
      getWorkflowDaemon: () => daemon,
      startFeedbackLoop: false, startRetryPolicy: false, tox: { loop: { enabled: false } },
    });
    try {
      expect(getToxRuntimeDeps().getWorkflowDaemon?.()).toBeNull();
      daemon = { registerWorkflow: () => {} };
      expect(getToxRuntimeDeps().getWorkflowDaemon?.()).toBe(daemon);
    } finally { handle.dispose(); }
    expect(getToxRuntimeDeps().getWorkflowDaemon?.()).toBeNull();
  });

  test('live daemon reached through boot getter registers a migrated schedule immediately', () => {
    const registered: WorkflowEntry[] = [];
    const daemon = { registerWorkflow: (entry: WorkflowEntry) => { registered.push(entry); } };
    const handle = wireTox({
      getWorkflowDaemon: () => daemon,
      startFeedbackLoop: false, startRetryPolicy: false, tox: { loop: { enabled: false } },
    });
    const scheduleDb = openSchedulesDb(':memory:');
    const store = new TaskStore({ path: ':memory:' });
    try {
      inventoryCrontab(scheduleDb, { crontab: '0 8 * * * cd /r && bun scripts/watch.ts' });
      const id = listSchedules(scheduleDb)[0]!.id;
      const live = getToxRuntimeDeps().getWorkflowDaemon?.() as typeof daemon | null;
      const result = migrateJobToTrigger({
        scheduleDb, store,
        ...(live ? { registerWorkflow: entry => live.registerWorkflow(entry) } : {}),
      }, id);
      expect(result.registered).toBe(true);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.definition.name).toBe(result.workflowName);
    } finally { store.close(); scheduleDb.close(); handle.dispose(); }
  });

  test('standalone boot without workflow daemon preserves null getter', () => {
    const handle = wireTox({ startFeedbackLoop: false, startRetryPolicy: false, tox: { loop: { enabled: false } } });
    try { expect(getToxRuntimeDeps().getWorkflowDaemon?.()).toBeNull(); }
    finally { handle.dispose(); }
  });
});
