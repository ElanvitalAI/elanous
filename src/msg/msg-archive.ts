import type { Database } from 'bun:sqlite';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MsgStore, defaultMsgStorePath, unreadArmsOn } from './msg-store.js';

/**
 * MSG-LEDGER-RETENTION-INDEX ①③ — 7일 지난 배달·ack 끝난 직통 행의 보관 이행과 커서 정리.
 * 칸(원문 features.sqlite): 7일 지난 배달·ack 끝난 행 보관 DB 이동 · 미읽음 인덱스 · 17자리 badge <5ms.
 * 이행은 원장 보존이다 — 옮겨진 행은 보관 원장에서 그대로 검색되고, 미읽음·만료·ALL·group 행은 운영 원장에 남는다.
 * 이행은 두 커밋으로 간다: (1) 복사 트랜잭션은 보관 원장에만 쓰고 (2) 삭제+③커서 정리는 운영 원장에만 쓴다 —
 * 각 커밋이 한 원장에만 쓰므로 운영 원장이 WAL 이어도 원장을 넘는 반쪽 커밋은 생기지 않는다.
 * 보관 원장은 ATTACH 직후 rollback journal(journal_mode=DELETE) 로 저널 모드를 강제한다(Terra r2 ②) —
 * 전환이 안 되면 이행 전에 안전 중단한다.
 * 보관 복사는 INSERT-only-missing 이다(Terra r2 ①③): 보관에 이미 있는 identical 행은 다시 쓰지 않고,
 * 보관에만 있는 자식 행은 절대 지우지 않는다(보존). 같은 키의 다른 내용과 충돌하는 행은 어느 쪽 원장도
 * 손대지 않고 그 행만 건너뛴다(r5 — JUD-C #128689 ①·OP #128692 무손실 격리): 충돌 메시지는 배치에서
 * 제외되고, 충돌 자식 행은 복사에서 제외된다 — 나머지 정상 행의 이행은 막히지 않고, 충돌 행은 운영
 * 원장에 그대로 남아 다음 이행이 다시 본다.
 * 삭제 트랜잭션은 지우기 전에 재검증한다(Terra r2 ③): 복사 커밋과 삭제 커밋 사이에 운영 행이 바뀌었거나
 * 자식이 추가된 메시지는 지우지 않고 운영 원장에 남겨 다음 이행이 다시 본다 — 보관본에 없는 데이터를 지우지 않는다.
 * 복사 커밋 뒤 삭제 전에 프로세스가 죽으면 재실행이 잔여를 정리해 처음부터 끝낸다(④ 회복 — 멱등).
 */
export const MSG_ARCHIVE_DEFAULT_DAYS = 7;

/** 보관 원장 경로 — 운영 원장(messages.db) 옆 messages-archive.db. */
export function defaultArchivePath(): string {
  return join(dirname(defaultMsgStorePath()), 'messages-archive.db');
}

export interface ArchiveDeliveredOutcome {
  /** 이번 이행이 옮긴 행 수(멱등 — 두 번째 실행은 0). */
  archived: number;
  /** 보존기 시작 시각(이행 기준) ISO. */
  cutoffIso: string;
  /** ③ 커서 정리 뒤 각 자리의 커서 — stale 커서는 첫 미읽음 직전까지만 전진한다. */
  cursors: Record<string, number>;
  /** r5 — JUD-C #128689 ① 무손실 격리: 충돌(같은 키 다른 내용)으로 건너뛴 행 수. 어느 원장도 손대지 않았다. */
  skippedConflicts: { messages: number; childRows: number };
}

