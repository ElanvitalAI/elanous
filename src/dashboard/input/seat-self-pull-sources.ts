// ── SEAT-SELF-PULL 재료 읽기 `seat-self-pull-sources` (2026-11-17) ───────────────────────────────────
//
// 선택기(`seat-self-pull.ts`)에 넘길 재료를 실제 원장에서 «읽기만» 한다:
//   ⓐ release checklist — 컷이 아직 앞에 있는 판(seat-loop 와 같은 기준)의 칸 중 주인 = 이 자리 · 선행 칸 상태
//   ⓑ traffic.json hold · feeder/handed.txt (seat-loop 와 같은 리더 `traffic-signal.ts`)
//   ⓒ WORK-QUEUE — 자리 폴더의 `WORK-QUEUE*.tsv|md` ⊕ opt-in 파일(`self-pull`)에 적힌 추가 경로
// ⛔ 쓰기 0(claim·상태 전이·우편 ack 0). 못 읽는 판은 건너뛰고(관측 한 줄), 신호를 못 읽으면 집지 않는다(fail-closed).
// 파서(`parseWorkQueueTsv`·`parseWorkQueueMarkdown`)는 순수 함수 — 시험은 문자열로 잰다.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { openMsgStore } from '../../msg/msg-store.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import {
  createSeatSelfPull,
  formatSelfPullPrompt,
  ownerSeat,
  SEAT_SELF_PULL_FILE,
  type SelfPullCandidate,
  type SelfPullNoWorkContext,
  type SelfPullSources,
} from './seat-self-pull.js';

// ── WORK-QUEUE 파서 ───────────────────────────────────────────────────────────────────

export interface WorkQueueEntry {
  id: string;
  title: string;
  owner: string | null;
  /** open = 집을 수 있는 상태 · done = 끝(선행 판정용) · unknown = 상태 칸 없음/모름. */
  state: 'open' | 'done' | 'claimed' | 'hold' | 'blocked' | 'unknown';
  claim: string | null;
  rank: number | null;
  ordinal: number;
  predecessors: string[];
}

const TSV_OPEN = new Set(['', 'open', 'ready', 'todo', 'queued', 'pending', 'unclaimed', 'returned', 'yellow', 'red']);
const TSV_DONE = new Set(['done', 'closed', 'cancelled', 'canceled', 'merged', 'landed', 'superseded', 'dropped', 'green']);

function tsvState(status: string): WorkQueueEntry['state'] {
  const s = status.trim().toLowerCase();
  if (TSV_OPEN.has(s)) return 'open';
  if (TSV_DONE.has(s)) return 'done';
  if (s === 'claimed') return 'claimed';
  if (s === 'hold') return 'hold';
  if (s === 'blocked') return 'blocked';
  return 'unknown';
}

/** 머리줄이 있는 TSV(id|task_id · owner · status · priority · claim_tab|claim · note|title). 머리줄을 모르면 []. */
export function parseWorkQueueTsv(text: string): WorkQueueEntry[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const head = lines[0]!.split('\t').map(h => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map(n => head.indexOf(n)).find(i => i >= 0) ?? -1;
  const idCol = col('id', 'task_id');
  const ownerCol = col('owner');
  const statusCol = col('status');
  if (idCol < 0 || ownerCol < 0 || statusCol < 0) return [];
  const priorityCol = col('priority');
  const claimCol = col('claim_tab', 'claim');
  const titleCol = col('title', 'note', 'kind');
  const out: WorkQueueEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split('\t');
    const id = cells[idCol]?.trim();
    if (!id) continue;
    const prio = priorityCol >= 0 ? Number.parseInt(cells[priorityCol] ?? '', 10) : Number.NaN;
    const claim = claimCol >= 0 ? (cells[claimCol]?.trim() || null) : null;
    out.push({
      id,
      title: (titleCol >= 0 ? cells[titleCol]?.trim() : '') || id,
      owner: cells[ownerCol]?.trim() || null,
      state: tsvState(cells[statusCol] ?? ''),
      claim,
      rank: Number.isFinite(prio) ? prio : null,
      ordinal: i,
      predecessors: [],
    });
  }
  return out;
}

const CELL_ID = /^[A-Z][A-Z0-9_.-]*[A-Z0-9]$/;

