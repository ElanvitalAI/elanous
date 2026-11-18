import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runSchedule } from './schedule-cli.js';

test('ACK SLA schedule spec registers the five-minute one-shot through schedule CRUD', async () => {
  const calls: Record<string, unknown>[] = [];
  await runSchedule('create', { from: resolve(import.meta.dir, '../../docs/conductor/SEAT-MAIL-ACK-SCHEDULE.md'), json: true }, async args => {
    calls.push(args); return { created: true };
  }, () => {});
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ action: 'create', cron: '*/5 * * * *', command: 'bun bin/elanous.mjs msg overdue --after 15 --stage ack --mark --notify', yes: true });
});
