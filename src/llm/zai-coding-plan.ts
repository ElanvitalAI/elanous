// ── ZAI-CODING-PLAN-PROVIDER — GLM Coding Plan(Z.ai) 직결 ──
//
// 대표 2026-10-11 결정(A안): OpenRouter 를 거치지 않고 기존 `glm` 공급자 «안에서» 코딩 엔드포인트를 고른다.
//   ⛔ 공급자 «이름»을 늘리지 않는다 — `glm` 은 이미 union·사다리에 있다(llm-tier-map 의 Record 를 안 건드린다).
//   ⛔ 이용 규정상 «지원 도구 밖» 위험은 대표 가 알고 택했다 — 그래서 ***위장하지 않는다***(헤더 꾸미기 0).
//
// 이 파일 = 엔드포인트 선택 · 동시 상한 · 오류 판별 · 정책 결정 · 폴백 · 크레딧 적산 · 공식 사용량 조회.
// `llm.ts` 는 배선(한 분기 ⊕ export 한 줄)만 갖는다(OP Q3 · RFC llm-ts-split · Bedrock #25966 선례).
// ⛔ 순환 방지: `../llm.js` 는 «타입»만 정적으로 가져오고, 값(호환 공급자·OpenRouter 공급자)은 호출 때 동적 import.
//
// 근거 문서 = PR #26038 `docs/reference/zai-glm-coding-plan/` — 오류 코드 `api-reference__api-code.md` ·
//   크레딧·창 `devpack__overview.md`(Max = 5h 28,000 / 주 140,000 · 비첨두 50% · 첨두 = 평일 14–18시 UTC+8).
// ⛔ 키 값은 어떤 로그·오류·요약에도 싣지 않는다 — 관측은 «있음/없음»만.

import type { LLMProvider, LLMStreamEvent, LLMOpts, LLMMessage } from '../llm.js';
import type { LLMConfig as UCLLMConfig } from '../user-config.js';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { keyFromCacheOrEnv } from '../config.js';
import { quotaSignalDir } from '../budget/codex-reset-credit-state.js';

/** 코딩 엔드포인트(OpenAI 호환). FAQ: "API endpoint for other tools is `https://api.z.ai/api/coding/paas/v4`". */
export const ZAI_CODING_PLAN_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
/** 공식 사용량 조회(문서엔 없다 · 2026-10-11 실측 200 — ⓒ). 응답 `data.limits[]` = 5h·주 창. */
export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const ZAI_CODING_DEFAULT_MODEL = 'glm-5.3';
export const ZAI_CODING_MODELS = ['glm-5.3', 'glm-5.3-flash'] as const;
/** 폴백 대상(사다리 `openrouter` balanced 와 같은 id). */
export const ZAI_OPENROUTER_FALLBACK_MODEL = 'openrouter/z-ai/glm-5.3';
export const ZAI_DEFAULT_MAX_CONCURRENT = 3;
/** Max 한도(공식 조회가 되면 그 값이 이긴다). */
export const ZAI_MAX_PLAN_LIMITS = { fiveHour: 28_000, weekly: 140_000 } as const;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type ZaiOveragePolicy = 'stop' | 'balance' | 'openrouter';
export const ZAI_OVERAGE_POLICIES: readonly ZaiOveragePolicy[] = ['stop', 'balance', 'openrouter'];
/** 기본 = `stop` — 잔액도 OpenRouter 도 «돈»이다. 명시할 때만 연다(codex `credits` 와 같은 fail-closed 결). */
export const ZAI_DEFAULT_OVERAGE_POLICY: ZaiOveragePolicy = 'stop';

export function isZaiOveragePolicy(v: unknown): v is ZaiOveragePolicy {
  return typeof v === 'string' && (ZAI_OVERAGE_POLICIES as readonly string[]).includes(v);
}

export interface ZaiCodingPlanSettings {
  overage: ZaiOveragePolicy;
  maxConcurrent: number;
}

export function zaiSettingsFromConfig(cfg: Pick<UCLLMConfig, 'zaiCodingPlan'> | undefined): ZaiCodingPlanSettings {
  const raw = cfg?.zaiCodingPlan;
  const max = raw?.maxConcurrent;
  return {
    overage: isZaiOveragePolicy(raw?.overage) ? raw.overage : ZAI_DEFAULT_OVERAGE_POLICY,
    maxConcurrent: typeof max === 'number' && Number.isSafeInteger(max) && max >= 1 ? max : ZAI_DEFAULT_MAX_CONCURRENT,
  };
}

// ── 자격 ────────────────────────────────────────────────

export interface ZaiKeyDeps {
  /** 시험 seam — 기본은 키 캐시(`~/.cache/zai_api_key`) → env `ZAI_API_KEY`. */
  readonly key?: () => string | undefined;
}

export function getZaiApiKey(deps: ZaiKeyDeps = {}): string | undefined {
  const v = (deps.key ?? (() => keyFromCacheOrEnv('ZAI_API_KEY')))();
  return v && v.trim() ? v.trim() : undefined;
}

