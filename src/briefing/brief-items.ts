import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { dateKey } from '../time/format.js';

export const BRIEF_DOMAINS = ['운영', '판', '흡수', '시장', '행정', '코나투스'] as const;
export const BRIEF_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export const BRIEF_SLOTS = ['08:30', 'after-release', '22:00'] as const;

export type BriefDomain = (typeof BRIEF_DOMAINS)[number];
export type BriefPriority = (typeof BRIEF_PRIORITIES)[number];
export type BriefSlot = (typeof BRIEF_SLOTS)[number];

const KST = 'Asia/Seoul';

export interface BriefItem {
  id: number;
  text: string;
  domain: BriefDomain;
  priority: BriefPriority;
  deadline: string | null;
  evidence: string | null;
  source: string;
  created_at: string;
  sent_at: string | null;
}

export interface AddBriefItem {
  text: string;
  domain: BriefDomain;
  priority: BriefPriority;
  deadline?: string | null;
  evidence?: string | null;
  source: string;
  createdAt?: string;
}

export interface BriefItemsOptions {
  stateDir?: string;
  now?: () => Date;
  log?: (category: string, event: string, data?: unknown) => void;
}

export class BriefItemsInputError extends Error {
  override name = 'BriefItemsInputError';
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BriefItemsInputError(`${field} is required`);
  return value;
}

function optional(value: string | null | undefined, field: string): string | null {
  return value == null ? null : required(value, field);
}

/** Collapse whitespace so the same claim, however spaced, counts once. */
export function normalizeClaim(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function deadlineDate(deadline: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : dateKey(deadline, { timeZone: KST });
}

/**
 * Unsent items created strictly before the slot instant (KST).
 * `08:30` and `22:00` are that clock today. `after-release` has no fixed
 * clock — a release can land at any hour — so its instant is `now`.
 * Tomorrow's items stay out of every slot.
 */
export function beforeSlot(createdAt: string, slot: BriefSlot, now: Date): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const today = dateKey(now, { timeZone: KST });
  const cutoff = slot === 'after-release' ? now.getTime() : Date.parse(`${today}T${slot}:00+09:00`);
  return createdMs < cutoff;
}

function needsDecision(item: BriefItem, today: string): boolean {
  return item.priority === 'P0' || (item.deadline !== null && deadlineDate(item.deadline) === today);
}

/**
 * One briefing page. Item text is copied verbatim.
 * Order: decisions due (P0, then a deadline of today) → domain groups →
 * duplicate claims dropped (same normalized sentence, most urgent kept).
 */
export function composeBriefMarkdown(items: readonly BriefItem[], slot: BriefSlot, now: Date): string {
  const today = dateKey(now, { timeZone: KST });
  const eligible = items.filter(item => item.sent_at === null && beforeSlot(item.created_at, slot, now));
  // Duplicate claims keep the copy that needs a decision today (P0 or due today), then the higher priority, then the earliest (ACP must-fix).
  const rank = (item: BriefItem) => [needsDecision(item, today) ? 0 : 1, BRIEF_PRIORITIES.indexOf(item.priority), item.id];
  const better = (a: BriefItem, b: BriefItem) => { const x = rank(a), y = rank(b); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; };
  const best = new Map<string, BriefItem>();
  for (const item of eligible) {
    const key = normalizeClaim(item.text);
    const kept = best.get(key);
    if (!kept || better(item, kept) < 0) best.set(key, item);
  }
  const unique = [...best.values()].sort((a, b) => a.id - b.id);
  const decisions = unique.filter(item => needsDecision(item, today))
    .sort((a, b) => Number(b.priority === 'P0') - Number(a.priority === 'P0') || a.id - b.id);
  const decisionIds = new Set(decisions.map(item => item.id));
  const lines = [`# 브리핑 — ${slot}`, ''];
  if (decisions.length > 0) {
    lines.push('## 결정이 필요한 것', '');
    for (const item of decisions) lines.push(itemLine(item));
    lines.push('');
  }
  for (const domain of BRIEF_DOMAINS) {
    const group = unique.filter(item => item.domain === domain && !decisionIds.has(item.id));
    if (group.length === 0) continue;
    lines.push(`## ${domain}`, '');
    for (const item of group.sort((a, b) => a.id - b.id)) lines.push(itemLine(item));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function itemLine(item: BriefItem): string {
  const extra = [
    item.deadline ? `마감: ${item.deadline}` : '',
    item.evidence ? `근거: ${item.evidence}` : '',
    `출처: ${item.source}`,
  ].filter(Boolean).join(' · ');
  return `- [${item.priority}] ${item.text} (${extra})`;
}

/**
 * The first ledger (#24193) used priorities high/medium/low and had no sent_at column. Keep its rows: move the old
 * table aside and copy them into the current shape (high→P0 · medium→P1 · low→P2) — append-only, nothing is lost.
 */
function migrateLegacyItems(db: Database, log: (category: string, event: string, data?: unknown) => void): void {
  const columns = db.query("SELECT name FROM pragma_table_info('items')").all() as { name: string }[];
  if (columns.length === 0 || columns.some(column => column.name === 'sent_at')) return;
  db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS items_no_update; DROP TRIGGER IF EXISTS items_no_delete; ALTER TABLE items RENAME TO items_v1;');
    db.exec(`CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('운영', '판', '흡수', '시장', '행정', '코나투스')),
      priority TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2')),
      deadline TEXT,
      evidence TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    )`);
    db.exec(`INSERT INTO items (id, text, domain, priority, deadline, evidence, source, created_at, sent_at)
      SELECT id, text,
        CASE WHEN domain IN ('운영', '판', '흡수', '시장', '행정', '코나투스') THEN domain ELSE '운영' END,
        CASE priority WHEN 'high' THEN 'P0' WHEN 'medium' THEN 'P1' ELSE 'P2' END,
        deadline, evidence,
        -- An unknown legacy domain keeps its meaning in the source label instead of vanishing (ACP must-fix).
        CASE WHEN domain IN ('운영', '판', '흡수', '시장', '행정', '코나투스') THEN source ELSE source || ' · 옛 도메인 ' || domain END,
        created_at, NULL FROM items_v1`);
  })();
  log('briefing.items', 'migrated-legacy', { rows: (db.query('SELECT COUNT(*) AS n FROM items_v1').get() as { n: number }).n });
}

