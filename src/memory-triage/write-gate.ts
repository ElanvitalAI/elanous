// 🧠 MEMORY-TRIAGE-NO-LLM 문 ① — 기억 «쓰기 문» 핵심. 배선(후속 PR (c)) 뒤에는 전역 기억(`src/memory.ts` saveMemory)과
// 자리 기억(`src/seat-memory/seat-memory.ts` saveSeatMemory)이 저장 직전에 이 함수 하나(`applyMemoryWriteGate`)를 지난다.
// 이 파일만으로는 아직 부르는 곳이 없다.
//
// S: 기억은 출처·범위·이유 없이 아무 문장이나 저장됐고, 같은 뜻이 여러 줄로 쌓였다
//    (11-17 감사: MOB-1·MVP-B 가 같은 교훈을 따로 저장 · 전역 3건이 537턴 중 378턴에 주입).
// C: 쓰기에 문이 없다 → 소음과 좋은 기억이 구분되지 않는다.
// A: 결정적 규칙(필수 칸 · 정규화 해시 · MinHash · 자리당 하루 상한). Jev(System One) 판정은 후속 PR (b) 의
//    어댑터가 맡는다 — 이 문은 그 결과(`JevMemoryJudgement`)를 입력으로만 받는다. 없으면 결정적 규칙만 쓴다.
//
// 세 얼굴:
//   관측 = `memory.triage` 범주 write-accepted · refused · deduped · superseded · capped
//          (· jev-fallback 은 (b) 어댑터가 낸다).
//          ⛔ 기억 본문·이름·이유 문면은 싣지 않는다 — id·라벨·수만.
//   판단 근거 = 아래 상수(출처 주석) · Jev 확률 · MinHash Jaccard 추정치.
//   수복과 인계 = 필수 칸이 빠진 옛 호출부는 그림자(shadow · 기본)로 쓴다 — 필수 칸 누락과 함께 중복·상한도
//          «했을 일»(would: refuse · increment · supersede)로 재서 남기고, 쓰기는 그대로 허락한다.
//          `ELANOUS_MEMORY_WRITE_GATE=on` 이면 구조화 오류(`MemoryWriteRefusedError.code`)로 거부한다.
//
// 동시성 범위: 판정과 쓰기(목록 읽기 → 판정 → 파일 쓰기)는 한 동기 구간이라 «한 프로세스» 안에서는
//   같은 문장 동시 쓰기가 한 줄 ⊕ 횟수로 접힌다. 프로세스 사이 잠금은 없다(다음 쓰기가 남은 중복에 횟수를 더한다).

import { debug, redactSecretText } from '../debug/log.js';

