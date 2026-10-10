import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { dateKey } from '../time/format.js';
import { readRequirementFunnel, type RequirementFunnelResult } from '../intake-plane/requirement-funnel.js';

export const BRIEF_DOMAINS = ['운영', '판', '흡수', '시장', '행정', '코나투스'] as const;
export const BRIEF_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export const BRIEF_SLOTS = ['08:30', 'after-release', '22:00'] as const;
export const BRIEF_REACTIONS = ['열람', '버튼', '답장', '정정', '무시'] as const;

export type BriefReaction = (typeof BRIEF_REACTIONS)[number];
export interface BriefActionCount { acted: number; total: number; rate: number }
export interface BriefWeeklyActions extends BriefActionCount {
  byKind: Record<BriefDomain, BriefActionCount>;
}

export type BriefDomain = (typeof BRIEF_DOMAINS)[number];
export type BriefPriority = (typeof BRIEF_PRIORITIES)[number];
export type BriefSlot = (typeof BRIEF_SLOTS)[number];
export type BriefSendSlot = BriefSlot | 'realtime';

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
  /** Optional normalized claim identity and time window for repeat observations. */
  dedupeKey?: string;
  dedupeWithinMs?: number;
}

export interface BriefItemsOptions {
  stateDir?: string;
  now?: () => Date;
  log?: (category: string, event: string, data?: unknown) => void;
  requirementFunnel?: (now: Date) => RequirementFunnelResult;
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

/** Unsent decisions needing immediate delivery, using the same KST deadline rule as slot pages. */
export function pendingRealtime(items: readonly BriefItem[], now: Date): BriefItem[] {
  const today = dateKey(now, { timeZone: KST });
  return items.filter(item => item.sent_at === null && needsDecision(item, today));
}

/**
 * One briefing page. Item text is copied verbatim.
 * Order: decisions due (P0, then a deadline of today) → domain groups →
 * duplicate claims dropped (same normalized sentence, most urgent kept).
 */
export function composeBriefMarkdown(items: readonly BriefItem[], slot: BriefSlot, now: Date): string {
  return composeBriefPage(items, slot, now).markdown;
}

/** The ids are exactly the rows represented by the composed page, after deduplication. */
export function composeBriefPage(items: readonly BriefItem[], slot: BriefSendSlot, now: Date): { markdown: string; ids: number[] } {
  const today = dateKey(now, { timeZone: KST });
  // A duplicate left out of a delivered page stays unsent in the ledger, but must not reappear on a later page.
  // A new undeliverable observation after a sent page is a new occurrence, not an old duplicate.
  const deliveredClaims = new Set(items.filter(item => item.sent_at !== null).map(item => normalizeClaim(item.text)));
  const candidates = slot === 'realtime' ? pendingRealtime(items, now) : items.filter(item => item.sent_at === null && beforeSlot(item.created_at, slot, now));
  const eligible = candidates.filter(item => item.source === 'outbound.undeliverable' || !deliveredClaims.has(normalizeClaim(item.text)));
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
  return { markdown: `${lines.join('\n').trimEnd()}\n`, ids: unique.map(item => item.id) };
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
  private readonly requirementFunnel: (now: Date) => RequirementFunnelResult;

  constructor(options: BriefItemsOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'briefing', 'items.sqlite');
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((category, event, data) => debug.log(category, event, data));
    this.requirementFunnel = options.requirementFunnel ?? ((now) => readRequirementFunnel({ stateDir: options.stateDir, now }));
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
      );
      CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id),
        reaction TEXT NOT NULL CHECK(reaction IN ('열람', '버튼', '답장', '정정', '무시')),
        reacted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reactions_item_time ON reactions(item_id, reacted_at);
      CREATE INDEX IF NOT EXISTS sends_time ON sends(sent_at);`);
      if (!(db.query("SELECT name FROM pragma_table_info('items')").all() as { name: string }[]).some(column => column.name === 'dedupe_key')) {
        db.exec('ALTER TABLE items ADD COLUMN dedupe_key TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS items_dedupe ON items(source, dedupe_key, created_at)');
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
    const dedupeKey = input.dedupeKey === undefined ? null : normalizeClaim(required(input.dedupeKey, 'dedupeKey'));
    const windowMs = input.dedupeWithinMs;
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0 || dedupeKey === null)) {
      throw new BriefItemsInputError('invalid dedupe window');
    }
    const selected = this.using(db => {
      const select = 'SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items WHERE id = ?';
      db.exec('BEGIN IMMEDIATE');
      try {
        if (dedupeKey !== null && windowMs !== undefined) {
          const existing = db.query(`SELECT id FROM items WHERE source = ? AND dedupe_key = ?
            AND NOT EXISTS (SELECT 1 FROM sends WHERE sends.item_id = items.id)
            AND julianday(created_at) >= julianday(?) - ? / 86400000.0
            AND julianday(created_at) <= julianday(?) ORDER BY id DESC LIMIT 1`)
            .get(source, dedupeKey, createdAt, windowMs, createdAt) as { id: number } | null;
          if (existing) {
            const item = db.query(select).get(existing.id) as BriefItem;
            db.exec('COMMIT');
            return { item, added: false };
          }
        }
        const result = db.query(
          'INSERT INTO items (text, domain, priority, deadline, evidence, source, created_at, sent_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
        ).run(text, input.domain, input.priority, deadline, evidence, source, createdAt, dedupeKey);
        const item = db.query(select).get(result.lastInsertRowid) as BriefItem;
        db.exec('COMMIT');
        return { item, added: true };
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    });
    if (selected.added) this.log('briefing.items', 'added', { id: selected.item.id, domain: selected.item.domain, priority: selected.item.priority, source: selected.item.source });
    return selected.item;
  }

  /** Append a reaction without changing the original item or its send history. */
  recordReaction(itemId: number, reaction: BriefReaction): void {
    if (!Number.isSafeInteger(itemId) || itemId < 1) throw new BriefItemsInputError('invalid item id');
    if (!(BRIEF_REACTIONS as readonly string[]).includes(reaction)) throw new BriefItemsInputError('invalid reaction');
    this.using(db => {
      const at = this.now().toISOString();
      if (!db.query('SELECT 1 FROM sends WHERE item_id = ? AND sent_at <= ? LIMIT 1').get(itemId, at)) {
        throw new BriefItemsInputError('item was not sent');
      }
      db.query('INSERT INTO reactions (item_id, reaction, reacted_at) VALUES (?, ?, ?)')
        .run(itemId, reaction, at);
    });
    this.log('briefing.items', 'reaction-recorded', { itemId, reaction });
  }

  /** KST Monday through now: distinct sent items acted on (button/reply/correction), grouped by domain. */
  weeklyActions(): BriefWeeklyActions {
    const now = this.now();
    const today = dateKey(now, { timeZone: KST });
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const since = new Date(`${day.toISOString().slice(0, 10)}T00:00:00+09:00`).toISOString();
    const until = now.toISOString();
    return this.using(db => {
      const rows = db.query(`SELECT items.domain AS kind,
        COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM reactions r WHERE r.item_id = items.id
            AND r.reaction IN ('버튼', '답장', '정정') AND r.reacted_at >= ? AND r.reacted_at <= ?
        ) THEN 1 ELSE 0 END) AS acted
        FROM items WHERE EXISTS (
          SELECT 1 FROM sends s WHERE s.item_id = items.id AND s.sent_at >= ? AND s.sent_at <= ?
        ) GROUP BY items.domain`).all(since, until, since, until) as Array<{ kind: BriefDomain; total: number; acted: number }>;
      const byKind = Object.fromEntries(BRIEF_DOMAINS.map(kind => [kind, { acted: 0, total: 0, rate: 0 }])) as Record<BriefDomain, BriefActionCount>;
      let acted = 0;
      let total = 0;
      for (const row of rows) {
        byKind[row.kind] = { acted: row.acted, total: row.total, rate: row.acted / row.total };
        acted += row.acted;
        total += row.total;
      }
      return { acted, total, rate: total === 0 ? 0 : acted / total, byKind };
    });
  }

  /** Insertion order. Optional domain filter. Item text is the stored original. */
  list(filters: { domain?: BriefDomain } = {}): BriefItem[] {
    return this.using(db => (filters.domain === undefined
      ? db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items ORDER BY id').all()
      : db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items WHERE domain = ? ORDER BY id').all(filters.domain)) as BriefItem[]);
  }

  /**
   * Markdown for one slot. Reads only — never marks, rewrites, or sends an item.
   * Items created at or after the slot instant are left out. At 08:30 the
   * requirement funnel contributes ephemeral lines without adding ledger rows.
   */
  compose(slot: string): string {
    if (!(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    return this.composeWithIds(slot).markdown;
  }

  private itemsFromDb(db: Database): BriefItem[] {
    return db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at, (SELECT MIN(sent_at) FROM sends WHERE sends.item_id = items.id) AS sent_at FROM items ORDER BY id').all() as BriefItem[];
  }

  private pageFromDb(db: Database, slot: BriefSendSlot): { markdown: string; ids: number[] } {
    const items = this.itemsFromDb(db);
    const now = this.now();
    const morningCutoff = Date.parse(`${dateKey(now, { timeZone: KST })}T08:30:00+09:00`);
    let funnelItems: BriefItem[] = [];
    if (slot === '08:30' && now.getTime() >= morningCutoff) {
      // A funnel failure must not take the morning brief down with it.
      try {
        const extra = this.requirementFunnel(new Date(morningCutoff - 1)).briefItems;
        // Negative ids never collide with ledger rows and keep the funnel's own order (summary first).
        funnelItems = extra.map((item, index): BriefItem => ({
          id: index - extra.length, text: item.text, domain: item.domain, priority: item.priority, deadline: null,
          evidence: item.evidence ?? null, source: item.source,
          created_at: new Date(morningCutoff - 1).toISOString(), sent_at: null,
        }));
      } catch (error) {
        this.log('briefing.items', 'requirement-funnel-failed', { slot, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const composed = composeBriefPage([...items, ...funnelItems], slot, now);
    // Ephemeral funnel lines appear on the page but have no ledger row to mark sent.
    const page = { markdown: composed.markdown, ids: composed.ids.filter(id => id > 0) };
    const candidates = (slot === 'realtime' ? pendingRealtime(items, now) : items.filter(item => item.sent_at === null && beforeSlot(item.created_at, slot, now))).length;
    this.log('briefing.items', 'composed', { slot, candidates, bytes: Buffer.byteLength(page.markdown) });
    return page;
  }

  /** Read-only page and the exact ledger item ids printed on it (after deduplication). */
  composeWithIds(slot: string): { markdown: string; ids: number[] } {
    if (slot !== 'realtime' && !(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    return this.using(db => this.pageFromDb(db, slot as BriefSendSlot));
  }

  /** Hold the ledger's SQLite writer lock from selecting unsent rows through delivery and marking.
   * A failed delivery rolls back and releases the lock; the next sender can retry.
   */
  withSendLock<T>(slot: string, work: (page: { markdown: string; ids: number[] }, markSent: (ids: readonly number[], slot: BriefSendSlot) => number) => T): T {
    if (slot !== 'realtime' && !(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    return this.using(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const page = this.pageFromDb(db, slot as BriefSendSlot);
        const result = work(page, (ids, sentSlot) => {
          if (sentSlot !== slot || ids.length !== page.ids.length || ids.some((id, index) => id !== page.ids[index])) {
            throw new BriefItemsInputError('marked ids must match composed page');
          }
          return this.markSentInDb(db, ids, sentSlot);
        });
        db.exec('COMMIT');
        return result;
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    });
  }

  private markSentInDb(db: Database, ids: readonly number[], slot: BriefSendSlot): number {
    const at = this.now().toISOString();
    const insert = db.query('INSERT INTO sends (item_id, slot, sent_at) VALUES (?, ?, ?)');
    let count = 0;
    for (const id of ids) { insert.run(id, slot, at); count++; }
    this.log('briefing.items', 'marked-sent', { slot, count });
    return count;
  }

  /**
   * Records that these items went out in a slot (append-only); later composes leave them out (ACP must-fix).
   * Only an actual sender calls this — compose itself stays read-only (no flag marks items it did not send).
   */
  markSent(ids: readonly number[], slot: BriefSendSlot): number {
    if (slot !== 'realtime' && !(BRIEF_SLOTS as readonly string[]).includes(slot)) throw new BriefItemsInputError('invalid slot');
    return this.using(db => db.transaction(() => this.markSentInDb(db, ids, slot))());
  }
}
