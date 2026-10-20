/**
 * INFLIGHT-REGISTRY — 비행 중 등록부(대표 10-17 «출발 때 맥락 남기고 머지 때 참조 · 착지하면 지움 · 폭증 막기»).
 *
 * 발사하는 런이 runId·칸·한 줄 의도·대상 파일을 한 줄 등록하고, 머지 순간(스마트 머지 LLM)에 같은 파일을
 * 만지는 줄들의 의도를 읽는다. 착지하면 지운다. 정본은 PR 본문이고 이것은 «색인»이다 — 못 읽으면 빈 목록
 * (머지는 종전 그대로 간다), 못 쓰면 발사·착지를 막지 않는다(호출부가 fail-soft).
 *
 * 폭증 막기: 런당 1줄(같은 칸 재발사는 덮어씀) · 의도 ≤300자 · 파일 ≤20.
 *
 * 걷기: 닫힌 PR(`removeInflightForClosedPrs`)·끝난 런(`removeInflightForFinishedRuns`)은 그때 바로 걷고,
 * 남은 줄은 `gcInflight` 가 6h 시한(`INFLIGHT_GC_TTL_MS`)으로 걷는다 — 6h 넘게 살아 있는 런은 없다.
 * 48h 지연 필터(`INFLIGHT_TTL_MS`)는 GC 가 한 번도 안 돈 등록부의 백스톱이다(읽기는 쓰지 않는다).
 *
 * 쓰기는 임시 파일 → rename 원자 쓰기 — 반쯤 쓴 등록부를 동시에 읽는 쪽이 보지 않는다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';

export const INFLIGHT_INTENT_MAX_CHARS = 300;
export const INFLIGHT_FILES_MAX = 20;
/** 지연 필터 시한 — GC 가 안 돈 등록부가 머지를 영원히 오염시키지 못하게 하는 백스톱. */
export const INFLIGHT_TTL_MS = 48 * 60 * 60 * 1000;
/** GC 시한 — 이만큼 지난 줄은 지금 살아 있는 런이 아니다. */
export const INFLIGHT_GC_TTL_MS = 6 * 60 * 60 * 1000;
export const INFLIGHT_REGISTRY_FILE = 'inflight-registry.json';

export interface InflightEntry {
  runId: string;
  /** 칸 id(없으면 카드 id) — 같은 칸 재발사는 이 키로 덮어쓴다. */
  cell: string;
  intent: string;
  files: string[];
  registeredAt: string;
  cardId?: string;
}

export interface InflightOptions {
  path?: string;
  now?: () => Date;
}

/** 줄을 연 과제 카드의 최소 모양 — PR 상태(`state`)는 호출부가 gh 로 채워 준다. */
export interface InflightOwnerCard {
  id: string;
  runId?: string;
  pr?: number | { number: number; state?: string };
}

export interface InflightGcInput extends InflightOptions {
  /** 머지 없이 닫힌 PR 번호. */
  closedPrs?: readonly number[];
  /** 끝난 런 id — 정상 종료·중단 모두. */
  finishedRuns?: readonly string[];
  /** 과제 카드들 — `card.pr` 이 닫힌 PR 이면 그 카드의 줄을 걷는다. */
  cards?: Iterable<InflightOwnerCard>;
}

export type InflightGcReason = 'expired' | 'finished-run' | 'closed-pr';

export interface InflightGcResult {
  /** 걷고 남은 줄 수. */
  kept: number;
  removed: Array<{ entry: InflightEntry; reason: InflightGcReason }>;
}

const CLOSED_PR_STATES = new Set(['CLOSED', 'closed', 'MERGED', 'merged']);

function prNumberOf(card: InflightOwnerCard): number | undefined {
  return typeof card.pr === 'number' ? card.pr : card.pr?.number;
}

