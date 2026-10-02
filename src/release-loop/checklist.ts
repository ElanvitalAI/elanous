import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { CliUserError } from '../cli/cli-user-error.js';

export type ChecklistStatus = 'green' | 'yellow' | 'red' | 'done';
export type ChecklistDisposition = 'move' | 'known-issue' | 'block';
/** `screen` = a five-surface feature cell — its evidence carries a `짝:` line (MANUAL-five-surface-parity §A). */
export type ChecklistKind = 'screen';
export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  owner?: string;
  evidence?: string;
  disposition?: ChecklistDisposition;
  kind?: ChecklistKind;
  updatedAt: string;
  updatedBy: string;
}
export interface ChecklistHistory {
  at: string;
  by: string;
  id: string;
  field: string;
  from: unknown;
  to: unknown;
  released: string;
  dev: string;
}
export interface Checklist {
  version: string;
  released: string;
  dev: string;
  items: ChecklistItem[];
  history: ChecklistHistory[];
}

export function devVersion(): string {
  return (JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
}

function releasedVersion(): string {
  const dir = join(releaseLedgerRoot(), 'release');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(join(dir, v, 'release.json')))
    .filter((v) => {
      try { const record = JSON.parse(readFileSync(join(dir, v, 'release.json'), 'utf8')) as { version?: string; publishedAt?: string }; return record.version === v && typeof record.publishedAt === 'string'; }
      catch { return false; }
    })
    .sort((a, b) => {
      const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
      return (bb[0]! - aa[0]!) || (bb[1]! - aa[1]!) || (bb[2]! - aa[2]!);
    })[0] ?? '';
}

function pathFor(v: string): string {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(v)) throw new CliUserError(`체크리스트 판이 아니다: ${v}`);
  return join(releaseLedgerRoot(), 'release', v, 'checklist.json');
}

export function listChecklist(v: string): Checklist {
  const path = pathFor(v);
  if (existsSync(path)) {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Checklist;
    refresh(data);
    return data;
  }
  return { version: v, released: releasedVersion(), dev: devVersion(), items: [], history: [] };
}