/** ⭐ 직결 경로가 «서나» — 키가 없으면 false 이고 `glm` 은 종전 동작(OpenRouter 안내 오류) 그대로다. */
export function zaiCodingPlanAvailable(deps: ZaiKeyDeps = {}): boolean {
  return getZaiApiKey(deps) !== undefined;
}

// ── 크레딧 ──────────────────────────────────────────────

const CREDIT_RATES: Record<'glm-5.3' | 'glm-5.3-flash', { input: number; cached: number; output: number }> = {
  'glm-5.3': { input: 6.9, cached: 1.7, output: 24 },
  'glm-5.3-flash': { input: 2.3, cached: 0.56, output: 8 },
};

/** 첨두 = 월–금 14:00–18:00 싱가포르 시각(UTC+8). 그 밖(주말 포함)은 비첨두 50%. */
export function isZaiPeak(nowMs: number): boolean {
  const sg = new Date(nowMs + 8 * 60 * 60 * 1000);
  const day = sg.getUTCDay();
  const hour = sg.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 14 && hour < 18;
}

export function zaiRateFamily(model: string): 'glm-5.3' | 'glm-5.3-flash' {
  return /flash/i.test(model) ? 'glm-5.3-flash' : 'glm-5.3';
}

/** 크레딧 = (입력×in + 캐시입력×cached + 출력×out)/10,000 × (첨두 1 · 비첨두 0.5).
 *  ⚠️ `input` 은 «새 입력만»(elanous 규약 · `parseOpenAIUsage` 가 캐시분을 이미 뺐다). */
export function zaiCredits(
  model: string,
  usage: { input: number; cached: number; output: number },
  nowMs: number,
): number {
  const r = CREDIT_RATES[zaiRateFamily(model)];
  const base = (usage.input * r.input + usage.cached * r.cached + usage.output * r.output) / 10_000;
  // ⛔ 반올림하지 않는다 — 작은 호출이 0 으로 접혀 적산이 실제보다 낮아진다(반올림은 표시 때만).
  return base * (isZaiPeak(nowMs) ? 1 : 0.5);
}

// ── 오류 판별 ───────────────────────────────────────────

/** plan-limit = 플랜 창 소진(잔액 사용 꺼짐) · balance-limit = 잔액·월 상한 소진 · plan-unavailable = 플랜 자체가 막힘. */
export type ZaiLimitKind = 'plan-limit' | 'balance-limit' | 'plan-unavailable';
export type ZaiLimitWindow = '5h' | 'weekly';

export interface ZaiErrorClass {
  code: number;
  kind: ZaiLimitKind | 'rate' | 'other';
  window: ZaiLimitWindow | null;
  /** epoch ms — `next_flush_time` 에서. 못 읽으면 null. */
  resetAt: number | null;
  /** 원문 시각 문자열(관측용 · 키 아님). */
  resetRaw: string | null;
}

const PLAN_LIMIT = new Set([1308, 1310]);
const BALANCE_LIMIT = new Set([1113, 1316, 1317, 1318, 1319, 1320, 1321]);
const PLAN_UNAVAILABLE = new Set([1309, 1311, 1313, 1314, 1315]);
const RATE = new Set([1302, 1305]);
const FIVE_H_CODES = new Set([1316, 1318, 1320]);
const WEEK_CODES = new Set([1310, 1317, 1319, 1321]);

/** `{"error":{"code":"1316","message":"… Resets at 2026-10-11 09:12:33."}}` → 판별. JSON 이 아니면 null. */
export function classifyZaiError(status: number, bodyText: string): ZaiErrorClass | null {
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  const err = (parsed as { error?: { code?: unknown; message?: unknown; next_flush_time?: unknown } } | null)?.error;
  const code = Number(err?.code);
  if (!err || !Number.isFinite(code)) return null;
  const message = typeof err.message === 'string' ? err.message : '';
  const kind: ZaiErrorClass['kind'] = PLAN_LIMIT.has(code) ? 'plan-limit'
    : BALANCE_LIMIT.has(code) ? 'balance-limit'
      : PLAN_UNAVAILABLE.has(code) ? 'plan-unavailable'
        : RATE.has(code) ? 'rate' : 'other';
  const window: ZaiLimitWindow | null = FIVE_H_CODES.has(code) ? '5h'
    : WEEK_CODES.has(code) ? 'weekly'
      : code === 1308 ? (/hour/i.test(message) ? '5h' : /week|day/i.test(message) ? 'weekly' : null)
        : null;
  const flush = parseNextFlushTime(err.next_flush_time ?? (parsed as Record<string, unknown>).next_flush_time, message);
  void status;
  return { code, kind, window, resetAt: flush.at, resetRaw: flush.raw };
}

/** `next_flush_time` — 숫자(epoch s/ms) 또는 문자열. 시간대 없는 «YYYY-MM-DD HH:mm:ss» 는 UTC+8(Z.ai 기준 시각)로 읽는다.
 *  ⚠️ 그 가정은 관측(`resetRaw`)으로 남겨 실측과 대조한다. */
