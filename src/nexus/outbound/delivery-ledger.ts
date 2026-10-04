// ── 발송 배송 원장 (2026-07-07 · 발송 팬아웃 구조) ────────────────────
//
// 대표 요구 2건의 구조적 토대:
//  ① 중복 발사 제어 — 다채널 동시발사는 의도(팬아웃)지만, 같은 메시지가 짧은
//     창 안에 두 번 팬아웃되면 사용자에겐 중복. dedupKey(kind+text 해시)로 최근
//     발송분과 대조해 재팬아웃을 억제.
//  ② 크로스채널 리드 동기화 — 한 채널에서 읽으면 전체 read 처리. 메시지 1건을
//     messageId로 식별하고 채널별 배송 + read 상태를 원장에 기록. markRead가
//     전체를 read로 마킹(채널 측 전파=삭제/편집는 향후 콜백 배선 — 여기선 상태
//     원장 + 프리미티브까지).
//
// 지금은 telegram-only 운영이나 채널이 1개여도 원장은 동일하게 동작 —
// 다채널 활성 시 그대로 확장. 별도 SQLite(surface_events와 분리 — 이건 배송/read
// 운영 상태, 저건 회상용 에피소드 기억).

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { conatusPath } from '../../domains/conatus-data-dir.js';
import { HOURS, SECONDS, sinceTs } from '../../time/db-window.js';

export const DELIVERY_DB_PATH = conatusPath('outbound_deliveries.db');

export interface ChannelDelivery { type: string; ok: boolean }

export interface DeliveryRow {
  message_id: string; ts: string;
  kind: string; dedup_key: string; text: string;
  channels: string;            // JSON ChannelDelivery[]
  read: number; read_at: string | null; read_channel: string | null;
}

export function openDeliveryDb(path: string = DELIVERY_DB_PATH): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS deliveries(
    message_id TEXT PRIMARY KEY, ts TEXT NOT NULL,
    kind TEXT, dedup_key TEXT NOT NULL, text TEXT,
    channels TEXT,
    read INT DEFAULT 0, read_at TEXT, read_channel TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_deliv_dedup ON deliveries(dedup_key, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_deliv_read ON deliveries(read, ts)`);
  return db;
}

/** dedupKey — kind + 정규화 text 해시. 같은 발표/알림의 즉시 재발사 판별용. */
export function deliveryDedupKey(kind: string, text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  return createHash('sha1').update(`${kind}\n${norm}`).digest('hex').slice(0, 16);
}

/** ① 중복 발사 제어 — windowSec 내 동일 메시지가 한 채널 이상 성공했으면 그 messageId.
 *  실패 기록은 재시도를 막지 않는다. 짧은 창(기본 120s) 밖의 재발송은 통과. */
export function successfulDeliveryId(
  db: Database, dedupKey: string, windowSec = 120, nowMs: number = Date.now(),
): string | null {
  // ⚠️ 축 ②(JS 임계 · db-window 참조) — 같은 파일의 `recentDeliveryCount` 와 동형이다.
  //    SQL 안의 `datetime('now')` 를 쓰면 **시계를 주입할 수 없어** 테스트가 실제 시각에
  //    매달린다. 실제로 이 함수의 테스트가 고정 날짜로 seed 한 채 시간이 흘러 어느 날 빨개진
  //    시한폭탄이었다. `deliveries.ts` 는 ISO 로만 쓰므로 raw 비교가 옳고 인덱스도 산다.
  const row = db.prepare(
    `SELECT message_id FROM deliveries
     WHERE dedup_key = ? AND ts >= ?
       AND EXISTS (SELECT 1 FROM json_each(deliveries.channels) WHERE json_extract(value, '$.ok') = 1)
     ORDER BY ts DESC LIMIT 1`,
  ).get(dedupKey, sinceTs(SECONDS(windowSec), nowMs)) as { message_id: string } | null;
  return row?.message_id ?? null;
}

/** 기존 boolean 호출부 호환 — 성공 배송 기록만 중복으로 센다. */
export function recentlyDelivered(
  db: Database, dedupKey: string, windowSec = 120, nowMs: number = Date.now(),
): boolean {
  return successfulDeliveryId(db, dedupKey, windowSec, nowMs) !== null;
}

/** 최근 창(windowSec) 내 총 발송 수 — 버스트(밀림) 판정용. 전 kind 합산.
 *  ts 는 ISO 문자열 저장이므로 ISO 임계로 비교(datetime('now') 는 공백포맷이라 T/Z 와 오비교). */
export function recentDeliveryCount(db: Database, windowSec = 120, nowMs = Date.now()): number {
  // 임계 계산은 표준(`sinceTs`)으로 — 손으로 쓰면 파일마다 미세하게 갈린다.
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM deliveries WHERE ts >= ?`,
  ).get(sinceTs(SECONDS(windowSec), nowMs)) as { n: number };
  return row.n;
}

export interface RecordDeliveryInput {
  messageId: string; kind: string; dedupKey: string; text: string;
  channels: ChannelDelivery[]; ts?: string;
}

/** 배송 사실 기록(팬아웃 후). 채널별 성공/실패 + read 초기 0. */
export function recordDelivery(db: Database, d: RecordDeliveryInput): void {
  db.run(
    `INSERT OR REPLACE INTO deliveries (message_id, ts, kind, dedup_key, text, channels, read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [d.messageId, d.ts ?? new Date().toISOString(), d.kind, d.dedupKey, d.text.slice(0, 4000), JSON.stringify(d.channels)],
  );
}

/** ② 리드 동기화 — messageId(또는 dedupKey)를 read로 마킹. 어느 채널에서 읽었든
 *  전체가 read. 채널 측 전파(다른 채널 삭제/편집)는 향후 어댑터 콜백에서 이 함수
 *  호출 + reverse 전파. 여기선 상태 원장 갱신까지. 마킹된 행 수 반환. */
export function markRead(db: Database, idOrDedup: string, channel?: string, now = new Date().toISOString()): number {
  const r = db.prepare(
    `UPDATE deliveries SET read = 1, read_at = ?, read_channel = ?
     WHERE (message_id = ? OR dedup_key = ?) AND read = 0`,
  ).run(now, channel ?? null, idOrDedup, idOrDedup);
  return r.changes;
}

/** 미열람 발송 목록(최근순) — read-sync UI/알림 배지·재알림 판단용. */
export function listUnread(
  db: Database, hours = 48, limit = 50, nowMs: number = Date.now(),
): DeliveryRow[] {
  // 축 ②(JS 임계) — 이 파일의 다른 창 조회와 동형. `deliveries.ts` 는 ISO 로만 쓰므로
  // raw 비교가 옳고 인덱스도 산다. `ORDER BY ts` 도 같은 이유로 정규화가 불필요하다.
  return db.prepare(
    `SELECT * FROM deliveries WHERE read = 0 AND ts >= ? ORDER BY ts DESC LIMIT ?`,
  ).all(sinceTs(HOURS(hours), nowMs), limit) as DeliveryRow[];
}
