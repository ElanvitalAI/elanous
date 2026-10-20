import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem } from './checklist.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import type { RubricAxis } from './rubric-types.js';
export type { RubricAxis } from './rubric-types.js';

export const DEFAULT_PROJECT_AXES: readonly RubricAxis[] = [
  { key: 'V', weight: 2 }, { key: 'U', weight: 2 },
  { key: 'R', weight: 2 }, { key: 'S', weight: -0.5 },
];

const INTERNAL_AXES: readonly RubricAxis[] = [
  { key: 'A', weight: 2 }, { key: 'E', weight: 2 },
  { key: 'R', weight: 2 }, { key: 'D', weight: 1.5 },
  { key: 'M', weight: 1 }, { key: 'B', weight: 1 },
  { key: 'S', weight: -0.5 }, { key: 'X', weight: -0.5 },
];

export function rubricScoreWith(axes: readonly RubricAxis[], values: Readonly<{ [key: string]: number } | Rubric>): number {
  const scores: Readonly<Record<string, number>> = values as Readonly<Record<string, number>>;
  return axes.reduce((score, { key, weight }) => {
    const value = Object.hasOwn(scores, key) ? scores[key] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`루브릭 축 ${key} 값이 없다`);
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`루브릭 축 ${key} 가중이 유한수가 아니다`);
    return score + weight * value;
  }, 0);
}

/**
 * RFC §A4b⑤ — unconfigured projects (and the internal pack `elanous`) keep the internal eight axes;
 * a project with `projects.<id>.rubric.axes` starts from V/U/R/S and replaces matching keys or appends new ones.
 * An invalid axes entry raises its config error text here (loading the config itself stays non-fatal).
 */
export function resolveRubricAxes(projectId?: string): RubricAxis[] {
  const projects = projectId && projectId !== 'elanous' ? getUserConfig().projects : undefined;
  const rubric = projects && Object.hasOwn(projects, projectId!) ? projects[projectId!]?.rubric : undefined;
  if (rubric?.error) {
    debug.log('release.rubric', 'axes-invalid', { project: projectId, error: rubric.error });
    throw new Error(rubric.error);
  }
  const configured = rubric?.axes;
  const axes = (configured ? DEFAULT_PROJECT_AXES : INTERNAL_AXES).map((axis) => ({ ...axis }));
  for (const axis of configured ?? []) {
    const index = axes.findIndex((current) => current.key === axis.key);
    if (index < 0) axes.push({ ...axis });
    else axes[index] = { ...axis };
  }
  // An omitted project id is logged as null (unspecified) — not as `elanous` — even though it resolves to the internal axes.
  debug.log('release.rubric', 'axes', { project: projectId ?? null, keys: axes.map(({ key }) => key) });
  return axes;
}

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

function* rubricLines(text: string): Generator<Partial<Rubric>> {
  for (const line of text.split(/\r?\n/)) {
    const match = /(?:^|\s)루브릭:\s*([^\r\n]*)/.exec(line);
    if (!match) continue;
    const values: Partial<Rubric> = {};
    const body = match[1]!.replace(/\([^)]*\)/g, ' ');
    for (const token of body.trim().split(/\s+/)) {
      const axis = /^([AERDMBSX])([0-3])$/.exec(token);
      if (axis) values[axis[1] as keyof Rubric] = Number(axis[2]);
    }
    yield values;
  }
}

/** Read one explicit rubric line; an old score in parentheses is not an axis. */
export function parseRubric(text: string): Rubric | null {
  for (const values of rubricLines(text)) {
    if (AXES.every((axis) => values[axis] !== undefined)) return values as Rubric;
  }
  return null;
}

/** Read an explicitly entered S axis even when the other rubric axes are incomplete. */
export function parseRubricS(text: string): number | null {
  for (const values of rubricLines(text)) {
    if (values.S !== undefined) return values.S;
  }
  return null;
}

export function rubricScore(r: Rubric): number {
  return rubricScoreWith(INTERNAL_AXES, r);
}

