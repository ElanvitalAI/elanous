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
function recoveryFile(root: string): string { return join(intakeLedgerDir(root), 'telegram-saved.recovery.json'); }

function readRecoveryCursor(root: string): number | undefined {
  try {
    const cursor = Number(JSON.parse(readFileSync(recoveryFile(root), 'utf8')).lastId);
    return Number.isSafeInteger(cursor) ? cursor : undefined;
  } catch { return undefined; }
}

function writeRecoveryCursor(root: string, lastId: number): void {
  mkdirSync(intakeLedgerDir(root), { recursive: true });
  writeFileSync(recoveryFile(root), JSON.stringify({ lastId }) + '\n');
}

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

export interface CollectSavedResult {
  cursorBefore: number;
  cursorAfter: number;
  /** fetch 가 돌려준 «저장된 메시지» 수 — 커서 이후 읽은 것. */
  messages: number;
  /** 그중 savedMessageToRaws 가 0줄로 버린 메시지 수(빈 몸통) — «필터» 축. */
  droppedByFilter: number;
  /** 원장에 넣으려고 만든 입력 줄 수 — «원장 입력» 축. messages 와 다른 값이다. */
  raws: number;
  dryRun: boolean;
  ingest?: IngestResult;
}

/** «메시지 0»·«원장 입력 0» 의 까닭 — 필터로 비었는지 다른 주체가 이미 가져갔는지 갈라 읽는다. */
export type SavedCollectDiagnosis = 'new-items' | 'no-new-messages' | 'filtered-out' | 'already-consumed';

export function diagnoseSavedCollect(res: CollectSavedResult): SavedCollectDiagnosis {
  // 원장 입력이 있고 새로/합쳐 들어간 것이 있으면 정상 흡수다(dry-run 은 넣을 예정).
  if (res.raws > 0 && (!res.ingest || res.ingest.added + res.ingest.merged > 0)) return 'new-items';
  if (res.messages === 0) return 'no-new-messages';
  if (res.droppedByFilter === res.messages) return 'filtered-out';
  return 'already-consumed';
}

/** 사람이 읽는 한 덩이 — «메시지 0» 과 «원장 입력 0» 을 다른 줄로 갈라 보여준다. */
export function renderCollectTelegramSavedResult(res: CollectSavedResult): string {
  const lines = [
    `텔레그램 저장된 메시지: 읽음 ${res.messages} · 필터로 버림 ${res.droppedByFilter} · 원장 입력 ${res.raws} · 커서 ${res.cursorBefore} → ${res.cursorAfter}${res.dryRun ? ' (dry-run · 안 씀)' : ''}`,
  ];
  if (res.ingest) lines.push(`원장: 새 ${res.ingest.added} · 합침 ${res.ingest.merged} · 이미 끝난 것 ${res.ingest.seen} · 버림 ${res.ingest.skipped}`);
  const diagnosis = diagnoseSavedCollect(res);
  if (diagnosis === 'no-new-messages') {
    lines.push(`메시지 0 — 커서 ${res.cursorBefore} 이후 새 저장 메시지가 없다${res.cursorBefore > 0 ? ' (커서는 이미 다른 주체가 넘겼을 수 있다)' : ''}`);
  } else if (diagnosis === 'filtered-out') {
    lines.push(`원장 입력 0 은 필터 때문이다 — 링크·메모 문장이 없는 빈 메시지 ${res.droppedByFilter}건`);
  } else if (diagnosis === 'already-consumed') {
    lines.push(`원장 입력 ${res.raws} · 새 0 — 같은 항목을 다른 주체(queue)가 이미 가져갔다 (이미 끝난 것 ${res.ingest?.seen ?? 0})`);
  } else if (res.dryRun) {
    lines.push(`원장에 들어갈 것 ${res.raws}건 (dry-run — 쓰지 않았다)`);
  } else {
    lines.push(`원장에 새 것 ${res.ingest?.added ?? 0}건이 들어갔다`);
  }
  return lines.join('\n');
}

/**
 * 커서 이후 메시지를 한 번에 최대 max 개 읽어 원장에 넣고 커서를 옮긴다.
 * 첫 판(커서 0)은 가장 오래된 것부터 — 쌓인 링크를 하루 max 개씩 따라잡는다.
 * dryRun 이면 원장·커서를 바꾸지 않는다.
 */