function isClosedOwner(card: InflightOwnerCard, closedPrs: ReadonlySet<number>): boolean {
  const pr = card.pr;
  if (pr === undefined) return false;
  if (typeof pr === 'object' && pr.state !== undefined && CLOSED_PR_STATES.has(pr.state)) return true;
  const number = prNumberOf(card);
  return number !== undefined && closedPrs.has(number);
}

/** 닫힌 카드들의 카드 id·runId — 줄을 찾는 키. */
function closedOwnerKeys(cards: readonly InflightOwnerCard[], closedPrs: ReadonlySet<number>): { cardIds: Set<string>; runIds: Set<string> } {
  const owners = cards.filter((card) => isClosedOwner(card, closedPrs));
  return {
    cardIds: new Set(owners.map((card) => card.id)),
    runIds: new Set(owners.flatMap((card) => (card.runId ? [card.runId] : []))),
  };
}

/** 기본 자리 — 과제 카드 상태(`task-agent-actions.json`)와 같은 우주 뿌리. */
export function inflightRegistryPath(): string {
  return join(effectiveInstanceRoot(), INFLIGHT_REGISTRY_FILE);
}

function readEntries(path: string): InflightEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch { return []; }
}

function isEntry(value: unknown): value is InflightEntry {
  const entry = value as Partial<InflightEntry> | null;
  return !!entry && typeof entry.runId === 'string' && typeof entry.cell === 'string' && typeof entry.intent === 'string'
    && Array.isArray(entry.files) && typeof entry.registeredAt === 'string';
}

function olderThan(entry: InflightEntry, now: Date, ttlMs: number): boolean {
  const at = Date.parse(entry.registeredAt);
  return !Number.isFinite(at) || now.getTime() - at > ttlMs;
}

function isExpired(entry: InflightEntry, now: Date): boolean {
  return olderThan(entry, now, INFLIGHT_TTL_MS);
}

/**
 * 임시 파일 → rename. 임시 파일은 같은 디렉터리(=같은 파일시스템)에 만들어 rename 이 원자다 —
 * 읽는 쪽은 «옛 등록부» 아니면 «완성된 새 등록부»만 본다(반쯤 쓴 JSON 을 파싱하지 않는다).
 */
function writeEntriesAtomic(path: string, entries: InflightEntry[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ entries })}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* rename 이 이미 끝났으면 지울 임시 파일이 없다 */ }
    throw error;
  }
}

/** 잠금 안에서 읽고 고쳐 쓴다 — 48h 지난 줄은 쓸 때 걷는다(`expire` 관측). */
function mutate(opts: InflightOptions, update: (entries: InflightEntry[]) => InflightEntry[]): void {
  const path = opts.path ?? inflightRegistryPath();
  const now = (opts.now ?? (() => new Date()))();
  withFileLockSync(`${path}.lock`, () => {
    const all = readEntries(path);
    const live = all.filter((entry) => !isExpired(entry, now));
    if (live.length < all.length) {
      try { debug.log('pr-tool.inflight', 'expire', { phase: 'write', runIds: all.filter((entry) => isExpired(entry, now)).map((entry) => entry.runId) }); } catch { /* fail-soft */ }
    }
    writeEntriesAtomic(path, update(live));
  });
}

/** 잠금 한 번·원자 쓰기 한 번으로 걷는다 — 지울 줄이 없으면 디스크를 건드리지 않는다. */
function sweep(opts: InflightOptions, reason: string, drop: (entry: InflightEntry) => boolean): InflightEntry[] {
  const path = opts.path ?? inflightRegistryPath();
  let removed: InflightEntry[] = [];
  withFileLockSync(`${path}.lock`, () => {
    const all = readEntries(path);
    removed = all.filter(drop);
    if (removed.length === 0) return;
    writeEntriesAtomic(path, all.filter((entry) => !drop(entry)));
  });
  try { debug.log('pr-tool.inflight', 'remove', { reason, removed: removed.map((entry) => entry.runId) }); } catch { /* fail-soft */ }
  return removed;
}

