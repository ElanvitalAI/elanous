import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export type BriefPriority = 'high' | 'medium' | 'low';

export interface BriefItem {
  id: number;
  text: string;
  domain: string;
  priority: BriefPriority;
  deadline: string | null;
  evidence: string | null;
  source: string;
  created_at: string;
}

export interface AddBriefItem {
  text: string;
  domain: string;
  priority: BriefPriority;
  deadline?: string | null;
  evidence?: string | null;
  source: string;
}

export interface BriefItemsOptions {
  stateDir?: string;
  now?: () => Date;
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

/** Append-only item ledger. All three operations open the same instance-scoped SQLite file. */
export class BriefItemsLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: BriefItemsOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'briefing', 'items.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private using<T>(work: (db: Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL, domain TEXT NOT NULL,
        priority TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')),
        deadline TEXT, evidence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS items_no_update BEFORE UPDATE ON items
        BEGIN SELECT RAISE(ABORT, 'brief items are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS items_no_delete BEFORE DELETE ON items
        BEGIN SELECT RAISE(ABORT, 'brief items are immutable'); END;`);
      return work(db);
    } finally {
      db.close();
    }
  }

  add(input: AddBriefItem): BriefItem {
    const text = required(input.text, 'text');
    const domain = required(input.domain, 'domain');
    const source = required(input.source, 'source');
    if (!['high', 'medium', 'low'].includes(input.priority)) throw new BriefItemsInputError('invalid priority');
    const deadline = optional(input.deadline, 'deadline');
    if (deadline !== null) {
      const format = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
      if (!format.test(deadline) || !Number.isFinite(Date.parse(deadline))) throw new BriefItemsInputError('invalid deadline');
    }
    const evidence = optional(input.evidence, 'evidence');
    return this.using(db => {
      const createdAt = this.now().toISOString();
      const result = db.query('INSERT INTO items (text, domain, priority, deadline, evidence, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(text, domain, input.priority, deadline, evidence, source, createdAt);
      return db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at FROM items WHERE id = ?')
        .get(result.lastInsertRowid) as BriefItem;
    });
  }

  /** Higher priorities first, then nearest deadline by instant, then insertion order. */
  list(filters: { domain?: string } = {}): BriefItem[] {
    const items = this.using(db => (filters.domain === undefined
      ? db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at FROM items').all()
      : db.query('SELECT id, text, domain, priority, deadline, evidence, source, created_at FROM items WHERE domain = ?').all(filters.domain)) as BriefItem[]);
    const rank: Record<BriefPriority, number> = { high: 0, medium: 1, low: 2 };
    return items.sort((a, b) => rank[a.priority] - rank[b.priority]
      || Number(a.deadline === null) - Number(b.deadline === null)
      || (a.deadline !== null && b.deadline !== null ? Date.parse(a.deadline) - Date.parse(b.deadline) : 0)
      || a.id - b.id);
  }

  /** Pure Markdown output: composing never marks, alters, or sends stored items. */
  compose(slot: string, filters: { domain?: string } = {}): string {
    required(slot, 'slot');
    const items = this.list(filters);
    const lines = [`# Briefing — ${slot}`, ''];
    for (const item of items) {
      lines.push(`- [${item.priority}] ${item.text} (${item.domain})`);
      lines.push(`  - Source: ${item.source}${item.deadline ? ` · Deadline: ${item.deadline}` : ''}${item.evidence ? ` · Evidence: ${item.evidence}` : ''}`);
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
}
