import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
  priority?: 'P0' | 'P1' | 'P2';
  predecessors?: string[];
  deadlineVersion?: string;
  ceoMinutes?: number;
  ceoDate?: string;
  /** 다른 칸의 처리량을 올리는 칸(자율성·효율성·동시성). 없으면 가속 등급이 아니다. */
  accelerator?: true;
  /** 이 칸이 근거로 삼는 문서(저장소 상대 경로, 선택적으로 `#절`). 없으면 칸에 실리지 않는다. */
  refs?: string[];
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
  reason?: string;
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

/** The checklist version of the development tree: package.json says `0.2.18-dev.0` once a release branch is cut,
 * but the checklist only knows `0.2.18` (10-07: every server caller that passed devVersion() raw got null/throw). */
export function checklistDevVersion(version = devVersion()): string {
  return version.replace(/-dev\.\d+$/, '');
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

export function listChecklist(v: string, root?: string): Checklist {
  return decodeClaimHistory(root === undefined ? store.list(v) : store.list(v, undefined, undefined, root));
}

/** Events for this id across every release, ordered by event time (then ledger sequence). */
export function checklistHistory(id: string): Array<ChecklistHistory & { version: string; seq: number }> {
  return store.history(id).map(decodeClaimHistoryEntry);
}

/** Status events in the requested window; other ledger fields never become status changes. */
export function statusChangesSince(history: readonly ChecklistHistory[], sinceIso: string): ChecklistHistory[] {
  const since = Date.parse(sinceIso);
  return history.filter((entry) => entry.field === 'status' && Date.parse(entry.at) >= since);
}

function mutate(v: string, apply: (data: Checklist, otherItems: (id: string) => store.ChecklistCollision[]) => boolean): Checklist {
  return decodeClaimHistory(store.mutate(v, store.releasedVersion(), devVersion(), apply));
}

function change(data: Checklist, id: string, field: string, from: unknown, to: unknown, by: string, at: string): void {
  data.history.push({ at, by, id, field, from: from ?? null, to: to ?? null, released: data.released, dev: data.dev });
  debug.log('release-loop.checklist', 'change', { version: data.version, id, field, from: from ?? null, to: to ?? null, by });
}

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** `--ref` 문서를 찾는 뿌리들 — 이 코드의 트리 ⊕ 지금 작업 디렉토리의 git 뿌리.
 *  ⭐ 설치본(`~/.local/share/elanous/current`)에는 `docs/` 가 없다 — 저장소 안에서 부른 설치본도 저장소 문서를 인용할 수 있게. */
export function refRoots(cwd = process.cwd()): string[] {
  const roots = [REPO_ROOT];
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5_000 });
    const path = top.status === 0 ? top.stdout.trim() : '';
    if (path && !roots.includes(path)) roots.push(path);
  } catch { /* git 없음 — 코드 트리만 */ }
  return roots;
}