export const MEMORY_KINDS = ['교정', '확인된 방법', '사실', '약속'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_SCOPES = ['seat', 'role', 'project', 'global'] as const;
export type MemoryScope = typeof MEMORY_SCOPES[number];

/** 근접 중복 문턱 — MinHash 로 추정한 Jaccard 가 이 값 이상이면 같은 기억으로 본다. */
// 출처: ASK-MEMORY-TRIAGE-NO-LLM-1117 «정규화 문장 해시 ⊕ MinHash(Jaccard ≥0.8)면 새 줄 대신 횟수+1»
export const MEMORY_NEAR_DUP_JACCARD = 0.8;
/** 자리당 하루 새 기억 상한(중복으로 접힌 것은 세지 않는다). */
// 출처: ASK-MEMORY-TRIAGE-NO-LLM-1117 «평가» 표 — 쓰기 문 호출 빈도 «자리당 하루 ≤5»
export const MEMORY_SEAT_DAILY_CAP = 5;
/** Jev durable 확률이 이 값 미만이면 버린다. */
// 출처: ASK-MEMORY-TRIAGE-NO-LLM-1117 «정정» — «p(durable)<0.6 이면 버림»
export const MEMORY_JEV_DURABLE_MIN = 0.6;
/** Jev dup 질문에 싣는 기존 후보 수 k. */
// 출처: 회상 상한과 같은 값 — `src/seat-memory/seat-memory.ts` SEAT_MEMORY_RECALL_MAX_HITS(5)
export const MEMORY_JEV_DUP_TOP_K = 5;
/** MinHash 순열 수 — 추정 오차 ≈ 1/√k(128 → ±0.09). */
// 출처: Leskovec·Rajaraman·Ullman «Mining of Massive Datasets» 3.3 — 서명 길이와 Jaccard 추정 오차
export const MEMORY_MINHASH_PERMUTATIONS = 128;
/** 문자 shingle 길이 — 조사가 붙는 한국어 짧은 문장에서 낱말 단위보다 안정적이다. */
// 출처: 같은 책 3.2.2 — 짧은 문서는 작은 k 의 문자 shingle
export const MEMORY_SHINGLE_CHARS = 3;

export type MemoryWriteGateMode = 'shadow' | 'on';
export type MemoryWriteStore = 'global' | 'seat';
export type MemoryWriteRefusalCode =
  | 'missing-source' | 'missing-field' | 'daily-cap' | 'jev-not-durable' | 'store-read-failed';

/** 호출부가 주는 필수 칸. 하나라도 빠지면 «출처 없는 쓰기»로 본다. */
export interface MemoryWriteMeta {
  kind?: string;
  scope?: string;
  sourceEventId?: string;
  reason?: string;
}

/** 줄(row)에 남는 트리아지 기록 — 전역은 머리말 `triage:` JSON 한 줄, 자리 기억도 같다. */
export interface MemoryTriageRecord {
  kind: MemoryKind;
  scope: MemoryScope;
  source: string;
  reason: string;
  seat: string | null;
  /** UTC 날짜(YYYY-MM-DD) — 자리당 하루 상한을 셀 때 쓴다. 옛 줄을 접어 만든 기록은 빈 문자열. */
  day: string;
  /** 정규화 문장 sha 해시(16자) — 본문을 다시 읽지 않고 정확 중복을 가린다. */
  hash: string;
  count: number;
  lastSource?: string;
  /** 이 줄이 대신한 옛 줄 id — 근접·Jev 중복이지만 낱말이 달라 접지 않고 새 줄로 쓴 경우. */
  supersedes?: string;
  /** 이 줄을 대신한 새 줄 id — 강등된 옛 줄(중복 판정 후보에서 빠진다). */
  supersededBy?: string;
}

export interface MemoryGateRow {
  id: string;
  text: string;
  triage?: MemoryTriageRecord;
}

export interface JevMemoryVerdict {
  ok: true;
  durable: number;
  scope: MemoryScope;
  kind: MemoryKind;
  /** Jev 가 고른 중복 대상 줄 id · none 이면 null. */
  dupTargetId: string | null;
  model?: string;
}
export type JevMemoryJudgement = JevMemoryVerdict | { ok: false; reason: string };

export class MemoryWriteRefusedError extends Error {
  readonly code: MemoryWriteRefusalCode;
  constructor(code: MemoryWriteRefusalCode) {
    super(`memory write refused: ${code}`);
    this.name = 'MemoryWriteRefusedError';
    this.code = code;
  }
}

export function resolveMemoryWriteGateMode(env: NodeJS.ProcessEnv = process.env): MemoryWriteGateMode {
  return env.ELANOUS_MEMORY_WRITE_GATE?.trim().toLowerCase() === 'on' ? 'on' : 'shadow';
}

// ── 정규화 · 해시 · MinHash ───────────────────────────────────────────

/** NFKC ⊕ 소문자 ⊕ 공백 접기. 낱말 목록으로 행동을 가르지 않는다(R-SIG) — 같은 문장을 같은 바이트로 만들 뿐. */
export function normalizeMemoryText(text: string): string {
  return text.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean).join(' ');
}

/** FNV-1a 32비트 — 의존성 없는 결정적 해시. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 정확 중복 키 — 정규화 문장의 두 FNV 해시(서로 다른 seed)를 이어 16 hex. */
export function memoryTextHash(text: string): string {
  const n = normalizeMemoryText(text);
  return fnv1a(n).toString(16).padStart(8, '0') + fnv1a(n, 0x01000193).toString(16).padStart(8, '0');
}

