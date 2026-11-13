// 정기 외부 흡수 원장 — 입력원마다 모양이 다른 것을 `IntakeItem` 한 모양 · 원장 하나로 모은다.
// 설계 = 내부 문서 `RFC-regular-external-intake-and-normalization-pipeline-2026-09-26` §3 (① 모양 맞추기 · ② 중복 없애기).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { findTrack } from '../autopilot/mission-phase-track.js';
import { canonicalUrl, intakeLedgerDir } from './core.js';
import { wasIntakeEventScheduled } from './event-state.js';
export { canonicalUrl, intakeLedgerDir } from './core.js';

export const INTAKE_SOURCES = ['x', 'youtube', 'github', 'telegram-saved', 'telegram-bot', 'memo', 'pwa'] as const;
export type RegisteredIntakeSourceKind = 'rss' | 'command' | 'topic-search' | 'markdown';
export type IntakeSource = typeof INTAKE_SOURCES[number];
export type IntakeKind = 'video' | 'repo' | 'post' | 'article' | 'note' | 'rss';
export type IntakePrivacy = 'public' | 'user-private';
export const INTAKE_STATUSES = ['new', 'queued', 'absorbed', 'checked', 'routed', 'discarded', 'deferred'] as const;
export type IntakeStatus = typeof INTAKE_STATUSES[number];
export type AbsorbScrapKind = 'text' | 'web' | 'x' | 'youtube' | 'voice' | 'video' | 'photo';
export type AbsorbScrapTimelineEntry =
  | { t: number; kind: 'voice' | 'photo' | 'video'; mediaRef: string; mime: string }
  | { t: number; kind: 'marker'; label: string };
export interface AbsorbScrapPayload {
  schema: 'absorb/v0';
  memberId: string;
  kind: AbsorbScrapKind;
  source: 'android-share' | 'android-record' | 'flutter-share' | 'flutter-record' | 'tui' | 'pwa' | 'telegram';
  raw: { text?: string; transcript?: string; url?: string; mediaRef?: string; mime?: string; timeline?: AbsorbScrapTimelineEntry[];
    recordedAt?: string; recordedTimeZone?: string; recordedDate?: string; classDate?: string };
  folderId?: string | null;
  exports?: { vaultId: string; path: string; savedAt: string }[];
  /** Durable create-only reservation; restart verifies file bytes before finalizing. */
  pendingExports?: { vaultId: string; path: string; contentSha256: string; startedAt: string; content?: string; writeMarker?: string }[];
  status: 'new' | 'extracting' | 'absorbed' | 'failed';
  card?: { title: string; points: [string, string?, string?]; tags: string[]; originUrl?: string };
  /** Member-scoped extracted source for a later model-generated share summary. */
  extractedBody?: string;
  failure?: { stage: 'extract' | 'card'; reason: string };
  createdAt: string;
  absorbedAt?: string;
}

export interface IntakeItem {
  id: string;
  /** Member namespace for absorb/v0 records; legacy intake entries omit it. */
  memberId?: string;
  absorb?: AbsorbScrapPayload;
  /** Hashed, member-scoped idempotency keys; never included in the public absorb payload. */
  absorbIdempotency?: Record<string, string>;
  source: IntakeSource | RegisteredIntakeSourceKind;
  /** 같은 항목이 다른 입력원에서도 왔으면 여기 모인다 — «두 입력원에서 동시에 뜬 것»이 신호다. */
  sources: (IntakeSource | RegisteredIntakeSourceKind)[];
  seat?: string;
  /** Configured topic identity used to keep successive briefing topics isolated. */
  briefingTopic?: string;
  briefingTopics?: string[];
  publisher?: string;
  /** Parent Linear issue UUID, kept separate from its human-readable identifier. */
  linearIssueId?: string;
  url?: string;
  kind: IntakeKind;
  title?: string;
  text?: string;
  observedAt: string;
  lastSeenAt: string;
  /** `<입력원>.<신호>` → 마지막으로 본 값 */
  signals: Record<string, number>;
  axis?: string;
  judgement?: { axis: string; axisConf: number; promo: number; learn: number };
  privacy: IntakePrivacy;
  status: IntakeStatus;
  outputs: { kind: 'note' | 'goal' | 'manual' | 'release' | 'grounding'; ref: string }[];
}