/** `--ref` 값 검사: 저장소 상대 경로(⊕ `#절`)이고 그 파일이 뿌리들 중 하나에 있어야 한다. 중복은 순서를 지키며 지운다. */
export function normalizeRefs(refs: readonly string[], root: string | readonly string[] = refRoots()): string[] {
  const roots = typeof root === 'string' ? [root] : root;
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    const path = ref.split('#')[0] ?? '';
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..')) throw new CliUserError(`잘못된 문서 참조: ${raw}`, '저장소 상대 경로[#절] — 예: docs/manual/MANUAL-x.md#§1');
    let isFile = false;
    for (const base of roots) {
      try { if (statSync(join(base, path)).isFile()) { isFile = true; break; } } catch { /* 없음 */ }
    }
    if (!isFile) throw new CliUserError(`없는 문서: ${path}`, '저장소 상대 «파일» 경로로 준다(폴더는 안 된다)');
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** 한 문서를 인용하는 칸 한 줄 — `release checklist refs <doc>` 의 «구현 현황» 행. */
export interface DocRefRow { version: string; id: string; title: string; status: ChecklistStatus; owner: string | null; section: string | null }

function splitRef(ref: string): { path: string; section: string | null } {
  const at = ref.indexOf('#');
  const path = (at < 0 ? ref : ref.slice(0, at)).trim().replace(/^\.\//, '');
  return { path, section: at < 0 ? null : ref.slice(at + 1) };
}

/** 읽기 전용: 칸의 refs 중 경로(`#` 앞)가 doc 의 경로와 같은 것을 행으로 낸다. doc 에 `#절`이 붙으면 그 절과 정확히 같은 ref 만. */
export function cellsReferencingDoc(doc: string, checklists: readonly Checklist[]): DocRefRow[] {
  const want = splitRef(doc.trim());
  const rows: DocRefRow[] = [];
  for (const data of checklists) {
    for (const item of data.items) {
      // 칸마다 한 행 — 같은 문서의 절을 여럿 인용해도 절을 모아 한 줄로(절 없는 인용이 섞이면 문서 전체로 본다).
      const sections: string[] = [];
      let whole = false;
      for (const ref of item.refs ?? []) {
        const got = splitRef(ref);
        if (got.path !== want.path) continue;
        if (want.section !== null && got.section !== want.section) continue;
        if (got.section === null) whole = true;
        else if (!sections.includes(got.section)) sections.push(got.section);
      }
      if (!whole && sections.length === 0) continue;
      rows.push({ version: data.version, id: item.id, title: item.title, status: item.status, owner: item.owner ?? null, section: whole ? null : sections.join(' · ') });
    }
  }
  return rows;
}

/** `| 판 | 칸 | 상태 | 절 | 제목 |` 마크다운 표 — 행이 없으면 머리줄 둘만. */
export function renderRefsStatus(rows: readonly DocRefRow[]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return ['| 판 | 칸 | 상태 | 절 | 제목 |', '| --- | --- | --- | --- | --- |', ...rows.map((row) => `| ${cell(row.version)} | ${cell(row.id)} | ${row.status} | ${cell(row.section ?? '-')} | ${cell(row.title)} |`)].join('\n');
}

export function validateCeoLoad(input: { ceoMinutes?: number; ceoDate?: string }): void {
  if (input.ceoMinutes !== undefined && (!Number.isSafeInteger(input.ceoMinutes) || input.ceoMinutes < 0)) throw new CliUserError('대표 손 분량은 0 이상의 정수 분이어야 한다');
  if (input.ceoDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.ceoDate) || !Number.isFinite(Date.parse(`${input.ceoDate}T00:00:00Z`)) || new Date(`${input.ceoDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.ceoDate)) throw new CliUserError('대표 손 날짜는 YYYY-MM-DD 이어야 한다');
}

export function addItem(v: string, input: { id: string; title: string; refs?: string[]; owner?: string; kind?: ChecklistKind; priority?: ChecklistItem['priority']; predecessors?: string[]; deadlineVersion?: string; ceoMinutes?: number; ceoDate?: string; accelerator?: boolean }, options: { allowDuplicateId?: boolean } = {}): Checklist {
  if (!input.id.trim()) throw new CliUserError('칸 id 가 비었다');
  if (!input.title.trim()) throw new CliUserError('칸 제목이 비었다');
  if (input.kind !== undefined && input.kind !== 'screen') throw new CliUserError(`잘못된 종류: ${input.kind}`, 'screen');
  if (input.owner !== undefined) parseOwner(input.owner);
  if (input.priority !== undefined && !['P0', 'P1', 'P2'].includes(input.priority)) throw new CliUserError(`잘못된 우선순위: ${input.priority}`);
  if (input.predecessors !== undefined && (!Array.isArray(input.predecessors) || input.predecessors.some((p) => typeof p !== 'string' || !p.trim() || p === input.id))) throw new CliUserError('잘못된 선행 칸');
  if (input.deadlineVersion !== undefined) store.validateVersion(input.deadlineVersion);
  if (input.accelerator !== undefined && input.accelerator !== true) throw new CliUserError('가속 등급은 true 이거나 생략한다');
  validateCeoLoad(input);
  const refs = input.refs !== undefined && input.refs.length ? normalizeRefs(input.refs) : undefined;
  return mutate(v, (data, otherItems) => {
    if (data.items.some((item) => item.id === input.id)) throw new CliUserError(`이미 있는 칸: ${input.id}`, 'set <id> 로 고친다');
    const collisions = otherItems(input.id);
    if (collisions.length) {
      const displayedId = JSON.stringify(input.id).slice(1, -1);
      console.error(`⚠ 중복 id: ${displayedId} — ${collisions.map((item) => `${item.version} · 담당 ${JSON.stringify(item.owner ?? '-').slice(1, -1)} · ${item.title.replace(/\s+/g, ' ').slice(0, 40)}`).join(' / ')}`);
      if (!options.allowDuplicateId) throw new CliUserError(`다른 판에 이미 있는 칸: ${displayedId}`, '--allow-duplicate-id 로 허용');
    }
    const by = process.env.ELANOUS_TRACK || 'cli';
    const at = new Date().toISOString();
    const item: ChecklistItem = { id: input.id, title: input.title, status: 'yellow', ...(input.owner !== undefined ? { owner: input.owner } : {}), ...(input.kind !== undefined ? { kind: input.kind } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}), ...(input.predecessors !== undefined ? { predecessors: input.predecessors } : {}), ...(input.deadlineVersion !== undefined ? { deadlineVersion: input.deadlineVersion } : {}), ...(input.ceoMinutes !== undefined ? { ceoMinutes: input.ceoMinutes } : {}), ...(input.ceoDate !== undefined ? { ceoDate: input.ceoDate } : {}), ...(input.accelerator === true ? { accelerator: true as const } : {}), ...(refs ? { refs } : {}), updatedAt: at, updatedBy: by };
    data.items.push(item);
    change(data, item.id, 'add', null, item, by, at);
    return true;
  });
}

export function setItem(v: string, id: string, patch: { status?: ChecklistStatus; evidence?: string; refs?: string[]; owner?: string; disposition?: ChecklistDisposition; kind?: ChecklistKind; priority?: ChecklistItem['priority']; predecessors?: string[]; deadlineVersion?: string; ceoMinutes?: number; ceoDate?: string; accelerator?: boolean | null }, by: string): Checklist {
  return mutate(v, (data) => {
    const item = data.items.find((i) => i.id === id);
    if (!item) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
    if (patch.status !== undefined && !['green', 'yellow', 'red', 'done'].includes(patch.status)) throw new CliUserError(`잘못된 상태: ${patch.status}`);
    if (patch.disposition !== undefined && !['move', 'known-issue', 'block'].includes(patch.disposition)) throw new CliUserError(`잘못된 처분: ${patch.disposition}`);
    if (patch.kind !== undefined && patch.kind !== 'screen') throw new CliUserError(`잘못된 종류: ${patch.kind}`, 'screen');
    if (patch.priority !== undefined && !['P0', 'P1', 'P2'].includes(patch.priority)) throw new CliUserError(`잘못된 우선순위: ${patch.priority}`);
    if (patch.predecessors !== undefined && (!Array.isArray(patch.predecessors) || patch.predecessors.some((p) => typeof p !== 'string' || !p.trim() || p === id))) throw new CliUserError('잘못된 선행 칸');
    if (patch.deadlineVersion !== undefined) store.validateVersion(patch.deadlineVersion);
    if (patch.accelerator !== undefined && patch.accelerator !== true && patch.accelerator !== null) throw new CliUserError('가속 등급은 true(부여) 또는 null(해제)이다');
    validateCeoLoad(patch);
    // --ref 는 «더하기»다 — 기존 참조 뒤에 붙이고 중복을 지운다.
    if (patch.refs !== undefined) patch = { ...patch, refs: normalizeRefs([...(item.refs ?? []), ...patch.refs]) };
    if (patch.owner !== undefined) {
      parseOwner(patch.owner);
      if (item.owner && patch.owner !== item.owner) {
        throw new CliUserError(`지금 주인: ${item.owner} — --force 로만 바꾼다`, 'release checklist claim <id> --by <자리> --force');
      }
    }
    const fields = (['evidence', 'owner', 'status', 'disposition', 'kind', 'priority', 'predecessors', 'deadlineVersion', 'ceoMinutes', 'ceoDate', 'accelerator', 'refs'] as const).filter((field) => patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(item[field] ?? null));
    if (fields.length === 0) return false;
    const at = new Date().toISOString();
    for (const field of fields) {
      const from = item[field];
      const to = patch[field]!;
      if (field === 'accelerator' && to === null) delete item.accelerator;
      else (item as unknown as Record<string, unknown>)[field] = to;
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

/** GATE-ENTRY-ALIGN: the cut-time judgement shared by `release run`'s entry check and the checklist-gate node —
 *  past the landing deadline a non-P0 yellow without a disposition is carried (moved), and a P0 yellow always blocks. */
export function cutChecklistGate(v: string, landBy: string | null | undefined, now: Date = new Date()): ChecklistGate & { autoMoved: string[] } {
  const items = listChecklist(v).items;
  const overdue = landBy !== null && landBy !== undefined && now.getTime() > Date.parse(landBy);
  const autoMoved = overdue ? items.filter((item) => item.status === 'yellow' && item.priority !== 'P0' && item.disposition === undefined).map((item) => item.id) : [];
  const p0 = items.filter((item) => item.status === 'yellow' && item.priority === 'P0').map((item) => item.id);
  const gate = checklistGate(v);
  gate.undecided = gate.undecided.filter((id) => !autoMoved.includes(id) && !p0.includes(id));
  gate.moved = gate.moved.filter((id) => !p0.includes(id)).concat(autoMoved);
  gate.knownIssues = gate.knownIssues.filter((item) => !p0.includes(item.id));
  gate.blocked.push(...p0.filter((id) => !gate.blocked.includes(id)));
  gate.ok = gate.red.length === 0 && gate.undecided.length === 0 && gate.blocked.length === 0;
  return { ...gate, autoMoved };
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
