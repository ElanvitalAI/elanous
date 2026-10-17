/**
 * INFLIGHT-REGISTRY — 비행 중 등록부(대표 10-17 «출발 때 맥락 남기고 머지 때 참조 · 착지하면 지움 · 폭증 막기»).
 *
 * 발사하는 런이 runId·칸·한 줄 의도·대상 파일을 한 줄 등록하고, 머지 순간(스마트 머지 LLM)에 같은 파일을
 * 만지는 줄들의 의도를 읽는다. 착지하면 지운다. 정본은 PR 본문이고 이것은 «색인»이다 — 못 읽으면 빈 목록
 * (머지는 종전 그대로 간다), 못 쓰면 발사·착지를 막지 않는다(호출부가 fail-soft).
 *
 * 폭증 막기: 런당 1줄(같은 칸 재발사는 덮어씀) · 의도 ≤300자 · 파일 ≤20 · 48h 지난 줄은 읽을 때 거르고 쓸 때 걷는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';

export const INFLIGHT_INTENT_MAX_CHARS = 300;
export const INFLIGHT_FILES_MAX = 20;
export const INFLIGHT_TTL_MS = 48 * 60 * 60 * 1000;
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

function isExpired(entry: InflightEntry, now: Date): boolean {
  const at = Date.parse(entry.registeredAt);
  return !Number.isFinite(at) || now.getTime() - at > INFLIGHT_TTL_MS;
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ entries: update(live) }));
  });
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
