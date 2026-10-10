// ── elanous 네이티브 알림 발송 (Conatus send.py 대체·순수 TS) ────────────
//
// KORU 스윙 등 크론 알림을 elanous 단일 발송 지점 `/v1/outbound`(텔레그램 report
// channel)로 전송. 데몬 미가동/실패 시 텔레그램 직접(sendMessage) fallback —
// send.py 와 동일 동작을 TS 로 포팅(완전 elanous 소유). sync(curl) 계약.

import * as childProcess from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, unlinkSync, readdirSync, renameSync, openSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { conatusEnv } from './conatus-env.js';
import { spillLongContent } from '../storage/content-spill.js';
import { openSurfaceEventsDb, recordEvent } from './surface-events.js';
import { latestUserIntentTs } from '../user-intent/index.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { explainReportRoute, isOperationalKind, kindRouteTarget, logKindRouteFallback, mainHomeTarget } from './telegram-kind-route.js';
import { debug } from '../debug/log.js';
import type { AddBriefItem } from '../briefing/brief-items.js';
import { registerLogStoreSink, setLogInstanceName } from '../mss/logging/log-store.js';
import type { LogSink } from '../mss/logging/sink.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
// ★ origin 되돌림(대표 2026-07-12) — 미션 알림을 발신 채널(메인 Q&A 봇)로 되돌린다. type-only
//   import 라 런타임 순환 없음(발송 로직은 이 파일에 self-contained). origin 없으면 report 폴백.
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { conatusDataDir, conatusPath } from './conatus-data-dir.js';
import { assertNoRealSendFromTest, assertNotTestWritingOps, isTestDouble, TestOpsWriteRefusedError } from '../instance/test-write-guard.js';

/** Explicit `ELANOUS_NEXUS_URL` wins. Otherwise ask the daemon endpoint resolver.
 *  A missing daemon is not a guessed port — the caller falls through to direct send. */
function nexusUrl(): string | null {
  const explicit = process.env.ELANOUS_NEXUS_URL?.trim();
  if (explicit) return explicit;
  return resolveDaemonEndpoint()?.baseUrl ?? null;
}
// 로컬 데몬이 getElanousConfigDir()/acp-token 에 발행한 loopback 토큰을 읽어 로컬
// /v1/outbound 로 POST — getElanousConfigDir() 치환은 prod 동치(~/.elanous) + --config-dir 정합.
const ACP_TOKEN_PATH = join(getElanousConfigDir(), 'acp-token');
const DEFERRED_PATH = conatusPath('outbound_deferred.jsonl');
// The real transport, captured before any test can spy on it — a pass-through spy is not a fake.
const REAL_EXEC_FILE_SYNC = childProcess.execFileSync;

// CLI/cron do not inherit the daemon's StoreSink. Register once before the first
// send, but never attach a second sink to a daemon which already owns one.
let outboundLogSink: (() => void) | null = null;
function ensureOutboundLogSink(): void {
  if (outboundLogSink || inProcessOutbound || process.env.NODE_ENV === 'test') return;
  try {
    const logs = getUserConfig().logs;
    setLogInstanceName(logs.instanceName);
    outboundLogSink = registerLogStoreSink((s: LogSink) => debug.registerSink(s), 'outbound', logs.retention);
    if (outboundLogSink) process.once('exit', outboundLogSink);
  } catch { /* observations must not prevent delivery */ }
}

function botLabel(token: string): string {
  // Telegram bot IDs are public numeric IDs; never log the token's secret suffix.
  const id = token.split(':', 1)[0];
  return /^\d+$/.test(id ?? '') ? `telegram:${id}` : 'telegram:configured';
}

function safeObservationLabel(value: string): string {
  return /^[a-zA-Z0-9_./-]{1,160}$/.test(value) ? value : 'unknown';
}

// ── 발송 관측 (대표 지시 2026-07-15): 발송 시각·mode·밀림(burst/lag) 를 logs.db 에 남겨
//    "실시간인지 밀린 것인지" 를 `elanous logs --category outbound.send` 로 판단 가능하게. ──
/** 밀림(버스트) 판정 — 최근 창 내 이 수 이상 발송이 몰리면 밀려 나가는 중으로 본다. */
const BURST_WINDOW_SEC = 120;
const BURST_THRESHOLD = 5;

/** 최근 발송 밀도(ledger read-only)로 버스트 판정. 실패=판정 안 함(fail-soft). */
function recentSendBurst(): { recentCount: number; burst: boolean } {
  try {
    const { openDeliveryDb, recentDeliveryCount } = require('../nexus/outbound/delivery-ledger.js') as typeof import('../nexus/outbound/delivery-ledger.js');
    const db = openDeliveryDb();
    try {
      const recentCount = recentDeliveryCount(db, BURST_WINDOW_SEC);
      return { recentCount, burst: recentCount >= BURST_THRESHOLD };
    } finally { db.close(); }
  } catch { return { recentCount: -1, burst: false }; }
}

/** 발송 1건을 logs.db 에 관측(fail-open) — 발송 시각·mode·kind·밀림 판정. */
function logSend(
  mode: 'realtime' | 'quiet-bypass' | 'flush',
  kind: string,
  extra: Record<string, unknown> = {},
  opts?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' },
): void {
  try { debug.log('outbound.send', mode, { kind: safeObservationLabel(kind), ...extra }, opts); } catch { /* fail-open */ }
}