/** murmur3 fmix32 — 순열마다 다른 seed 를 섞어 독립 해시처럼 쓴다. */
function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const PERMUTATION_SEEDS: readonly number[] = Array.from(
  { length: MEMORY_MINHASH_PERMUTATIONS },
  (_, i) => fmix32((i + 1) * 0x9e3779b1),
);

export function memoryShingles(text: string): Set<string> {
  const n = normalizeMemoryText(text);
  const out = new Set<string>();
  if (n.length <= MEMORY_SHINGLE_CHARS) { if (n) out.add(n); return out; }
  for (let i = 0; i + MEMORY_SHINGLE_CHARS <= n.length; i += 1) out.add(n.slice(i, i + MEMORY_SHINGLE_CHARS));
  return out;
}

/** 서명 캐시(정규화 해시 → 서명) — 줄마다 매 쓰기 128순열을 다시 계산하지 않는다(그림자에서도 모든 쓰기가 중복을 잰다). */
const signatureCache = new Map<string, Uint32Array>();
// 출처: 전역 색인 상한(`src/memory.ts` INDEX_MAX_LINES 200)의 여러 배 — 저장소 하나의 줄 수를 넉넉히 덮는다
const SIGNATURE_CACHE_MAX = 4_096;

export function minhashSignature(text: string): Uint32Array {
  const key = memoryTextHash(text);
  const hit = signatureCache.get(key);
  if (hit) return hit;
  const sig = computeMinhashSignature(text);
  signatureCache.set(key, sig);
  while (signatureCache.size > SIGNATURE_CACHE_MAX) signatureCache.delete(signatureCache.keys().next().value as string);
  return sig;
}