/** 수집기가 내는 한 줄 — 모양 맞추기 전. */
export interface RawIntakeItem {
  memberId?: string;
  absorb?: AbsorbScrapPayload;
  seat?: string;
  briefingTopic?: string;
  publisher?: string;
  linearIssueId?: string;
  url?: string;
  title?: string;
  text?: string;
  kind?: IntakeKind;
  observedAt?: string;
  signals?: Record<string, number>;
  axis?: string;
  judgement?: IntakeItem['judgement'];
}

function normalizedSeat(seat: unknown): string | undefined {
  if (seat === undefined) return undefined;
  if (typeof seat !== 'string') throw new Error(`알 수 없는 자리: ${String(seat)}`);
  if (seat.trim() === 'user') return 'user';
  const track = findTrack(seat.trim());
  if (!track) throw new Error(`알 수 없는 자리: ${seat}`);
  return track.id;
}

export function intakeItemId(source: IntakeSource | RegisteredIntakeSourceKind,
  raw: Pick<RawIntakeItem, 'url' | 'text' | 'linearIssueId' | 'memberId'> & { seat?: string }): string {
  const seat = normalizedSeat(raw.seat);
  const url = raw.url ? canonicalUrl(raw.url) : undefined;
  const itemKey = url ?? `${source}:${(raw.text ?? '').trim().slice(0, 200)}`;
  const basis = raw.linearIssueId ? JSON.stringify(['linear-issue', raw.linearIssueId.toLowerCase(), itemKey]) : itemKey;
  // Unassigned items retain their original IDs; assigned items have an independent lifecycle per seat.
  return createHash('sha256').update(raw.memberId ? JSON.stringify([raw.memberId, basis]) : seat ? JSON.stringify([seat, basis]) : basis).digest('hex').slice(0, 16);
}

function kindFor(source: IntakeSource | RegisteredIntakeSourceKind, url: string | undefined): IntakeKind {
  if (url?.startsWith('https://www.youtube.com/')) return 'video';
  if (url?.startsWith('https://github.com/')) return 'repo';
  if (url?.startsWith('https://x.com/')) return 'post';
  if (!url) return 'note';
  return source === 'x' ? 'post' : 'article';
}

/** 개인 메모 입력원은 user-private — 원문을 바깥 LLM 에 보내지 않는다(RFC §3.4). PWA 칸에 사람이 쓴 글도 같다(RFC-pwa-intake-front-door). */
export function privacyFor(source: IntakeSource | RegisteredIntakeSourceKind): IntakePrivacy {
  return source === 'telegram-saved' || source === 'memo' || source === 'pwa' ? 'user-private' : 'public';
}

/** ① 모양 맞추기 — 수집기 한 줄 → IntakeItem. 비어 있으면(URL·본문 둘 다 없음) null. */
export function shapeIntakeItem(source: IntakeSource | RegisteredIntakeSourceKind, raw: RawIntakeItem, now: string): IntakeItem | null {
  const seat = normalizedSeat(raw.seat);
  if (raw.linearIssueId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.linearIssueId)) {
    throw new Error('invalid Linear issue UUID');
  }
  const url = raw.url ? canonicalUrl(raw.url) : undefined;
  const text = raw.text?.trim() || undefined;
  if (!url && !text) return null;
  const observedAt = raw.observedAt ?? now;
  const signals: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.signals ?? {})) if (Number.isFinite(v)) signals[`${source}.${k}`] = v;
  return {
    id: intakeItemId(source, { url, text, seat, linearIssueId: raw.linearIssueId, memberId: raw.memberId }),
    ...(raw.memberId ? { memberId: raw.memberId } : {}),
    ...(raw.absorb ? { absorb: raw.absorb } : {}),
    source,
    sources: [source],
    ...(seat ? { seat } : {}),
    ...(raw.briefingTopic ? { briefingTopic: raw.briefingTopic } : {}),
    ...(raw.briefingTopic ? { briefingTopics: [raw.briefingTopic] } : {}),
    ...(raw.publisher ? { publisher: raw.publisher } : {}),
    ...(raw.linearIssueId ? { linearIssueId: raw.linearIssueId } : {}),
    ...(url ? { url } : {}),
    kind: raw.kind ?? kindFor(source, url),
    ...(raw.title?.trim() ? { title: raw.title.trim().slice(0, 300) } : {}),
    ...(text ? { text: text.slice(0, 2000) } : {}),
    observedAt,
    lastSeenAt: observedAt,
    signals,
    ...(raw.axis ? { axis: raw.axis } : {}),
    ...(raw.judgement ? { judgement: raw.judgement } : {}),
    privacy: privacyFor(source),
    status: 'new',
    outputs: [],
  };
}