/** 밀림 경고 임계 env 이름 — 비교 값은 여기서만 읽는다(호출부에 리터럴을 박지 않는다). */
export const FLUSH_LAG_WARN_MIN_ENV = 'ELANOUS_OUTBOUND_FLUSH_LAG_WARN_MIN';

/** 밀림 경고 임계(분). `FLUSH_LAG_WARN_MIN_ENV` 로 바꾼다. */
export function flushLagWarnMin(): number {
  const raw = process.env[FLUSH_LAG_WARN_MIN_ENV]?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const fallback = process.env.ELANOUS_OUTBOUND_FLUSH_LAG_WARN_MIN_DEFAULT?.trim();
  const n = fallback ? Number(fallback) : NaN;
  if (Number.isFinite(n) && n >= 0) return n;
  // 기본 1일 — 비교 리터럴이 아니라 설정 기본값. env 로 덮는다.
  return 60 * 24;
}

// ── 야간 무음 (대표 지시 2026-07-06): KST 00:00~06:30 발송 금지 · 보류 후 일괄 ──

/** KST 자정 기준 분. */
export function kstMinutes(now: Date = new Date()): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [h, m] = s.split(':').map(Number);
  return ((h ?? 0) % 24) * 60 + (m ?? 0);
}

/** 야간 무음 창(00:00 ≤ t < 06:30 KST). 아침리포트(06:25)는 별도 경로라 비대상. */
export function inQuietHours(now: Date = new Date()): boolean {
  const m = kstMinutes(now);
  return m >= 0 && m < 390;
}

/** 최근 사용자 활동 우회 창(분) — 이 시간 내 genuine 사용자 인텐트가 있으면 무음이어도 즉시 발송. */
const USER_ACTIVE_WINDOW_MIN = Number(process.env.ELANOUS_USER_ACTIVE_WINDOW_MIN) || 30;

/** ★ 사용자 깨어있음 우회(대표 2026-07-14) — "지금처럼 사용자가 깨어나 보낸 것"이면 야간 무음을
 *  무력화하고 즉시 발송. 판정=genuine 사용자 인텐트 로그(user-intent·타이핑/버튼탭 등)의 최신 시각이
 *  창(기본 30분) 내인가. 자율 신호(ambient/system)는 latestUserIntentTs 가 제외. fail-soft(에러=우회 안 함). */
export function userRecentlyActive(now: Date = new Date()): boolean {
  try {
    const ts = latestUserIntentTs(now.toISOString());
    if (!ts) return false;
    const age = now.getTime() - Date.parse(ts);
    return Number.isFinite(age) && age >= 0 && age <= USER_ACTIVE_WINDOW_MIN * 60_000;
  } catch { return false; }
}

/** 야간 보류 적재 (jsonl append — 크론 동시 실행에 안전). origin 있으면 함께 적재 —
 *  아침 flush 가 그 origin(발신 채널)으로 되돌려 발송(없으면 report 묶음). */
export function deferOutbound(text: string, kind: string, origin?: MissionOrigin | null, path = DEFERRED_PATH): boolean {
  assertNotTestWritingOps(path, 'append the deferred-alert queue');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const rec = { ts: new Date().toISOString(), kind, text, ...(origin ? { origin } : {}) };
    withQueueLock(path, () => appendFileSync(path, JSON.stringify(rec) + '\n'));
    console.error(`[outbound] 야간 무음(00:00~06:30 KST) — 보류 적재 (${kind})`);
    return true;
  } catch (e) {
    console.error(`[outbound] 보류 적재 실패 — 콘솔 출력\n${text}`, e instanceof Error ? e.message : '');
    return false;
  }
}

/** botId(토큰 prefix) → 봇 토큰 해석. config telegram 후보 중 매칭(없으면 메인 botToken).
 *  mission-notify.resolveTelegramBotToken 과 동일 규칙(순환 회피 위해 self-contained 복제). */
function resolveBotToken(botId?: string): string | null {
  try {
    const tg = getUserConfig().telegram as {
      botToken?: string; reportChannel?: { botToken?: string }; testChannel?: { botToken?: string };
    } | undefined;
    if (!tg) return null;
    const mainToken = resolveChannelBotToken('telegram', getUserConfig())?.token;
    const candidates = [mainToken, tg.reportChannel?.botToken, tg.testChannel?.botToken]
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (botId) { const m = candidates.find((t) => t.split(':')[0] === botId); if (m) return m; }
    return mainToken ?? candidates[0] ?? null;
  } catch { return null; }
}

/** origin(발신 채널)으로 직접 발송. 실패하면 호출자가 report 폴백/재시도한다. */
function deliverToOrigin(origin: MissionOrigin, text: string, onBot?: (bot: string) => void): boolean {
  if (origin.channel === 'discord') {
    if (!origin.channelId) return false;
    let token: string | undefined;
    try { token = resolveChannelBotToken('discord', getUserConfig())?.token; } catch { return false; }
    if (!token) return false;
    // Outside the swallowing try below: a refused test send must surface, not read as «delivery failed».
    assertTestSendFaked('send a real Discord message');
    try {
      onBot?.('discord:configured');
      const channelId = origin.discordThreadId || origin.channelId;
      const out = spillLongContent(text).text;
      for (let start = 0; start < out.length;) {
        let end = Math.min(start + 2000, out.length);
        if (end < out.length && /[\uD800-\uDBFF]/.test(out[end - 1]!)) end--;
        const response = curlPost(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          JSON.stringify({ content: out.slice(start, end) }),
          [`Authorization: Bot ${token}`, 'Content-Type: application/json'],
          'send a real Discord message',
        );
        if (typeof response?.id !== 'string' || !response.id) return false;
        start = end;
      }
      return out.length > 0;
    } catch { return false; }
  }
  if (origin.channel !== 'telegram' || origin.chatId == null) return false;
  const token = resolveBotToken(origin.botId);
  if (!token) return false;
  onBot?.(botLabel(token));
  assertTestSendFaked('send a real Telegram message to the origin');
  try { return sendTelegramRaw(token, origin.chatId, text, origin.threadId); } catch { return false; }
}

