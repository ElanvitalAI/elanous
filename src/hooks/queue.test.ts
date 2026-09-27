import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookQueue } from './queue.js';

test('durable queue deduplicates provider:eventId across restart and records delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-queue-'));
  try {
    const item = { provider: 'linear' as const, eventId: 'one', task: { eventId: 'one', title: 'Task', external: { provider: 'linear' as const, ref: 'issue' } } };
    const queue = new HookQueue(root);
    expect(queue.enqueue(item)).toBe(true);
    expect(queue.enqueue(item)).toBe(false);
    expect(queue.count()).toBe(1);
    expect(statSync(join(queue.directory, readdirSync(queue.directory)[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(queue.seenPath).mode & 0o777).toBe(0o600);
    const restarted = new HookQueue(root);
    expect(restarted.enqueue(item)).toBe(false);
    expect(restarted.entries()).toEqual([item]);
    restarted.delivered(item, 1_700_000_000_000);
    expect(restarted.count()).toBe(0);
    expect(restarted.lastDelivered()).toBe(new Date(1_700_000_000_000).toISOString());
    expect(statSync(queue.deliveredPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(queue.seenPath, 'utf8')).toContain('linear:one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a published queue file without its seen entry survives restart and remains deduplicated', () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-crash-'));
  try {
    const item = { provider: 'asana' as const, eventId: 'event-1', task: { eventId: 'event-1', title: 'Task', external: { provider: 'asana' as const, ref: 'task-1' } } };
    const queue = new HookQueue(root);
    expect(queue.enqueue(item)).toBe(true);
    writeFileSync(queue.seenPath, '', { mode: 0o600 });
    const restarted = new HookQueue(root);
    expect(restarted.enqueue(item)).toBe(false);
    expect(restarted.entries()).toEqual([item]);
    expect(restarted.count()).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