export function parseNextFlushTime(field: unknown, message: string): { at: number | null; raw: string | null } {
  if (typeof field === 'number' && Number.isFinite(field)) {
    return { at: field < 1e12 ? field * 1000 : field, raw: String(field) };
  }
  const candidates = [typeof field === 'string' ? field : '', message];
  for (const text of candidates) {
    if (!text) continue;
    const epoch = text.match(/\b(\d{13}|\d{10})\b/);
    const iso = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/);
    if (iso) {
      const tz = iso[3] ? (iso[3] === 'Z' ? 'Z' : iso[3].includes(':') ? iso[3] : `${iso[3].slice(0, 3)}:${iso[3].slice(3)}`) : '+08:00';
      const time = iso[2].length === 5 ? `${iso[2]}:00` : iso[2];
      const at = Date.parse(`${iso[1]}T${time}${tz}`);
      if (Number.isFinite(at)) return { at, raw: iso[0] };
    }
    if (epoch) {
      const n = Number(epoch[1]);
      return { at: epoch[1].length === 10 ? n * 1000 : n, raw: epoch[1] };
    }
  }
  return { at: null, raw: null };
}

export type ZaiAction = 'call' | 'stop' | 'openrouter';

/** 정책 결정표 — `pre` = 호출 전(기록된 한도가 아직 살아 있다) · `post` = 방금 서버가 한도 오류를 냈다.
 *  - stop       → 언제나 멈춘다(돈 0).
 *  - openrouter → 언제나 OpenRouter 로.
 *  - balance    → 플랜 창만 찼으면(pre) 그대로 호출(서버가 잔액으로 «extra usage» 를 쓴다) ·
 *                 잔액·월 상한(1113/1316~1321)이나 서버가 막았으면 다음 칸(OpenRouter). */
export function decideZaiAction(policy: ZaiOveragePolicy, kind: ZaiLimitKind, phase: 'pre' | 'post'): ZaiAction {
  if (policy === 'stop') return 'stop';
  if (policy === 'openrouter') return 'openrouter';
  return kind === 'plan-limit' && phase === 'pre' ? 'call' : 'openrouter';
}

// ── 원장(적산) ──────────────────────────────────────────

export interface ZaiCallRecord {
  ts: number; kind: 'call'; model: string;
  input: number; cached: number; output: number;
  credits: number; peak: boolean;
  /** plan = 구독 창 · balance = 창이 찬 뒤 잔액(extra usage)로 갔다고 «추정»한 호출. */
  bucket: 'plan' | 'balance';
}
export interface ZaiLimitRecord {
  ts: number; kind: 'limit'; code: number; limitKind: ZaiLimitKind;
  window: ZaiLimitWindow | null; resetAt: number | null; model: string;
}
export type ZaiLedgerRecord = ZaiCallRecord | ZaiLimitRecord;

export interface ZaiLedgerDeps {
  /** 원장 파일 경로 — 기본 `<자격 뿌리>/budget/zai-coding-plan-ledger.jsonl`(계정 자원이라 우주를 안 가른다 · codex 신호와 같은 뿌리). */
  readonly ledgerPath?: string;
  readonly now?: () => number;
}

export function zaiLedgerPath(deps: ZaiLedgerDeps = {}): string {
  return deps.ledgerPath ?? join(quotaSignalDir(), 'zai-coding-plan-ledger.jsonl');
}

export function appendZaiLedger(record: ZaiLedgerRecord, deps: ZaiLedgerDeps = {}): void {
  const path = zaiLedgerPath(deps);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    debug.log('zai.coding-plan', 'ledger-write-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
  }
}

/** 최근 8일만 읽는다(주 창 + 여유). 깨진 줄은 버린다.
 *  ⭐ 버린 줄이 많으면(≥ 1,000) 남길 줄만으로 파일을 다시 쓴다 — 원장이 끝없이 자라지 않는다. */