// SQLite's OS-backed write lock is released when the owning process exits, even without a finally block.
// Hold it across the JSON read/modify/atomic-rename sequence so writers never use stale snapshots.
function mutate(v: string, apply: (data: Checklist) => boolean): Checklist {
  const path = pathFor(v);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.mutex.sqlite`;
  const db = new Database(lock, { create: true, strict: true });
  try {
    chmodSync(lock, 0o600);
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const data = listChecklist(v);
      if (apply(data)) save(v, data);
      db.exec('COMMIT');
      return data;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}

function save(v: string, data: Checklist): void {
  const path = pathFor(v);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
}

function change(data: Checklist, id: string, field: string, from: unknown, to: unknown, by: string, at: string): void {
  data.history.push({ at, by, id, field, from: from ?? null, to: to ?? null, released: data.released, dev: data.dev });
  debug.log('release-loop.checklist', 'change', { version: data.version, id, field, from: from ?? null, to: to ?? null, by });
}

function refresh(data: Checklist): void { data.released = releasedVersion(); data.dev = devVersion(); }

export function addItem(v: string, input: { id: string; title: string; owner?: string; kind?: ChecklistKind }): Checklist {
  if (!input.id.trim()) throw new CliUserError('칸 id 가 비었다');
  if (!input.title.trim()) throw new CliUserError('칸 제목이 비었다');
  if (input.kind !== undefined && input.kind !== 'screen') throw new CliUserError(`잘못된 종류: ${input.kind}`, 'screen');
  return mutate(v, (data) => {
    if (data.items.some((item) => item.id === input.id)) throw new CliUserError(`이미 있는 칸: ${input.id}`, 'set <id> 로 고친다');
    const by = process.env.ELANOUS_TRACK || 'cli';
    const at = new Date().toISOString();
    const item: ChecklistItem = { id: input.id, title: input.title, status: 'yellow', ...(input.owner !== undefined ? { owner: input.owner } : {}), ...(input.kind !== undefined ? { kind: input.kind } : {}), updatedAt: at, updatedBy: by };
    data.items.push(item);
    change(data, item.id, 'add', null, item, by, at);
    return true;
  });
}

export function setItem(v: string, id: string, patch: { status?: ChecklistStatus; evidence?: string; owner?: string; disposition?: ChecklistDisposition; kind?: ChecklistKind }, by: string): Checklist {
  return mutate(v, (data) => {
    const item = data.items.find((i) => i.id === id);
    if (!item) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
    if (patch.status !== undefined && !['green', 'yellow', 'red', 'done'].includes(patch.status)) throw new CliUserError(`잘못된 상태: ${patch.status}`);
    if (patch.disposition !== undefined && !['move', 'known-issue', 'block'].includes(patch.disposition)) throw new CliUserError(`잘못된 처분: ${patch.disposition}`);
    if (patch.kind !== undefined && patch.kind !== 'screen') throw new CliUserError(`잘못된 종류: ${patch.kind}`, 'screen');
    const fields = (['evidence', 'owner', 'status', 'disposition', 'kind'] as const).filter((field) => patch[field] !== undefined && patch[field] !== item[field]);
    if (fields.length === 0) return false;
    const at = new Date().toISOString();
    for (const field of fields) {
      const from = item[field];
      const to = patch[field]!;
      (item as unknown as Record<string, unknown>)[field] = to;
      item.updatedAt = at;
      item.updatedBy = by;
      change(data, id, field, from, to, by, at);
    }
    return true;
  });
}

export function removeItem(v: string, id: string, by: string): Checklist {
  return mutate(v, (data) => {
    const index = data.items.findIndex((i) => i.id === id);
    if (index < 0) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
    const at = new Date().toISOString();
    const [item] = data.items.splice(index, 1);
    change(data, id, 'remove', item, null, by, at);
    return true;
  });
}

export function summarize(v: string): ChecklistSummary {
  return summarizeChecklist(listChecklist(v));
}

export interface ChecklistSummary { green: number; yellow: number; red: number; done: number; blocked: string[]; byOwner: Record<string, number> }

export function summarizeChecklist(data: Checklist): ChecklistSummary {
  const summary = { green: 0, yellow: 0, red: 0, done: 0, blocked: [] as string[], byOwner: Object.create(null) as Record<string, number> };
  for (const item of data.items) {
    summary[item.status]++;
    if (item.status === 'red') summary.blocked.push(item.id);
    const owner = item.owner ?? 'unassigned';
    summary.byOwner[owner] = (summary.byOwner[owner] ?? 0) + 1;
  }
  return summary;
}

export interface ChecklistGate {
  ok: boolean;
  red: string[];
  undecided: string[];
  blocked: string[];
  moved: string[];
  knownIssues: Array<{ id: string; title: string; evidence: string }>;
  /** Screen cells whose `짝:` line is missing or has an untracked ⏳ — a warning; it never changes `ok`. */
  parity?: Array<{ id: string; why: string }>;
}

const PARITY_LINE = /짝:\s*PWA\s*(.+?)\s*·\s*데스크톱\s*(.+?)\s*·\s*폴드\s*(.+?)\s*·\s*아이폰\s*(.+?)\s*·\s*아이패드\s*(.+?)\s*$/m;
const PARITY_SURFACES = ['PWA', '데스크톱', '폴드', '아이폰', '아이패드'] as const;

/** Why a screen cell's evidence fails the five-surface rule, or null when it passes. */
export function parityGap(evidence: string | undefined): string | null {
  if (!evidence || !/짝:/.test(evidence)) return '근거에 짝: 줄이 없다';
  const match = PARITY_LINE.exec(evidence);
  if (!match) return '짝: 줄에 다섯 열(PWA · 데스크톱 · 폴드 · 아이폰 · 아이패드)이 다 없다';
  const untracked = PARITY_SURFACES.filter((_, i) => match[i + 1]!.includes('⏳') && !/\(칸 /.test(match[i + 1]!));
  return untracked.length ? `⏳ 에 (칸 …) 번호가 없다: ${untracked.join(', ')}` : null;
}

export function checklistGate(v: string): ChecklistGate {
  const result: ChecklistGate = { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [], parity: [] };
  for (const item of listChecklist(v).items) {
    if (item.kind === 'screen') {
      const why = parityGap(item.evidence);
      if (why) result.parity!.push({ id: item.id, why });
    }
    if (item.status === 'red') result.red.push(item.id);
    if (item.status !== 'yellow') continue;
    if (item.disposition === 'block') result.blocked.push(item.id);
    else if (item.disposition === 'move') result.moved.push(item.id);
    else if (item.disposition === 'known-issue') result.knownIssues.push({ id: item.id, title: item.title, evidence: item.evidence ?? '' });
    else result.undecided.push(item.id);
  }
  result.ok = result.red.length === 0 && result.undecided.length === 0 && result.blocked.length === 0;
  return result;
}

export function seedFromRoadmap(v: string, markdown: string): Checklist {
  return mutate(v, (data) => {
    let added = false;
    for (const line of markdown.split('\n')) {
      const match = /^\|\s*(K\d+[a-z]?[′']?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/.exec(line);
      if (!match || data.items.some((i) => i.id === match[1])) continue;
      const id = match[1]!;
      const title = match[2]!;
      const icon = match[3]!.trim();
      const status: ChecklistStatus = icon.startsWith('🟢') ? 'green' : icon.startsWith('🔴') ? 'red' : icon.startsWith('✅') ? 'done' : 'yellow';
      const at = new Date().toISOString();
      const by = process.env.ELANOUS_TRACK || 'cli';
      const item: ChecklistItem = { id, title, status, updatedAt: at, updatedBy: by };
      data.items.push(item);
      change(data, id, 'add', null, item, by, at);
      added = true;
    }
    return added;
  });
}