export async function collectTelegramSaved(root: string, fetch: FetchSavedMessages, opts: { max: number; dryRun?: boolean }): Promise<CollectSavedResult> {
  const cursorBefore = readSavedCursor(root);
  const fetched = await fetch(cursorBefore, opts.max);
  let messages = fetched.filter((message) => Number.isSafeInteger(message.id) && message.id > cursorBefore);
  // A cursor may have advanced without this consumer seeing the bounded interval. Scan that span
  // once for each cursor value, even when the forward read has newer messages. Telegram's minId is
  // exclusive, so include the cursor ID because another consumer may have consumed it.
  if (cursorBefore > 0 && readRecoveryCursor(root) !== cursorBefore) {
    const recoveryLimit = Math.max(1, opts.max);
    let recoveryFrom = Math.max(0, cursorBefore - recoveryLimit - 1);
    const recovered: SavedMessage[] = [];
    while (recoveryFrom < cursorBefore) {
      const recovery = await fetch(recoveryFrom, recoveryLimit);
      const page = recovery.filter((message) => Number.isSafeInteger(message.id)
        && message.id > recoveryFrom && message.id <= cursorBefore);
      recovered.push(...page);
      if (page.length < recoveryLimit) break;
      const nextFrom = page.reduce((last, message) => Math.max(last, message.id), recoveryFrom);
      if (nextFrom <= recoveryFrom) break;
      recoveryFrom = nextFrom;
    }
    messages = [...recovered, ...messages];
  }
  const rowsPerMessage = messages.map(savedMessageToRaws);
  const raws = rowsPerMessage.flat();
  const droppedByFilter = rowsPerMessage.filter((rows) => rows.length === 0).length;
  const cursorAfter = messages.reduce((mx, m) => Math.max(mx, m.id), cursorBefore);
  const result: CollectSavedResult = { cursorBefore, cursorAfter, messages: messages.length, droppedByFilter, raws: raws.length, dryRun: !!opts.dryRun };
  if (!opts.dryRun) {
    result.ingest = ingestIntakeItems(root, 'telegram-saved', raws);
    if (cursorAfter > cursorBefore) writeSavedCursor(root, cursorAfter);
    // The marker commits the scan only after ingestion succeeds; keep it monotonic at the saved cursor boundary.
    writeRecoveryCursor(root, Math.max(cursorAfter, cursorBefore));
  }
  // ⛔ 본문·링크는 싣지 않는다 — 커서와 건수만. 두 축(메시지·원장 입력)을 따로 남겨 사흘 0 을 갈라 읽게.
  debug.log('intake.collect', 'telegram-saved', {
    cursorBefore, cursorAfter, messages: messages.length, droppedByFilter, raws: raws.length,
    ...(result.ingest ? { added: result.ingest.added, merged: result.ingest.merged, seen: result.ingest.seen, skipped: result.ingest.skipped } : {}),
    diagnosis: diagnoseSavedCollect(result), dryRun: !!opts.dryRun,
  });
  return result;
}

/** GramJS 사용자 세션으로 `me` 대화를 읽는 실제 구현. 자격이 없으면 이유를 담아 던진다(값은 싣지 않는다). */
type GramjsModules = { TelegramClient: typeof import('telegram').TelegramClient; StringSession: typeof import('telegram/sessions').StringSession };
const loadGramjs = async (): Promise<GramjsModules> => ({
  TelegramClient: (await import('telegram')).TelegramClient,
  StringSession: (await import('telegram/sessions')).StringSession,
});

export async function gramjsFetchSaved(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<GramjsModules> = loadGramjs,
): Promise<{ fetch: FetchSavedMessages; close: () => Promise<void> }> {
  const apiId = Number(env.TELEGRAM_API_ID ?? 0);
  const apiHash = env.TELEGRAM_API_HASH ?? '';
  const session = env.TELEGRAM_USER_SESSION ?? '';
  const missing = [!apiId && 'TELEGRAM_API_ID', !apiHash && 'TELEGRAM_API_HASH', !session && 'TELEGRAM_USER_SESSION'].filter(Boolean);
  if (missing.length) throw new Error(`텔레그램 사용자 세션 자격이 없다: ${missing.join(' · ')} (docs/manual/MANUAL-telegram-unmanned-test-2026-07-21.md §1~§3)`);
  // `telegram` is an optional dependency: its native websocket helpers have no Linux ARM64 build, so npm may leave it out.
  let modules: GramjsModules;
  try { modules = await load(); }
  catch { throw new Error('텔레그램 사용자 세션 모듈(telegram)이 이 설치에 없다 — 선택 의존이라 Linux ARM64 등에서는 빠진다(npm i -g telegram 으로 따로 깔 수 있다)'); }
  const { TelegramClient, StringSession } = modules;
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