function ledgerFile(instanceRoot: string): string { return join(intakeLedgerDir(instanceRoot), 'items.jsonl'); }

/** 원장 = 덧붙이기만 하는 줄 목록 · 같은 id 는 마지막 줄이 이긴다. 깨진 줄은 건너뛰고 센다. */
export function loadIntakeLedger(instanceRoot: string): { items: Map<string, IntakeItem>; badLines: number } {
  const items = new Map<string, IntakeItem>();
  let badLines = 0;
  const file = ledgerFile(instanceRoot);
  if (!existsSync(file)) return { items, badLines };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as IntakeItem;
      if (item && typeof item.id === 'string') items.set(item.id, item); else badLines++;
    } catch { badLines++; }
  }
  return { items, badLines };
}

function appendItems(instanceRoot: string, items: IntakeItem[]): void {
  if (!items.length) return;
  mkdirSync(intakeLedgerDir(instanceRoot), { recursive: true });
  appendFileSync(ledgerFile(instanceRoot), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
}

export interface IngestResult { shaped: number; added: number; merged: number; seen: number; skipped: number; badLines: number }

const SETTLED: ReadonlySet<IntakeStatus> = new Set(['absorbed', 'discarded', 'routed', 'checked']);

/**
 * ② 중복 없애기 — 같은 id 는 새 항목을 만들지 않고 신호·입력원을 합친다.
 * 이미 흡수·버림·갈래가 끝난 것은 «seen» 으로 세고 상태를 되돌리지 않는다(다시 올리지 않는다).
 */
export function ingestIntakeItems(instanceRoot: string, source: IntakeSource | RegisteredIntakeSourceKind, raws: RawIntakeItem[], now = new Date().toISOString(),
  log: (event: string, data: Record<string, unknown>) => void = (e, d) => { debug.log('intake.normalize', e, d); }): IngestResult {
  const { items: existing, badLines } = loadIntakeLedger(instanceRoot);
  const result: IngestResult = { shaped: 0, added: 0, merged: 0, seen: 0, skipped: 0, badLines };
  const writes = new Map<string, IntakeItem>();
  for (const raw of raws) {
    const shaped = shapeIntakeItem(source, raw, now);
    if (!shaped) { result.skipped++; continue; }
    result.shaped++;
    const prev = writes.get(shaped.id) ?? existing.get(shaped.id);
    if (!prev) { writes.set(shaped.id, shaped); result.added++; continue; }
    const merged: IntakeItem = {
      ...prev,
      memberId: shaped.memberId ?? prev.memberId,
      absorb: shaped.absorb ?? prev.absorb,
      sources: [...new Set([...prev.sources, source])],
      lastSeenAt: now,
      signals: { ...prev.signals, ...shaped.signals },
      title: prev.title ?? shaped.title,
      text: prev.text ?? shaped.text,
      linearIssueId: prev.linearIssueId ?? shaped.linearIssueId,
      briefingTopic: shaped.briefingTopic ?? prev.briefingTopic,
      briefingTopics: [...new Set([...(prev.briefingTopics ?? (prev.briefingTopic ? [prev.briefingTopic] : [])),
        ...(shaped.briefingTopics ?? (shaped.briefingTopic ? [shaped.briefingTopic] : []))])],
      publisher: shaped.publisher ?? prev.publisher,
      axis: shaped.axis ?? prev.axis,
      judgement: shaped.judgement ?? prev.judgement,
      // 한 번이라도 개인 입력원에서 왔으면 개인으로 남긴다(공개로 풀지 않는다).
      privacy: prev.privacy === 'user-private' || shaped.privacy === 'user-private' ? 'user-private' : 'public',
    };
    writes.set(shaped.id, merged);
    if (SETTLED.has(prev.status)) result.seen++; else result.merged++;
  }
  appendItems(instanceRoot, [...writes.values()]);
  log('ingested', { source, ...result });
  return result;
}

/** Store absorb/v0 scraps in the existing IntakeItem JSONL ledger. */
export function ingestAbsorbScrap(instanceRoot: string, payload: AbsorbScrapPayload, idempotencyKey: string, now = payload.createdAt): { item: IntakeItem; replayed: boolean } {
  const source: IntakeSource = 'pwa';
  const identity = payload.raw.url ?? payload.raw.text ?? payload.raw.mediaRef ?? `${payload.kind}:${now}`;
  const raw: RawIntakeItem = {
    memberId: payload.memberId,
    url: payload.raw.url,
    text: payload.raw.text ?? payload.raw.mediaRef ?? identity,
    title: payload.card?.title,
    kind: payload.kind === 'text' || payload.kind === 'photo' ? 'note' : payload.kind === 'web' ? 'article' : payload.kind === 'x' ? 'post' : 'video',
    absorb: payload,
  };
  // Absorb entries keep the complete input identity: URL-only or text-prefix IDs
  // can collapse different kinds or long bodies into one member's ledger item.
  const id = createHash('sha256').update(JSON.stringify([
    'absorb/v0', payload.memberId, payload.kind, payload.source, payload.raw,
  ])).digest('hex').slice(0, 16);
  const { items } = loadIntakeLedger(instanceRoot);
  const keyHash = createHash('sha256').update(`${payload.memberId}\0${idempotencyKey}`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ kind: payload.kind, source: payload.source, raw: payload.raw })).digest('hex');
  for (const existing of items.values()) {
    const prior = existing.absorbIdempotency?.[keyHash];
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error('idempotency-conflict');
      return { item: existing, replayed: true };
    }
  }
  const prev = items.get(id);
  if (prev?.absorb) {
    const updated = { ...prev, absorbIdempotency: { ...prev.absorbIdempotency, [keyHash]: fingerprint } };
    appendItems(instanceRoot, [updated]);
    return { item: updated, replayed: false };
  }
  const shaped = shapeIntakeItem(source, raw, now);
  if (!shaped) throw new Error('scrap requires text, url, or mediaRef');
  shaped.id = id;
  shaped.absorbIdempotency = { [keyHash]: fingerprint };
  appendItems(instanceRoot, [shaped]);
  debug.log('absorb.ingest', 'scrap-received', { id, memberId: payload.memberId, kind: payload.kind, source: payload.source });
  return { item: shaped, replayed: false };
}