export function readZaiLedger(deps: ZaiLedgerDeps = {}): ZaiLedgerRecord[] {
  const now = (deps.now ?? Date.now)();
  const path = zaiLedgerPath(deps);
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out: ZaiLedgerRecord[] = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ZaiLedgerRecord;
      if (typeof r?.ts === 'number' && r.ts >= now - WEEK_MS - 24 * 60 * 60 * 1000) out.push(r);
      else dropped += 1;
    } catch { dropped += 1; }
  }
  if (dropped >= ZAI_LEDGER_COMPACT_THRESHOLD) {
    try {
      // 임시 파일 → rename(원자 교체). ⚠️ 읽기~교체 사이 다른 프로세스의 append 는 잃을 수 있다 — 드문 압축 순간에 한하고 적산은 추정이다.
      const tmpPath = `${path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, out.map((r) => JSON.stringify(r)).join('\n') + (out.length > 0 ? '\n' : ''), { mode: 0o600 });
      renameSync(tmpPath, path);
      debug.log('zai.coding-plan', 'ledger-compacted', { dropped, kept: out.length });
    } catch { /* 다음 읽기에 다시 시도한다 */ }
  }
  return out;
}
export const ZAI_LEDGER_COMPACT_THRESHOLD = 1_000;

/** 아직 살아 있는 한도 기록(가장 최근 · 리셋 시각이 미래). 리셋 시각을 모르면 15분만 유효(그 뒤엔 다시 찔러 본다). */
export function activeZaiLimit(records: readonly ZaiLedgerRecord[], nowMs: number): ZaiLimitRecord | null {
  let best: ZaiLimitRecord | null = null;
  for (const r of records) {
    if (r.kind !== 'limit') continue;
    const until = r.resetAt ?? r.ts + 15 * 60 * 1000;
    if (until <= nowMs) continue;
    // 같은 창의 더 뒤 «성공» 호출이 있으면 그 한도는 풀린 것이다(리셋 카드 등).
    const cleared = records.some((c) => c.kind === 'call' && c.ts > r.ts && c.bucket === 'plan');
    if (cleared && r.limitKind === 'plan-limit') continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best;
}

export interface ZaiLocalWindows {
  fiveHour: { used: number; oldestTs: number | null };
  weekly: { used: number; sinceTs: number | null };
  balanceCredits: number;
  calls: number;
}

/** ⓐ 우리 쪽 적산 — 5h 는 «소비 후 5시간에 풀린다»(롤링). 주 창은 기준 시각을 모르면 롤링 7일로 «추정». */
export function sumZaiLocalWindows(records: readonly ZaiLedgerRecord[], nowMs: number, weeklyStart?: number | null): ZaiLocalWindows {
  const fiveFrom = nowMs - FIVE_HOURS_MS;
  const weekFrom = weeklyStart && weeklyStart <= nowMs ? weeklyStart : nowMs - WEEK_MS;
  let five = 0; let week = 0; let balance = 0; let calls = 0; let oldest: number | null = null;
  for (const r of records) {
    if (r.kind !== 'call') continue;
    if (r.ts >= weekFrom) {
      calls += 1;
      if (r.bucket === 'balance') { balance += r.credits; continue; }
      week += r.credits;
    }
    if (r.ts >= fiveFrom && r.bucket === 'plan') {
      five += r.credits;
      if (oldest === null || r.ts < oldest) oldest = r.ts;
    }
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { fiveHour: { used: round(five), oldestTs: oldest }, weekly: { used: round(week), sinceTs: weekFrom }, balanceCredits: round(balance), calls };
}

// ── 공식 사용량 조회(ⓒ) ─────────────────────────────────

export interface ZaiQuotaWindow { window: ZaiLimitWindow; limit: number; used: number; remaining: number; resetAt: number | null }
export type ZaiQuotaResult =
  | { status: 'ok'; level: string | null; windows: ZaiQuotaWindow[]; fetchedAt: number }
  | { status: 'unauthorized' | 'error'; detail: string };

/** 응답 `{data:{limits:[{type:'CREDIT_LIMIT',unit:3,number:5,usage,currentValue,remaining,nextResetTime}], level}}`.
 *  unit 3 = 시간 · unit 6 = 주(실측 2026-10-11: 3/5 → 28,000 · 6/1 → 140,000). 모르는 단위는 버린다. */
export function parseZaiQuota(body: unknown, fetchedAt: number): ZaiQuotaResult {
  const data = (body as { data?: { limits?: unknown; level?: unknown } } | null)?.data;
  if (!data || !Array.isArray(data.limits)) return { status: 'error', detail: 'upstream-shape' };
  const windows: ZaiQuotaWindow[] = [];
  for (const l of data.limits as Array<Record<string, unknown>>) {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const unit = num(l.unit); const n = num(l.number); const limit = num(l.usage);
    const used = num(l.currentValue); const remaining = num(l.remaining);
    if (unit === null || n === null || limit === null) continue;
    // ⛔ 쓴 양을 모르는 창은 «0» 으로 만들지 않는다 — 버리고 아래에서 불완전으로 판정한다.
    if (used === null && remaining === null) continue;
    const window: ZaiLimitWindow | null = unit === 3 && n === 5 ? '5h' : unit === 6 && n === 1 ? 'weekly' : null;
    if (!window || windows.some((w) => w.window === window)) continue;
    windows.push({
      window, limit,
      used: used ?? Math.max(0, limit - (remaining as number)),
      remaining: remaining ?? Math.max(0, limit - (used as number)),
      resetAt: num(l.nextResetTime),
    });
  }
  // ⛔ 5h·주 «둘 다» 있어야 공식으로 쓴다 — 하나라도 빠지면 조회 실패로 보고 추정 표로 간다(행이 사라지지 않는다).
  if (!windows.some((w) => w.window === '5h') || !windows.some((w) => w.window === 'weekly')) {
    return { status: 'error', detail: windows.length === 0 ? 'no-known-window' : 'incomplete-windows' };
  }
  windows.sort((a, b) => (a.window === '5h' ? -1 : 1) - (b.window === '5h' ? -1 : 1));
  return { status: 'ok', level: typeof data.level === 'string' ? data.level : null, windows, fetchedAt };
}

export interface ZaiQuotaDeps extends ZaiKeyDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** 마지막 공식 조회 캐시 — 호출 경로의 «잔액 귀속» 판정이 읽는다. */
  readonly snapshotPath?: string;
}

function zaiQuotaSnapshotPath(deps: ZaiQuotaDeps = {}): string {
  return deps.snapshotPath ?? join(quotaSignalDir(), 'zai-coding-plan-quota.json');
}

export async function fetchZaiQuota(deps: ZaiQuotaDeps = {}): Promise<ZaiQuotaResult> {
  const key = getZaiApiKey(deps);
  if (!key) return { status: 'error', detail: 'no-key' };
  const now = (deps.now ?? Date.now)();
  try {
    const res = await (deps.fetchImpl ?? fetch)(ZAI_QUOTA_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { status: 'unauthorized', detail: `http-${res.status}` };
    if (!res.ok) return { status: 'error', detail: `http-${res.status}` };
    const parsed = parseZaiQuota(await res.json(), now);
    if (parsed.status === 'ok') {
      try {
        const path = zaiQuotaSnapshotPath(deps);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
      } catch { /* 캐시는 선택 */ }
    }
    debug.log('zai.coding-plan', 'quota-query', {
      status: parsed.status,
      ...(parsed.status === 'ok' ? { windows: parsed.windows.map((w) => ({ window: w.window, used: w.used, limit: w.limit, resetAt: w.resetAt })) } : {}),
    });
    return parsed;
  } catch (error) {
    return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

function readZaiQuotaSnapshot(deps: ZaiQuotaDeps = {}): Extract<ZaiQuotaResult, { status: 'ok' }> | null {
  try {
    const v = JSON.parse(readFileSync(zaiQuotaSnapshotPath(deps), 'utf8')) as ZaiQuotaResult;
    return v.status === 'ok' ? v : null;
  } catch { return null; }
}

// ── 동시 상한 ───────────────────────────────────────────

/** 프로세스 안 세마포어(⚠️ 프로세스 «사이»는 안 묶는다 — 각 프로세스가 자기 상한을 갖는다). */
export class ZaiConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: () => number) {}
  get inFlight(): number { return this.active; }
  get queued(): number { return this.waiters.length; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    // ⛔ 이미 취소된 요청은 줄을 서지 않는다 — 서면 슬롯이 풀릴 때 그 슬롯을 «주인 없이» 쥔다.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (this.active >= this.limit() || this.waiters.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal?.reason ?? new Error('aborted'));
        };
        const wake = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      // ⭐ 슬롯은 release 가 «양도»했다(active 를 줄이지 않고 넘김) — 여기서 다시 세지 않는다.
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // ⛔ 대기자가 있으면 active 를 줄이지 않고 슬롯을 그대로 넘긴다 — 줄였다 늘리면 그 사이 새 호출이 끼어 상한을 넘는다.
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/** 상한 값마다 게이트 하나 — 한 공급자를 만든다고 다른 설정의 상한이 바뀌지 않는다. */
const sharedGates = new Map<number, ZaiConcurrencyGate>();
function gateFor(limit: number): ZaiConcurrencyGate {
  let gate = sharedGates.get(limit);
  if (!gate) { gate = new ZaiConcurrencyGate(() => limit); sharedGates.set(limit, gate); }
  return gate;
}

// ── 공급자 ──────────────────────────────────────────────

export class ZaiCodingPlanLimitError extends Error {
  readonly code: number;
  readonly limitKind: ZaiLimitKind;
  readonly resetAt: number | null;
  constructor(opts: { code: number; limitKind: ZaiLimitKind; resetAt: number | null; policy: ZaiOveragePolicy; reason: string }) {
    const when = opts.resetAt ? ` · 리셋 ${new Date(opts.resetAt).toISOString()}` : '';
    super(`GLM Coding Plan 한도(code ${opts.code} · ${opts.limitKind}${when}) — 정책 llm.zaiCodingPlan.overage=${opts.policy}: ${opts.reason}`);
    this.name = 'ZaiCodingPlanLimitError';
    this.code = opts.code;
    this.limitKind = opts.limitKind;
    this.resetAt = opts.resetAt;
  }
}

export interface ZaiProviderDeps extends ZaiKeyDeps, ZaiLedgerDeps {
  /** 시험 seam — 호환 공급자 생성기(기본 = llm.ts `makeOpenAICompatProvider`). */
  readonly makeCompat?: (name: string, defaultModel: string, url: string, cfg: UCLLMConfig, wire: Record<string, unknown>) => LLMProvider;
  /** 시험 seam — OpenRouter 폴백 공급자(기본 = llm.ts `makeOpenRouterProvider`). */
  readonly makeOpenRouter?: (cfg: UCLLMConfig) => LLMProvider;
  readonly openRouterKey?: () => string | undefined;
  readonly gate?: ZaiConcurrencyGate;
  readonly quotaSnapshot?: () => Extract<ZaiQuotaResult, { status: 'ok' }> | null;
}

/** 모델 id 정리 — `glm-5.3`·`glm-5.3-flash` 외에는 기본 모델로(코딩 엔드포인트가 모르는 id 를 보내 1211 을 맞지 않는다). */
export function zaiWireModel(model: string | undefined): string {
  const m = (model ?? '').trim().toLowerCase().replace(/^z-ai\//, '').replace(/^openrouter\/z-ai\//, '');
  return (ZAI_CODING_MODELS as readonly string[]).includes(m) ? m : ZAI_CODING_DEFAULT_MODEL;
}

/** 폴백 대상은 사양대로 «하나»(`openrouter/z-ai/glm-5.3`) — flash 호출도 같다. */
function openRouterModelFor(_wireModel: string): string {
  return ZAI_OPENROUTER_FALLBACK_MODEL;
}

/** reasoningLevel → `reasoning_effort`(GLM-5.3 는 low·high·max 만). 설정이 없으면 싣지 않는다(서버 기본). */
function zaiReasoningEffort(requested: LLMOpts['reasoningEffort'], level: UCLLMConfig['reasoningLevel']): 'low' | 'high' | 'max' | undefined {
  const v = requested ?? level;
  if (!v) return undefined;
  if (v === 'off' || v === 'minimal' || v === 'low') return 'low';
  if (v === 'medium' || v === 'high') return 'high';
  return 'max';
}

/**
 * ⭐ GLM Coding Plan 직결 공급자. 이름은 `glm`(새 공급자 이름 0).
 * 흐름: 기록된 한도 확인(pre) → 동시 상한 → 호출 → usage 적산 / 429 판별 → 정책대로 멈춤·OpenRouter.
 * ⛔ 폴백은 «첫 이벤트 전»에만 한다 — 이미 흘린 출력 위에 다른 모델을 잇지 않는다.
 */
export function makeZaiCodingPlanProvider(cfg: UCLLMConfig, deps: ZaiProviderDeps = {}): LLMProvider {
  const settings = zaiSettingsFromConfig(cfg);
  const defaultModel = zaiWireModel(cfg.model);
  const now = deps.now ?? Date.now;
  const gate = deps.gate ?? gateFor(settings.maxConcurrent);
  const quotaSnapshot = deps.quotaSnapshot ?? (() => readZaiQuotaSnapshot());

  async function compat(model: string, effort: 'low' | 'high' | 'max' | undefined): Promise<LLMProvider> {
    const key = getZaiApiKey(deps);
    const make = deps.makeCompat ?? ((await import('../llm.js')) as unknown as {
      makeOpenAICompatProvider: NonNullable<ZaiProviderDeps['makeCompat']>;
    }).makeOpenAICompatProvider;
    // ⛔ cfg.baseUrl 은 넘기지 않는다 — 코딩 엔드포인트가 이 경로의 정체성이다. 키는 Z.ai 키만(남의 cfg.apiKey 금지).
    return make('glm', model, ZAI_CODING_PLAN_URL, { provider: 'glm', model, apiKey: key, reasoningLevel: cfg.reasoningLevel } as UCLLMConfig, {
      // GLM-5.3 은 thinking 이 «항상» 켜진다 — 기본 max_tokens 2048 이면 본문 전에 잘린다(OpenRouter 와 같은 처리).
      omitMaxTokens: true,
      omitDefaultTemperature: true,
      ...(effort ? { extraBody: { reasoning_effort: effort } } : {}),
    });
  }

  async function openRouter(): Promise<LLMProvider | null> {
    const key = deps.openRouterKey ? deps.openRouterKey() : (await import('../config.js')).getOpenRouterApiKey();
    if (!key) return null;
    const make = deps.makeOpenRouter ?? ((await import('../llm.js')) as unknown as {
      makeOpenRouterProvider: NonNullable<ZaiProviderDeps['makeOpenRouter']>;
    }).makeOpenRouterProvider;
    return make({ provider: 'openrouter', model: ZAI_OPENROUTER_FALLBACK_MODEL, reasoningLevel: cfg.reasoningLevel } as UCLLMConfig);
  }

  async function* viaOpenRouter(
    messages: LLMMessage[], opts: LLMOpts, wireModel: string,
    info: { code: number; limitKind: ZaiLimitKind; resetAt: number | null; phase: 'pre' | 'post' },
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const or = await openRouter();
    const orModel = openRouterModelFor(wireModel);
    debug.log('zai.coding-plan', 'fallback', {
      code: info.code, limitKind: info.limitKind, resetAt: info.resetAt, phase: info.phase,
      model: wireModel, to: orModel, policy: settings.overage, openRouterKey: or !== null,
    }, { level: 'warn' });
    if (!or) {
      throw new ZaiCodingPlanLimitError({ ...info, policy: settings.overage, reason: 'OpenRouter 폴백 키(OPENROUTER_API_KEY) 없음' });
    }
    yield* or.streamChat!(messages, { ...opts, model: orModel });
  }

  return {
    name: 'glm',
    defaultModel,
    available: () => zaiCodingPlanAvailable(deps),
    async *streamChat(messages, opts = {}) {
      const wireModel = zaiWireModel(opts.model || defaultModel);
      // ⭐ 슬롯을 «먼저» 잡고 한도를 본다 — 기다리는 동안 앞선 호출이 429 를 적었으면 그 판단을 따른다.
      const release = await gate.acquire(opts.signal);
      const startedAt = now();
      const ledger = readZaiLedger(deps);
      const active = activeZaiLimit(ledger, startedAt) ?? snapshotLimit(quotaSnapshot(), startedAt);
      if (active) {
        const action = decideZaiAction(settings.overage, active.limitKind, 'pre');
        debug.log('zai.coding-plan', 'pre-limit', {
          code: active.code, limitKind: active.limitKind, window: active.window, resetAt: active.resetAt, model: wireModel, action, policy: settings.overage,
        });
        if (action === 'stop') {
          release();
          throw new ZaiCodingPlanLimitError({ code: active.code, limitKind: active.limitKind, resetAt: active.resetAt, policy: settings.overage, reason: '리셋까지 멈춘다' });
        }
        if (action === 'openrouter') {
          release();
          yield* viaOpenRouter(messages, opts, wireModel, { code: active.code, limitKind: active.limitKind, resetAt: active.resetAt, phase: 'pre' });
          return;
        }
      }
      let emitted = false;
      let usage: { input: number; cached: number; output: number } | null = null;
      try {
        const effort = zaiReasoningEffort(opts.reasoningEffort, cfg.reasoningLevel);
        const provider = await compat(wireModel, effort);
        debug.log('zai.coding-plan', 'request', {
          model: wireModel, inFlight: gate.inFlight, maxConcurrent: settings.maxConcurrent, reasoningEffort: effort ?? null,
        });
        try {
          for await (const ev of provider.streamChat!(messages, { ...opts, model: wireModel })) {
            if (ev.type === 'usage') {
              usage = {
                input: ev.usage.inputTokens ?? 0,
                cached: ev.usage.cacheReadInputTokens ?? 0,
                output: ev.usage.outputTokens ?? 0,
              };
            } else {
              emitted = true;
            }
            yield ev;
          }
        } catch (error) {
          const status = (error as { status?: unknown })?.status;
          const bodyText = (error as { bodyText?: unknown })?.bodyText;
          const cls = typeof status === 'number' && typeof bodyText === 'string' ? classifyZaiError(status, bodyText) : null;
          if (!cls || cls.kind === 'rate' || cls.kind === 'other') {
            if (cls) debug.log('zai.coding-plan', 'error', { code: cls.code, kind: cls.kind, model: wireModel }, { level: 'warn' });
            throw error;
          }
          appendZaiLedger({ ts: now(), kind: 'limit', code: cls.code, limitKind: cls.kind, window: cls.window, resetAt: cls.resetAt, model: wireModel }, deps);
          const action = decideZaiAction(settings.overage, cls.kind, 'post');
          debug.log('zai.coding-plan', 'limit', {
            code: cls.code, limitKind: cls.kind, window: cls.window, resetAt: cls.resetAt, resetRaw: cls.resetRaw,
            model: wireModel, action, policy: settings.overage, emitted,
          }, { level: 'warn' });
          if (action === 'stop' || emitted) {
            throw new ZaiCodingPlanLimitError({
              code: cls.code, limitKind: cls.kind, resetAt: cls.resetAt, policy: settings.overage,
              reason: emitted ? '출력이 이미 나간 뒤라 폴백하지 않는다' : '리셋까지 멈춘다',
            });
          }
          release();
          yield* viaOpenRouter(messages, opts, wireModel, { code: cls.code, limitKind: cls.kind, resetAt: cls.resetAt, phase: 'post' });
          return;
        }
      } finally {
        release();
        if (usage) {
          const ts = now();
          const credits = zaiCredits(wireModel, usage, ts);
          const bucket = estimateBucket(settings, readZaiLedger(deps), quotaSnapshot(), ts, active);
          appendZaiLedger({ ts, kind: 'call', model: wireModel, ...usage, credits, peak: isZaiPeak(ts), bucket }, deps);
          debug.log('zai.coding-plan', 'usage', { model: wireModel, ...usage, credits, bucket, peak: isZaiPeak(ts) });
        }
      }
    },
    async *chat(messages, opts = {}) {
      for await (const ev of this.streamChat!(messages, opts)) {
        if (ev.type === 'text' && ev.delta) yield ev.delta;
      }
    },
  };
}

/** 10분 안의 공식 조회가 어느 창이든 남은 양 0 이라 했으면 «플랜 한도»로 본다(서버가 잔액으로 조용히 결제하기 «전»에
 *  stop·openrouter 정책이 막을 수 있게). 코드는 창에 맞춘 1308(5h)·1310(주)로 적는다(합성 · 관측에 window 로 남는다). */
export function snapshotLimit(snapshot: Extract<ZaiQuotaResult, { status: 'ok' }> | null, nowMs: number): ZaiLimitRecord | null {
  if (!snapshot || nowMs - snapshot.fetchedAt >= 10 * 60 * 1000) return null;
  const full = snapshot.windows.find((w) => w.remaining <= 0 && (w.resetAt === null || w.resetAt > nowMs));
  if (!full) return null;
  return { ts: snapshot.fetchedAt, kind: 'limit', code: full.window === '5h' ? 1308 : 1310, limitKind: 'plan-limit', window: full.window, resetAt: full.resetAt, model: '' };
}

/** 잔액(extra usage)으로 갔나를 «추정»한다 — 서버는 호출마다 어느 쪽에서 깎았는지 말해 주지 않는다.
 *  근거 셋 중 하나: ⑴ 살아 있는 플랜 한도 기록 위에서 balance 정책으로 호출했다
 *  ⑵ 10분 안의 공식 조회가 어느 창이든 남은 양 0 이라 했다 ⑶ 우리 적산 5h 가 한도를 넘었다. */
function estimateBucket(
  settings: ZaiCodingPlanSettings,
  ledger: readonly ZaiLedgerRecord[],
  snapshot: Extract<ZaiQuotaResult, { status: 'ok' }> | null,
  nowMs: number,
  active: ZaiLimitRecord | null,
): 'plan' | 'balance' {
  if (settings.overage !== 'balance') return 'plan';
  if (active?.limitKind === 'plan-limit') return 'balance';
  if (snapshot && nowMs - snapshot.fetchedAt < 10 * 60 * 1000 && snapshot.windows.some((w) => w.remaining <= 0)) return 'balance';
  const local = sumZaiLocalWindows(ledger, nowMs);
  return local.fiveHour.used >= ZAI_MAX_PLAN_LIMITS.fiveHour ? 'balance' : 'plan';
}

// ── usage 표면 ──────────────────────────────────────────

export interface ZaiUsageWindowView {
  window: ZaiLimitWindow;
  used: number;
  limit: number;
  resetAt: number | null;
  /** official = 콘솔 조회 · next_flush_time = 429 본문 · estimated = 우리 적산(추정). */
  source: 'official' | 'next_flush_time' | 'estimated';
}

export interface ZaiUsageView {
  windows: ZaiUsageWindowView[];
  local: ZaiLocalWindows;
  balanceCredits: number;
  quotaStatus: ZaiQuotaResult['status'];
  quotaDetail: string | null;
  lastLimit: { code: number; limitKind: ZaiLimitKind; resetAt: number | null; ts: number } | null;
}

/** 공식 조회가 되면 그것을, 안 되면 우리 적산 ⊕ 429 리셋 시각으로 «추정» 표를 만든다. */
export function buildZaiUsageView(quota: ZaiQuotaResult, ledger: readonly ZaiLedgerRecord[], nowMs: number): ZaiUsageView {
  const weeklyOfficial = quota.status === 'ok' ? quota.windows.find((w) => w.window === 'weekly') : undefined;
  const weeklyStart = weeklyOfficial?.resetAt ? weeklyOfficial.resetAt - WEEK_MS : null;
  const local = sumZaiLocalWindows(ledger, nowMs, weeklyStart);
  const limits = ledger.filter((r): r is ZaiLimitRecord => r.kind === 'limit');
  const last = limits.length > 0 ? limits.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
  const flushFor = (window: ZaiLimitWindow) => {
    const hits = limits.filter((r) => r.window === window && r.resetAt !== null && r.resetAt > nowMs);
    return hits.length > 0 ? hits.reduce((a, b) => (b.ts > a.ts ? b : a)).resetAt : null;
  };
  let windows: ZaiUsageWindowView[];
  if (quota.status === 'ok') {
    windows = quota.windows.map((w) => ({ window: w.window, used: w.used, limit: w.limit, resetAt: w.resetAt, source: 'official' as const }));
  } else {
    const fiveFlush = flushFor('5h');
    const weekFlush = flushFor('weekly');
    windows = [
      {
        window: '5h', used: local.fiveHour.used, limit: ZAI_MAX_PLAN_LIMITS.fiveHour,
        resetAt: fiveFlush ?? (local.fiveHour.oldestTs !== null ? local.fiveHour.oldestTs + FIVE_HOURS_MS : null),
        source: fiveFlush ? 'next_flush_time' : 'estimated',
      },
      {
        window: 'weekly', used: local.weekly.used, limit: ZAI_MAX_PLAN_LIMITS.weekly,
        resetAt: weekFlush, source: weekFlush ? 'next_flush_time' : 'estimated',
      },
    ];
  }
  return {
    windows,
    local,
    balanceCredits: local.balanceCredits,
    quotaStatus: quota.status,
    quotaDetail: quota.status === 'ok' ? null : quota.detail,
    lastLimit: last ? { code: last.code, limitKind: last.limitKind, resetAt: last.resetAt, ts: last.ts } : null,
  };
}