/** 한 줄 등록 — 같은 runId 또는 같은 칸의 옛 줄을 덮어쓴다. 의도·파일은 상한에서 자른다. */
export function registerInflight(input: { runId: string; cell: string; intent: string; files: readonly string[]; cardId?: string }, opts: InflightOptions = {}): InflightEntry {
  const now = (opts.now ?? (() => new Date()))();
  const files = [...new Set(input.files.map((file) => file.trim()).filter(Boolean))];
  // 한 줄 칸만 — 줄바꿈·제어 문자는 공백으로(머지 프롬프트 인용 블록을 깨지 못하게 · 프롬프트 쪽도 따로 무력화한다).
  const oneLine = (value: string) => value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const entry: InflightEntry = {
    runId: oneLine(input.runId),
    cell: oneLine(input.cell),
    intent: oneLine(input.intent).slice(0, INFLIGHT_INTENT_MAX_CHARS),
    files: files.slice(0, INFLIGHT_FILES_MAX),
    registeredAt: now.toISOString(),
    ...(input.cardId ? { cardId: input.cardId } : {}),
  };
  let replaced: string[] = [];
  mutate(opts, (entries) => {
    replaced = entries.filter((old) => old.runId === entry.runId || old.cell === entry.cell).map((old) => old.runId);
    return [...entries.filter((old) => old.runId !== entry.runId && old.cell !== entry.cell), entry];
  });
  try { debug.log('pr-tool.inflight', 'register', { runId: entry.runId, cell: entry.cell, files: entry.files.length, filesDropped: files.length - entry.files.length, intentChars: entry.intent.length, replaced }); } catch { /* fail-soft */ }
  return entry;
}

/** 줄을 지운다 — runId 또는 카드 id 로. 지운 수를 돌려준다(0 = 그런 줄 없음). */
export function removeInflight(key: { runId: string } | { cardId: string }, reason: string, opts: InflightOptions = {}): number {
  let removed: string[] = [];
  const matches = (entry: InflightEntry): boolean => 'runId' in key ? entry.runId === key.runId : entry.cardId === key.cardId;
  mutate(opts, (entries) => {
    removed = entries.filter(matches).map((entry) => entry.runId);
    return entries.filter((entry) => !matches(entry));
  });
  try { debug.log('pr-tool.inflight', 'remove', { ...key, reason, removed }); } catch { /* fail-soft */ }
  return removed.length;
}

/** 살아 있는 줄 — `files` 를 주면 그중 하나라도 만지는 줄만. 48h 지난 줄은 거른다(읽기는 쓰지 않는다). */
export function listInflight(filter: { files?: readonly string[] } = {}, opts: InflightOptions = {}): InflightEntry[] {
  const now = (opts.now ?? (() => new Date()))();
  const all = readEntries(opts.path ?? inflightRegistryPath());
  const live = all.filter((entry) => !isExpired(entry, now));
  if (live.length < all.length) {
    try { debug.log('pr-tool.inflight', 'expire', { phase: 'read', count: all.length - live.length }); } catch { /* fail-soft */ }
  }
  if (!filter.files) return live;
  const wanted = new Set(filter.files);
  return live.filter((entry) => entry.files.some((file) => wanted.has(file)));
}

/**
 * 착지한 PR 의 줄을 지운다 — 그 PR 을 연 과제 카드(`card.pr`)의 카드 id·runId 로 찾는다.
 * 카드가 없으면 디스크를 건드리지 않는다(사람 PR · 다른 우주 카드 = 지울 줄 없음).
 */
export function removeInflightForPr(
  pr: number,
  cards: Iterable<{ id: string; runId?: string; pr?: number | { number: number } }>,
  opts: InflightOptions = {},
): number {
  const owners = [...cards].filter((card) => (typeof card.pr === 'number' ? card.pr : card.pr?.number) === pr);
  if (owners.length === 0) {
    try { debug.log('pr-tool.inflight', 'remove', { pr, reason: 'pr-landed', removed: [], cards: 0 }); } catch { /* fail-soft */ }
    return 0;
  }
  let removed = 0;
  for (const card of owners) {
    removed += removeInflight({ cardId: card.id }, `pr-landed:${pr}`, opts);
    if (card.runId) removed += removeInflight({ runId: card.runId }, `pr-landed:${pr}`, opts);
  }
  return removed;
}