export function listAbsorbScraps(instanceRoot: string, memberId: string): IntakeItem[] {
  return [...loadIntakeLedger(instanceRoot).items.values()]
    .filter((item) => item.memberId === memberId && item.absorb?.schema === 'absorb/v0')
    .sort((a, b) => b.absorb!.createdAt.localeCompare(a.absorb!.createdAt));
}

export function updateAbsorbScrap(instanceRoot: string, id: string, patch: Partial<Pick<AbsorbScrapPayload,
  'status' | 'card' | 'extractedBody' | 'failure' | 'absorbedAt' | 'folderId' | 'raw' | 'exports' | 'pendingExports'>>): boolean {
  const { items } = loadIntakeLedger(instanceRoot);
  const item = items.get(id);
  if (!item?.absorb) return false;
  appendItems(instanceRoot, [{ ...item, absorb: { ...item.absorb, ...patch } }]);
  return true;
}

/** 상태·산출 갱신 — 흡수 뒤 `absorbed` · 노트 경로 등. 없는 id 면 false. */
export function markIntakeItem(instanceRoot: string, id: string, patch: { status?: IntakeStatus; output?: IntakeItem['outputs'][number] },
  now = new Date().toISOString()): boolean {
  const { items } = loadIntakeLedger(instanceRoot);
  const prev = items.get(id);
  if (!prev) return false;
  const next: IntakeItem = {
    ...prev,
    ...(patch.status ? { status: patch.status } : {}),
    outputs: patch.output ? [...prev.outputs, patch.output] : prev.outputs,
    lastSeenAt: now,
  };
  appendItems(instanceRoot, [next]);
  debug.log('intake.normalize', 'item-marked', { id, status: next.status, output: patch.output?.kind });
  return true;
}