function computeMinhashSignature(text: string): Uint32Array {
  const sig = new Uint32Array(MEMORY_MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const shingle of memoryShingles(text)) {
    const base = fnv1a(shingle);
    for (let i = 0; i < sig.length; i += 1) {
      const v = fmix32(base ^ PERMUTATION_SEEDS[i]!);
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
  return same / a.length;
}

/**
 * 낱말(문자·숫자 덩어리) 집합이 다른가 — 부정어 목록 없이 극성을 지킨다:
 * «올린다» → «올리지 않는다» 처럼 뜻이 뒤집히는 고침은 반드시 낱말 하나 이상을 더하거나 뺀다.
 * 같은 낱말의 순서·문장부호·띄어쓰기만 다르면 false.
 */
export function memoryWordsDiffer(a: string, b: string): boolean {
  const words = (t: string): Set<string> => new Set(normalizeMemoryText(t).match(/[\p{L}\p{N}]+/gu) ?? []);
  const x = words(a);
  const y = words(b);
  if (x.size !== y.size) return true;
  for (const w of x) if (!y.has(w)) return true;
  return false;
}

/** MinHash 가 가장 가까운 줄 k개(Jev dup 후보) — 추정치 내림차순. */
export function nearestMemoryRows(text: string, rows: readonly MemoryGateRow[], k = MEMORY_JEV_DUP_TOP_K): Array<{ row: MemoryGateRow; jaccard: number }> {
  const sig = minhashSignature(text);
  return rows
    .map(row => ({ row, jaccard: estimateJaccard(sig, minhashSignature(row.text)) }))
    .sort((x, y) => y.jaccard - x.jaccard || x.row.id.localeCompare(y.row.id))
    .slice(0, Math.max(0, k));
}

// ── 판정 ──────────────────────────────────────────────────────────────

const isKind = (v: unknown): v is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(String(v));
const isScope = (v: unknown): v is MemoryScope => (MEMORY_SCOPES as readonly string[]).includes(String(v));
const nonEmpty = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export type MemoryGateVerdict =
  | { kind: 'create' }
  | { kind: 'refuse'; code: MemoryWriteRefusalCode }
  | { kind: 'increment'; target: MemoryGateRow; match: 'exact' | 'near' | 'jev'; jaccard?: number }
  | { kind: 'supersede'; target: MemoryGateRow; match: 'near' | 'jev'; jaccard?: number };

export interface MemoryGateInput {
  store: MemoryWriteStore;
  /** 어느 호출부인가(라벨) — 관측용. */
  origin: string;
  text: string;
  meta?: MemoryWriteMeta;
  seat?: string | null;
  /** 이미 있는 줄을 고치는 쓰기(같은 id·같은 name) — 새 기억이 아니므로 중복·상한을 보지 않는다. */
  updateTargetId?: string | null;
  jev?: JevMemoryJudgement;
  mode?: MemoryWriteGateMode;
  now?: Date;
  dailyCap?: number;
}

/** 필수 칸이 모두 있나 — 트리아지 기록(종류·범위·출처·이유)을 줄에 남길 수 있는지만 정한다. 강제 여부는 mode 만 정한다. */
export function memoryMetaComplete(meta: MemoryWriteMeta | undefined): boolean {
  return Boolean(meta && nonEmpty(meta.sourceEventId) && nonEmpty(meta.reason) && isKind(meta.kind) && isScope(meta.scope));
}

/**
 * 순수 판정 — 순서: 고침 → 출처·필수 칸 → Jev durable → 정확 중복 → 근접 중복 → Jev dup → 하루 상한 → 새 줄.
 * 근접·Jev 중복이라도 낱말이 다르면(`memoryWordsDiffer`) 횟수로 접지 않는다 — 새 본문을 버리면 부정·교정이 사라진다.
 * 대신 새 줄 ⊕ supersedes 링크(옛 줄 강등)다. 강등된 줄은 중복 후보에서 빠진다.
 * 줄 목록은 필요할 때만 읽는다(`getRows`) — 출처 없는 옛 쓰기는 목록·MinHash 비용 없이 판정이 끝난다.
 */
export function memoryFieldRefusal(meta: MemoryWriteMeta | undefined): 'missing-source' | 'missing-field' | undefined {
  const m = meta ?? {};
  if (!nonEmpty(m.sourceEventId)) return 'missing-source';
  if (!nonEmpty(m.reason) || !isKind(m.kind) || !isScope(m.scope)) return 'missing-field';
  return undefined;
}

export function decideMemoryWrite(
  input: MemoryGateInput,
  getRows: () => readonly MemoryGateRow[],
  getDailyCount?: (seat: string | null, day: string) => number,
  /** 그림자: 필수 칸 누락은 따로 기록했으니 건너뛰고, 중복·상한을 «했을 일»로 계속 잰다. */
  opts: { skipFieldCheck?: boolean } = {},
): MemoryGateVerdict {
  if (input.updateTargetId) return { kind: 'create' };
  const fieldCode = opts.skipFieldCheck ? undefined : memoryFieldRefusal(input.meta);
  if (fieldCode) return { kind: 'refuse', code: fieldCode };
  if (input.jev?.ok && input.jev.durable < MEMORY_JEV_DURABLE_MIN) return { kind: 'refuse', code: 'jev-not-durable' };
  const rows = getRows().filter(row => !row.triage?.supersededBy);
  const hash = memoryTextHash(input.text);
  // 저장된 hash 는 참고값이다 — 본문이 손으로 고쳐졌을 수 있으니 판정은 지금 본문으로 한다.
  const exact = rows.find(row => memoryTextHash(row.text) === hash);
  if (exact) return { kind: 'increment', target: exact, match: 'exact' };
  let supersede: MemoryGateVerdict | undefined;
  const nearest = nearestMemoryRows(input.text, rows, 1)[0];
  if (nearest && nearest.jaccard >= MEMORY_NEAR_DUP_JACCARD) {
    if (!memoryWordsDiffer(input.text, nearest.row.text)) return { kind: 'increment', target: nearest.row, match: 'near', jaccard: nearest.jaccard };
    supersede = { kind: 'supersede', target: nearest.row, match: 'near', jaccard: nearest.jaccard };
  }
  const jev = input.jev;
  if (!supersede && jev?.ok && jev.dupTargetId) {
    const target = rows.find(row => row.id === jev.dupTargetId);
    if (target && !memoryWordsDiffer(input.text, target.text)) return { kind: 'increment', target, match: 'jev' };
    if (target) supersede = { kind: 'supersede', target, match: 'jev' };
  }
  // supersede 도 새 줄을 만든다 — 하루 상한을 지나고 원장에 센다(낱말 하나씩 바꿔 쓰는 무한 증식을 막는다).
  const day = utcDay(input.now ?? new Date());
  const seatKey = input.seat ?? null;
  const today = getDailyCount
    ? getDailyCount(seatKey, day)
    : rows.filter(row => row.triage && row.triage.day === day && row.triage.seat === seatKey).length;
  if (today >= (input.dailyCap ?? MEMORY_SEAT_DAILY_CAP)) return { kind: 'refuse', code: 'daily-cap' };
  return supersede ?? { kind: 'create' };
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** 새 줄에 붙일 트리아지 기록 — 필수 칸이 다 있을 때만 만든다(옛 호출부의 파일 바이트는 바꾸지 않는다). */
export function newTriageRecord(input: MemoryGateInput): MemoryTriageRecord | undefined {
  const meta = input.meta;
  if (!memoryMetaComplete(meta)) return undefined;
  return {
    kind: meta!.kind as MemoryKind,
    scope: meta!.scope as MemoryScope,
    source: nonEmpty(meta!.sourceEventId),
    reason: nonEmpty(meta!.reason),
    seat: input.seat ?? null,
    day: utcDay(input.now ?? new Date()),
    hash: memoryTextHash(input.text),
    count: 1,
  };
}

/** 중복으로 접힐 때 대상 줄의 기록 — 옛 줄(기록 없음)은 횟수 1 에서 시작해 +1. */
export function bumpedTriageRecord(target: MemoryGateRow, input: MemoryGateInput): MemoryTriageRecord {
  const prev = target.triage;
  const meta = input.meta ?? {};
  const source = nonEmpty(meta.sourceEventId);
  return {
    // 횟수 +1 은 필수 칸 검사를 지난 뒤에만 온다 — meta 의 kind·scope 는 이미 유효하다(추정값을 만들지 않는다).
    kind: prev?.kind ?? (meta.kind as MemoryKind),
    scope: prev?.scope ?? (meta.scope as MemoryScope),
    source: prev?.source ?? source,
    reason: prev?.reason ?? nonEmpty(meta.reason),
    seat: prev?.seat ?? input.seat ?? null,
    day: prev?.day ?? '',
    hash: prev?.hash ?? memoryTextHash(target.text),
    count: (prev?.count ?? 1) + 1,
    ...(source ? { lastSource: source } : prev?.lastSource ? { lastSource: prev.lastSource } : {}),
  };
}

export function parseTriageRecord(raw: string | undefined): MemoryTriageRecord | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<MemoryTriageRecord>;
    if (!v || typeof v !== 'object' || !isKind(v.kind) || !isScope(v.scope)) return undefined;
    const count = typeof v.count === 'number' && Number.isFinite(v.count) && v.count >= 1 ? Math.floor(v.count) : 1;
    return {
      kind: v.kind, scope: v.scope, source: nonEmpty(v.source), reason: nonEmpty(v.reason),
      seat: typeof v.seat === 'string' ? v.seat : null, day: typeof v.day === 'string' ? v.day : '',
      hash: typeof v.hash === 'string' ? v.hash : '', count,
      ...(typeof v.lastSource === 'string' && v.lastSource ? { lastSource: v.lastSource } : {}),
      ...(typeof v.supersedes === 'string' && v.supersedes ? { supersedes: v.supersedes } : {}),
      ...(typeof v.supersededBy === 'string' && v.supersededBy ? { supersededBy: v.supersededBy } : {}),
    };
  } catch { return undefined; }
}

/** 사건에 싣는 줄 참조 — 자리 기억의 id 는 파일 이름(= 기억 이름)이라 그대로 싣으면 문면이 샌다. 해시로만 싣는다. */
export const memoryRowRef = (id: string): string => `m:${memoryTextHash(id)}`;

export const renderTriageRecord = (record: MemoryTriageRecord): string => JSON.stringify(record).replace(/[\r\n]+/g, ' ');

// ── 관측 ──────────────────────────────────────────────────────────────

export type MemoryTriageLog = (category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => void;
const defaultLog: MemoryTriageLog = (category, event, data, level) => debug.log(category, event, data, level ? { level } : undefined);

/** ⛔ 본문·이름·이유는 받지 않는다 — 부르는 쪽이 넣을 수 없게 인자 모양을 좁혔다. */
export function emitMemoryTriage(
  event: 'write-accepted' | 'refused' | 'deduped' | 'superseded' | 'capped' | 'jev-fallback',
  data: {
    store: MemoryWriteStore; origin: string; seat?: string | null; mode?: MemoryWriteGateMode; enforced?: boolean;
    action?: 'create' | 'update'; code?: MemoryWriteRefusalCode; match?: 'exact' | 'near' | 'jev'; target?: string;
    count?: number; jaccard?: number; kind?: string; scope?: string; source?: string; cause?: string; would?: string;
    jevDurable?: number; model?: string;
  },
  log: MemoryTriageLog = defaultLog,
): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    // 라벨 칸(kind·scope)은 정해진 값만, 아니면 «other» — 자유 문면이 이 경로로 새지 않게 한다.
    if (k === 'kind') safe[k] = isKind(v) ? v : 'other';
    else if (k === 'scope') safe[k] = isScope(v) ? v : 'other';
    else safe[k] = typeof v === 'string' ? redactSecretText(v).slice(0, 160) : v;
  }
  try { log('memory.triage', event, safe, event === 'refused' || event === 'capped' || event === 'jev-fallback' ? 'warn' : 'info'); }
  catch { /* 관측 실패가 쓰기를 막지 않는다 */ }
}