/**
 * 표 꼴 큐(«| 자리 | A → B → C |») — 이 자리 줄의 칸 id 를 순서대로. 칸 id 꼴이 아닌 토막(«(#37970 마무리)»)은 버린다.
 * 사슬 순서 = 선행: 뒤 칸은 바로 앞 칸이 끝나야 집는다. 상태는 표에 없다(unknown — 체크리스트에서 채운다).
 */
export function parseWorkQueueMarkdown(text: string, seat: string): WorkQueueEntry[] {
  const want = seat.trim().toUpperCase();
  const out: WorkQueueEntry[] = [];
  let ordinal = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2 || cells[0]!.toUpperCase() !== want) continue;
    let prev: string | null = null;
    for (const token of cells[1]!.split('→').map(t => t.trim())) {
      if (!CELL_ID.test(token)) continue;
      out.push({ id: token, title: token, owner: want, state: 'unknown', claim: null, rank: null,
        ordinal: ++ordinal, predecessors: prev ? [prev] : [] });
      prev = token;
    }
  }
  return out;
}

// ── 체크리스트 ───────────────────────────────────────────────────────────────────────

/** 재료로 쓰는 칸 꼴(`ChecklistItem` 의 부분). */
export interface SelfPullChecklistItem {
  id: string;
  title: string;
  status: 'green' | 'yellow' | 'red' | 'done';
  owner?: string;
  priority?: 'P0' | 'P1' | 'P2';
  predecessors?: string[];
  updatedAt?: string;
}

export interface SelfPullChecklistVersion {
  version: string;
  items: readonly SelfPullChecklistItem[];
  /** 칸이 처음 원장에 오른 시각(id → ISO) — 없으면 updatedAt. */
  addedAt?: ReadonlyMap<string, string>;
}

const OPEN_CELL = new Set(['yellow', 'red']);

function isoMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 판들 → 후보(이 자리 칸만) ⊕ 칸 상태 표(선행 판정 · WORK-QUEUE 상태 채우기). 순수. */
export function checklistCandidates(seat: string, versions: readonly SelfPullChecklistVersion[]): {
  candidates: SelfPullCandidate[];
  cells: Map<string, { status: SelfPullChecklistItem['status']; owner: string | null; rank: number | null; title: string }>;
} {
  const want = seat.trim().toUpperCase();
  const candidates: SelfPullCandidate[] = [];
  const cells = new Map<string, { status: SelfPullChecklistItem['status']; owner: string | null; rank: number | null; title: string }>();
  let ordinal = 0;
  for (const v of versions) {
    for (const item of v.items) {
      const rank = item.priority ? Number(item.priority.slice(1)) : null;
      cells.set(item.id, { status: item.status, owner: item.owner ?? null, rank, title: item.title });
      ordinal++;
      if (ownerSeat(item.owner) !== want) continue;
      candidates.push({
        source: 'checklist', id: item.id, title: item.title, owner: item.owner ?? null,
        open: OPEN_CELL.has(item.status), rank, ordinal,
        addedAt: isoMs(v.addedAt?.get(item.id) ?? item.updatedAt),
        predecessors: item.predecessors ?? [], origin: `checklist ${v.version}`,
      });
    }
  }
  return { candidates, cells };
}

/** WORK-QUEUE 항목 → 후보. 체크리스트에 같은 칸이 있으면 그 주인·상태·등급을 따른다(남의 칸이면 남의 것). */
export function workQueueCandidates(
  seat: string,
  entries: readonly { path: string; entries: readonly WorkQueueEntry[] }[],
  cells: ReadonlyMap<string, { status: SelfPullChecklistItem['status']; owner: string | null; rank: number | null; title: string }>,
): { candidates: SelfPullCandidate[]; hold: Set<string>; done: Map<string, boolean | null> } {
  const want = seat.trim().toUpperCase();
  const candidates: SelfPullCandidate[] = [];
  const hold = new Set<string>();
  const done = new Map<string, boolean | null>();
  for (const file of entries) {
    const base = file.path.split('/').at(-1) ?? file.path;
    for (const e of file.entries) {
      const cell = cells.get(e.id);
      const state = e.state === 'unknown' && cell
        ? (OPEN_CELL.has(cell.status) ? 'open' : 'done')
        : e.state;
      done.set(e.id, state === 'done' ? true : state === 'unknown' ? null : false);
      if (ownerSeat(e.owner) !== want) continue;
      if (state === 'hold') hold.add(e.id);
      candidates.push({
        source: 'work-queue', id: e.id, title: cell?.title ?? e.title,
        owner: cell?.owner ?? e.owner,
        open: state !== 'done',
        rank: e.rank ?? cell?.rank ?? null, addedAt: null, ordinal: e.ordinal,
        predecessors: e.predecessors,
        ...(state === 'claimed' ? { claimedBy: e.claim ?? 'unknown' } : {}),
        ...(state === 'blocked' ? { blocked: true } : {}),
        origin: base,
      });
    }
  }
  return { candidates, hold, done };
}

