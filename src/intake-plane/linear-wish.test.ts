import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalTaskEvent } from '../connectors/types.js';
import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';
import { scanLinearWishes, suggestLinearWishes } from './linear-wish.js';

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

test('suggest scans unlabelled open issues, matches title or body, and returns only identifier, 40-character title and one-word reason', async () => {
  const cases = [
    { ...issue('UX-1'), title: '가'.repeat(41) + ' 만들어 줘', body: '' },
    { ...issue('UX-2'), title: '정상 제목', body: '이렇게 해 줘' },
    { ...issue('UX-3'), title: '만들어', body: '' },
    { ...issue('UX-4'), title: '정상', body: '이 기능 원해요' },
    { ...issue('UX-5'), title: '있으면 좋겠다', body: '' },
    { ...issue('UX-6'), title: '버그 수리', body: '오류가 납니다' },
  ];
  const args: unknown[] = [];
  const result = await suggestLinearWishes({ teamKey: 'UX', deps: {
    getApiKey: async () => 'secret', fetchIssues: async (options) => { args.push(options); return cases; },
  } });
  expect(args).toEqual([{ apiKey: 'secret', teamKey: 'UX', excludeLabel: 'wish' }]);
  expect(result).toEqual([
    { identifier: 'UX-1', title: '가'.repeat(40), reason: '제작' },
    { identifier: 'UX-2', title: '정상 제목', reason: '요청' },
    { identifier: 'UX-3', title: '만들어', reason: '제작' },
    { identifier: 'UX-4', title: '정상', reason: '희망' },
    { identifier: 'UX-5', title: '있으면 좋겠다', reason: '희망' },
  ]);
});

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
      source: 'linear', ref: 'UX-1', replyTo: { surface: 'linear', issueId: 'UX-1' }, text: 'Wish UX-1\n\nBody UX-1\n\nhttps://linear.app/example/UX-1',
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
    expect(store.listCards().find(card => card.goalId === 'wish:linear:UX-4')?.sections.map(section => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
    append.mockRestore();
    expect(await scanLinearWishes({ teamKey: 'UX', label: 'custom', store, deps })).toEqual({ added: 0, duplicate: 2, failed: 0 });
    expect(JSON.parse(store.listCards().find(card => card.goalId === 'wish:linear:UX-3')!.sections[0]!.content)).toMatchObject({ recovered: true });
  } finally { append.mockRestore(); store.close(); }
});