// ── 문 ────────────────────────────────────────────────────────────────

export interface MemoryGateStore {
  /** 판정에 쓸 기존 줄 — 실패하면 던진다(`store-read-failed`). */
  rows(): MemoryGateRow[];
  /** 자리·날짜별 «만든 수» 원장 — 저장소 사이에 공유되고 줄을 지워도 줄지 않는다. 없으면 남은 줄로 센다. */
  dailyLedger?: MemoryDailyLedger;
}

export interface MemoryDailyLedger {
  count(seat: string | null, day: string): number;
  record(seat: string | null, day: string): void;
}

const DAILY_LEDGER_FILE = '.triage-daily.json';

/**
 * 하루 상한 원장 — `<기억 뿌리>/.triage-daily.json` 하나를 전역·자리 저장소가 같이 쓴다.
 * 오늘·어제 칸만 남긴다. 읽기 실패(깨진 JSON)는 던진다 → 문이 `store-read-failed` 로 다룬다.
 * 한 프로세스 안에서는 판정과 같은 동기 구간이라 경합이 없다 · 프로세스 사이 잠금은 없다.
 */
export function fileDailyLedger(root: string): MemoryDailyLedger {
  const { existsSync, readFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { writeFileDurable } = require('../memory.js') as typeof import('../memory.js');
  const path = join(root, DAILY_LEDGER_FILE);
  const read = (): Record<string, Record<string, number>> => {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('daily ledger malformed');
    return parsed as Record<string, Record<string, number>>;
  };
  const key = (seat: string | null): string => seat ?? '-';
  return {
    count: (seat, day) => {
      const n = read()[day]?.[key(seat)];
      return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    },
    record: (seat, day) => {
      const all = read();
      const yesterday = utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000));
      const kept: Record<string, Record<string, number>> = {};
      for (const d of [yesterday, day]) if (all[d]) kept[d] = all[d]!;
      kept[day] = { ...(kept[day] ?? {}), [key(seat)]: ((kept[day] ?? {})[key(seat)] ?? 0) + 1 };
      mkdirSync(root, { recursive: true });
      writeFileDurable(path, `${JSON.stringify(kept)}\n`);
    },
  };
}

