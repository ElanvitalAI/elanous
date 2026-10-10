import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliUserError } from '../cli/cli-user-error.js';
import { resolveRepositoryName } from '../harness/repository-name.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { userConfigPath } from '../user-config.js';
import { addItem, listChecklist, ownerMatches, parseOwner, setItem, validateCeoLoad, type ChecklistItem } from './checklist.js';
import { assignedVersions, move, releasedVersion } from './feature-store.js';
import { debug } from '../debug/log.js';
import { kstDay, listSchedules, type ReleaseSchedule } from './release-schedule.js';
import { parseRubric, rubricScore, type rubricGrade } from './rubric.js';

export type PlacementPriority = 'P0' | 'P1' | 'P2';
export interface PlacementCell { id: string; title: string; owner: string; priority: PlacementPriority; grade?: ReturnType<typeof rubricGrade>; predecessors: string[]; deadlineVersion?: string; ceoMinutes?: number; ceoDate?: string; accelerator?: boolean }
export interface PlacementDecision { id: string; from: string | null; version: string; reason: string; displaced: Array<{ id: string; from: string; to: string; reason: string }> }
export interface RebalanceResult {
  decisions: PlacementDecision[];
  blocked: Array<{ id: string; from: string; to: string; reason: string }>;
}
export interface PlacementDeps {
  now?: Date;
  schedules?: ReleaseSchedule[];
  merged24h?: number;
  seatCap?: Record<string, number>;
  ceoDailyCap?: number;
  ceoCalendar?: CeoCalendar;
  checklist?: typeof listChecklist;
  released?: string;
  dryRun?: boolean;
  by?: string;
  /** Backlog releases are a source of cells, never a placement target (default {@link BACKLOG_VERSIONS}). */
  backlog?: readonly string[];
}

/** 0.9.0 is the backlog bucket: cells are pulled out of it, never placed into it. */
export const BACKLOG_VERSIONS: readonly string[] = ['0.9.0'];