/** 보류 큐 재시도 상한 env — config `outbound.deferredMaxAttempts` 가 없을 때만 읽는다. */
export const DEFERRED_MAX_ATTEMPTS_ENV = 'ELANOUS_OUTBOUND_DEFERRED_MAX_ATTEMPTS';

/** 보류 항목이 격리되기 전까지 허용하는 실패 flush 수 — config > env > 5. */
export function deferredMaxAttempts(config?: Pick<UserConfig, 'outbound'>): number {
  try {
    const v = (config ?? getUserConfig()).outbound?.deferredMaxAttempts;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  } catch { /* unreadable config: env, then default */ }
  const raw = Number(process.env[DEFERRED_MAX_ATTEMPTS_ENV]?.trim() || NaN);
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  return 5;
}

/** 격리 파일 — 보류 큐 옆 `<name>.failed.jsonl`. */
export function deferredQuarantinePath(path: string): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.failed.jsonl` : `${path}.failed`;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 큐 적재·claim 이 서로를 가로지르지 않게 하는 짧은 배타 잠금(`<queue>.lock`, O_EXCL).
 *  적재는 open→write→close 를 잠금 안에서 하므로 claim 의 rename 이 «열린 채 쓰기 전»인 적재를 가져가지 않는다.
 *  잠금을 못 얻으면(2초 · 30초 넘은 잔여 잠금은 걷는다) 그대로 진행한다 — 알림을 잃는 것보다 낫다. */
function withQueueLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  let fd: number | null = null;
  while (fd === null && Date.now() <= deadline) {
    try { fd = openSync(lock, 'wx'); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') { try { mkdirSync(dirname(path), { recursive: true }); } catch { break; } continue; }
      if (code !== 'EEXIST') break;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === null) { try { debug.log('outbound.send', 'deferred-lock-unavailable', { lock: basename(lock) }); } catch { /* */ } }
  try { return fn(); } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* */ } try { unlinkSync(lock); } catch { /* */ } }
  }
}

/** 이보다 오래된 claim 은 소유 pid 가 살아 있어도 회수한다(pid 재사용 대비 · 정상 flush 는 이보다 훨씬 짧다). */
const STALE_CLAIM_MS = 15 * 60_000;

let claimSeq = 0;
/** 큐를 «가져간다» — 원자적 rename 으로 이 flush 만의 파일로 옮긴다. flush 도중 적재되는 항목은 새 큐 파일에
 *  쌓이므로 잃지 않는다. 죽은 flusher(또는 이 프로세스의 앞 호출)가 남긴 claim 도 같이 회수한다. */
function claimDeferred(path: string): string[] {
  const claims: string[] = [];
  const next = (): string => `${path}.flushing-${process.pid}-${Date.now()}-${claimSeq++}`;
  const dir = dirname(path);
  const prefix = `${basename(path)}.flushing-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const m = /^(\d+)-(\d+)-/.exec(name.slice(prefix.length));
      const pid = Number(m?.[1]);
      const at = Number(m?.[2]);
      if (!Number.isSafeInteger(pid)) continue;
      // flushDeferred 는 동기라 같은 pid 의 claim 은 «지난 호출의 잔여»다. 남의 것은 죽었거나 오래됐을 때만.
      const stale = Number.isFinite(at) && Date.now() - at > STALE_CLAIM_MS;
      if (pid !== process.pid && !stale && pidAlive(pid)) continue;
      const own = next();
      try { renameSync(join(dir, name), own); claims.push(own); } catch { /* another flusher took it */ }
    }
  } catch { /* no directory yet */ }
  withQueueLock(path, () => {
    if (!existsSync(path)) return;
    const own = next();
    try { renameSync(path, own); claims.push(own); } catch { /* another flusher took it */ }
  });
  return claims;
}

/** flushDeferred 주입점 — 시험은 실제 발송 대신 sendBatch 를 준다. */
export type FlushDeferredDeps = {
  sendBatch?: (text: string, kind: string, origin?: MissionOrigin) => boolean;
  maxAttempts?: number;
};

/** 보류분 일괄 발송 — 묶음 단위. 배달 건수 반환.
 *  무음 창 밖 첫 sendOutbound 가 자동 호출 + 06:31 플러시 크론이 보장.
 *  ⭐ 실패한 묶음의 항목만 큐에 남긴다(성공 묶음은 다시 보내지 않는다 · 10-07 야간 11회 재발송 사고).
 *  실패가 `maxAttempts` 번 쌓인 항목은 `<name>.failed.jsonl` 로 격리한다. */