export type MemoryGateOutcome =
  | { action: 'create'; triage?: MemoryTriageRecord; enforced: boolean }
  | { action: 'update'; enforced: boolean }
  | { action: 'increment'; target: MemoryGateRow; triage: MemoryTriageRecord; match: 'exact' | 'near' | 'jev' }
  /** 새 줄(triage.supersedes = 옛 줄 id) ⊕ 옛 줄 강등(demoted — 호출부가 supersededBy 에 새 줄 id 를 넣는다). */
  | { action: 'supersede'; target: MemoryGateRow; triage: MemoryTriageRecord; demoted: MemoryTriageRecord; match: 'near' | 'jev'; demote: boolean };

/**
 * 모든 기억 쓰기가 지나는 단 하나의 문. 결과대로 호출부가 «새 줄 / 고침 / 횟수 +1»을 쓴다.
 * 강제(enforced) = mode on 뿐이다(`ELANOUS_MEMORY_WRITE_GATE=on`). 기본(그림자)은 필수 칸이 다 있어도 거부·상한·Jev 버림·
 * 횟수 접기를 «했을 일»(would)로만 남기고 새 줄을 허락한다 — 쓰기 문은 측정 뒤에 켠다(RFC «그림자 먼저»).
 * 강제 거부는 `MemoryWriteRefusedError`(code) 를 던진다.
 */