/** 표 존재 판정 — ATTACH 상황에서 스키마(main·msg_archive)별로 본다. 2인수 호출은 arity 위반이다(출처: #39557 r3 RED). */
function tableExists(db: Database, schema: string, name: string): boolean {
  return (db.query(`SELECT COUNT(*) AS count FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { count: number }).count > 0;
}

/** ① 같은 파일 판정 — dev·ino 가 같으면 같은 파일이고, 둘 중 하나가 없으면 realpath(심볼릭 링크까지)로 판다. */
function sameFilePath(a: string, b: string): boolean {
  try {
    const sa = statSync(a), sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { /* 아직 없는 쪽이 있다 — realpath 로 매달린 심볼릭 링크까지 본다 */ }
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function mainLedgerFile(db: Database): string {
  return ((db.query('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(row => row.name === 'main')?.file) ?? '';
}

/** 표의 열 이름 — 복사는 이 목록을 명시적으로 쓴다(SELECT * 의 열 순서 가정이 없다). */
function columnNames(db: Database, schema: string, table: string): string[] {
  return (db.query(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** ① 이행에 함께 갈 자식 표 — (표, 메시지를 가리키는 열). msg_ta_* 의 request_id 는 msg_messages(id) 외래키다. */
const ARCHIVE_CHILDREN: ReadonlyArray<readonly [string, string]> = [
  ['msg_receipts', 'message_id'],
  ['msg_message_acks', 'message_id'],
  ['msg_provenance', 'message_id'],
  ['msg_ta_delivery', 'request_id'],
  ['msg_ta_claim', 'request_id'],
];

interface ArchiveChildSpec {
  table: string;
  /** 메시지(또는 요청 메시지)를 가리키는 열. */
  column: string;
  /** 운영 표의 열 이름 — 복사·비교는 이 목록을 명시적으로 쓴다. */
  cols: string[];
}

/**
 * ① 배달·ack 끝난 7일+ 직통 행을 보관 원장으로 옮긴다.
 * 대상 술어: 직통 수신자(ALL·group:* 제외) · created_at ≤ cutoff · 만료 전 ·
 * 커서가 지났거나(msg_cursors.last_id ≥ id) 개별 ack(msg_message_acks) 끝난 행.
 * options.betweenTransactions — 두 커밋 사이(트랜잭션 밖)에서만 실행되는 시험·운영 후크.
 */
export function archiveDeliveredRows(
  store: MsgStore,
  archivePath: string,
  options: { days?: number; now?: Date; betweenTransactions?: () => void } = {},
): ArchiveDeliveredOutcome {
  const days = Math.max(1, Math.floor(options.days ?? MSG_ARCHIVE_DEFAULT_DAYS));
  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  const nowIso = now.toISOString();
  const db = store.db;
  // ① 보관 경로가 운영 원장과 같은 파일이면(경로 별칭·심볼릭 링크 포함) 이행 전에 거부한다 — 자기 복사 뒤 삭제는 원장 유실이다.
  const mainFile = mainLedgerFile(db);
  if (mainFile && mainFile !== ':memory:' && sameFilePath(mainFile, archivePath)) {
    throw new Error(`archive ledger must be a separate file from the message ledger: ${archivePath}`);
  }
  // r3-Terra-② 보관 원장 부재 시 이행 전에 안전 중단한다 — MsgStore 생성자는 빈 파일을 새로 만들어
  // «부재 시 이동 중단·원장 무변경» 실패 경로(PR 본문)를 무음으로 깨기 때문이다. 파일을 만들지 않고 던진다.
  if (!existsSync(archivePath)) {
    throw new Error(`archive ledger not found — refusing to create one; create it explicitly first: ${archivePath}`);
  }
  // 보관 원장의 스키마는 MsgStore 생성자가 정한다 — 마이그레이션까지 같은 생성자가 돌린다.
  new MsgStore(archivePath).close();
  db.exec(`ATTACH DATABASE '${archivePath.replace(/'/g, "''")}' AS msg_archive`);
  try {
    // ② 저널 모드 강제 — 보관 원장은 rollback journal 로만 커밋한다(전환이 안 되면 이행 전에 안전 중단).
    db.exec('PRAGMA msg_archive.journal_mode = DELETE');
    const journalMode = (db.query('PRAGMA msg_archive.journal_mode').get() as { journal_mode: string }).journal_mode;
    if (journalMode.toLowerCase() !== 'delete') {
      throw new Error(`archive ledger must use the rollback journal (journal_mode=delete) — got ${journalMode}`);
    }
    // 옛 원령 방어: expires_at 열·ack 표가 없으면 그 조건만 뺀 같은 술어(원장 보존 계약은 그대로).
    const sourceColumns = columnNames(db, 'main', 'msg_messages');
    const archiveColumns = columnNames(db, 'msg_archive', 'msg_messages');
    const missing = sourceColumns.filter(name => !archiveColumns.includes(name));
    if (missing.length > 0) throw new Error(`archive ledger schema is missing message-ledger columns: ${missing.join(', ')}`);
    const hasExpiry = sourceColumns.includes('expires_at');
    const ackClause = tableExists(db, 'main', 'msg_message_acks')
      ? 'OR EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id = m.id AND a.recipient = m.recipient)' : '';
    const expiryClause = hasExpiry ? 'AND (m.expires_at IS NULL OR m.expires_at > ?)' : '';
    // ① 자식 표 — 운영에 있는 표만 이행 대상이다. 보관에만 있는 표(역방향 스키마 차이 — 보관 전용
    // 표)는 이행 대상이 아니므로 건너뛴다: 존재하지 않는 운영 표를 조회하다 이행이 실패하지 않게.
    // 운영에 있는데 보관에 없으면 자식을 복사할 수 없으므로 지울 수도 없다 — 이행 전에 안전 중단한다(복사 없이 지우면 자식 유실).
    const childSpecs: ArchiveChildSpec[] = ARCHIVE_CHILDREN.flatMap(([table, column]) => {
      const inMain = tableExists(db, 'main', table), inArchive = tableExists(db, 'msg_archive', table);
      if (!inMain) return []; // 운영 표가 없으면 건너뛴다 — 보관 전용 표는 그대로 보존한다.
      if (!inArchive) throw new Error(`archive ledger schema is missing table ${table} — refusing to archive without it`);
      const cols = columnNames(db, 'main', table);
      const archiveCols = columnNames(db, 'msg_archive', table);
      const childMissing = cols.filter(name => !archiveCols.includes(name));
      if (childMissing.length > 0) throw new Error(`archive ledger schema is missing ${table} columns: ${childMissing.join(', ')}`);
      return [{ table, column, cols }];
    });
    // 복사 트랜잭션(쓰기는 보관 원장에만) — ④ 이 커밋이 삭제 단계보다 먼저 떨어진다.
    const skips = db.transaction((): { skippedMessages: number; skippedChildRows: number } => {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS archive_batch(id INTEGER PRIMARY KEY)');
      db.query('DELETE FROM archive_batch').run();
      const rows = db.query(`SELECT DISTINCT m.id AS id FROM msg_messages m
        WHERE m.recipient <> 'ALL' AND m.recipient NOT LIKE 'group:%'
          AND m.created_at <= ? ${expiryClause}
          AND (EXISTS (SELECT 1 FROM msg_cursors c WHERE c.recipient = m.recipient AND c.last_id >= m.id) ${ackClause})`)
        .all(...(hasExpiry ? [cutoffIso, nowIso] : [cutoffIso])) as Array<{ id: number }>;
      for (let index = 0; index < rows.length; index += 500) {
        const chunk = rows.slice(index, index + 500).map(row => row.id);
        // 행 생성자 형태여야 한다 — `VALUES (?,?)` 는 한 행에 2값(«N values for 1 columns»).
        db.query(`INSERT INTO archive_batch(id) VALUES ${chunk.map(() => '(?)').join(',')}`).run(...chunk);
      }
      // ② 충돌 무손실 격리(r5 — JUD-C #128689 ①·OP #128692): 보관에 같은 id 의 다른 내용이 있는
      // 메시지는 배치에서 제외한다 — 덮어쓰지 않고 운영 원장에 그대로 둬서 나머지 행의 이행이 계속된다.
      const differs = sourceColumns.map(name => `m.${quoteIdent(name)} IS NOT a.${quoteIdent(name)}`).join(' OR ');
      db.query(`DELETE FROM archive_batch WHERE id IN (
        SELECT m.id FROM msg_messages m JOIN msg_archive.msg_messages a ON a.id = m.id
        WHERE m.id IN (SELECT id FROM archive_batch) AND (${differs}))`).run();
      const skippedMessages = rows.length - (db.query('SELECT COUNT(*) AS count FROM archive_batch').get() as { count: number }).count;
      // ②③ 복사는 INSERT-only-missing — identical 행은 다시 쓰지 않고, 보관에만 있는 자식은 지우지 않는다(보존).
      db.query(`INSERT INTO msg_archive.msg_messages (${sourceColumns.map(quoteIdent).join(', ')})
        SELECT ${sourceColumns.map(name => `m.${quoteIdent(name)}`).join(', ')} FROM msg_messages m
        WHERE m.id IN (SELECT id FROM archive_batch)
          AND NOT EXISTS (SELECT 1 FROM msg_archive.msg_messages a WHERE a.id = m.id)`).run();
      let skippedChildRows = 0;
      for (const { table, column, cols } of childSpecs) {
        const identical = cols.map(name => `a.${quoteIdent(name)} IS t.${quoteIdent(name)}`).join(' AND ');
        // r5 무손실 격리: OR IGNORE 는 같은 키(고유 제약)가 이미 보관에 있는 행을 덮어쓰지 않고 건너뛴다
        // (OR REPLACE 와 달리 파괴가 없다). identical 행은 NOT EXISTS 가, 충돌 행은 OR IGNORE 가 제외한다.
        db.query(`INSERT OR IGNORE INTO msg_archive.${table} (${cols.map(quoteIdent).join(', ')})
          SELECT ${cols.map(name => `t.${quoteIdent(name)}`).join(', ')} FROM ${table} t
          WHERE t.${quoteIdent(column)} IN (SELECT id FROM archive_batch)
            AND NOT EXISTS (SELECT 1 FROM msg_archive.${table} a WHERE ${identical})`).run();
        // identical 보관 행이 여전히 없는(=충돌로 건너뛴) 자식 행 수 — 그 메시지는 삭제 단계 childGuard 가 운영에 남긴다.
        skippedChildRows += (db.query(`SELECT COUNT(*) AS count FROM ${table} t
          WHERE t.${quoteIdent(column)} IN (SELECT id FROM archive_batch)
            AND NOT EXISTS (SELECT 1 FROM msg_archive.${table} a WHERE ${identical})`).get() as { count: number }).count;
      }
      // 복사 검증 — 격리 제외 뒤 배치의 메시지는 전부 보관 원장에 들어갔다(새로 복사됐거나 identical 로 이미 있던 것).
      const batchCount = (db.query('SELECT COUNT(*) AS count FROM archive_batch').get() as { count: number }).count;
      const copied = (db.query('SELECT COUNT(*) AS count FROM msg_archive.msg_messages WHERE id IN (SELECT id FROM archive_batch)').get() as { count: number }).count;
      if (copied !== batchCount) throw new Error(`archive copy verification failed: copied ${copied} of ${batchCount} message(s)`);
      return { skippedMessages, skippedChildRows };
    }).immediate();
    // 시험·운영 후크 — 두 커밋 사이(트랜잭션 밖)에서만 실행된다.
    options.betweenTransactions?.();
    // 삭제+③커서 정리(쓰기는 운영 원장에만) — ④ 복사 커밋이 먼저 떨어진 뒤에야 실행된다.
    return db.transaction((): ArchiveDeliveredOutcome => {
      // ③ 삭제 전 재검증 — 운영 행이 복사본과 identical 하고 현재 자식 전부가 보관에 identical 로 있는
      // 메시지만 지운다: 복사 뒤 바뀐 행·새로 붙은 자식이 있으면 그 메시지는 남아 다음 이행이 다시 본다.
      db.exec('CREATE TEMP TABLE IF NOT EXISTS archive_confirm(id INTEGER PRIMARY KEY)');
      db.query('DELETE FROM archive_confirm').run();
      const sameMessage = sourceColumns.map(name => `m.${quoteIdent(name)} IS a.${quoteIdent(name)}`).join(' AND ');
      const childGuards = childSpecs.map(({ table, column, cols }) => {
        const sameChild = cols.map(name => `ac.${quoteIdent(name)} IS c.${quoteIdent(name)}`).join(' AND ');
        return ` AND NOT EXISTS (SELECT 1 FROM ${table} c WHERE c.${quoteIdent(column)} = m.id
          AND NOT EXISTS (SELECT 1 FROM msg_archive.${table} ac WHERE ${sameChild}))`;
      }).join('');
      db.query(`INSERT INTO archive_confirm(id)
        SELECT m.id FROM msg_messages m JOIN msg_archive.msg_messages a ON a.id = m.id
        WHERE m.id IN (SELECT id FROM archive_batch) AND ${sameMessage}${childGuards}`).run();
      for (const { table, column } of childSpecs) {
        db.query(`DELETE FROM ${table} WHERE ${quoteIdent(column)} IN (SELECT id FROM archive_confirm)`).run();
      }
      // r3-Terra-③ 이번 실행에서 실제로 이동한 좌석 — 삭제 전에 포착한다(아래 DELETE 로 msg_messages 행이
      // 사라지므로 나중은 늦는다). ③ 커서 정리는 이 좌석만 대상으로 한다(무관 좌석 커서 오염 방지).
      const movedRecipients = (db.query(`SELECT DISTINCT m.recipient AS recipient FROM msg_messages m
        WHERE m.id IN (SELECT id FROM archive_confirm)`).all() as Array<{ recipient: string }>).map(row => row.recipient);
      db.query('DELETE FROM msg_messages WHERE id IN (SELECT id FROM archive_confirm)').run();
      const confirmed = (db.query('SELECT COUNT(*) AS count FROM archive_confirm').get() as { count: number }).count;
      // ③ 커서 정리 — stale 커서는 첫 미읽음 직전까지만 전진한다(미읽음 없는 자리는 그대로).
      const cursors: Record<string, number> = {};
      // r3-Terra-③ 정리 대상은 이번 실행에서 실제로 이동한 좌석뿐이다(movedRecipients — 삭제 전에 포착) —
      // 이동 행이 없는 좌석의 커서를 무음으로 바꾸지 않는다(무관 좌석 오염 방지).
      const cursorRows = movedRecipients.length > 0
        ? db.query(`SELECT recipient, last_id FROM msg_cursors WHERE recipient IN (${movedRecipients.map(() => '?').join(',')})`)
            .all(...movedRecipients) as Array<{ recipient: string; last_id: number }>
        : [];
      for (const { recipient, last_id: lastId } of cursorRows) {
        if (recipient === 'ALL') continue; // ALL 은 topic — 커서 행이 올 수 없지만 방어적으로 건너뛴다.
        const arms = unreadArmsOn(db, recipient);
        const firstUnread = (db.query(`SELECT MIN(id) AS min_id FROM (${arms.sql})`).get(...arms.params) as { min_id: number | null }).min_id;
        const target = firstUnread === null ? lastId : Math.max(lastId, firstUnread - 1);
        if (target > lastId) db.query('UPDATE msg_cursors SET last_id = ? WHERE recipient = ?').run(target, recipient);
        cursors[recipient] = target;
      }
      return { archived: confirmed, cutoffIso, cursors, skippedConflicts: { messages: skips.skippedMessages, childRows: skips.skippedChildRows } };
    }).immediate();
  } finally {
    db.exec('DETACH DATABASE msg_archive');
  }
}