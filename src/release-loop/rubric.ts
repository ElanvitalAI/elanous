import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem } from './checklist.js';

export interface Rubric {
  A: number;
  E: number;
  R: number;
  D: number;
  M: number;
  B: number;
  S: number;
  X: number;
}

const AXES = ['A', 'E', 'R', 'D', 'M', 'B', 'S', 'X'] as const;

/** Read one explicit rubric line; an old score in parentheses is not an axis. */
export function parseRubric(text: string): Rubric | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /(?:^|\s)루브릭:\s*([^\r\n]*)/.exec(line);
    if (!match) continue;
    const values: Partial<Rubric> = {};
    const body = match[1]!.replace(/\([^)]*\)/g, ' ');
    for (const token of body.trim().split(/\s+/)) {
      const axis = /^([AERDMBSX])([0-3])$/.exec(token);
      if (axis) values[axis[1] as keyof Rubric] = Number(axis[2]);
    }
    if (AXES.every((axis) => values[axis] !== undefined)) return values as Rubric;
  }
  return null;
}

export function rubricScore(r: Rubric): number {
  return 2 * r.A + 2 * r.E + 2 * r.R + 1.5 * r.D + r.M + r.B - 0.5 * r.S - 0.5 * r.X;
}

export function rubricGrade(score: number): 'P1' | 'P2' | 'P3' | 'P4' {
  if (score >= 11) return 'P1';
  if (score >= 8) return 'P2';
  if (score >= 5) return 'P3';
  return 'P4';
}

/** Inspect an existing checklist without initializing, importing, or migrating its ledger. */
export function readRubricItems(version: string, ledgerRoot: string): Pick<ChecklistItem, 'id' | 'title' | 'evidence' | 'priority'>[] {
  const dbPath = join(ledgerRoot, 'release', 'features.sqlite');
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, strict: true });
    try {
      const columns = new Set((db.query('PRAGMA table_info(assignments)').all() as Array<{ name: string }>).map((row) => row.name));
      const priority = columns.has('priority') ? 'a.priority' : 'NULL';
      const rows = db.query(`SELECT f.id, COALESCE(a.title_override, f.title) AS title, a.evidence, ${priority} AS priority
        FROM assignments a JOIN features f ON f.id = a.feature_id WHERE a.version = ? ORDER BY a.rowid`)
        .all(version) as Array<{ id: string; title: string; evidence: string | null; priority: ChecklistItem['priority'] | null }>;
      const imported = db.query('SELECT 1 FROM imported_versions WHERE version = ?').get(version);
      if (rows.length || imported) {
        const refs = db.query('SELECT feature_id, ref FROM evidence WHERE version = ? ORDER BY rowid')
          .all(version) as Array<{ feature_id: string; ref: string }>;
        const refsById = new Map<string, string[]>();
        for (const { feature_id, ref } of refs) {
          const list = refsById.get(feature_id) ?? [];
          list.push(ref);
          refsById.set(feature_id, list);
        }
        return rows.map((row) => {
          const evidence = [row.evidence, ...(refsById.get(row.id) ?? [])]
            .filter((value): value is string => value !== null).join('\n');
          return { id: row.id, title: row.title, ...(evidence ? { evidence } : {}), ...(row.priority ? { priority: row.priority } : {}) };
        });
      }
    } finally { db.close(); }
  }
  const path = join(ledgerRoot, 'release', version, 'checklist.json');
  if (!existsSync(path)) return [];
  const legacy = JSON.parse(readFileSync(path, 'utf8')) as { version: string; items: ChecklistItem[] };
  if (legacy.version !== version || !Array.isArray(legacy.items)) throw new Error(`잘못된 체크리스트: ${path}`);
  return legacy.items;
}