function versionOrder(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/** Where each cell id lives. An id may repeat when one copy is in an already released version — history kept two
 *  different cells under one id (IA1 · EV10a … in 0.2.6~0.2.15) and later cells reused old ids (INSIDE1 0.2.11 ⊕
 *  0.2.19). A released copy is history: an open copy wins over it, and between released copies the latest wins. Only
 *  two open copies are a real conflict (ORCH-LIVE-1008 rehearsal 1: every placement failed on «여러 판의 같은 칸»). */
function cellLocations(snapshots: Iterable<[string, readonly { id: string }[]]>, released: string | null | undefined, skip: readonly string[] = []): { locations: Map<string, string>; conflict: string | null } {
  const locations = new Map<string, string>();
  const shipped = (version: string) => !!released && versionOrder(version, released) <= 0;
  for (const [version, items] of snapshots) {
    if (skip.includes(version)) continue;
    for (const item of items) {
      const previous = locations.get(item.id);
      if (previous !== undefined) {
        if (!shipped(previous) && !shipped(version)) return { locations, conflict: item.id };
        // Keep the open copy; between two released copies keep the later one.
        const keepPrevious = shipped(version) && (!shipped(previous) || versionOrder(version, previous) < 0);
        if (keepPrevious) continue;
      }
      locations.set(item.id, version);
    }
  }
  return { locations, conflict: null };
}

/** The merged PR list is a first-class GitHub query, not a count inferred from checklist status. */
// ORCH-LIVE-1008: the orchestrator tick runs from the installed package (not a git checkout), where a bare `gh pr list`
// fails «not a git repository» and placement silently left every cell unplaced — so the repository is named explicitly
// (--repo > harness.repo > GH_REPO > the checkout's remote · `resolveRepositoryName`).
export function mergedPrsLast24h(now = new Date()): number {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  let repo: string;
  try { repo = resolveRepositoryName(); }
  catch (error) {
    throw new CliUserError(`병합 PR 속도 조회 실패: 저장소를 못 정했다 — ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`, 'harness.repo 설정(owner/name) 또는 GH_REPO');
  }
  const r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since.slice(0, 10)}`, '--limit', '1000', '--json', 'number,mergedAt'], { encoding: 'utf8' });
  if (r.status !== 0) throw new CliUserError(`병합 PR 속도 조회 실패: ${(r.stderr || r.error || '').toString().trim()}`);
  let rows: Array<{ number: number; mergedAt: string }>;
  try { rows = JSON.parse(r.stdout) as typeof rows; }
  catch { throw new CliUserError('병합 PR 속도 응답이 JSON 이 아니다'); }
  if (!Array.isArray(rows) || rows.length >= 1000 || rows.some((row) => typeof row.number !== 'number' || typeof row.mergedAt !== 'string' || !Number.isFinite(Date.parse(row.mergedAt))))
    throw new CliUserError('병합 PR 속도 조회가 잘렸거나 잘못됐다');
  return rows.filter((row) => Date.parse(row.mergedAt) >= Date.parse(since) && Date.parse(row.mergedAt) <= now.getTime()).length;
}

export interface CeoCalendar {
  /** KST inclusive term ranges. A term cap can tighten the normal daily budget. */
  terms?: Array<{ from: string; to: string; dailyCap: number }>;
  /** KST event days explicitly override the term/normal cap, including exceptions with extra time. */
  events?: Record<string, number>;
}

function placementConfig(root?: string): { seatCap?: Record<string, number>; ceoDailyCap?: number; ceoCalendar?: CeoCalendar } {
  const path = root !== undefined ? join(root, 'config.json')
    : getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { placement?: { seatCap?: Record<string, number>; ceoDailyCap?: number; ceoCalendar?: CeoCalendar } } };
  return raw.release?.placement ?? {};
}

export function placementSeatCap(): Record<string, number> { return placementConfig().seatCap ?? {}; }
function validCeoCap(cap: number): number {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new CliUserError('잘못된 대표 하루 상한: release.placement.ceoDailyCap');
  return cap;
}

export function placementCeoDailyCap(): number { return validCeoCap(placementConfig().ceoDailyCap ?? 30); }

function validDay(day: string): boolean {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function calendarCap(day: string, cap: number, calendar: CeoCalendar): number {
  if (!calendar || (calendar.terms !== undefined && !Array.isArray(calendar.terms))
    || (calendar.events !== undefined && (!calendar.events || typeof calendar.events !== 'object' || Array.isArray(calendar.events))))
    throw new CliUserError('잘못된 대표 달력: release.placement.ceoCalendar');
  let effective = cap;
  for (const term of calendar.terms ?? []) {
    if (!term || typeof term !== 'object') throw new CliUserError('잘못된 대표 학기 달력: release.placement.ceoCalendar.terms');
    if (!validDay(term.from) || !validDay(term.to) || term.from > term.to) throw new CliUserError('잘못된 대표 학기 달력 날짜: release.placement.ceoCalendar.terms');
    validCeoCap(term.dailyCap);
    if (term.from <= day && day <= term.to) effective = Math.min(effective, term.dailyCap);
  }
  for (const [date, eventCap] of Object.entries(calendar.events ?? {})) {
    if (!validDay(date)) throw new CliUserError('잘못된 대표 행사 달력 날짜: release.placement.ceoCalendar.events');
    validCeoCap(eventCap);
  }
  return calendar.events?.[day] ?? effective;
}

/** Explicit day wins; otherwise a cell uses the target release's landing day in KST. */
function ceoDay(item: { ceoDate?: string }, row: ReleaseSchedule): string {
  return item.ceoDate ?? kstDay(row.landBy!);
}

type CeoWork = Pick<ChecklistItem, 'id' | 'ceoMinutes' | 'ceoDate'>;
function ceoOverload(item: CeoWork, row: ReleaseSchedule, snapshots: Map<string, { items: CeoWork[] }>, schedules: ReleaseSchedule[], cap: number, calendar: CeoCalendar = {}): string | null {
  if (!item.ceoMinutes) return null;
  const day = ceoDay(item, row);
  const limit = calendarCap(day, cap, calendar);
  const peers = [...snapshots].flatMap(([version, snapshot]) => {
    const schedule = schedules.find((candidate) => candidate.version === version);
    return snapshot.items.filter((other) => other.id !== item.id && other.ceoMinutes
      && (other.ceoDate === day || (!other.ceoDate && schedule?.landBy && ceoDay(other, schedule) === day)));
  });
  const total = item.ceoMinutes + peers.reduce((sum, other) => sum + other.ceoMinutes!, 0);
  if (total <= limit) return null;
  const reason = `대표 손 과부하 ${day} KST: ${[...peers.map((peer) => `${peer.id} ${peer.ceoMinutes}분`), `${item.id} ${item.ceoMinutes}분`].join(' + ')} = ${total}분 > 하루 상한 ${limit}분 — 늦추기(다음 날짜/판) · 자리 대행(대표 분량 축소) · 묶기(촬영·승인 합산 분량 축소)를 제안`;
  debug.log('release.placement', 'ceo-overload', { day, id: item.id, total, cap: limit, reason });
  return reason;
}

/** Called by setSchedule before a landing-day change can overload an already placed cell. */
export function checkScheduleCeoLoad(version: string, landBy: string, root?: string): void {
  const schedules = listSchedules(root);
  const proposed = schedules.some((row) => row.version === version)
    ? schedules.map((row) => row.version === version ? { ...row, landBy } : row)
    : [...schedules, { version, cutAt: landBy, landBy, updatedAt: '', updatedBy: '' }];
  const target = proposed.find((row) => row.version === version)!;
  const targetItems = listChecklist(version, root).items;
  const changed = targetItems.filter((item) => item.ceoMinutes && !item.ceoDate);
  if (!changed.length) return;
  const versions = [...new Set([...proposed.map((row) => row.version), ...assignedVersions(root)])];
  const snapshots = new Map(versions.map((v) => [v, { items: v === version ? targetItems : listChecklist(v, root).items }]));
  const config = placementConfig(root);
  const cap = validCeoCap(config.ceoDailyCap ?? 30);
  for (const item of changed) {
    const issue = ceoOverload(item, target, snapshots, proposed, cap, config.ceoCalendar);
    if (issue) throw new CliUserError(issue);
  }
}

function dependencyViolation(
  snapshots: Map<string, { items: ChecklistItem[] }>,
  locations: Map<string, string>,
  overrides: Map<string, string>,
  input: PlacementCell,
  released?: string | null,
): string | null {
  for (const [version, snapshot] of snapshots) for (const item of snapshot.items) {
    // A released version is history — its cells (and what they once depended on) never constrain a new placement.
    if (released && versionOrder(version, released) <= 0) continue;
    const predecessors = item.id === input.id ? input.predecessors : item.predecessors ?? [];
    // Only the cells this placement moves, and cells that depend on them, can be made wrong by it — a pre-existing
    // violation elsewhere on the board must not make every placement infeasible (ORCH-LIVE-1008 rehearsal 1).
    if (!overrides.has(item.id) && !predecessors.some((predecessor) => overrides.has(predecessor))) continue;
    const dependentVersion = overrides.get(item.id) ?? version;
    for (const predecessor of predecessors) {
      const predecessorVersion = overrides.get(predecessor) ?? locations.get(predecessor);
      if (!predecessorVersion || versionOrder(dependentVersion, predecessorVersion) <= 0)
        return `의존 칸 ${item.id}은 선행 칸 ${predecessor} 이후 판이어야 한다`;
    }
  }
  if (!locations.has(input.id)) for (const predecessor of input.predecessors) {
    const predecessorVersion = overrides.get(predecessor) ?? locations.get(predecessor);
    const dependentVersion = overrides.get(input.id);
    if (!predecessorVersion || !dependentVersion || versionOrder(dependentVersion, predecessorVersion) <= 0)
      return `의존 칸 ${input.id}은 선행 칸 ${predecessor} 이후 판이어야 한다`;
  }
  return null;
}

/** A freeze window holds operational rollout only; the release still exists and takes cells (OP 10-04 19:39). */
function available(row: ReleaseSchedule, now: number, backlog: readonly string[]): boolean {
  if (backlog.includes(row.version)) return false;
  return Date.parse(row.landBy ?? row.cutAt) > now;
}

export function placeCell(input: PlacementCell, deps: PlacementDeps = {}): PlacementDecision {
  if (!input.id.trim() || !input.title.trim()) throw new CliUserError('칸 id 와 제목이 필요하다');
  if (!Array.isArray(input.predecessors) || input.predecessors.some((id) => typeof id !== 'string' || !id.trim() || id === input.id)) throw new CliUserError('선행 칸 id 가 잘못됐다');
  validateCeoLoad(input);
  const seat = parseOwner(input.owner).seat;
  if (!['P0', 'P1', 'P2'].includes(input.priority)) throw new CliUserError(`잘못된 우선순위: ${input.priority}`);
  if (input.grade !== undefined && !['P1', 'P2', 'P3', 'P4'].includes(input.grade)) throw new CliUserError(`잘못된 루브릭 등급: ${input.grade}`);
  if (input.accelerator !== undefined && input.accelerator !== true && input.accelerator !== false) throw new CliUserError('가속 등급은 true 이거나 생략한다');
  const now = (deps.now ?? new Date()).getTime();
  const schedules = [...(deps.schedules ?? listSchedules())].sort((a, b) => versionOrder(a.version, b.version));
  const released = deps.released ?? releasedVersion();
  const backlog = deps.backlog ?? BACKLOG_VERSIONS;
  const open = schedules.filter((row) => (!released || versionOrder(row.version, released) > 0) && row.landBy && available(row, now, backlog));
  const sources = [...new Set([...schedules.map((row) => row.version), ...backlog])];
  const snapshots = new Map(sources.map((version) => [version, (deps.checklist ?? listChecklist)(version)]));
  const { locations, conflict } = cellLocations([...snapshots].map(([version, snapshot]) => [version, snapshot.items] as [string, readonly { id: string }[]]), released, backlog);
  if (conflict) throw new CliUserError(`여러 판의 같은 칸: ${conflict}`);
  if (input.ceoMinutes || [...snapshots.values()].some((snapshot) => snapshot.items.some((item) => item.id === input.id && item.ceoMinutes))) {
    for (const version of assignedVersions()) if (!snapshots.has(version)) snapshots.set(version, (deps.checklist ?? listChecklist)(version));
  }
  // A backlog copy never outranks a scheduled cell with the same id.
  for (const version of backlog) for (const item of snapshots.get(version)?.items ?? []) if (!locations.has(item.id)) locations.set(item.id, version);
  const from = locations.get(input.id) ?? null;
  const existing = from ? snapshots.get(from)!.items.find((item) => item.id === input.id)! : null;
  if (from && released && versionOrder(from, released) <= 0) throw new CliUserError(`이미 발행된 판의 칸은 배치하지 않는다: ${input.id}`);
  if (existing?.status === 'done') throw new CliUserError(`끝난 칸은 배치하지 않는다: ${input.id}`);
  if (existing && (existing.title !== input.title || existing.owner !== input.owner)) throw new CliUserError(`기존 칸 제목·담당 불일치: ${input.id}`);
  const accelerator = input.accelerator === true || (input.accelerator === undefined && existing?.accelerator === true);
  const load = { id: input.id, ceoMinutes: input.ceoMinutes ?? existing?.ceoMinutes, ceoDate: input.ceoDate ?? existing?.ceoDate };
  const ceoCap = validCeoCap(deps.ceoDailyCap ?? placementCeoDailyCap());
  const ceoCalendar = deps.ceoCalendar ?? placementConfig().ceoCalendar ?? {};
  const predecessors = input.predecessors.map((id) => {
    const version = locations.get(id);
    if (!version) throw new CliUserError(`없는 선행 칸: ${id}`);
    if (backlog.includes(version)) throw new CliUserError(`선행 칸 ${id} 이 백로그 ${version} 에 있다 — 먼저 배치하라`);
    return version;
  });
  const rate = deps.merged24h ?? mergedPrsLast24h(new Date(now));
  if (!Number.isInteger(rate) || rate < 0) throw new CliUserError('24시간 병합 PR 수가 잘못됐다');
  const caps = deps.seatCap ?? placementSeatCap();
  for (const [configuredSeat, limit] of Object.entries(caps)) if (!Number.isInteger(limit) || limit < 0) throw new CliUserError(`잘못된 자리 용량: ${configuredSeat}`);
  const seatLimit = caps[seat] ?? Infinity;
  const first = open[0];
  const deadlineVersion = input.priority === 'P0' ? undefined : input.deadlineVersion ?? existing?.deadlineVersion;
  if (input.priority === 'P1' && !deadlineVersion) throw new CliUserError(`P1 칸의 마감 판이 없다: ${input.id}`);
  if (input.priority !== 'P0' && deadlineVersion && !schedules.some((row) => row.version === deadlineVersion)) throw new CliUserError(`없는 마감 판: ${deadlineVersion}`);
  const eligible = open.filter((row) => predecessors.every((v) => versionOrder(row.version, v) > 0));
  // Rubric grades rank discretionary placement, not incident/deadline priority. A P4 needs a separate merge/drop decision.
  if (input.priority === 'P2' && input.grade === 'P4') throw new CliUserError(`${input.id} 배치할 판이 없다 — 루브릭 P4 칸은 합치거나 빼야 한다`);
  const discretionary = eligible.filter((row) => !deadlineVersion || versionOrder(row.version, deadlineVersion) <= 0);
  const candidates = input.priority === 'P0' ? eligible.filter((row) => row.version === first?.version)
    : input.priority === 'P1' ? eligible.filter((row) => row.version === deadlineVersion)
      : input.grade === 'P3' ? discretionary.reverse() : discretionary;

  const occupied = (version: string) => snapshots.get(version)!.items.filter((item) => item.status !== 'done' && item.id !== input.id);
  const capacity = (row: ReleaseSchedule) => Math.floor(rate * (Date.parse(row.landBy!) - now) / 86_400_000 * 0.7);
  const displaced: PlacementDecision['displaced'] = [];
  let chosen: ReleaseSchedule | undefined;
  let loadIssue: string | null = null;
  const feasible = candidates.filter((row) => !dependencyViolation(snapshots, locations, new Map([[input.id, row.version]]), input, released));
  // Without a deferral grade, keep the earliest eligible release; P3 starts at the latest eligible release.
  // Accelerator displacement still only affects an otherwise full candidate.
  for (const row of feasible) {
    const placement = new Map([[input.id, row.version]]);
    const items = occupied(row.version);
    const seatItems = items.filter((item) => ownerMatches(item.owner, seat));
    const directIssue = ceoOverload(load, row, snapshots, schedules, ceoCap, ceoCalendar);
    if (items.length < capacity(row) && seatItems.length < seatLimit) {
      if (directIssue) { loadIssue ??= directIssue; continue; }
      chosen = row;
      break;
    }
    const mayDisplace = input.priority === 'P1' ? from !== row.version : accelerator && from !== row.version;
    if (!mayDisplace) { loadIssue ??= directIssue; continue; }
    const next = open.find((later) => versionOrder(later.version, row.version) > 0);
    if (!next || items.length - 1 >= capacity(row)) { loadIssue ??= directIssue; continue; }
    const victimOk = (priority: PlacementPriority | undefined) => (input.priority === 'P1' && priority === 'P2')
      || (accelerator && priority === input.priority);
    const p2 = [...items].reverse().find((item) => {
      if (item.accelerator === true) return false;
      if (!victimOk(item.priority) || dependencyViolation(snapshots, locations, new Map([...placement, [item.id, next.version]]), input, released)) return false;
      if (item.deadlineVersion && versionOrder(next.version, item.deadlineVersion) > 0) return false;
      if (items.length < capacity(row) && !(seatItems.length >= seatLimit && ownerMatches(item.owner, seat))) return false;
      if (!item.owner) return false;
      const shiftedSeat = parseOwner(item.owner).seat;
      if (occupied(next.version).length >= capacity(next) || occupied(next.version).filter((other) => ownerMatches(other.owner, shiftedSeat)).length >= (caps[shiftedSeat] ?? Infinity)) return false;
      if (!(seatItems.length < seatLimit || (ownerMatches(item.owner, seat) && seatItems.length - 1 < seatLimit))) return false;

      // Evaluate both changed cells against the same post-placement state, before either ledger write.
      const proposed = new Map<string, { items: CeoWork[] }>([...snapshots].map(([version, snapshot]) => [version, { items: snapshot.items.filter((cell) => cell.id !== input.id && cell.id !== item.id) }]));
      proposed.get(row.version)!.items.push(load);
      proposed.get(next.version)!.items.push(item);
      const issue = ceoOverload(load, row, proposed, schedules, ceoCap, ceoCalendar)
        ?? ceoOverload(item, next, proposed, schedules, ceoCap, ceoCalendar);
      if (issue) { loadIssue ??= issue; return false; }
      return true;
    });
    if (p2) {
      displaced.push({ id: p2.id, from: row.version, to: next.version, reason: accelerator
        ? `가속 등급 ${input.id} 를 같은 우선순위 안에서 먼저 두기 위해 ${p2.priority ?? 'P2'} ${p2.id} 이월`
        : `P1 ${input.id} 마감 판 ${row.version} 용량 확보를 위해 P2 이월` });
      chosen = row;
      break;
    }
    loadIssue ??= directIssue;
  }
  if (!chosen) throw new CliUserError(loadIssue ?? `${input.id} 배치할 판이 없다 — 용량·선행·마감·동결을 확인하라`);
  const reason = `${accelerator ? '가속 등급 · ' : ''}${input.priority} ${input.priority === 'P0' ? '사고·회귀·발행 막음: 다음 판' : input.priority === 'P1' ? `지시·행사 마감 판 ${deadlineVersion}` : input.grade === 'P3' ? '루브릭 P3: 착지 마감 내 가장 늦은 여유 판부터' : '착지 마감 내 가장 이른 여유 판'}${accelerator ? ' · 같은 우선순위 안에서 가속 등급을 먼저' : ''} · PR/24h ${rate} · 용량 ${capacity(chosen)} · 자리 ${seatLimit}`;
  const decision = { id: input.id, from, version: chosen.version, reason, displaced };
  if (!deps.dryRun) {
    const by = deps.by ?? 'OP';
    for (const shifted of displaced) move(shifted.id, shifted.from, shifted.to, by, undefined, undefined, shifted.reason);
    if (from && from !== chosen.version) move(input.id, from, chosen.version, by, undefined, undefined, reason);
    if (from && (existing?.priority !== input.priority || JSON.stringify(existing.predecessors ?? []) !== JSON.stringify(input.predecessors) || (input.deadlineVersion !== undefined && existing.deadlineVersion !== input.deadlineVersion) || (input.ceoMinutes !== undefined && existing.ceoMinutes !== input.ceoMinutes) || (input.ceoDate !== undefined && existing.ceoDate !== input.ceoDate) || (input.accelerator !== undefined && (existing?.accelerator === true) !== (input.accelerator === true))))
      setItem(chosen.version, input.id, { priority: input.priority, predecessors: input.predecessors, ...(input.deadlineVersion ? { deadlineVersion: input.deadlineVersion } : {}), ...(input.ceoMinutes !== undefined ? { ceoMinutes: input.ceoMinutes } : {}), ...(input.ceoDate !== undefined ? { ceoDate: input.ceoDate } : {}), ...(input.accelerator !== undefined ? { accelerator: input.accelerator === true ? true : null } : {}) }, by);
    if (!from) addItem(chosen.version, { id: input.id, title: input.title, owner: input.owner, priority: input.priority, predecessors: input.predecessors, deadlineVersion, ...(load.ceoMinutes !== undefined ? { ceoMinutes: load.ceoMinutes } : {}), ...(load.ceoDate !== undefined ? { ceoDate: load.ceoDate } : {}), ...(accelerator ? { accelerator: true } : {}) });
  }
  return decision;
}

function moveConstraint(
  item: ChecklistItem, to: ReleaseSchedule, backlog: readonly string[],
  snapshots: Map<string, ChecklistItem[]>, now: number, rate: number, caps: Record<string, number>, rows: ReleaseSchedule[], ceoCap: number, calendar: CeoCalendar,
  released: string | null | undefined,
): string | null {
  if (!to.landBy || !available(to, now, backlog)) return '착지 마감이 지났거나 백로그 판이라 이동 불가';
  if (item.deadlineVersion && versionOrder(to.version, item.deadlineVersion) > 0) return '마감 판 뒤로 이월 불가';
  if (!item.owner) return '담당 없는 칸은 이동 불가';
  const seat = parseOwner(item.owner).seat;
  const destination = snapshots.get(to.version) ?? [];
  if (destination.filter((cell) => cell.status !== 'done').length >= Math.floor(rate * (Date.parse(to.landBy) - now) / 86_400_000 * 0.7)) return '다음 판 PR 용량 초과';
  if (destination.filter((cell) => cell.status !== 'done' && ownerMatches(cell.owner, seat)).length >= (caps[seat] ?? Infinity)) return '다음 판 자리 용량 초과';
  const ceoSnapshots = new Map([...snapshots].map(([version, items]) => [version, { items }]));
  if (item.ceoMinutes) for (const version of assignedVersions()) {
    if (!ceoSnapshots.has(version)) ceoSnapshots.set(version, { items: listChecklist(version).items });
  }
  const loadIssue = ceoOverload(item, to, ceoSnapshots, rows, ceoCap, calendar);
  if (loadIssue) return loadIssue;
  const { locations, conflict } = cellLocations(snapshots, released);
  if (conflict) return `여러 판의 같은 칸: ${conflict}`;
  for (const predecessor of item.predecessors ?? []) {
    const location = locations.get(predecessor);
    if (!location || versionOrder(to.version, location) <= 0) return `선행 칸 ${predecessor} 이후 판으로만 이동 가능`;
  }
  for (const [version, items] of snapshots) for (const dependent of items) {
    // A released version is history — its cells never pin a move (same rule as placement).
    if (released && versionOrder(version, released) <= 0) continue;
    if (dependent.id !== item.id && dependent.predecessors?.includes(item.id) && versionOrder(version, to.version) <= 0)
      return `의존 칸 ${dependent.id} 이전 판으로만 이동 가능`;
  }
  return null;
}

/** Only unstarted cells inside the two-hour pre-deadline window move; a dry run never writes. */
export function rebalance(version: string, deps: PlacementDeps = {}): RebalanceResult {
  const rows = [...(deps.schedules ?? listSchedules())].sort((a, b) => versionOrder(a.version, b.version));
  const current = rows.find((row) => row.version === version);
  if (!current?.landBy) throw new CliUserError(`착지 마감이 없는 판: ${version}`);
  const now = (deps.now ?? new Date()).getTime();
  if (Date.parse(current.landBy) - now > 7_200_000 || Date.parse(current.landBy) <= now) return { decisions: [], blocked: [] };
  const backlog = deps.backlog ?? BACKLOG_VERSIONS;
  const next = rows.find((row) => versionOrder(row.version, version) > 0 && !backlog.includes(row.version));
  const snapshots = new Map(rows.map((row) => [row.version, [...(deps.checklist ?? listChecklist)(row.version).items]]));
  const unstarted = snapshots.get(version)!.filter((item) => item.status === 'yellow' && !item.evidence)
    .map((item, index) => {
      const rubric = parseRubric(`${item.title}\n${item.evidence ?? ''}`);
      return { item, index, score: rubric ? rubricScore(rubric) : null };
    })
    .sort((a, b) => {
      if (a.score === null) return b.score === null ? a.index - b.index : 1;
      if (b.score === null) return -1;
      return a.score - b.score || a.index - b.index;
    });
  if (unstarted.length && !next) throw new CliUserError(`${version} 다음 판이 없다`);
  if (!unstarted.length) return { decisions: [], blocked: [] };
  const rate = deps.merged24h ?? mergedPrsLast24h(new Date(now));
  const caps = deps.seatCap ?? placementSeatCap();
  const ceoCap = validCeoCap(deps.ceoDailyCap ?? placementCeoDailyCap());
  const ceoCalendar = deps.ceoCalendar ?? placementConfig().ceoCalendar ?? {};
  const result: RebalanceResult = { decisions: [], blocked: [] };
  for (const { item, score } of unstarted) {
    const violation = moveConstraint(item, next!, backlog, snapshots, now, rate, caps, rows, ceoCap, ceoCalendar, deps.released ?? releasedVersion());
    if (violation) {
      result.blocked.push({ id: item.id, from: version, to: next!.version, reason: violation });
      continue;
    }
    const reason = `${version} 착지 마감 2시간 전 미시작 칸 이월${score === null ? '' : ` · 루브릭 ${score}`}`;
    result.decisions.push({ id: item.id, from: version, version: next!.version, reason, displaced: [] });
    snapshots.set(version, snapshots.get(version)!.filter((cell) => cell.id !== item.id));
    snapshots.get(next!.version)!.push(item);
  }
  if (!deps.dryRun) for (const decision of result.decisions) move(decision.id, version, decision.version, deps.by ?? 'OP', undefined, undefined, decision.reason);
  return result;
}

/** A seat may defer its own cell one release, never pull another owner's cell forward. */
export function seatMove(id: string, from: string, to: string, by: string, reason: string, deps: PlacementDeps = {}): void {
  if (!reason.trim()) throw new CliUserError('이동 이유가 필요하다');
  const rows = [...(deps.schedules ?? listSchedules())].sort((a, b) => versionOrder(a.version, b.version));
  const backlog = deps.backlog ?? BACKLOG_VERSIONS;
  const next = rows.find((row) => versionOrder(row.version, from) > 0 && !backlog.includes(row.version));
  const snapshots = new Map(rows.map((row) => [row.version, (deps.checklist ?? listChecklist)(row.version).items]));
  const item = snapshots.get(from)?.find((cell) => cell.id === id);
  if (!item) throw new CliUserError(`없는 칸: ${id}`);
  if (!ownerMatches(item.owner, parseOwner(by).seat) || next?.version !== to) throw new CliUserError('남의 칸 당기기 거부 — COO 에 요청');
  const now = (deps.now ?? new Date()).getTime();
  const rate = deps.merged24h ?? mergedPrsLast24h(new Date(now));
  const violation = moveConstraint(item, next, backlog, snapshots, now, rate, deps.seatCap ?? placementSeatCap(), rows, validCeoCap(deps.ceoDailyCap ?? placementCeoDailyCap()), deps.ceoCalendar ?? placementConfig().ceoCalendar ?? {}, deps.released ?? releasedVersion());
  if (violation) throw new CliUserError(`${id}: ${violation}`);
  if (!deps.dryRun) move(id, from, to, by, undefined, undefined, reason);
}
