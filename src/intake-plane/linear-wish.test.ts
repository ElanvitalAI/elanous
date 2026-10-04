import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalTaskEvent } from '../connectors/types.js';
import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';
import { scanLinearWishes } from './linear-wish.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linear-wish-'));
  roots.push(root);
  return new CardStore(root);
}

function issue(identifier: string): ExternalTaskEvent {
  return {
    provider: 'linear', eventId: identifier, kind: 'updated', ref: identifier,
    identifier, title: `Wish ${identifier}`, body: `Body ${identifier}`,
    url: `https://linear.app/example/${identifier}`, priority: null, occurredAt: '2026-10-04T00:00:00Z',
  };
}

test('two matching issues produce two cards with full text; a repeat counts duplicates and logs only counts', async () => {
  const store = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const fetched: Array<{ apiKey: string; teamKey: string; labelOrPrefix?: string }> = [];
  const deps = {
    getApiKey: async () => 'private-linear-key',
    fetchIssues: async (args: { apiKey: string; teamKey: string; labelOrPrefix?: string }) => {
      fetched.push(args);
      return [issue('UX-1'), issue('UX-2')];
    },
  };
  try {
    expect(await scanLinearWishes({ teamKey: 'UX', store, deps })).toEqual({ added: 2, duplicate: 0, failed: 0 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:linear:UX-1', 'wish:linear:UX-2']);
    const card = store.listCards().find(card => card.goalId === 'wish:linear:UX-1')!;
    expect(JSON.parse(card.sections[0]!.content)).toMatchObject({
      source: 'linear', ref: 'UX-1', text: 'Wish UX-1\n\nBody UX-1\n\nhttps://linear.app/example/UX-1',
    });
    expect(await scanLinearWishes({ teamKey: 'UX', store, deps })).toEqual({ added: 0, duplicate: 2, failed: 0 });
    expect(store.listCards()).toHaveLength(2);
    expect(fetched).toEqual([
      { apiKey: 'private-linear-key', teamKey: 'UX', labelOrPrefix: 'wish' },
      { apiKey: 'private-linear-key', teamKey: 'UX', labelOrPrefix: 'wish' },
    ]);
    expect(log).toHaveBeenCalledWith('intake.linear-wish', 'scanned', { teamKey: 'UX', label: 'wish', added: 2, duplicate: 0, failed: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Wish UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Body UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('https://linear.app/example/UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-linear-key');
  } finally { log.mockRestore(); store.close(); }
});

test('an issue that throws does not prevent the remaining issue from becoming a card', async () => {
  const store = fixture();
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('write failed'); });
  const deps = { getApiKey: async () => 'secret', fetchIssues: async () => [issue('UX-3'), issue('UX-4')] };
  try {
    expect(await scanLinearWishes({ teamKey: 'UX', label: 'custom', store, deps })).toEqual({ added: 1, duplicate: 0, failed: 1 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:linear:UX-3', 'wish:linear:UX-4']);
    expect(store.listCards().find(card => card.goalId === 'wish:linear:UX-4')?.sections).toHaveLength(1);
    append.mockRestore();
    expect(await scanLinearWishes({ teamKey: 'UX', label: 'custom', store, deps })).toEqual({ added: 0, duplicate: 2, failed: 0 });
    expect(JSON.parse(store.listCards().find(card => card.goalId === 'wish:linear:UX-3')!.sections[0]!.content)).toMatchObject({ recovered: true });
  } finally { append.mockRestore(); store.close(); }
});
