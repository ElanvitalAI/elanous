// 흡수 입력원 I4 — 텔레그램 «저장된 메시지»(me 대화)를 읽기만 한다. RFC-regular-external-intake §2 · §3.4 · §8-1.
// ⛔ 사용자 세션은 계정 전체 권한이다(읽기 전용 토큰이 없다). 그래서 이 모듈은 `me` 대화 «읽기» 하나만 부르고,
//    보내기·지우기 경로를 import 하지 않는다 · 호스트 전용(Pod 에 주입하지 않는다) · 관측엔 커서·건수만 남긴다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { ingestIntakeItems, intakeLedgerDir, type IngestResult, type RawIntakeItem } from './items.js';

export interface SavedMessage { id: number; date: string; text: string; urls: string[] }

/** 커서 이후(id > minId)의 저장된 메시지를 오래된 것부터 최대 limit 개. 실제 구현은 GramJS · 시험은 가짜. */
export type FetchSavedMessages = (minId: number, limit: number) => Promise<SavedMessage[]>;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** 메시지 한 개 → 원장 입력 줄. 링크가 있으면 링크마다 한 줄(메모 문장은 text 로) · 없으면 메모 한 줄. */
export function savedMessageToRaws(m: SavedMessage): RawIntakeItem[] {
  const urls = [...new Set([...m.urls, ...(m.text.match(URL_RE) ?? [])].map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const memo = m.text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (urls.length === 0) return memo ? [{ text: memo, kind: 'note', observedAt: m.date }] : [];
  return urls.map((url) => ({ url, ...(memo ? { text: memo } : {}), observedAt: m.date }));
}

function cursorFile(root: string): string { return join(intakeLedgerDir(root), 'telegram-saved.cursor.json'); }

export function readSavedCursor(root: string): number {
  try { return Number(JSON.parse(readFileSync(cursorFile(root), 'utf8')).lastId) || 0; } catch { return 0; }
}

/** When the cursor last moved (= a run last found a new saved message). Undefined before the first message. */
export function readSavedCursorAt(root: string): string | undefined {
  try { const at = JSON.parse(readFileSync(cursorFile(root), 'utf8')).at; return typeof at === 'string' ? at : undefined; } catch { return undefined; }
}

function writeSavedCursor(root: string, lastId: number): void {
  mkdirSync(intakeLedgerDir(root), { recursive: true });
  writeFileSync(cursorFile(root), JSON.stringify({ lastId, at: new Date().toISOString() }) + '\n');
}

export interface CollectSavedResult { cursorBefore: number; cursorAfter: number; messages: number; raws: number; dryRun: boolean; ingest?: IngestResult }

/**
 * 커서 이후 메시지를 한 번에 최대 max 개 읽어 원장에 넣고 커서를 옮긴다.
 * 첫 판(커서 0)은 가장 오래된 것부터 — 쌓인 링크를 하루 max 개씩 따라잡는다.
 * dryRun 이면 원장·커서를 바꾸지 않는다.
 */
export async function collectTelegramSaved(root: string, fetch: FetchSavedMessages, opts: { max: number; dryRun?: boolean }): Promise<CollectSavedResult> {
  const cursorBefore = readSavedCursor(root);
  const messages = await fetch(cursorBefore, opts.max);
  const raws = messages.flatMap(savedMessageToRaws);
  const cursorAfter = messages.reduce((mx, m) => Math.max(mx, m.id), cursorBefore);
  const result: CollectSavedResult = { cursorBefore, cursorAfter, messages: messages.length, raws: raws.length, dryRun: !!opts.dryRun };
  if (!opts.dryRun) {
    result.ingest = ingestIntakeItems(root, 'telegram-saved', raws);
    if (cursorAfter > cursorBefore) writeSavedCursor(root, cursorAfter);
  }
  // ⛔ 본문·링크는 싣지 않는다 — 커서와 건수만.
  debug.log('intake.collect', 'telegram-saved', { cursorBefore, cursorAfter, messages: messages.length, raws: raws.length, dryRun: !!opts.dryRun });
  return result;
}

/** GramJS 사용자 세션으로 `me` 대화를 읽는 실제 구현. 자격이 없으면 이유를 담아 던진다(값은 싣지 않는다). */
export async function gramjsFetchSaved(env: NodeJS.ProcessEnv = process.env): Promise<{ fetch: FetchSavedMessages; close: () => Promise<void> }> {
  const apiId = Number(env.TELEGRAM_API_ID ?? 0);
  const apiHash = env.TELEGRAM_API_HASH ?? '';
  const session = env.TELEGRAM_USER_SESSION ?? '';
  const missing = [!apiId && 'TELEGRAM_API_ID', !apiHash && 'TELEGRAM_API_HASH', !session && 'TELEGRAM_USER_SESSION'].filter(Boolean);
  if (missing.length) throw new Error(`텔레그램 사용자 세션 자격이 없다: ${missing.join(' · ')} (docs/manual/MANUAL-telegram-unmanned-test-2026-07-21.md §1~§3)`);
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel('error' as never);   // 연결 로그가 표준출력을 채우지 않게
  await client.connect();
  const fetch: FetchSavedMessages = async (minId, limit) => {
    const msgs = await client.getMessages('me', { reverse: true, minId, limit });
    return msgs.map((m) => {
      const text = String(m.message ?? '');
      const urls: string[] = [];
      for (const e of (m.entities ?? []) as { className?: string; url?: string; offset?: number; length?: number }[]) {
        if (e.className === 'MessageEntityTextUrl' && e.url) urls.push(e.url);
        else if (e.className === 'MessageEntityUrl' && e.offset != null && e.length != null) urls.push(text.slice(e.offset, e.offset + e.length));
      }
      const webpage = (m.media as { webpage?: { url?: string } } | undefined)?.webpage?.url;
      if (webpage) urls.push(webpage);
      return { id: m.id, date: new Date((m.date ?? 0) * 1000).toISOString(), text, urls };
    });
  };
  return { fetch, close: async () => { await client.disconnect(); } };
}

export function hasSavedCursor(root: string): boolean { return existsSync(cursorFile(root)); }