export function applyMemoryWriteGate(input: MemoryGateInput, store: MemoryGateStore, log: MemoryTriageLog = defaultLog): MemoryGateOutcome {
  const mode = input.mode ?? resolveMemoryWriteGateMode();
  // 그림자 먼저: 강제는 mode on 일 때만. 필수 칸이 다 있는 쓰기도 기본에서는 기록만 한다(조용히 기억이 줄지 않게).
  const enforced = mode === 'on';
  const meta = input.meta ?? {};
  const base = {
    store: input.store, origin: input.origin, seat: input.seat ?? null, mode, enforced,
    kind: meta.kind, scope: meta.scope, source: nonEmpty(meta.sourceEventId) || undefined,
    ...(input.jev?.ok ? { jevDurable: input.jev.durable } : {}),
  };
  if (input.updateTargetId) {
    emitMemoryTriage('write-accepted', { ...base, action: 'update', target: memoryRowRef(input.updateTargetId) }, log);
    return { action: 'update', enforced };
  }
  let cached: MemoryGateRow[] | undefined;
  let readFailed = false;
  const getRows = (): MemoryGateRow[] => {
    if (cached) return cached;
    try { cached = store.rows(); return cached; }
    catch (error) { readFailed = true; throw error; }
  };
  const ledger = store.dailyLedger;
  const getDailyCount = ledger ? (seat: string | null, day: string): number => {
    try { return ledger.count(seat, day); } catch (error) { readFailed = true; throw error; }
  } : undefined;
  // 그림자(강제 아님 = 필수 칸 누락): 누락을 «거부했을 것»으로 남기고, 판정은 칸 검사를 건너뛰어 중복·상한까지 잰다.
  if (!enforced) {
    const fieldCode = memoryFieldRefusal(input.meta);
    if (fieldCode) emitMemoryTriage('refused', { ...base, code: fieldCode, would: 'refuse' }, log);
  }
  /**
   * 새 줄 — 강제든 그림자든 같은 길이다. 필수 칸이 다 있으면 트리아지 기록을 붙이고, 쓰기 «전»에 원장에 센다
   * (쓰기가 실패하면 하루 상한 쪽으로 하나 더 보수적). 그림자의 «했을 상한»도 이 수로 잰다. 원장 쓰기 실패는 강제일 때만 막는다.
   */
  const createRow = (): MemoryGateOutcome => {
    const triage = newTriageRecord(input);
    if (triage && ledger) {
      try { ledger.record(triage.seat, triage.day); }
      catch {
        emitMemoryTriage('refused', { ...base, code: 'store-read-failed', cause: 'daily-ledger-write', ...(enforced ? {} : { would: 'refuse' }) }, log);
        if (enforced) throw new MemoryWriteRefusedError('store-read-failed');
      }
    }
    emitMemoryTriage('write-accepted', { ...base, action: 'create' }, log);
    return { action: 'create', ...(triage ? { triage } : {}), enforced };
  };
  let verdict: MemoryGateVerdict;
  try { verdict = decideMemoryWrite({ ...input, mode }, getRows, getDailyCount, { skipFieldCheck: !enforced }); }
  catch (error) {
    if (!readFailed) throw error;
    emitMemoryTriage('refused', { ...base, code: 'store-read-failed', ...(enforced ? {} : { would: 'refuse' }) }, log);
    if (enforced) throw new MemoryWriteRefusedError('store-read-failed');
    return createRow();
  }
  if (verdict.kind === 'create') return createRow();
  if (verdict.kind === 'supersede') {
    const bumped = bumpedTriageRecord(verdict.target, input);
    emitMemoryTriage('superseded', {
      ...base, match: verdict.match, target: memoryRowRef(verdict.target.id), count: bumped.count,
      ...(verdict.jaccard !== undefined ? { jaccard: Number(verdict.jaccard.toFixed(3)) } : {}),
      ...(enforced ? {} : { would: 'supersede' }),
    }, log);
    if (enforced) {
      // 강제 경로는 필수 칸이 다 있다 → 새 기록이 있다. 횟수는 옛 줄에서 이어받는다(같은 교훈이 한 번 더 확인됨).
      const fresh = newTriageRecord(input) ?? bumped;
      // 새 줄이므로 create 와 같이 쓰기 «전»에 원장에 센다.
      if (ledger) {
        try { ledger.record(fresh.seat, fresh.day); }
        catch {
          emitMemoryTriage('refused', { ...base, code: 'store-read-failed', cause: 'daily-ledger-write' }, log);
          throw new MemoryWriteRefusedError('store-read-failed');
        }
      }
      const demoted: MemoryTriageRecord = verdict.target.triage
        ?? { kind: bumped.kind, scope: bumped.scope, source: '', reason: '', seat: bumped.seat, day: '', hash: bumped.hash, count: 1 };
      return {
        action: 'supersede', target: verdict.target, match: verdict.match,
        triage: { ...fresh, count: bumped.count, supersedes: verdict.target.id },
        demoted,
        // 강등(색인에서 빼기·고정 풀기)은 결정적 근거(MinHash)일 때만 — Jev 만의 근거로는 supersedes 링크만 남긴다.
        demote: verdict.match === 'near',
      };
    }
  } else if (verdict.kind === 'increment') {
    const triage = bumpedTriageRecord(verdict.target, input);
    emitMemoryTriage('deduped', {
      ...base, match: verdict.match, target: memoryRowRef(verdict.target.id), count: triage.count,
      ...(verdict.jaccard !== undefined ? { jaccard: Number(verdict.jaccard.toFixed(3)) } : {}),
      ...(enforced ? {} : { would: 'increment' }),
    }, log);
    if (enforced) return { action: 'increment', target: verdict.target, triage, match: verdict.match };
  } else {
    emitMemoryTriage(verdict.code === 'daily-cap' ? 'capped' : 'refused', { ...base, code: verdict.code, ...(enforced ? {} : { would: 'refuse' }) }, log);
    if (enforced) throw new MemoryWriteRefusedError(verdict.code);
  }
  // 그림자: «했을 일»은 위에서 사건으로 남겼다. 쓰기는 새 줄로 허락하되 기록·원장 수는 잃지 않는다(조용한 측정 손실 금지).
  return createRow();
}
