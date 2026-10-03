import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export type CardStatus = 'open' | 'closed';
export interface CardSection {
  key: string;
  owner: string;
  content: string;
  createdAt: string;
}
export interface TaskCard {
  id: string;
  goalId: string;
  title: string;
  status: CardStatus;
  createdAt: string;
  sections: CardSection[];
}
export interface CreateCardInput {
  goalId: string;
  title: string;
}
export interface AppendSectionInput {
  key: string;
  owner: string;
  content: string;
}

type CardEvent =
  | { type: 'created'; id: string; goalId: string; title: string; createdAt: string }
  | { type: 'section'; key: string; owner: string; content: string; createdAt: string }
  | { type: 'closed'; createdAt: string };

/** RFC §3 (내부 문서 `RFC-execution-and-landing-loop-agents-parallel-first-2026-09-29`) — each card section has one owner.
 *  A key is `<section>` or `<section>:<idempotency key>`: the same section can be appended many times over a
 *  task's life (e.g. workspace diff updates), and the same full key is written once. `incidents` is open to any loop. */
export const SECTION_OWNERS: Readonly<Record<string, string | null>> = {
  intake: 'steward', triage: 'steward', prfaq: 'steward', manual: 'steward', launch: 'steward', outcome: 'steward', hitl: 'steward',
  gates: 'execution-loop', relations: 'execution-loop', memory: 'execution-loop',
  workspace: 'executor', run: 'executor',
  landing: 'landing-loop', release: 'release-loop', 'test-diet': 'test-diet',
  incidents: null,
};

export function sectionOf(key: string): string {
  const at = key.indexOf(':');
  return at < 0 ? key : key.slice(0, at);
}

const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, /\b[A-Za-z0-9_-]{40,}\b/g];

/** Secret-shaped substrings never reach the card file or the index (RFC §3 · goal invariant). */
export function redactSecrets(text: string): string {
  return SECRET_SHAPES.reduce((out, shape) => out.replace(shape, '<redacted>'), text);
}

/** Latest entry per section — what a reader (loop, board, CLI) acts on. */
export function foldSections(card: Pick<TaskCard, 'sections'>): Record<string, CardSection> {
  const latest: Record<string, CardSection> = {};
  for (const section of card.sections) latest[sectionOf(section.key)] = section;
  return latest;
}

export function taskCardsDir(root: string = elanousStateRoot()): string {
  return join(root, 'task-cards');
}
export function cardIndexPath(root: string = elanousStateRoot()): string {
  return join(taskCardsDir(root), 'index.db');
}
export function cardEventsPath(id: string, root: string = elanousStateRoot()): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid card id');
  return join(taskCardsDir(root), `${id}.jsonl`);
}

/** JSONL is authoritative; SQLite holds a rebuildable index and committed byte offsets. */
export class CardStore {
  private readonly db: Database;
  readonly root: string;