export function flushDeferred(path = DEFERRED_PATH, deps: FlushDeferredDeps = {}): number {
  assertNotTestWritingOps(path, 'flush the deferred-alert queue');
  ensureOutboundLogSink();
  const observeFlush = (
    count: number, lagMin: number, kinds: string[],
    outcome: { sent: number; kept: number; quarantined: number },
  ): void => {
    const lagWarnMin = flushLagWarnMin();
    const over = count > 0 && lagMin > lagWarnMin;
    logSend(
      'flush',
      'deferred-batch',
      { count, lagMin, kinds: kinds.map(safeObservationLabel), path, lagWarnMin, ...outcome },
      over ? { level: 'warn' } : undefined,
    );
  };
  const none = { sent: 0, kept: 0, quarantined: 0 };
  const claims = claimDeferred(path);
  if (claims.length === 0) {
    observeFlush(0, 0, [], none);
    return 0;
  }
  type Item = { ts: string; kind: string; text: string; origin?: MissionOrigin; attempts?: number };
  const items: Item[] = [];
  const corrupt: string[] = [];
  const readClaims: string[] = [];
  for (const claim of claims) {
    let body = '';
    try { body = readFileSync(claim, 'utf-8'); } catch (e) {
      // 못 읽은 claim 은 지우지 않는다 — 다음 flush 가 다시 회수한다.
      try { debug.log('outbound.send', 'deferred-claim-unreadable', { error: e instanceof Error ? e.message : String(e) }, { level: 'warn' }); } catch { /* */ }
      continue;
    }
    readClaims.push(claim);
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Item;
        if (rec && typeof rec === 'object' && typeof rec.text === 'string') items.push(rec);
        else corrupt.push(line);
      } catch { corrupt.push(line); }
    }
  }
  const qPath = deferredQuarantinePath(path);
  const settleFailed = (stage: string, e: unknown): void => {
    try { debug.log('outbound.send', 'deferred-settle-failed', { stage, error: e instanceof Error ? e.message : String(e) }, { level: 'warn' }); } catch { /* */ }
  };
  /** 읽은 claim 을 정산한다. 격리 기록이 실패하면 그 줄은 큐로 돌린다(다음에 다시 격리).
   *  큐 기록이 실패하면 claim 하나를 «남길 줄만»으로 바꿔 두어 다음 flush 가 배달분을 다시 보내지 않게 한다. */
  /** 정산된 claim 을 걷는다. 삭제가 실패하면 비워 둔다 — 남은 claim 이 다음 flush 에 배달분을 다시 내지 않게. */
  const retireClaim = (claim: string): void => {
    try { unlinkSync(claim); return; } catch (e) { settleFailed('claim-unlink', e); }
    try { writeFileSync(claim, ''); } catch (e) { settleFailed('claim-truncate', e); }
  };
  type Quarantine = { line: string; kind?: string; attempts?: number };
  /** 반환 = 실제 정산 결과(관측은 이것으로 센다). */
  const settle = (keep: string[], quarantine: Quarantine[]): { kept: number; quarantined: number } => {
    let back = keep;
    let quarantined = 0;
    if (quarantine.length) {
      try {
        appendFileSync(qPath, quarantine.map(q => q.line).join('\n') + '\n');
        quarantined = quarantine.length;
        for (const q of quarantine) {
          if (q.kind === undefined) continue;
          try { debug.log('outbound.send', 'deferred-quarantined', { kind: safeObservationLabel(q.kind), attempts: q.attempts }); } catch { /* */ }
        }
      } catch (e) { settleFailed('quarantine', e); back = [...keep, ...quarantine.map(q => q.line)]; }
    }
    const result = { kept: back.length, quarantined };
    if (readClaims.length === 0) return result;
    let wrote = back.length === 0;
    if (!wrote) {
      try { withQueueLock(path, () => appendFileSync(path, back.join('\n') + '\n')); wrote = true; } catch (e) { settleFailed('queue', e); }
    }
    if (!wrote) {
      const first = readClaims[0]!;
      const tmp = join(dirname(first), `.${basename(first)}.tmp`);
      try {
        writeFileSync(tmp, back.join('\n') + '\n');
        renameSync(tmp, first);
        for (const claim of readClaims.slice(1)) retireClaim(claim);
      } catch (e) { settleFailed('claim-rewrite', e); }
      return result;
    }
    for (const claim of readClaims) retireClaim(claim);
    return result;
  };
  const maxAttempts = deps.maxAttempts ?? deferredMaxAttempts();
  const priorAttempts = (it: Item): number =>
    typeof it.attempts === 'number' && Number.isSafeInteger(it.attempts) && it.attempts > 0 ? it.attempts : 0;
  const quarantine: Quarantine[] = corrupt.map(line => ({ line }));
  // 이미 상한에 닿은 줄(앞 flush 의 격리 기록이 실패해 큐로 돌아온 것)은 보내지 않고 다시 격리만 시도한다.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (priorAttempts(it) < maxAttempts) continue;
    quarantine.push({ line: JSON.stringify(it), kind: it.kind, attempts: priorAttempts(it) });
    items.splice(i, 1);
  }
  if (items.length === 0) {
    const settled = settle([], quarantine);
    observeFlush(0, 0, [], { ...none, ...settled });
    return 0;
  }
  const kst = (iso: string) => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return '?'; }
  };
  // 밀림 지연 판정 — 가장 오래된 보류분의 경과(분). 관측 + 메시지 마커에 노출.
  const oldestMs = items.reduce((min, i) => Math.min(min, Date.parse(i.ts) || Infinity), Infinity);
  const lagMin = Number.isFinite(oldestMs) ? Math.round((Date.now() - oldestMs) / 60_000) : 0;
  const fmt = (list: Item[]) => [
    `🌙 야간 보류 알림 ${list.length}건 (00:00~06:30 KST 무음 · ⏳ 최대 ${lagMin}분 지연 — 일괄 전달)`,
    ...list.map(i => `\n── [${kst(i.ts)} · ${i.kind}] ──\n${i.text}`),
  ].join('\n');
  const sendBatch = deps.sendBatch ?? ((text: string, kind: string, origin?: MissionOrigin): boolean => {
    let bot = 'unknown';
    const path = origin
      ? (deliverToOrigin(origin, text, label => { bot = label; }) ? 'origin' : false)
      : deliver(text, kind, label => { bot = label; }, 'deferred-flush');
    if (path === 'daemon') return true;
    try {
      debug.log('outbound.send', path ? 'sent' : 'failed', {
        kind: safeObservationLabel(kind), source: 'deferred-flush', bot,
        chars: text.length, path: path || 'undeliverable',
      });
    } catch { /* observation must not change delivery */ }
    return path !== false;
  });
  const failed: Item[] = [];
  const send = (batch: Item[], kind: string, origin?: MissionOrigin): void => {
    if (!sendBatch(fmt(batch), kind, origin)) failed.push(...batch);
  };
  // origin 없는 매매 알림만 report 묶음. 그 외는 kind 별로 운영 봇 경계를 유지한다.
  const noOrigin = items.filter(i => !i.origin);
  const tradingBatch = noOrigin.filter(i => !isOperationalKind(i.kind));
  if (tradingBatch.length) send(tradingBatch, 'report');
  for (const kind of new Set(noOrigin.filter(i => isOperationalKind(i.kind)).map(i => i.kind))) {
    send(noOrigin.filter(i => i.kind === kind), kind);
  }
  // origin 있는 것 = 발신 채널·스레드별로 묶어 서로 다른 수신자에게 섞이지 않게 발송.
  const groups = new Map<string, { origin: MissionOrigin; list: Item[] }>();
  for (const it of items) {
    if (!it.origin) continue;
    const key = it.origin.channel === 'discord'
      ? JSON.stringify(['discord', it.origin.channelId, it.origin.discordThreadId ?? null])
      : JSON.stringify([it.origin.channel, it.origin.botId ?? null, it.origin.chatId ?? null, it.origin.threadId ?? null]);
    if (!groups.has(key)) groups.set(key, { origin: it.origin, list: [] });
    groups.get(key)!.list.push(it);
  }
  for (const g of groups.values()) {
    const kinds = new Set(g.list.map(i => i.kind));
    send(g.list, kinds.size === 1 ? g.list[0]!.kind : 'mixed', g.origin);
  }
  // 실패 묶음의 항목만 되돌린다(시도 수 +1). 상한에 닿은 항목은 격리 — 영원히 재시도하지 않는다.
  const keep: string[] = [];
  for (const it of failed) {
    const attempts = priorAttempts(it) + 1;
    const line = JSON.stringify({ ...it, attempts });
    if (attempts >= maxAttempts) quarantine.push({ line, kind: it.kind, attempts });
    else keep.push(line);
  }
  const settled = settle(keep, quarantine);
  const delivered = items.length - failed.length;
  observeFlush(items.length, lagMin, [...new Set(items.map(i => i.kind))], { sent: delivered, ...settled });
  return delivered;
}

