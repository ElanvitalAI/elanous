import { expect, test } from 'bun:test';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { contextNow } from '../context-bus/context-now.js';
import { emitSessionEvent, type SessionEventInput } from '../context-bus/session-events.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';

const view = (db: ReturnType<typeof openSurfaceEventsDb>) => contextNow({}, {
  version: () => '0.2.0',
  checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
  decisions: () => [], seatEntries: () => [],
  events: since => listCoordEvents({ since }, { db }),
});

test('a fake self-implement run publishes claimed then done in context_now with runId and PR', async () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const publish = (input: SessionEventInput) => { emitSessionEvent(input, { db }); };
    const result = await runSelfImplement({ feature: 'CTX1 lifecycle fixture', autoMerge: false,
      seams: seams({ emitContextEvent: publish }),
    });
    expect(result).toMatchObject({ ok: true, stage: 'pr-opened', prNumber: 7 });
    const events = view(db).events.slice().reverse();
    expect(events.map(event => event.kind)).toEqual(['task-claimed', 'task-done']);
    const refs = listCoordEvents({ since: '2000-01-01T00:00:00.000Z' }, { db });
    expect(refs.map(event => event.refs.ref)).toEqual([
      `runId=${result.runId}`, `runId=${result.runId} PR=#7`,
    ]);
  } finally { db.close(); }
}, 30_000);

test('context journal write errors leave the self-implement result unchanged', async () => {
  const events: SessionEventInput[] = [];
  const options = { feature: 'CTX1 fail-soft fixture', autoMerge: false };
  const baseline = await runSelfImplement({ ...options,
    seams: seams({ emitContextEvent: input => { events.push(input); } }),
  });
  const failed = await runSelfImplement({ ...options,
    seams: seams({ emitContextEvent: () => { throw new Error('journal unavailable'); } }),
  });
  expect(events.map(event => event.kind)).toEqual(['task-claimed', 'task-done']);
  expect({ ok: failed.ok, stage: failed.stage, outcome: failed.outcome, prNumber: failed.prNumber })
    .toEqual({ ok: baseline.ok, stage: baseline.stage, outcome: baseline.outcome, prNumber: baseline.prNumber });
}, 30_000);
