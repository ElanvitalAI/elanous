import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
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