/** TEST-PROD-LEAK — a test process may not reach a real bot or the ops daemon. `external` = a third-party bot API
 *  (refused unless curl is a test double replacing the real one); the local daemon is refused only when ops-routed. */
function assertTestSendFaked(what: string, external = true): void {
  let roots: string[] = [];
  try { roots = [getElanousConfigDir(), dirname(ACP_TOKEN_PATH), effectiveInstanceRoot(), conatusDataDir(), dirname(DEFERRED_PATH)]; }
  catch { roots = [dirname(ACP_TOKEN_PATH), dirname(DEFERRED_PATH)]; }
  assertNoRealSendFromTest(what, { transportFaked: isTestDouble(childProcess.execFileSync, REAL_EXEC_FILE_SYNC), routingRoots: roots, external });
}

/** 동기 curl(POST). body 는 stdin. 파싱 실패/에러 → null. `what` names the send for the test guard (never the URL — it carries the token). */
function curlPost(url: string, body: string, headers: string[], what = 'send a real outbound message', external = true): any {
  assertTestSendFaked(what, external);
  const args = ['-s', '-m', '25', '-X', 'POST'];
  for (const h of headers) args.push('-H', h);
  args.push('--data', '@-', url);
  try {
    const out = childProcess.execFileSync('curl', args, { input: body, encoding: 'utf-8', timeout: 30_000, maxBuffer: 2_000_000 });
    return JSON.parse(out);
  } catch { return null; }
}

/** 크로스서피스 기억 P0 — 발송 사실을 검색 가능한 원장에 기록. fail-soft(발송을
 *  절대 막지 않음). 논리적 발송 1건 = 1회 기록(전송 재시도 deliver/flush엔 미배선).
 *  내부 문서 `PLAN-cross-surface-memory-2026-07-07`. */
export function recordOutbound(text: string, kind: string): void {
  try {
    const db = openSurfaceEventsDb();
    try { recordEvent(db, { surface: 'outbound', direction: 'outbound', kind, text }); }
    finally { db.close(); }
  } catch { /* 기억 기록 실패가 발송을 막지 않음 */ }
}

/** 발송 진입점 — 야간 무음 게이트(00:00~06:30 KST 보류) + 보류분 자동 플러시.
 *  origin(발신 채널) 이 주어지면 그 채널(메인 Q&A 봇 등)로 되돌려 발송 — 무음이면 origin 을
 *  함께 보류했다가 아침에 그 채널로 flush. origin 없거나 발송 실패 시 report 폴백(기존 동작). */
