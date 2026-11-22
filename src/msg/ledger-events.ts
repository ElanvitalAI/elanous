// OP P0 2단계 ELS-SERVER-EVENT-HUB-NO-DB-POLL — writer side.
// 우편 원장 쓰기(post·ack·receipt)는 원장 옆 부수 이벤트 파일에 한 줄을 남긴다(append-only · O_APPEND · best-effort).
// 원장 쓰기가 사실이고 이 줄은 알림일 뿐이다 — 절대 쓰기 경로를 깨지 않는다(fail-soft 전면).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The sidecar events path for one ledger path. */
export function ledgerEventsPath(dbPath: string): string { return `${dbPath}.events`; }

/** One JSON event line beside the ledger. Never throws: the ledger write is the fact, this line is a courtesy. */
export function appendLedgerEvent(dbPath: string, kind: string): void {
  const eventsPath = ledgerEventsPath(dbPath);   // hoisted: the catch below must be able to name it
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify({ v: 1, kind, at: new Date().toISOString() })}\n`);
  } catch {
    // JUD-B #132880 mustFix ② — a lost courtesy line must be visible, not silent: one best-effort marker beside the
    // ledger (fail-soft stays — this too never throws; the reader's bounded resync heals the badge without follow-up mail).
    try { appendFileSync(`${eventsPath}.lost`, `${JSON.stringify({ v: 1, kind, lost: true, at: new Date().toISOString() })}\n`); } catch { /* give up silently — the ledger write already succeeded */ }
  }
}
