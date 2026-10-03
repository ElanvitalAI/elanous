import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCardCommand } from './card-cli.js';
import { CardStore } from './card-store.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'card-cli-'));
  roots.push(root);
  const store = new CardStore(root);
  const output: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCardCommand(program, {
    createStore: () => new CardStore(root),
    write: (text) => { output.push(text); },
  });
  const run = (...args: string[]) => program.parse(['node', 'elanous', 'card', ...args]);
  return { store, output, run };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('card list --json emits an empty array, not a wrapper or human text', () => {
  const { store, output, run } = fixture();
  run('list', '--json');
  expect(output).toEqual(['[]\n']);
  store.close();
});

test('card show renders stored sections, and --json returns the complete stored card', () => {
  const { store, output, run } = fixture();
  const created = store.createCard({ goalId: 'goal-1', title: 'Implement parser' });
  const card = store.appendSection(created.id, { key: 'landing', owner: 'landing-loop', content: 'Passed\nchecks' });
  run('show', card.id);
  expect(output.join('')).toContain(`ID: ${card.id}`);
  expect(output.join('')).toContain('Goal: goal-1');
  expect(output.join('')).toContain('Status: open');
  expect(output.join('')).toContain('landing (landing-loop,');
  expect(output.join('')).toContain('Passed\nchecks');
  output.length = 0;
  run('show', card.id, '--json');
  expect(output).toEqual([`${JSON.stringify(card)}\n`]);
  store.close();
});

test('card list --open filters closed cards in both text and JSON; unfiltered list preserves both', () => {
  const { store, output, run } = fixture();
  const opened = store.createCard({ goalId: 'open-goal', title: 'Open title' });
  const closed = store.closeCard(store.createCard({ goalId: 'closed-goal', title: 'Closed title' }).id);
  run('list', '--open', '--json');
  expect(JSON.parse(output.join(''))).toEqual([opened]);
  output.length = 0;
  run('list', '--json');
  expect(JSON.parse(output.join(''))).toEqual(store.listCards());
  expect(JSON.parse(output.join('')).map((card: { id: string }) => card.id)).toContain(closed.id);
  output.length = 0;
  run('list', '--open');
  expect(output.join('')).toContain(`Open title\t${opened.goalId}`);
  expect(output.join('')).not.toContain(closed.id);
  output.length = 0;
  run('list');
  expect(output.join('')).toContain(closed.id);
  store.close();
});

test('missing card fails rather than displaying an invented card', () => {
  const { store, output, run } = fixture();
  expect(() => run('show', 'missing', '--json')).toThrow('Card not found: missing');
  expect(output).toEqual([]);
  store.close();
});

test('wish-scan --dir emits counts in text or JSON and makes cards visible to list', () => {
  const { store, output, run } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'card-wish-'));
  roots.push(dir);
  writeFileSync(join(dir, 'sample.md'), '# Wish title\n');
  run('wish-scan', '--dir', dir);
  expect(output).toEqual(['추가 1 · 갱신 0 · 건너뜀 0\n']);
  output.length = 0;
  run('wish-scan', '--dir', dir, '--json');
  expect(output).toEqual(['{"added":0,"updated":0,"skipped":1}\n']);
  output.length = 0;
  run('list', '--json');
  expect(JSON.parse(output.join(''))[0]).toMatchObject({ goalId: 'wish:sample.md', title: 'Wish title' });
  store.close();
});

test('wish-scan defaults to OBSIDIAN_VAULT_ROOT Wish directory; --dir takes precedence', () => {
  const { store, output, run } = fixture();
  const vault = mkdtempSync(join(tmpdir(), 'card-vault-'));
  roots.push(vault);
  const wishDir = join(vault, '00. Inbox', '00. Wish');
  mkdirSync(wishDir, { recursive: true });
  writeFileSync(join(wishDir, 'vault.md'), '# From vault');
  const alternate = join(vault, 'other');
  mkdirSync(alternate);
  writeFileSync(join(alternate, 'other.md'), '# From option');
  const previous = process.env.OBSIDIAN_VAULT_ROOT;
  try {
    process.env.OBSIDIAN_VAULT_ROOT = vault;
    run('wish-scan', '--json');
    expect(JSON.parse(output.pop()!)).toEqual({ added: 1, updated: 0, skipped: 0 });
    run('wish-scan', '--dir', alternate, '--json');
    expect(JSON.parse(output.pop()!)).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:other.md', 'wish:vault.md']);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_ROOT;
    else process.env.OBSIDIAN_VAULT_ROOT = previous;
    store.close();
  }
});

test('wish-scan missing directory prints attempted path and sets exit code 2', () => {
  const { store, output, run } = fixture();
  const missing = join(mkdtempSync(join(tmpdir(), 'card-wish-missing-')), 'missing');
  roots.push(join(missing, '..'));
  const lines: string[] = [];
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
  try {
    run('wish-scan', '--dir', missing);
    expect(lines).toEqual([`Wish 폴더를 찾지 못했습니다: ${missing}\n`]);
    expect(process.exitCode).toBe(2);
    expect(output).toEqual([]);
    expect(store.listCards()).toEqual([]);
  } finally {
    process.stderr.write = original;
    process.exitCode = exitCode ?? 0;
    store.close();
  }
});