export function sendOutbound(text: string, kind = 'alert', origin?: (MissionOrigin & { surface?: string }) | null): boolean {
  // Prefer the producer's surface; otherwise keep the caller's repository-relative path
  // so two producers named index.ts cannot collapse into one sender.
  const caller = new Error().stack?.split('\n')[2] ?? '';
  const callerPath = caller.match(/(?:\(|\s)(file:\/\/[^\s()]+|\/[^\s()]+\.[cm]?[jt]s):\d+:\d+\)?/)?.[1];
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const source = origin?.surface || (callerPath
    ? relative(repoRoot, callerPath.startsWith('file://') ? fileURLToPath(callerPath) : callerPath).replace(/\\/g, '/')
    : 'unknown');
  ensureOutboundLogSink();
  let bot = origin?.channel === 'discord' ? 'discord:configured' : 'unknown';
  const logOutcome = (event: 'sent' | 'deferred' | 'failed', path?: string): void => {
    try { debug.log('outbound.send', event, { kind: safeObservationLabel(kind), source: safeObservationLabel(source), chars: text.length, bot, ...(path ? { path } : {}) }); } catch { /* fail-open */ }
  };
  // ★ 무음 우회(대표 2026-07-14) — 사용자가 최근(기본 30분) genuine 인텐트(타이핑/버튼탭)를 냈으면
  //   깨어있으므로 야간 무음이어도 즉시 발송(사용자 발원 흐름의 결과물이 아침까지 묶이지 않게).
  //   우회 시 flushDeferred 로 그간 보류분도 함께 전달(사용자가 지금 볼 수 있음).
  if (inQuietHours() && !userRecentlyActive()) {
    const queued = deferOutbound(text, kind, origin);
    if (queued) recordOutbound(text, kind); // 성공한 보류만 회상 대상
    logOutcome(queued ? 'deferred' : 'failed', queued ? 'deferred' : 'queue-failed');
    return queued; // 적재가 성공했을 때만 보류 수락
  }
  const bypass = inQuietHours();
  if (bypass) console.error('[outbound] 야간 무음 우회 — 최근 사용자 활동(깨어있음) → 즉시 발송 + 보류분 flush');
  try { flushDeferred(); } catch { /* fail-soft */ }
  // ★ 발송 관측(대표 지시) — 발송 시각·mode·밀림(burst) 판정을 logs.db 에. burst=최근 2분 5건+
  //   (몰려 나가는 중 = 밀림 의심). `elanous logs --category outbound.send` 로 실시간/밀림 구분.
  const { recentCount, burst } = recentSendBurst();
  logSend(bypass ? 'quiet-bypass' : 'realtime', kind, { burst, recentCount, ...(burst ? { backlog: true } : {}) });
  // ★ origin 되돌림(무음 밖) — 발신 채널로 직접 발송. 성공 시 종료, 실패면 report 폴백.
  if (origin && deliverToOrigin(origin, text, (label) => { bot = label; })) {
    recordOutbound(text, kind);
    logOutcome('sent', 'origin');
    return true;
  }
  const path = deliver(text, kind, (label) => { bot = label; }, source);
  // 데몬 경유는 실제 라우터의 최종 결과만 기록한다. 직접 폴백과 미전달만 여기서 기록.
  if (path === 'direct') recordOutbound(text, kind);
  if (path !== 'daemon') logOutcome(path === false ? 'failed' : 'sent', path === false ? 'undeliverable' : path);
  return path !== false;
}

/** 데몬 `/v1/outbound` 응답을 네 갈래로 가른다 — 처방이 반대인 인증거절 vs 데몬부재를 접지 않기 위해. */
export type DaemonPathClass = 'ok' | 'unauthorized' | 'rejected' | 'unreachable';

export function classifyDaemonResponse(j: unknown): DaemonPathClass {
  if (j == null) return 'unreachable';
  if (typeof j === 'object') {
    const rec = j as { delivered?: unknown; error?: unknown };
    if (rec.delivered) return 'ok';
    if (rec.error === 'unauthorized') return 'unauthorized';
    return 'rejected';
  }
  return 'rejected';
}

/** 데몬 경로를 못 쓴 이유를 남긴다. 관측 실패가 발송을 막지 않음(recordOutbound 과 같은 fail-soft).
 *  비-ok 분류는 크론 운영자가 읽는 표준 출력에도 한 줄 — 싱크 미등록 스크립트에서도 즉시 보이게. */
function logDaemonPath(classification: DaemonPathClass, kind: string, extra: Record<string, unknown> = {}): void {
  ensureOutboundLogSink();
  try {
    debug.log('outbound.send', 'daemon-path', {
      classification, kind: safeObservationLabel(kind),
      ...('hasToken' in extra ? { hasToken: extra.hasToken === true } : {}),
      ...('inProcess' in extra ? { inProcess: extra.inProcess === true } : {}),
    });
  } catch { /* fail-soft */ }
  if (classification === 'ok') return;
  try { console.error(`[outbound] daemon-path ${classification}`); } catch { /* fail-soft */ }
}

/** OB8 — the daemon registers its own in-process sender at startup. Inside the daemon, deliver() must never curl
 *  its own `/v1/outbound`: the curl is synchronous, the event loop that would answer it is the one it blocks, and the
 *  whole daemon freezes until the curl times out (~25 s · `unreachable`) — the message is lost (CS1 · 10-01). */
export type InProcessOutbound = (text: string, kind: string, source?: string, deferFailureObservation?: boolean) => Promise<boolean>;
let inProcessOutbound: InProcessOutbound | null = null;
export function setInProcessOutbound(send: InProcessOutbound | null): void { inProcessOutbound = send; }

