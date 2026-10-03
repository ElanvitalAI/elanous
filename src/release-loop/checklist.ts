import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './feature-store.js';
import { debug } from '../debug/log.js';
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
  force?: true;
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

export function parseOwner(value: string): { seat: string; sub?: string } {
  const match = /^([A-Z]{2,8})(?:\/([a-z][a-z0-9-]{0,31}))?$/.exec(value);
  if (!match || match[0] !== value) throw new CliUserError(`잘못된 담당: ${value}`, 'TC 또는 TC/rel');
  return match[2] ? { seat: match[1]!, sub: match[2] } : { seat: match[1]! };
}

export function ownerMatches(owner: string | undefined, filter: string): boolean {
  if (owner === undefined) return false;
  try {
    const parsed = parseOwner(owner);
    const requested = parseOwner(filter);
    return parsed.seat === requested.seat && (requested.sub === undefined || parsed.sub === requested.sub);
  } catch { return false; }
}

// The ledger event schema has no force column; decode its claim target for every checklist snapshot.
export function decodeClaimHistoryEntry<T extends ChecklistHistory>(entry: T): T {
  if (entry.field !== 'claim' || !entry.to || typeof entry.to !== 'object') return entry;
  const target = entry.to as { owner?: unknown; force?: unknown };
  return typeof target.owner === 'string' && target.force === true ? { ...entry, to: target.owner, force: true } as T : entry;
}

function decodeClaimHistory(data: Checklist): Checklist {
  return { ...data, history: data.history.map(decodeClaimHistoryEntry) };
}

export function listChecklist(v: string): Checklist {
  return decodeClaimHistory(store.list(v));
}

/** Status events in the requested window; other ledger fields never become status changes. */
export function statusChangesSince(history: readonly ChecklistHistory[], sinceIso: string): ChecklistHistory[] {
  const since = Date.parse(sinceIso);
  return history.filter((entry) => entry.field === 'status' && Date.parse(entry.at) >= since);
}

function mutate(v: string, apply: (data: Checklist) => boolean): Checklist {
  return decodeClaimHistory(store.mutate(v, store.releasedVersion(), devVersion(), apply));
}

function change(data: Checklist, id: string, field: string, from: unknown, to: unknown, by: string, at: string): void {
  data.history.push({ at, by, id, field, from: from ?? null, to: to ?? null, released: data.released, dev: data.dev });
  debug.log('release-loop.checklist', 'change', { version: data.version, id, field, from: from ?? null, to: to ?? null, by });
}

export function addItem(v: string, input: { id: string; title: string; owner?: string; kind?: ChecklistKind }): Checklist {
  if (!input.id.trim()) throw new CliUserError('칸 id 가 비었다');
  if (!input.title.trim()) throw new CliUserError('칸 제목이 비었다');
  if (input.kind !== undefined && input.kind !== 'screen') throw new CliUserError(`잘못된 종류: ${input.kind}`, 'screen');
  if (input.owner !== undefined) parseOwner(input.owner);
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
    if (patch.owner !== undefined) {
      parseOwner(patch.owner);
      if (item.owner && patch.owner !== item.owner) {
        throw new CliUserError(`지금 주인: ${item.owner} — --force 로만 바꾼다`, 'release checklist claim <id> --by <자리> --force');
      }
    }
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

export function claimItem(v: string, id: string, by: string, options: { force?: boolean } = {}): Checklist {
  const requested = parseOwner(by);
  let outcome: 'claimed' | 'same' | 'refused' = 'refused';
  let from: string | null = null;
  try {
    const result = mutate(v, (data) => {
      const item = data.items.find((i) => i.id === id);
      if (!item) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
      from = item.owner ?? null;
      if (from === by) { outcome = 'same'; return false; }
      if (from && !options.force && !(from === requested.seat && requested.sub)) {
        throw new CliUserError(`지금 주인: ${from} — --force 로만 바꾼다`);
      }
      const at = new Date().toISOString();
      item.owner = by;
      item.updatedAt = at;
      item.updatedBy = by;
      data.history.push({ at, by, id, field: 'claim', from, to: options.force ? { owner: by, force: true } : by,
        released: data.released, dev: data.dev });
      outcome = 'claimed';
      return true;
    });
    return result;
  } finally {
    debug.log('release-loop.checklist', 'claim', { version: v, id, from, to: by, force: options.force === true, outcome });
  }
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

export interface ChecklistSummary { green: number; yellow: number; red: number; done: number; blocked: string[]; byOwner: Record<string, number>; bySeat: Record<string, number> }

export function summarizeChecklist(data: Checklist): ChecklistSummary {
  const summary = { green: 0, yellow: 0, red: 0, done: 0, blocked: [] as string[], byOwner: Object.create(null) as Record<string, number>, bySeat: Object.create(null) as Record<string, number> };
  for (const item of data.items) {
    summary[item.status]++;
    if (item.status === 'red') summary.blocked.push(item.id);
    const owner = item.owner ?? 'unassigned';
    summary.byOwner[owner] = (summary.byOwner[owner] ?? 0) + 1;
    if (item.owner !== undefined) {
      try {
        const { seat } = parseOwner(item.owner);
        summary.bySeat[seat] = (summary.bySeat[seat] ?? 0) + 1;
      } catch { /* Preserve legacy owner in byOwner without assigning it to a seat. */ }
    }
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
