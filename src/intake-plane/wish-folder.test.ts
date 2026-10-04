import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, foldSections } from '../task-cards/card-store.js';
import { scanWishFolder } from './wish-folder.js';
import { wishBenchmarkLedgerPath } from './wish-benchmark-ledger.js';

const roots: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Wish markdown files become one card each, repeat skips, changed mtime updates intake only; notes remain untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-folder-'));
  roots.push(root);
  const dir = join(root, 'vault', '00. Inbox', '00. Wish');
  const child = join(dir, 'nested');
  mkdirSync(child, { recursive: true });
  const first = join(dir, 'first.md');
  const second = join(child, 'second.md');
  writeFileSync(first, 'intro\n# First wish\n# Later heading\n');
  writeFileSync(second, 'No heading here');
  writeFileSync(join(dir, 'README.md'), '# README');
  writeFileSync(join(dir, '.hidden.md'), '# Hidden');
  writeFileSync(join(child, '.hidden.md'), '# Hidden nested');
  mkdirSync(join(child, 'deeper'));
  writeFileSync(join(child, 'deeper', 'ignored.md'), '# Too deep');
  const before = [first, second].map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  const store = new CardStore(join(root, 'state'));
  try {
    expect(scanWishFolder({ dir, store })).toEqual({ added: 2, updated: 0, skipped: 0 });
    const cards = store.listCards();
    expect(cards).toHaveLength(2);
    const ledger = wishBenchmarkLedgerPath(store.root);
    const samples = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(samples).toHaveLength(2);
    expect(samples).toContainEqual({ id: expect.any(String), at: expect.any(String), surface: 'wish', text: before[0]!.content.toString(), chars: Array.from(before[0]!.content.toString()).length, op_cells: [], note: 'wish-card' });
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    expect(statSync(join(store.root, 'bench')).mode & 0o777).toBe(0o700);
    expect(cards.map(card => card.goalId).sort()).toEqual(['wish:first.md', 'wish:nested/second.md']);
    const card = cards.find(item => item.goalId === 'wish:first.md')!;
    expect(card.title).toBe('First wish');
    expect(JSON.parse(foldSections(card).intake!.content)).toEqual({
      source: 'wish', path: 'first.md', mtime: before[0]!.mtime, title: 'First wish', text: before[0]!.content.toString(),
    });
    expect(cards.find(item => item.goalId === 'wish:nested/second.md')?.title).toBe('second');
    expect(scanWishFolder({ dir, store })).toEqual({ added: 0, updated: 0, skipped: 2 });
    expect(store.listCards()).toEqual(cards);
    for (const [index, path] of [first, second].entries()) {
      expect(readFileSync(path)).toEqual(before[index]!.content);
      expect(statSync(path).mtimeMs).toBe(before[index]!.mtime);
    }
    const changed = new Date(before[0]!.mtime + 10000);
    utimesSync(first, changed, changed);
    expect(scanWishFolder({ dir, store })).toEqual({ added: 0, updated: 1, skipped: 1 });
    const revised = store.getCard(card.id)!;
    expect(revised.id).toBe(card.id);
    expect(revised.title).toBe(card.title);
    expect(revised.sections).toHaveLength(2);
    expect(JSON.parse(foldSections(revised).intake!.content)).toEqual({
      source: 'wish', path: 'first.md', mtime: statSync(first).mtimeMs, title: 'First wish', text: before[0]!.content.toString(),
    });
    expect(store.listCards()).toHaveLength(2);
    utimesSync(first, new Date(before[0]!.mtime), new Date(before[0]!.mtime));
    expect(scanWishFolder({ dir, store })).toEqual({ added: 0, updated: 1, skipped: 1 });
    expect(store.getCard(card.id)?.sections).toHaveLength(3);
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(first)).toEqual(before[0]!.content);
    expect(statSync(first).mtimeMs).toBe(Math.trunc(before[0]!.mtime));
    expect(readFileSync(second)).toEqual(before[1]!.content);
    expect(statSync(second).mtimeMs).toBe(before[1]!.mtime);
  } finally {
    store.close();
  }
});

test('missing Wish directory reports the attempted path without creating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-missing-'));
  roots.push(root);
  const dir = join(root, 'missing');
  const store = new CardStore(join(root, 'state'));
  try {
    expect(() => scanWishFolder({ dir, store })).toThrow(`Wish 폴더를 찾지 못했습니다: ${dir}`);
    expect(store.listCards()).toEqual([]);
  } finally {
    store.close();
  }
});