/** elanous `/v1/outbound` 우선 → 실패 시 텔레그램 직접. 성공 경로 반환(원장 중복방지용). */
export function deliver(text: string, kind = 'alert', onBot?: (bot: string) => void, source?: string): 'daemon' | 'direct' | false {
  // 0) inside the daemon — route in-process, asynchronously; the caller's synchronous answer is «accepted».
  if (inProcessOutbound && process.env.SEND_VIA_ELANOUS !== '0') {
    assertTestSendFaked('route through the in-process daemon sender', false);
    onBot?.('daemon:configured');
    const send = inProcessOutbound;
    const fallback = (): void => {
      let bot = 'unknown';
      const ok = sendTelegramDirect(text, kind, {}, label => { bot = label; });
      if (ok) recordOutbound(text, kind);
      try { debug.log('outbound.send', ok ? 'sent' : 'failed', {
        kind: safeObservationLabel(kind), source: safeObservationLabel(source ?? 'daemon-fallback'),
        bot, path: ok ? 'direct' : 'undeliverable', chars: text.length,
      }); } catch { /* fail-open */ }
    };
    void send(text, kind, source, true)
      .then((ok) => {
        logDaemonPath(ok ? 'ok' : 'rejected', kind, { inProcess: true });
        if (!ok) fallback();
      })
      .catch(() => {
        logDaemonPath('rejected', kind, { inProcess: true });
        fallback();
      });
    return 'daemon';
  }
  // 1) elanous 단일 발송 지점(/v1/outbound) — 데몬이 팬아웃 + 원장 기록.
  let daemonPath: DaemonPathClass | 'not-found' | 'disabled' = 'disabled';
  if (process.env.SEND_VIA_ELANOUS !== '0') {
    let token = '';
    try { if (existsSync(ACP_TOKEN_PATH)) token = readFileSync(ACP_TOKEN_PATH, 'utf-8').trim(); } catch { /* no token */ }
    const headers = ['Content-Type: application/json', 'X-Elanous-Client-Fallback: direct',
      ...(source ? [`X-Elanous-Outbound-Source: ${safeObservationLabel(source)}`] : []),
      ...(token ? [`Authorization: Bearer ${token}`] : [])];
    const nexus = nexusUrl();
    const j = nexus
      // An explicit ELANOUS_NEXUS_URL can name any daemon, the ops one included: a test treats it like a real bot API.
      ? curlPost(`${nexus}/v1/outbound`, JSON.stringify({ text, markdown: false, kind }), headers, 'post to the daemon /v1/outbound',
        Boolean(process.env.ELANOUS_NEXUS_URL?.trim()))
      : null;
    const classification = classifyDaemonResponse(j);
    if (classification === 'ok') { onBot?.('daemon:configured'); return 'daemon'; }
    daemonPath = nexus ? classification : 'not-found';
    const extra: Record<string, unknown> = { hasToken: token.length > 0 };
    if (j && typeof j === 'object' && 'error' in (j as object)) extra.error = (j as { error?: unknown }).error;
    logDaemonPath(classification, kind, extra);
  }
  // 2) fallback: 텔레그램 sendMessage 직접(3900자 분할) — 데몬 미경유라 클라가 원장 기록.
  //    The same config judges the route and explains a failure (review r1).
  //    deliver → sendTelegramDirect: the refusal propagates to the caller instead of becoming «undeliverable».
  let cfg: UserConfig | undefined;
  try { cfg = getUserConfig(); } catch { /* sendTelegramDirect fails closed without config */ }
  if (sendTelegramDirect(text, kind, cfg ? { config: cfg } : {}, onBot)) return 'direct';
  reportUndeliverable(kind, daemonPath, cfg);
  return false;
}

type UndeliverableRecorder = (item: AddBriefItem) => void;
let undeliverableRecorder: UndeliverableRecorder | null = null;
/** Replace the ledger writer in tests; null restores the production ledger. */
export function setUndeliverableRecorder(recorder: UndeliverableRecorder | null): void {
  undeliverableRecorder = recorder;
}

/** OB8b — both paths failed: say so loudly, with the universe this process resolved, instead of a silent false.
 *  The usual cause (10-01 · MK): an ad-hoc `bun -e` or a script from a source tree resolves a cwd-derived test
 *  universe, so it finds neither the production daemon nor the production bot token. */