// ── 실제 원장 읽기(배선 기본값) ──────────────────────────────────────────────────────────

export interface DefaultSelfPullSourceDeps {
  home?: string;
  readText?: (path: string) => string | null;
  listDir?: (path: string) => string[];
  /** 컷이 아직 앞에 있는 판들의 칸. 기본 = release-loop 원장. */
  readChecklists?: (now: number) => SelfPullChecklistVersion[];
  /** traffic 신호 판정 — 집기를 막는 사유 또는 null ⊕ hold 목록. 기본 = seat-loop traffic-signal 리더. */
  readSignal?: (seat: string) => { stop: string | null; hold: string[] };
  readHanded?: () => ReadonlySet<string>;
}

function defaultReadText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function defaultListDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

/** opt-in 파일이 일반 파일이면 켜짐. */
export function isSelfPullEnabled(seat: string, home = homedir()): boolean {
  try { return statSync(join(home, 'elanous-hq', 'seat-state', seat, SEAT_SELF_PULL_FILE)).isFile(); }
  catch { return false; }
}

/** opt-in 파일의 추가 WORK-QUEUE 경로(줄마다 하나 · «#» 주석 · 상대 경로는 seat-state 기준). */
export function parseSelfPullExtraPaths(text: string | null, seatStateRoot: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
    .map(p => (isAbsolute(p) ? p : join(seatStateRoot, p)));
}

function defaultReadChecklists(now: number): SelfPullChecklistVersion[] {
  // 무거운 원장 모듈은 «켜진 자리가 실제로 잴 때»만 싣는다(대시보드 부팅 비용 0).
  const { listChecklist } = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
  const { readSchedules } = require('../../release-loop/feature-store.js') as typeof import('../../release-loop/feature-store.js');
  const { releaseLedgerRoot } = require('../../instance/resolve.js') as typeof import('../../instance/resolve.js');
  const root = releaseLedgerRoot();
  // seat-loop 와 같은 기준(UX J2 10-03): 컷이 아직 앞에 있는 판만 열린 판이다.
  const open = readSchedules(root)
    .filter(row => Number.isFinite(Date.parse(row.cutAt)) && Date.parse(row.cutAt) > now)
    .map(row => row.version).sort();
  const out: SelfPullChecklistVersion[] = [];
  for (const version of open) {
    try {
      const data = listChecklist(version, root);
      const addedAt = new Map<string, string>();
      for (const h of data.history) if (!addedAt.has(h.id)) addedAt.set(h.id, h.at);
      out.push({ version, items: data.items, addedAt });
    } catch (error) {
      debug.log('seat.self-pull', 'checklist-unreadable', { version, error: String(error).slice(0, 200) });
    }
  }
  return out;
}

function defaultReadSignal(seat: string): { stop: string | null; hold: string[] } {
  const { readTrafficSignal } = require('../../seat-loop/traffic-signal.js') as typeof import('../../seat-loop/traffic-signal.js');
  const signal = readTrafficSignal();
  if (signal === null) return { stop: null, hold: [] };
  if ('unreadable' in signal) return { stop: 'traffic-unreadable', hold: [] };
  if (signal.global !== 'green') return { stop: `traffic-${signal.global}`, hold: signal.hold ?? [] };
  if (signal.paused?.[seat]) return { stop: 'traffic-seat-paused', hold: signal.hold ?? [] };
  return { stop: null, hold: signal.hold ?? [] };
}

