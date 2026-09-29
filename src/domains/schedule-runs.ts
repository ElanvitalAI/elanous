import type { Database } from 'bun:sqlite';

/** A fired execution belongs to the stable registry id, not to a derived (and possibly shared) name. */
export interface ScheduleRun {
  id: number;
  schedule_id: string;
  fired_at: string;
  status: string;
  exit: number | null;
  duration_ms: number | null;
  via: string;
  run_id: string | null;
  log_ref: string | null;
}

export interface ScheduleRunResult {
  at?: string;
  status: string;
  exit?: number | null;
  durationMs?: number | null;
  via?: string;
  runId?: string | null;
  logRef?: string | null;
}

/** Called by the schedules.db opener; also usable with an isolated in-memory Database. */
export function ensureScheduleRunsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    status TEXT NOT NULL,
    exit INTEGER,
    duration_ms INTEGER,
    via TEXT NOT NULL,
    run_id TEXT,
    log_ref TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_fired
    ON schedule_runs(schedule_id, fired_at DESC, id DESC)`);
}

function utcScheduleTime(value: string, field: 'at' | 'before' | 'cursor.firedAt'): string {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) throw new RangeError(`${field} must be an ISO timestamp`);
  const [, y, mo, d, h, mi, s, , tzH, tzM] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!
    || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59
    || (tzH !== undefined && (Number(tzH) > 23 || Number(tzM) > 59))
    || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${field} must be an ISO timestamp`);
  }
  // 기록 시각(at)은 ms 로 맞춰 저장하고, 조회 경계(before·cursor)는 원문 그대로 SQL julianday 에 넘긴다(ms 아래 자릿수 보존).
  return field === 'at' ? new Date(value).toISOString() : value;
}

/** Append a fire; retain the newest 500 per schedule (including simultaneous fires). */
export function recordScheduleRun(db: Database, scheduleId: string, result: ScheduleRunResult): void {
  const firedAt = utcScheduleTime(result.at ?? new Date().toISOString(), 'at');
  db.transaction(() => {
    db.run(`INSERT INTO schedule_runs
      (schedule_id, fired_at, status, exit, duration_ms, via, run_id, log_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      scheduleId, firedAt, result.status,
      result.exit ?? null, result.durationMs ?? null, result.via ?? 'unknown',
      result.runId ?? null, result.logRef ?? null,
    ]);
    db.run(`DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
      SELECT id FROM schedule_runs WHERE schedule_id = ?
      ORDER BY fired_at DESC, id DESC LIMIT 500
    )`, [scheduleId, scheduleId]);
  })();
}

/** Exclusive ISO before filter, or a (firedAt, id) cursor for lossless equal-time paging. */
/** ISO 시각 → 1970 이후 나노초(BigInt) — 오프셋·소수 9자리까지 보존(SQLite julianday 는 ms 아래를 버린다). 못 읽으면 null. */
function instantNs(value: string): bigint | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac = '', sign, tzH = '0', tzM = '0'] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  if (!Number.isFinite(ms)) return null;
  const offsetMin = sign ? (sign === '-' ? -1 : 1) * (Number(tzH) * 60 + Number(tzM)) : 0;
  return (BigInt(ms) - BigInt(offsetMin) * 60_000n) * 1_000_000n + BigInt(frac.padEnd(9, '0'));
}

export function listScheduleRuns(
  db: Database, scheduleId: string,
  opts: { limit?: number; before?: string; cursor?: { firedAt: string; id: number } } = {},
): ScheduleRun[] {
  const limit = opts.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be an integer from 1 to 500');
  const before = opts.before === undefined ? undefined : instantNs(utcScheduleTime(opts.before, 'before'));
  const cursor = opts.cursor === undefined ? undefined : {
    ns: instantNs(utcScheduleTime(opts.cursor.firedAt, 'cursor.firedAt')), id: opts.cursor.id,
  };
  if (cursor && (!Number.isSafeInteger(cursor.id) || cursor.id < 1)) throw new RangeError('cursor.id must be a positive safe integer');
  // 표가 아직 없으면(이력 도입 전 DB · 읽기만 하는 경로) 빈 이력이다.
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schedule_runs'`).get()) return [];
  // 스케줄마다 최근 500줄만 남기므로 그 스케줄 행을 모두 읽어 «순간»으로 거르고 정렬한다 — 오프셋·소수 자릿수가 다른 옛 기록이 섞여도 경계가 맞다.
  const rows = db.prepare(`SELECT id, schedule_id, fired_at, status, exit, duration_ms, via, run_id, log_ref
    FROM schedule_runs WHERE schedule_id = ?`).all(scheduleId) as ScheduleRun[];
  const withNs = rows.map((row) => ({ row, ns: instantNs(String(row.fired_at)) }))
    .filter((r): r is { row: ScheduleRun; ns: bigint } => r.ns !== null)
    .filter(({ ns }) => before === undefined || before === null || ns < before)
    .filter(({ row, ns }) => !cursor || cursor.ns === null || ns < cursor.ns || (ns === cursor.ns && Number(row.id) < cursor.id));
  withNs.sort((a, b) => (a.ns === b.ns ? (Number(b.row.id) > Number(a.row.id) ? 1 : -1) : (b.ns > a.ns ? 1 : -1)));
  return withNs.slice(0, limit).map(({ row }) => row);
}

/** Prefer the actual task/subcommand over its shell, Bun, and elanous launchers. */
export function deriveScheduleName(command: string): string {
  let cmd = command.trim();
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
  cmd = cmd.replace(/^(?:(?:env\s+)?[A-Za-z_][A-Za-z_0-9]*=\S+\s+)+/, '');
  cmd = cmd.replace(/^(?:\S*\/)?(?:bun(?:\s+run)?|node)\s+/, '');
  cmd = cmd.replace(/^(?:\S*\/)?(?:scripts\/)?cron-run\.ts\s+(?:(?:--schedule-id\s+\S+|--shell\s+\S+)\s+)*/, '');
  cmd = cmd.replace(/^(?:\S*\/)?(?:bun(?:\s+run)?|node)\s+/, '');
  cmd = cmd.replace(/^(?:\S*\/)?(?:bash|zsh|sh)\s+/, '');
  cmd = cmd.replace(/^(?:\S*\/)?bin\/elanous\.mjs\s+|^elanous\s+/, '');
  const tokens = cmd.split(/\s+/);
  const head = tokens[0] ?? '';
  if (/\.(?:ts|js|mjs|sh)$/.test(head)) {
    const script = head.split('/').pop()!.replace(/\.(?:ts|js|mjs|sh)$/, '');
    const arg = tokens[1];
    return script === 'bot-routine' && arg && !arg.startsWith('-') ? `${script} ${arg}` : script;
  }
  return tokens.slice(0, head === 'harness' ? 3 : 2).filter(Boolean).join(' ') || command.trim();
}