export function rubricGrade(score: number): 'P1' | 'P2' | 'P3' | 'P4' {
  if (score >= 11) return 'P1';
  if (score >= 8) return 'P2';
  if (score >= 5) return 'P3';
  return 'P4';
}

/** The rule-only split uses the same numeric rubric as the release checklist. */
export function rubricPriority(text: string): ReturnType<typeof rubricGrade> {
  const rubric = parseRubric(text);
  return rubric ? rubricGrade(rubricScore(rubric)) : 'P2';
}

// Rubric v2 — first slice: the formula only (line parsing and v1/v2 output are later slots).

/** v2 value axes (L U F O R T M, each 0..3); Z divides the total, X subtracts from it. */
export const RUBRIC_V2_VALUE_AXES = ['L', 'U', 'F', 'O', 'R', 'T', 'M'] as const;
export const RUBRIC_V2_Z_CHOICES: readonly number[] = [1, 2, 4, 8];
const V2_AXIS_KEYS = new Set<string>([...RUBRIC_V2_VALUE_AXES, 'Z', 'X']);

/** Rubric v2 values: L U F O R T M each 0..3, Z ∈ {1,2,4,8}, X 0..3. */
export interface RubricV2 {
  L: number;
  U: number;
  F: number;
  O: number;
  R: number;
  T: number;
  M: number;
  Z: number;
  X: number;
}

/** The F weight is 2 through 2026-10-28 and 1 from 2026-10-29 on; asOf must retain its original date text. */
export const RUBRIC_V2_F_CUTOVER_DAY = '2026-10-29';

export function rubricV2FWeight(asOf: string): 2 | 1 {
  const invalid = () => new Error(`루브릭 v2 기준 날짜가 잘못되었다: ${String(asOf)}`);
  // A Date may already have normalized an impossible calendar day before this call.
  if (typeof asOf !== 'string') throw invalid();
  const parts = /^(\d{4}|[1-9]\d{4,5}|[+-]\d{6})-(\d{2})-(\d{2})(?:$|T)/.exec(asOf);
  if (!parts) throw invalid();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) throw invalid();
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date.getTime() >= Date.parse(`${RUBRIC_V2_F_CUTOVER_DAY}T00:00:00.000Z`) ? 1 : 2;
}

/** V = 2L + 2U + wF + 1.5O + 1.5R + 1.5T + M (w = rubricV2FWeight), 점수 = V / Z − 0.5X. */
export function rubricScoreV2(values: RubricV2, asOf: string): number {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new Error('루브릭 v2 값이 축 객체가 아니다');
  const given = values as unknown as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!V2_AXIS_KEYS.has(key)) throw new Error(`루브릭 v2 알 수 없는 축: ${key}`);
  }
  const readAxis = (axis: (typeof RUBRIC_V2_VALUE_AXES)[number]): number => {
    const value = given[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`루브릭 v2 축 ${axis} 값이 없다`);
    if (value < 0 || value > 3) throw new Error(`루브릭 v2 축 ${axis} 값이 0~3 밖이다: ${value}`);
    return value;
  };
  const L = readAxis('L');
  const U = readAxis('U');
  const F = readAxis('F');
  const O = readAxis('O');
  const R = readAxis('R');
  const T = readAxis('T');
  const M = readAxis('M');
  const Z = given.Z;
  if (typeof Z !== 'number' || !Number.isFinite(Z)) throw new Error('루브릭 v2 크기 Z 값이 없다');
  if (!RUBRIC_V2_Z_CHOICES.includes(Z)) throw new Error(`루브릭 v2 크기 Z 값이 1·2·4·8 밖이다: ${Z}`);
  const X = given.X;
  if (typeof X !== 'number' || !Number.isFinite(X)) throw new Error('루브릭 v2 위험 X 값이 없다');
  if (X < 0 || X > 3) throw new Error(`루브릭 v2 위험 X 값이 0~3 밖이다: ${X}`);
  const w = rubricV2FWeight(asOf);
  return (2 * L + 2 * U + w * F + 1.5 * O + 1.5 * R + 1.5 * T + M) / Z - 0.5 * X;
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