function defaultReadHanded(): ReadonlySet<string> {
  const { readHandedCells } = require('../../seat-loop/traffic-signal.js') as typeof import('../../seat-loop/traffic-signal.js');
  return readHandedCells();
}

/** 배선 기본 gather — 체크리스트 ⊕ WORK-QUEUE ⊕ hold/handed. 신호·handed 를 못 읽으면 던진다(→ source-unreadable). */
export function createDefaultSelfPullGather(deps: DefaultSelfPullSourceDeps = {}): (seat: string, now: number) => SelfPullSources {
  const home = deps.home ?? homedir();
  const readText = deps.readText ?? defaultReadText;
  const listDir = deps.listDir ?? defaultListDir;
  const readChecklists = deps.readChecklists ?? defaultReadChecklists;
  const readSignal = deps.readSignal ?? defaultReadSignal;
  const readHanded = deps.readHanded ?? defaultReadHanded;
  return (seat, now) => {
    const seatStateRoot = join(home, 'elanous-hq', 'seat-state');
    const seatDir = join(seatStateRoot, seat);
    const signal = readSignal(seat);
    if (signal.stop) {
      return { candidates: [], hold: new Set(signal.hold), handed: new Set(), isDone: () => null, signalStop: signal.stop };
    }
    const handed = readHanded();
    const { candidates: cl, cells } = checklistCandidates(seat, readChecklists(now));
    const own = listDir(seatDir).filter(n => /^WORK-QUEUE.*\.(tsv|md)$/.test(n)).sort().map(n => join(seatDir, n));
    const extra = parseSelfPullExtraPaths(readText(join(seatDir, SEAT_SELF_PULL_FILE)), seatStateRoot);
    const files: { path: string; entries: WorkQueueEntry[] }[] = [];
    for (const path of [...new Set([...own, ...extra])]) {
      const text = readText(path);
      if (text === null) { debug.log('seat.self-pull', 'work-queue-unreadable', { seat, path }); continue; }
      files.push({ path, entries: path.endsWith('.tsv') ? parseWorkQueueTsv(text) : parseWorkQueueMarkdown(text, seat) });
    }
    const wq = workQueueCandidates(seat, files, cells);
    const isDone = (id: string): boolean | null => {
      const cell = cells.get(id);
      if (cell) return !OPEN_CELL.has(cell.status);
      return wq.done.get(id) ?? null;
    };
    return {
      candidates: [...cl, ...wq.candidates],
      hold: new Set([...signal.hold, ...wq.hold]),
      handed,
      isDone,
      signalStop: null,
    };
  };
}

// ── autowake 기본 배선 ────────────────────────────────────────────────────────────────

export interface AutowakeSelfPullHookDeps {
  /** H2 내부 턴 문(autowake 와 같은 문). */
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  home?: string;
  /** Next TUI idle 끌어오기는 'self-pull'. classic autowake 기본값은 'autowake'. */
  origin?: 'autowake' | 'self-pull';
}

/**
 * classic autowake 의 `onNoWorkLeft` 기본값 — opt-in 자리만 재료를 읽고, 집으면 H2 문으로 한 턴 ⊕ OP 우편 한 줄.
 * 계획 층(PLAN-WIRE-SEAT)이 배선되면 handOff 를 `selfPullPlanTask` → `SeatTaskQueuePort.enqueue` 로 바꾼다.
 */
export function createAutowakeSelfPullHook(deps: AutowakeSelfPullHookDeps): (ctx: SelfPullNoWorkContext) => void {
  const home = deps.home ?? homedir();
  const controller = createSeatSelfPull({
    isEnabled: (seat) => isSelfPullEnabled(seat, home),
    gather: createDefaultSelfPullGather({ home }),
    handOff: (picked) => {
      const opened = deps.startTurnIfIdle(formatSelfPullPrompt(picked.seat, picked.item, picked.reason),
        { origin: deps.origin ?? 'autowake', reason: `자기 집기 ${picked.item.id}` });
      return opened.opened ? { accepted: true } : { accepted: false, detail: opened.reason };
    },
    postToOp: (seat, line) => {
      const store = openMsgStore();
      try { store.post({ from: seat, to: 'OP', kind: 'report', body: line }); } finally { store.close(); }
    },
  });
  return (ctx) => { controller.onNoWorkLeft(ctx); };
}