function reportUndeliverable(kind: string, daemonPath: DaemonPathClass | 'not-found' | 'disabled', cfg?: UserConfig): void {
  let root = '?';
  let universe: 'prod' | 'test' | '?' = '?';
  try {
    root = effectiveInstanceRoot();
    universe = root === prodInstanceRoot() ? 'prod' : 'test';
  } catch { /* the report still goes out */ }
  // Which routing rule closed the direct path — «토큰 없음 또는 전송 실패» hid a missing role for four days (BRIEF-DELIVERY-1007).
  let route: ReturnType<typeof explainReportRoute> | null = null;
  try { if (cfg) route = explainReportRoute(cfg, kind); } catch { /* the report still goes out */ }
  ensureOutboundLogSink();
  const reason = route?.reason ?? 'unknown';
  try { debug.log('outbound.send', 'undeliverable', { kind: safeObservationLabel(kind), daemonPath, universe, root, route: reason }); } catch { /* fail-soft */ }
  try {
    const record = undeliverableRecorder ?? ((item: AddBriefItem) => {
      const { BriefItemsLedger } = require('../briefing/brief-items.js') as typeof import('../briefing/brief-items.js');
      new BriefItemsLedger().add(item);
    });
    record({
      domain: '운영', priority: 'P1', source: 'outbound.undeliverable',
      text: `미전달: kind ${kind} · 데몬 ${daemonPath} · 경로 ${reason} · 우주 ${universe}`,
      evidence: 'elanous logs --category outbound.send --event undeliverable',
      dedupeKey: `${kind} · ${reason}`, dedupeWithinMs: 60 * 60_000,
    });
  } catch (error) {
    try { debug.log('outbound.send', 'undeliverable-record-failed', { kind: safeObservationLabel(kind), route: reason, error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
  }
  const hint = universe === 'prod'
    ? '운영 데몬이 떠 있는지 확인: elanous nexus show'
    : '운영으로 보내려면 설치본 elanous 로 실행하거나 ELANOUS_STATE_DIR=~/.elanous 와 --config-dir ~/.elanous 를 준다';
  try { console.error(`[outbound] ⛔ 못 보냄(${kind}) — 데몬 ${daemonPath} · 직접 발송도 실패(${route && route.reason !== 'routed' ? `${route.reason}: ${route.hint}` : '토큰 없음 또는 전송 실패'}) · 이 프로세스의 우주 ${universe} (${root}) · ${hint}`); } catch { /* fail-soft */ }
}

/** 텔레그램 raw 발송(토큰·chatId 명시) — spill + 3900자 분할(줄 경계). thread 지원. */
function sendTelegramRaw(token: string, chatId: string | number, text: string, threadId?: number): boolean {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // 롱콘텐츠 spill(공용) — 너무 길면 S3 업로드+링크 1건으로 대체(S3 불가면 원문·아래 분할).
  const out = spillLongContent(text).text;
  const chunks: string[] = [];
  let cur = '';
  for (const line of out.split('\n')) {
    if (cur.length + line.length + 1 > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur) chunks.push(cur);
  let ok = true;
  for (const ch of chunks) {
    const params: Record<string, string> = { chat_id: String(chatId), text: ch, disable_web_page_preview: 'true' };
    if (threadId !== undefined) params.message_thread_id = String(threadId);
    if (!curlPost(url, new URLSearchParams(params).toString(), ['Content-Type: application/x-www-form-urlencoded'], 'send a real Telegram message')) ok = false;
  }
  return ok;
}

/** 텔레그램 직접 발송. 운영 kind 는 메인 봇/홈 밖의 env 로 내려가지 않는다. */
export function sendTelegramDirect(
  text: string, kind?: string,
  deps: { config?: UserConfig; sendRaw?: typeof sendTelegramRaw; legacyEnv?: typeof conatusEnv } = {},
  onBot?: (bot: string) => void,
): boolean {
  const sendRaw = (token: string, chatId: string | number, body: string): boolean => {
    // The transport is checked only after a route is eligible; a test double cannot target the ops universe.
    assertTestSendFaked('send a real Telegram message', !deps.sendRaw);
    return (deps.sendRaw ?? sendTelegramRaw)(token, chatId, body);
  };
  let cfg: UserConfig | undefined;
  try { cfg = deps.config ?? getUserConfig(); } catch { /* unavailable config: operational delivery still fails closed */ }
  if (cfg) {
    try {
      const target = kindRouteTarget(cfg, kind);
      if (target) {
        // Refusal must escape the routing fallback; other routing/callback/transport failures retain that fallback.
        assertTestSendFaked('send a real Telegram message', !deps.sendRaw);
        onBot?.(botLabel(target.botToken));
        return (deps.sendRaw ?? sendTelegramRaw)(target.botToken, String(target.chatId), text);
      }
    } catch (error) {
      if (error instanceof TestOpsWriteRefusedError) throw error;
      /* unavailable channel routing: fall through */
    }
    // A declared table is authoritative: missing roles cannot escape to an env bot.
    if (cfg.telegram.channels?.length) {
      logKindRouteFallback(kind, 'none', false);
      return false;
    }
  }
  if (isOperationalKind(kind)) {
    let home: ReturnType<typeof mainHomeTarget> = null;
    let mainToken = '';
    try {
      if (cfg) {
        mainToken = resolveChannelBotToken('telegram', cfg).token;
        home = mainHomeTarget(cfg);
      }
    } catch { /* unavailable main bot */ }
    const rcToken = cfg?.telegram.reportChannel?.botToken;
    logKindRouteFallback(kind, home ? 'main-home' : 'none', !!mainToken && !!cfg?.telegram.reportChannel && (!rcToken || rcToken === mainToken));
    if (home) { onBot?.(botLabel(home.botToken)); return sendRaw(home.botToken, String(home.chatId), text); }
    console.error('[outbound] 운영 kind 메인 봇/홈 미설정 — 콘솔 출력\n' + text);
    return false;
  }
  let tok = process.env.TELEGRAM_BOT_TOKEN || '';
  let chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!tok || !chat) {
    const env = (deps.legacyEnv ?? conatusEnv)();
    tok = tok || env.TELEGRAM_BOT_TOKEN || '';
    chat = chat || env.TELEGRAM_CHAT_ID || '';
  }
  logKindRouteFallback(kind, tok && chat ? 'conatus-env' : 'none', false);
  if (!tok || !chat) { console.error('[outbound] 토큰/chat 미설정 — 콘솔 출력\n' + text); return false; }
  onBot?.(botLabel(tok));
  return sendRaw(tok, chat, text);
}
