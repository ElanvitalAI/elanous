// ── elanous 네이티브 알림 발송 (Conatus send.py 대체·순수 TS) ────────────
//
// KORU 스윙 등 크론 알림을 elanous 단일 발송 지점 `/v1/outbound`(텔레그램 report
// channel)로 전송. 데몬 미가동/실패 시 텔레그램 직접(sendMessage) fallback —
// send.py 와 동일 동작을 TS 로 포팅(완전 elanous 소유). sync(curl) 계약.

import * as childProcess from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { conatusEnv } from './conatus-env.js';
import { spillLongContent } from '../storage/content-spill.js';
import { openSurfaceEventsDb, recordEvent } from './surface-events.js';
import { latestUserIntentTs } from '../user-intent/index.js';
import { getUserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { kindRouteTarget } from './telegram-kind-route.js';
import { debug } from '../debug/log.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
// ★ origin 되돌림(대표 2026-07-12) — 미션 알림을 발신 채널(메인 Q&A 봇)로 되돌린다. type-only
//   import 라 런타임 순환 없음(발송 로직은 이 파일에 self-contained). origin 없으면 report 폴백.
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { conatusPath } from './conatus-data-dir.js';

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
  mode: 'realtime' | 'deferred' | 'quiet-bypass' | 'flush',
  kind: string,
  extra: Record<string, unknown> = {},
  opts?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' },
): void {
  try { debug.log('outbound.send', mode, { kind, ...extra }, opts); } catch { /* fail-open */ }
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
function deferOutbound(text: string, kind: string, origin?: MissionOrigin | null, path = DEFERRED_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const rec = { ts: new Date().toISOString(), kind, text, ...(origin ? { origin } : {}) };
    appendFileSync(path, JSON.stringify(rec) + '\n');
    console.log(`[outbound] 야간 무음(00:00~06:30 KST) — 보류 적재 (${kind})`);
    logSend('deferred', kind, { reason: 'quiet-hours' });  // 밀림 적재 관측
  } catch (e) {
    console.log(`[outbound] 보류 적재 실패 — 콘솔 출력\n${text}`, e instanceof Error ? e.message : '');
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

/** origin(발신 채널)으로 직접 텔레그램 발송. telegram+chatId+토큰 해석 성공 시 true. */
function deliverToOrigin(origin: MissionOrigin, text: string): boolean {
  if (origin.channel !== 'telegram' || origin.chatId == null) return false;
  const token = resolveBotToken(origin.botId);
  if (!token) return false;
  try { return sendTelegramRaw(token, origin.chatId, text, origin.threadId); } catch { return false; }
}

/** 보류분 일괄 발송 — 묶음 1건(아침 폭주 방지). 발송 건수 반환.
 *  무음 창 밖 첫 sendOutbound 가 자동 호출 + 06:31 플러시 크론이 보장. */
export function flushDeferred(path = DEFERRED_PATH): number {
  const observeFlush = (count: number, lagMin: number, kinds: string[]): void => {
    const lagWarnMin = flushLagWarnMin();
    const over = count > 0 && lagMin > lagWarnMin;
    logSend(
      'flush',
      'deferred-batch',
      { count, lagMin, kinds, path, lagWarnMin },
      over ? { level: 'warn' } : undefined,
    );
  };
  if (!existsSync(path)) {
    observeFlush(0, 0, []);
    return 0;
  }
  type Item = { ts: string; kind: string; text: string; origin?: MissionOrigin };
  let items: Item[] = [];
  try {
    items = readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { /* 손상 라인 무시 */ }
  if (items.length === 0) {
    try { unlinkSync(path); } catch { /* */ }
    observeFlush(0, 0, []);
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
  observeFlush(items.length, lagMin, [...new Set(items.map(i => i.kind))]);
  let delivered = 0;
  // origin 없는 것 = report 묶음(기존 동작·finance/크론 알림).
  const noOrigin = items.filter(i => !i.origin);
  if (noOrigin.length && deliver(fmt(noOrigin), 'report')) delivered += noOrigin.length;
  // ★ origin 있는 것 = 발신 채널(botId+chatId)별 묶음으로 되돌려 발송(미션 알림 → 메인 Q&A 봇).
  const groups = new Map<string, { origin: MissionOrigin; list: Item[] }>();
  for (const it of items) {
    if (!it.origin) continue;
    const key = `${it.origin.botId ?? ''}:${it.origin.chatId ?? ''}`;
    if (!groups.has(key)) groups.set(key, { origin: it.origin, list: [] });
    groups.get(key)!.list.push(it);
  }
  for (const g of groups.values()) { if (deliverToOrigin(g.origin, fmt(g.list))) delivered += g.list.length; }
  // 전량 배달 성공 시에만 파일 제거(부분 실패는 다음 flush 재시도 — 성공분 중복은 드문 엣지 수용).
  if (delivered >= items.length) { try { unlinkSync(path); } catch { /* */ } }
  return delivered;
}

/** 동기 curl(POST). body 는 stdin. 파싱 실패/에러 → null. */
function curlPost(url: string, body: string, headers: string[]): any {
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
export function sendOutbound(text: string, kind = 'alert', origin?: MissionOrigin | null): boolean {
  // ★ 무음 우회(대표 2026-07-14) — 사용자가 최근(기본 30분) genuine 인텐트(타이핑/버튼탭)를 냈으면
  //   깨어있으므로 야간 무음이어도 즉시 발송(사용자 발원 흐름의 결과물이 아침까지 묶이지 않게).
  //   우회 시 flushDeferred 로 그간 보류분도 함께 전달(사용자가 지금 볼 수 있음).
  if (inQuietHours() && !userRecentlyActive()) {
    deferOutbound(text, kind, origin);
    recordOutbound(text, kind); // 보류도 논리적 발송 — 회상 대상(데몬 미경유라 클라 기록)
    return true; // 보류 = 수락 (호출측 재시도/에러 루프 방지)
  }
  const bypass = inQuietHours();
  if (bypass) console.log('[outbound] 야간 무음 우회 — 최근 사용자 활동(깨어있음) → 즉시 발송 + 보류분 flush');
  try { flushDeferred(); } catch { /* fail-soft */ }
  // ★ 발송 관측(대표 지시) — 발송 시각·mode·밀림(burst) 판정을 logs.db 에. burst=최근 2분 5건+
  //   (몰려 나가는 중 = 밀림 의심). `elanous logs --category outbound.send` 로 실시간/밀림 구분.
  const { recentCount, burst } = recentSendBurst();
  logSend(bypass ? 'quiet-bypass' : 'realtime', kind, { burst, recentCount, ...(burst ? { backlog: true } : {}) });
  // ★ origin 되돌림(무음 밖) — 발신 채널로 직접 발송. 성공 시 종료, 실패면 report 폴백.
  if (origin && origin.channel === 'telegram' && origin.chatId != null && deliverToOrigin(origin, text)) {
    recordOutbound(text, kind);
    return true;
  }
  const path = deliver(text, kind);
  // 원장 기록은 정확히 1회. 데몬 경유(daemon)면 /v1/outbound 핸들러(outbound-report.ts)
  // 가 기록하므로 클라는 중복 금지 — 직접 폴백(direct·데몬 다운)만 클라가 기록.
  if (path === 'direct') recordOutbound(text, kind);
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
  try { debug.log('outbound.send', 'daemon-path', { classification, kind, ...extra }); } catch { /* fail-soft */ }
  if (classification === 'ok') return;
  try { console.log(`[outbound] daemon-path ${classification}`); } catch { /* fail-soft */ }
}

/** elanous `/v1/outbound` 우선 → 실패 시 텔레그램 직접. 성공 경로 반환(원장 중복방지용). */
export function deliver(text: string, kind = 'alert'): 'daemon' | 'direct' | false {
  // 1) elanous 단일 발송 지점(/v1/outbound) — 데몬이 팬아웃 + 원장 기록.
  if (process.env.SEND_VIA_ELANOUS !== '0') {
    let token = '';
    try { if (existsSync(ACP_TOKEN_PATH)) token = readFileSync(ACP_TOKEN_PATH, 'utf-8').trim(); } catch { /* no token */ }
    const headers = ['Content-Type: application/json', ...(token ? [`Authorization: Bearer ${token}`] : [])];
    const nexus = nexusUrl();
    const j = nexus
      ? curlPost(`${nexus}/v1/outbound`, JSON.stringify({ text, markdown: false, kind }), headers)
      : null;
    const classification = classifyDaemonResponse(j);
    if (classification === 'ok') return 'daemon';
    const extra: Record<string, unknown> = { hasToken: token.length > 0 };
    if (j && typeof j === 'object' && 'error' in (j as object)) extra.error = (j as { error?: unknown }).error;
    logDaemonPath(classification, kind, extra);
  }
  // 2) fallback: 텔레그램 sendMessage 직접(3900자 분할) — 데몬 미경유라 클라가 원장 기록.
  return sendTelegramDirect(text, kind) ? 'direct' : false;
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
    if (!curlPost(url, new URLSearchParams(params).toString(), ['Content-Type: application/x-www-form-urlencoded'])) ok = false;
  }
  return ok;
}

/** 텔레그램 직접 발송(TELEGRAM_BOT_TOKEN/CHAT_ID — env 우선, 없으면 CONATUS/.env). report 폴백. */
function sendTelegramDirect(text: string, kind?: string): boolean {
  // A purpose kind with a channel role (intake · ops-*) goes to that channel even when the daemon is down.
  try {
    const target = kindRouteTarget(getUserConfig(), kind);
    if (target) return sendTelegramRaw(target.botToken, String(target.chatId), text);
  } catch { /* fall through to the legacy direct path */ }
  let tok = process.env.TELEGRAM_BOT_TOKEN || '';
  let chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!tok || !chat) {
    const env = conatusEnv();
    tok = tok || env.TELEGRAM_BOT_TOKEN || '';
    chat = chat || env.TELEGRAM_CHAT_ID || '';
  }
  if (!tok || !chat) { console.log('[outbound] 토큰/chat 미설정 — 콘솔 출력\n' + text); return false; }
  return sendTelegramRaw(tok, chat, text);
}
