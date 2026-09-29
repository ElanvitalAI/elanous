import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { CardStore, cardEventsPath, cardIndexPath, taskCardsDir, foldSections } from './card-store.js';

const roots: string[] = [];
function fixture(): { store: CardStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'task-cards-'));
  roots.push(root);
  return { root, store: new CardStore(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('paths are scoped to the chosen state root; SQLite is WAL with a 5000 ms busy timeout', () => {
  const { root, store } = fixture();
  expect(taskCardsDir(root)).toBe(join(root, 'task-cards'));
  expect(cardIndexPath(root)).toBe(join(root, 'task-cards', 'index.db'));
  expect(taskCardsDir()).toBe(join(elanousStateRoot(), 'task-cards'));
  expect(() => cardEventsPath('../escape', root)).toThrow('Invalid card id');
  const db = new Database(cardIndexPath(root));
  expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  db.close();
  // busy_timeout is connection-local, so inspect the store connection rather than the second connection.
  expect((store as unknown as { db: Database }).db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
  store.close();
});

test('goalId creation deduplicates and survives reopening with only one create event', () => {
  const { root, store } = fixture();
  const first = store.createCard({ goalId: 'goal-a', title: 'Original' });
  expect(store.createCard({ goalId: 'goal-a', title: 'Changed' })).toEqual(first);
  expect(store.createCard({ goalId: 'goal-b', title: 'Other' }).id).not.toBe(first.id);
  expect(readFileSync(cardEventsPath(first.id, root), 'utf8').trim().split('\n')).toHaveLength(1);
  store.close();
  const reopened = new CardStore(root);
  expect(reopened.getCard(first.id)).toEqual(first);
  expect(reopened.createCard({ goalId: 'goal-a', title: 'After reopen' })).toEqual(first);
  expect(reopened.listCards()).toHaveLength(2);
  reopened.close();
});

test('section ownership, key deduplication and one-write content; closed card is immutable', () => {
  const { root, store } = fixture();
  const card = store.createCard({ goalId: 'g', title: 'Task' });
  const input = { key: 'landing', owner: 'landing-loop', content: 'Result' };
  const written = store.appendSection(card.id, input);
  expect(written.sections).toMatchObject([input]);
  expect(store.appendSection(card.id, input)).toEqual(written);
  expect(() => store.appendSection(card.id, { ...input, owner: 'implement' })).toThrow('belongs to landing-loop');
  expect(() => store.appendSection(card.id, { ...input, content: 'Replacement' })).toThrow('already written');
  expect(store.listCards({ open: true })).toHaveLength(1);
  expect(store.closeCard(card.id).status).toBe('closed');
  expect(store.closeCard(card.id).status).toBe('closed');
  expect(store.listCards({ open: true })).toEqual([]);
  expect(() => store.appendSection(card.id, { key: 'landing:later', owner: 'landing-loop', content: 'x' })).toThrow('closed');
  expect(readFileSync(cardEventsPath(card.id, root), 'utf8').trim().split('\n')).toHaveLength(3);
  store.close();
});

test('create event survives an index write failure; restart and goalId retry do not append twice', () => {
  const { root, store } = fixture();
  const db = (store as unknown as { db: Database }).db;
  db.exec("CREATE TRIGGER reject_create BEFORE INSERT ON card_offsets BEGIN SELECT RAISE(ABORT, 'index create failed'); END");
  expect(() => store.createCard({ goalId: 'crash-goal', title: 'Original' })).toThrow('index create failed');
  const files = readdirSync(taskCardsDir(root)).filter((name) => name.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  const id = files[0]!.slice(0, -6);
  expect((db.query('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(0);
  db.exec('DROP TRIGGER reject_create');
  store.close();
  const reopened = new CardStore(root);
  const card = reopened.createCard({ goalId: 'crash-goal', title: 'Different' });
  expect(card).toMatchObject({ id, title: 'Original', goalId: 'crash-goal' });
  expect(reopened.listCards()).toEqual([card]);
  expect((reopened as unknown as { db: Database }).db.query('SELECT byte_offset FROM card_offsets WHERE card_id = ?').get(id))
    .toEqual({ byte_offset: statSync(cardEventsPath(id, root)).size });
  expect(readFileSync(cardEventsPath(id, root), 'utf8').trim().split('\n')).toHaveLength(1);
  reopened.close();
});

test('section and close events survive index failures; reopening and retries keep ownership and one-write', () => {
  const { root, store } = fixture();
  const card = store.createCard({ goalId: 'recover', title: 'Task' });
  const db = (store as unknown as { db: Database }).db;
  const section = { key: 'run', owner: 'executor', content: 'evidence' };
  db.exec("CREATE TRIGGER reject_section BEFORE UPDATE ON card_offsets BEGIN SELECT RAISE(ABORT, 'index section failed'); END");
  expect(() => store.appendSection(card.id, section)).toThrow('index section failed');
  expect((db.query('SELECT count(*) AS n FROM card_sections').get() as { n: number }).n).toBe(0);
  db.exec('DROP TRIGGER reject_section');
  store.close();
  const reopened = new CardStore(root);
  const recovered = reopened.appendSection(card.id, section);
  expect(recovered.sections).toMatchObject([section]);
  expect(() => reopened.appendSection(card.id, { ...section, owner: 'other' })).toThrow('belongs to executor');
  expect(() => reopened.appendSection(card.id, { ...section, content: 'overwrite' })).toThrow('already written');
  const reopenedDb = (reopened as unknown as { db: Database }).db;
  reopenedDb.exec("CREATE TRIGGER reject_close BEFORE UPDATE ON card_offsets BEGIN SELECT RAISE(ABORT, 'index close failed'); END");
  expect(() => reopened.closeCard(card.id)).toThrow('index close failed');
  expect((reopenedDb.query('SELECT status FROM cards WHERE id = ?').get(card.id) as { status: string }).status).toBe('open');
  reopenedDb.exec('DROP TRIGGER reject_close');
  reopened.close();
  const again = new CardStore(root);
  expect(again.closeCard(card.id).status).toBe('closed');
  expect(again.listCards({ open: true })).toEqual([]);
  expect(again.getCard(card.id)?.sections).toEqual(recovered.sections);
  expect((again as unknown as { db: Database }).db.query('SELECT byte_offset FROM card_offsets WHERE card_id = ?').get(card.id))
    .toEqual({ byte_offset: statSync(cardEventsPath(card.id, root)).size });
  expect(readFileSync(cardEventsPath(card.id, root), 'utf8').trim().split('\n')).toHaveLength(3);
  again.close();
});

test('unknown card and invalid inputs cannot create orphan event files', () => {
  const { root, store } = fixture();
  expect(store.getCard('missing')).toBeNull();
  expect(() => store.appendSection('missing', { key: 'run', owner: 'executor', content: 'c' })).toThrow('not found');
  expect(() => store.createCard({ goalId: '', title: 'bad' })).toThrow('required');
  expect(() => store.createCard({ goalId: 'ok', title: '' })).toThrow('required');
  expect(() => store.appendSection('missing', { key: '', owner: 'executor', content: 'c' })).toThrow('required');
  expect(store.listCards()).toEqual([]);
  expect(existsSync(cardEventsPath('missing', root))).toBe(false);
  expect(readFileSync(cardIndexPath(root)).length).toBeGreaterThan(0);
  store.close();
});

// 🅢 09-29 — RFC §3 contract the first cut missed: sections take many keys over time, owners come from the table,
// secret-shaped text never reaches the card, and readers fold to the latest entry per section.
test('a section takes many keys over time, owners follow the RFC table, secrets are redacted, fold keeps the latest', () => {
  const store = new CardStore(mkdtempSync(join(tmpdir(), 'card-rfc-')));
  const card = store.createCard({ goalId: 'g-rfc', title: 'RFC contract' });
  store.appendSection(card.id, { key: 'workspace:1', owner: 'executor', content: 'files: a.ts' });
  store.appendSection(card.id, { key: 'workspace:2', owner: 'executor', content: 'files: a.ts b.ts' });
  expect(() => store.appendSection(card.id, { key: 'workspace:3', owner: 'steward', content: 'x' })).toThrow('belongs to executor');
  expect(() => store.appendSection(card.id, { key: 'nonsense', owner: 'executor', content: 'x' })).toThrow('Unknown card section');
  store.appendSection(card.id, { key: 'incidents:oom-1', owner: 'landing-loop', content: 'pod oom' });
  store.appendSection(card.id, { key: 'incidents:clone-1', owner: 'executor', content: 'clone EOF' });
  const withSecret = store.appendSection(card.id, { key: 'gates:1', owner: 'execution-loop', content: 'token sk-abcdefghijklmnopqrstuvwxyz0123 used' });
  expect(JSON.stringify(withSecret)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  expect(JSON.stringify(withSecret)).toContain('<redacted>');
  const folded = foldSections(store.getCard(card.id)!);
  expect(folded.workspace!.content).toBe('files: a.ts b.ts');
  expect(folded.incidents!.content).toBe('clone EOF');
  store.close();
});
