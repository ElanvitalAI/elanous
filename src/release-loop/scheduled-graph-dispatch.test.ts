import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchScheduledGraph } from './scheduled-graph-dispatch.js';

test('synthetic live dispatch emits red on invalid times and claims due creation once', async () => {
  const events: string[] = [];
  const base = { mode: 'live' as const, version: '0.3.38', now: new Date('2026-11-27T09:00Z'), hasRun: false,
    claimPath: join(mkdtempSync(join(tmpdir(), 'graph-dispatch-')), 'claims.sqlite'),
    red: async (_v: string, r: string) => { events.push(`red:${r}`); },
    create: async () => { events.push('create'); } };
  const schedule = { version: base.version, rehearsalAt: '2026-11-27T08:00Z', cutAt: '2026-11-27T09:00Z', publishAt: '2026-11-27T10:00Z' };
  expect(await dispatchScheduledGraph({ ...base, schedule: { ...schedule, publishAt: undefined } })).toBe('red');
  expect(events[0]).toContain('publishAt');
  expect(await dispatchScheduledGraph({ ...base, schedule })).toBe('done');
  expect(await dispatchScheduledGraph({ ...base, schedule })).toBe('already-claimed');
  expect(events.filter(x => x === 'create')).toHaveLength(1);
});