/**
 * 닫힌 PR(머지 포함)의 줄을 지운다 — `closedPrs` 번호와 `card.pr` 의 닫힘 상태 양쪽을 본다.
 * 열린 PR 카드는 건드리지 않고, 닫힌 카드가 없으면 디스크도 건드리지 않는다.
 */
export function removeInflightForClosedPrs(
  closedPrs: readonly number[],
  cards: Iterable<InflightOwnerCard>,
  opts: InflightOptions = {},
): number {
  const closed = new Set(closedPrs);
  const { cardIds, runIds } = closedOwnerKeys([...cards], closed);
  if (cardIds.size === 0 && runIds.size === 0) {
    try { debug.log('pr-tool.inflight', 'remove', { reason: 'pr-closed', removed: [], cards: 0, closedPrs: [...closed] }); } catch { /* fail-soft */ }
    return 0;
  }
  return sweep(opts, `pr-closed:${[...closed].sort((a, b) => a - b).join(',')}`, (entry) => (
    (entry.cardId !== undefined && cardIds.has(entry.cardId)) || runIds.has(entry.runId)
  )).length;
}

/** 끝난 런(정상 종료·중단 모두)의 줄을 지운다 — 카드가 없어도 runId 로 걷는다. */
export function removeInflightForFinishedRuns(runIds: readonly string[], opts: InflightOptions = {}): number {
  const finished = new Set(runIds);
  if (finished.size === 0) return 0;
  return sweep(opts, 'run-finished', (entry) => finished.has(entry.runId)).length;
}

/**
 * 등록부 청소 한 번 — 닫힌 PR 줄 · 끝난 런 줄 · 6h 넘은 줄을 한 잠금·원자 쓰기 한 번으로 걷는다.
 * 지울 줄이 없으면 디스크를 건드리지 않고, 무엇이 왜 걷혔는지(`reason`)를 돌려준다.
 * 우선순위: `expired` → `finished-run` → `closed-pr`(한 줄이 여러 규칙에 걸리면 시한이 먼저다).
 */
export function gcInflight(input: InflightGcInput = {}): InflightGcResult {
  const path = input.path ?? inflightRegistryPath();
  const now = (input.now ?? (() => new Date()))();
  const finished = new Set(input.finishedRuns ?? []);
  const { cardIds, runIds } = closedOwnerKeys([...(input.cards ?? [])], new Set(input.closedPrs ?? []));
  const classify = (entry: InflightEntry): InflightGcReason | null => {
    if (olderThan(entry, now, INFLIGHT_GC_TTL_MS)) return 'expired';
    if (finished.has(entry.runId)) return 'finished-run';
    if (runIds.has(entry.runId)) return 'closed-pr';
    if (entry.cardId !== undefined && cardIds.has(entry.cardId)) return 'closed-pr';
    return null;
  };
  let kept = 0;
  let removed: InflightGcResult['removed'] = [];
  withFileLockSync(`${path}.lock`, () => {
    const all = readEntries(path);
    removed = all.flatMap((entry) => {
      const reason = classify(entry);
      return reason === null ? [] : [{ entry, reason }];
    });
    kept = all.length - removed.length;
    if (removed.length === 0) return;
    writeEntriesAtomic(path, all.filter((entry) => classify(entry) === null));
  });
  try {
    debug.log('pr-tool.inflight', 'gc', { kept, removed: removed.map(({ entry, reason }) => ({ runId: entry.runId, reason })) });
  } catch { /* fail-soft */ }
  return { kept, removed };
}