  constructor(root: string = elanousStateRoot()) {
    this.root = root;
    mkdirSync(taskCardsDir(root), { recursive: true });
    this.db = new Database(cardIndexPath(root));
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS card_sections (
        card_id TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL,
        PRIMARY KEY (card_id, key), FOREIGN KEY (card_id) REFERENCES cards(id)
      );
      CREATE TABLE IF NOT EXISTS card_offsets (card_id TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cards_by_status ON cards(status, created_at DESC);`);
      this.db.transaction(() => this.reconcile()).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Only advance an offset in the same transaction as the corresponding index changes. */
  private apply(id: string, event: CardEvent, offset: number): void {
    if (event.type === 'created') {
      if (event.id !== id || !event.goalId?.trim() || !event.title?.trim()) throw new Error(`Invalid create event: ${id}`);
      this.db.query('INSERT INTO cards (id, goal_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, event.goalId, event.title, 'open', event.createdAt);
    } else if (event.type === 'section') {
      if (!event.key?.trim() || !event.owner?.trim() || !event.content?.trim()) throw new Error(`Invalid section event: ${id}`);
      const row = this.db.query('SELECT status FROM cards WHERE id = ?').get(id) as { status: CardStatus } | null;
      if (row?.status !== 'open') throw new Error(`Cannot index section on non-open card: ${id}`);
      this.db.query('INSERT INTO card_sections (card_id, key, owner) VALUES (?, ?, ?)').run(id, event.key, event.owner);
    } else if (event.type === 'closed') {
      const row = this.db.query('SELECT status FROM cards WHERE id = ?').get(id) as { status: CardStatus } | null;
      if (row?.status !== 'open') throw new Error(`Cannot index close on non-open card: ${id}`);
      this.db.query("UPDATE cards SET status = 'closed' WHERE id = ?").run(id);
    } else {
      throw new Error(`Invalid card event: ${id}`);
    }
    this.db.query('INSERT INTO card_offsets (card_id, byte_offset) VALUES (?, ?) ON CONFLICT(card_id) DO UPDATE SET byte_offset = excluded.byte_offset')
      .run(id, offset);
  }

  private reconcile(): void {
    for (const file of readdirSync(taskCardsDir(this.root))) {
      if (!/^[a-zA-Z0-9_-]+\.jsonl$/.test(file)) continue;
      const id = file.slice(0, -'.jsonl'.length);
      const bytes = readFileSync(cardEventsPath(id, this.root));
      const row = this.db.query('SELECT byte_offset FROM card_offsets WHERE card_id = ?').get(id) as { byte_offset: number } | null;
      let offset = row?.byte_offset ?? 0;
      if (offset > bytes.length) throw new Error(`Card event log shortened: ${id}`);
      if (offset === bytes.length) continue;
      const pending = bytes.subarray(offset);
      if (pending.length === 0 || pending[pending.length - 1] !== 10) throw new Error(`Incomplete card event log: ${id}`);
      for (const line of pending.toString('utf8').split('\n').slice(0, -1)) {
        if (!line) throw new Error(`Empty card event: ${id}`);
        offset += Buffer.byteLength(line, 'utf8') + 1;
        const event = JSON.parse(line) as CardEvent;
        this.apply(id, event, offset);
      }
    }
  }

  private append(id: string, event: CardEvent): void {
    const path = cardEventsPath(id, this.root);
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
    this.apply(id, event, statSync(path).size);
  }

  /** A repeated goalId returns its original card, without adding a second create event. */
  createCard(input: CreateCardInput): TaskCard {
    if (!input.goalId?.trim() || !input.title?.trim()) throw new Error('goalId and title are required');
    return this.db.transaction(() => {
      this.reconcile();
      const old = this.db.query('SELECT id FROM cards WHERE goal_id = ?').get(input.goalId) as { id: string } | null;
      if (old) return this.readCard(old.id)!;
      const event: Extract<CardEvent, { type: 'created' }> = {
        type: 'created', id: randomUUID(), goalId: input.goalId, title: input.title, createdAt: new Date().toISOString(),
      };
      this.append(event.id, event);
      return this.readCard(event.id)!;
    }).immediate();
  }

  /** A full key is written once (retries by its owner are idempotent); a section takes many keys over time. */
  appendSection(id: string, input: AppendSectionInput): TaskCard {
    if (!input.key?.trim() || !input.owner?.trim() || !input.content?.trim()) throw new Error('key, owner and content are required');
    const section = sectionOf(input.key);
    if (!(section in SECTION_OWNERS)) throw new Error(`Unknown card section: ${section}`);
    const owner = SECTION_OWNERS[section];
    if (owner !== null && owner !== input.owner) throw new Error(`Section ${section} belongs to ${owner}`);
    input = { ...input, content: redactSecrets(input.content) };
    return this.db.transaction(() => {
      this.reconcile();
      const row = this.db.query('SELECT status FROM cards WHERE id = ?').get(id) as { status: CardStatus } | null;
      if (!row) throw new Error(`Card not found: ${id}`);
      const existing = this.db.query('SELECT owner FROM card_sections WHERE card_id = ? AND key = ?')
        .get(id, input.key) as { owner: string } | null;
      if (existing) {
        if (existing.owner !== input.owner) throw new Error(`Section ${input.key} belongs to ${existing.owner}`);
        const card = this.readCard(id)!;
        const section = card.sections.find((item) => item.key === input.key)!;
        if (section.content !== input.content) throw new Error(`Section ${input.key} is already written`);
        return card;
      }
      if (row.status !== 'open') throw new Error(`Card is closed: ${id}`);
      const event: Extract<CardEvent, { type: 'section' }> = { type: 'section', ...input, createdAt: new Date().toISOString() };
      this.append(id, event);
      return this.readCard(id)!;
    }).immediate();
  }

  closeCard(id: string): TaskCard {
    return this.db.transaction(() => {
      this.reconcile();
      const card = this.readCard(id);
      if (!card) throw new Error(`Card not found: ${id}`);
      if (card.status === 'closed') return card;
      this.append(id, { type: 'closed', createdAt: new Date().toISOString() });
      return { ...card, status: 'closed' as const };
    }).immediate();
  }

  private readCard(id: string): TaskCard | null {
    const row = this.db.query('SELECT id, goal_id, title, status, created_at FROM cards WHERE id = ?').get(id) as {
      id: string; goal_id: string; title: string; status: CardStatus; created_at: string;
    } | null;
    if (!row) return null;
    const events = readFileSync(cardEventsPath(id, this.root), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as CardEvent);
    return {
      id: row.id, goalId: row.goal_id, title: row.title, status: row.status, createdAt: row.created_at,
      sections: events.filter((event): event is Extract<CardEvent, { type: 'section' }> => event.type === 'section')
        .map(({ key, owner, content, createdAt }) => ({ key, owner, content, createdAt })),
    };
  }

  getCard(id: string): TaskCard | null {
    return this.db.transaction(() => {
      this.reconcile();
      return this.readCard(id);
    }).immediate();
  }

  listCards(options: { open?: boolean } = {}): TaskCard[] {
    return this.db.transaction(() => {
      this.reconcile();
      const rows = this.db.query(`SELECT id FROM cards ${options.open ? "WHERE status = 'open'" : ''} ORDER BY created_at DESC, id DESC`)
        .all() as Array<{ id: string }>;
      return rows.map(({ id }) => this.readCard(id)!);
    }).immediate();
  }

  close(): void {
    this.db.close();
  }
}