/** Append-only briefing item ledger at `<state>/briefing/items.sqlite`. */
export class BriefItemsLedger {
  readonly path: string;
  private readonly now: () => Date;
  private readonly log: (category: string, event: string, data?: unknown) => void;

  constructor(options: BriefItemsOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'briefing', 'items.sqlite');
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((category, event, data) => debug.log(category, event, data));
  }

  private using<T>(work: (db: Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      migrateLegacyItems(db, this.log);
      db.exec(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        domain TEXT NOT NULL CHECK(domain IN ('운영', '판', '흡수', '시장', '행정', '코나투스')),
        priority TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2')),
        deadline TEXT,
        evidence TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TRIGGER IF NOT EXISTS items_no_update BEFORE UPDATE ON items
        BEGIN SELECT RAISE(ABORT, 'brief items are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS items_no_delete BEFORE DELETE ON items
        BEGIN SELECT RAISE(ABORT, 'brief items are immutable'); END;
      CREATE TABLE IF NOT EXISTS sends (
        item_id INTEGER NOT NULL REFERENCES items(id),
        slot TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );`);
      return work(db);
    } finally {
      db.close();
    }
  }

  add(input: AddBriefItem): BriefItem {
    const text = required(input.text, 'text');
    // A brief item is one claim line; a line break would break the composed Markdown structure (ACP must-fix).
    if (/[\r\n]/.test(text)) throw new BriefItemsInputError('text must be a single line');
    if (!(BRIEF_DOMAINS as readonly string[]).includes(input.domain)) throw new BriefItemsInputError('invalid domain');
    if (!(BRIEF_PRIORITIES as readonly string[]).includes(input.priority)) throw new BriefItemsInputError('invalid priority');
    const source = required(input.source, 'source');
    const deadline = optional(input.deadline, 'deadline');
    // Every field that reaches the composed Markdown is one line, so no stored item can forge a heading or entry (ACP must-fix).
    for (const [field, value] of [['source', source], ['evidence', input.evidence ?? null], ['deadline', deadline]] as const) {
      if (value !== null && /[\r\n]/.test(value)) throw new BriefItemsInputError(`${field} must be a single line`);
    }
    if (deadline !== null) {
      const format = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
      if (!format.test(deadline) || !Number.isFinite(Date.parse(deadline))) throw new BriefItemsInputError('invalid deadline');
    }
    const evidence = optional(input.evidence, 'evidence');
    const createdAt = input.createdAt ?? this.now().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) throw new BriefItemsInputError('invalid createdAt');
    const item = this.using(db => {
      const result = db.query(
        'INSERT INTO items (text, domain, priority, deadline, evidence, source, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      ).run(text, input.domain, input.priority, deadline, evidence, source, createdAt);
      return db.query(
        'SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items WHERE id = ?',
      ).get(result.lastInsertRowid) as BriefItem;
    });
    this.log('briefing.items', 'added', { id: item.id, domain: item.domain, priority: item.priority, source: item.source });
    return item;
  }

  /** Insertion order. Optional domain filter. Item text is the stored original. */
  list(filters: { domain?: BriefDomain } = {}): BriefItem[] {
    return this.using(db => (filters.domain === undefined
      ? db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items ORDER BY id').all()
      : db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items WHERE domain = ? ORDER BY id').all(filters.domain)) as BriefItem[]);
  }

  /**
   * Markdown for one slot. Reads only — never marks, rewrites, or sends an item.
   * Items created at or after the slot instant are left out.
   */
  compose(slot: string): string {
    if (!(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    const items = this.list();
    const markdown = composeBriefMarkdown(items, slot as BriefSlot, this.now());
    const included = items.filter(item => item.sent_at === null && beforeSlot(item.created_at, slot as BriefSlot, this.now()));
    this.log('briefing.items', 'composed', { slot, candidates: included.length, bytes: Buffer.byteLength(markdown) });
    return markdown;
  }

  /**
   * Records that these items went out in a slot (append-only); later composes leave them out (ACP must-fix).
   * Only an actual sender calls this — compose itself stays read-only (no flag marks items it did not send).
   */
  markSent(ids: readonly number[], slot: BriefSlot): number {
    if (!(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    const at = this.now().toISOString();
    const count = this.using(db => {
      const insert = db.query('INSERT INTO sends (item_id, slot, sent_at) VALUES (?, ?, ?)');
      let n = 0;
      db.transaction(() => { for (const id of ids) { insert.run(id, slot, at); n++; } })();
      return n;
    });
    this.log('briefing.items', 'marked-sent', { slot, count });
    return count;
  }
}