export function listIntakeItems(instanceRoot: string, filter: { status?: IntakeStatus; source?: IntakeSource; seat?: string } = {}): IntakeItem[] {
  return [...loadIntakeLedger(instanceRoot).items.values()]
    .filter((i) => (!filter.status || i.status === filter.status) && (!filter.source || i.sources.includes(filter.source)) && (!filter.seat || i.seat === filter.seat))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** 수집기 산출(JSONL · 한 줄 = RawIntakeItem) 읽기. 깨진 줄은 세고 건너뛴다. */
export function parseRawIntakeJsonl(text: string): { raws: RawIntakeItem[]; bad: number } {
  const raws: RawIntakeItem[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') raws.push(o as RawIntakeItem); else bad++; } catch { bad++; }
  }
  return { raws, bad };
}

/**
 * 자동 흡수 대기열 — 텔레그램 저장 링크는 별도 레인(기본 30), 일반 몫은 하루 상한(기본 10). RFC §4 O1.
 * 레인이 먼저. 각 몫 안에서는 사용자가 직접 남긴 것(메모 포함) → 여러 입력원 → 점수(`*.score`) → 최근에 본 것.
 * 고른 항목은 `queued` 로 옮겨 다음 판에 다시 고르지 않는다(흡수 뒤 `absorbed`, 실패는 `deferred`).
 */
const STALE_QUEUED_MS = 24 * 3600_000;

export function pickAbsorbQueue(instanceRoot: string, opts: { max: number; laneMax?: number; kind?: IntakeKind; dryRun?: boolean }, now = new Date().toISOString(), taskStatus?: Parameters<typeof wasIntakeEventScheduled>[3]): IntakeItem[] {
  const userLeft = (i: IntakeItem) => i.sources.some((s) => s === 'telegram-saved' || s === 'memo');
  const score = (i: IntakeItem) => Math.max(0, ...Object.entries(i.signals).filter(([k]) => k.endsWith('.score')).map(([, v]) => v));
  const eligible = [...loadIntakeLedger(instanceRoot).items.values()]
    // queued 로 옮긴 뒤 흡수·표시가 없이 하루가 지난 것(흡수 도중 죽은 판)은 다시 고른다.
    .filter((i) => (i.status === 'new' || (i.status === 'queued' && Date.parse(now) - Date.parse(i.lastSeenAt) > STALE_QUEUED_MS))
      && !!i.url && !wasIntakeEventScheduled(instanceRoot, i.url, now, taskStatus) && (!opts.kind || i.kind === opts.kind))
    .sort((a, b) => Number(userLeft(b)) - Number(userLeft(a)) || b.sources.length - a.sources.length || score(b) - score(a) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const laneMax = opts.laneMax ?? 30;
  const lane = eligible.filter((i) => i.sources.includes('telegram-saved')).slice(0, Math.max(0, laneMax));
  const regular = eligible.filter((i) => !i.sources.includes('telegram-saved')).slice(0, Math.max(0, opts.max));
  const picked = [...lane, ...regular];
  if (!opts.dryRun && picked.length) {
    appendItems(instanceRoot, picked.map((i) => ({ ...i, status: 'queued' as const, lastSeenAt: now })));
  }
  debug.log('intake.normalize', 'absorb-queue', { picked: picked.length, max: opts.max, lane: lane.length, laneMax, kind: opts.kind, dryRun: !!opts.dryRun });
  return picked.map((i) => (opts.dryRun ? i : { ...i, status: 'queued' as const }));
}
