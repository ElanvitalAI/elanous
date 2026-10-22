import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { opSeatStatePath, readTrafficSignal } from '../seat-loop/traffic-signal.js';

const SEATS = ['OP', 'MK', 'TC', 'UX'] as const;
type Seat = typeof SEATS[number];
export type HygieneCell = { id: string; owner?: string | null; status: string; title?: string };
export type HygieneNotice = { to: Seat; key: string; body: string };
export type HygieneDeps = {
  root: string;
  now: Date;
  cells: readonly HygieneCell[];
  trafficPath?: string;
  metaPath?: string;
  dispatcherDir?: string;
};

function readOptional(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** A following budget line closes the preceding cycle; a trailing cycle may still launch. */
export function starvingCycles(log: string): { reasons: Record<string, number> } | null {
  const cycles: Array<{ budget: number; launches: number; noCapacity: number; reasons: Record<string, number> }> = [];
  for (const line of log.split(/\r?\n/)) {
    const budget = /역압 예산\s*(\d+)/.exec(line);
    if (budget) cycles.push({ budget: Number(budget[1]), launches: 0, noCapacity: 0, reasons: {} });
    else if (cycles.length) {
      const current = cycles[cycles.length - 1]!;
      if (/발사\s+\S/.test(line)) current.launches++;
      if (line.includes('여유 없음')) current.noCapacity++;
      const skip = /건너뜀\s*(.*)/.exec(line);
      if (skip) {
        const reason = skip[1]?.trim() || '사유 미기록';
        current.reasons[reason] = (current.reasons[reason] ?? 0) + 1;
      }
    }
  }
  const last = cycles.slice(0, -1).slice(-3);
  if (last.length !== 3 || last.some(cycle => cycle.budget <= 0 || cycle.launches !== 0 || cycle.noCapacity !== 0)) return null;
  const reasons: Record<string, number> = {};
  for (const cycle of last) for (const [reason, count] of Object.entries(cycle.reasons)) reasons[reason] = (reasons[reason] ?? 0) + count;
  return { reasons };
}

type HoldMeta = { id?: unknown; op?: unknown; reason?: unknown; until?: unknown; kind?: unknown; confirmedAt?: unknown; at?: unknown; title?: unknown };
function holdMetadata(path: string): Map<string, HoldMeta> {
  const latest = new Map<string, HoldMeta>();
  for (const line of (readOptional(path) ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as HoldMeta;
      if (typeof row.id === 'string') latest.set(row.id, row);
    } catch { /* An invalid row cannot supply a reason for any hold. */ }
  }
  return latest;
}

function untilTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  const time = compact ? Date.parse(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:00+09:00`) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function confirmedTime(value: unknown): number | null {
  return typeof value === 'string' && /^\d{12}$/.test(value) ? untilTime(value) : null;
}

export function inspectHoldHygiene(deps: HygieneDeps): HygieneNotice[] {
  const notices: HygieneNotice[] = [];
  const dir = deps.dispatcherDir ?? opSeatStatePath('feeder');
  for (const seat of SEATS) {
    const log = readOptional(join(dir, `dispatcher-${seat}.out`));
    const finding = log === null ? null : starvingCycles(log);
    if (!finding) continue;
    const detail = Object.entries(finding.reasons).map(([reason, count]) => `${reason} ×${count}`).join(' · ') || '건너뜀 사유 미기록';
    const body = `${seat} 디스패처 굶주림: 최근 3주기 예산>0 · 발사 0 · 여유 없음 0. 건너뜀: ${detail}. 후보 칸·잠금·경로를 확인해 주세요.`;
    for (const to of new Set<Seat>(['OP', seat])) notices.push({ to, key: `starve:${seat}:${to}`, body });
  }
  const signal = readTrafficSignal(deps.trafficPath);
  if (!signal || 'unreadable' in signal) return notices;
  const held = new Set(signal.hold ?? []);
  const metadata = holdMetadata(deps.metaPath ?? opSeatStatePath(join('tools', 'hold-meta.jsonl')));
  const seen = new Set<string>();
  for (const cell of deps.cells) {
    if (!held.has(cell.id) || cell.status !== 'yellow' || seen.has(cell.id)) continue;
    seen.add(cell.id);
    const owner = cell.owner;
    if (!SEATS.some(seat => seat === owner)) continue;
    const meta = metadata.get(cell.id);
    const reason = meta?.op === 'add' && typeof meta.reason === 'string' ? meta.reason.trim() : '';
    let attention = '';
    if (meta?.kind === '손작업') {
      const confirmed = confirmedTime(meta.confirmedAt ?? meta.at);
      if (confirmed === null) attention = '재확인 시각 없음';
      else if (deps.now.getTime() - confirmed >= 24 * 60 * 60_000) attention = '24h 재확인 지연';
    } else if (meta?.kind === '재발사금지') {
      if (typeof meta.title !== 'string' || !meta.title || typeof cell.title !== 'string' || !cell.title) attention = '제목 기준 확인 불가';
      else if (cell.title !== meta.title) attention = '칸 제목 변경';
    } else if (meta?.kind === '선행대기' || meta?.kind === undefined || meta?.kind === '') {
      const expiry = untilTime(meta?.until);
      if (expiry === null) attention = 'until 확인 불가';
      else if (expiry <= deps.now.getTime()) attention = `until ${String(meta?.until)} 지남`;
    } else attention = 'hold 종류 확인 불가';
    if (reason && !attention) continue;
    const guidance = meta?.kind === '손작업' ? '재확인 시각·사유를 판단해 OP에 알려 주세요.'
      : meta?.kind === '재발사금지' ? '칸 제목과 기준 제목·사유를 대조해 OP에 알려 주세요.'
        : '풀기/유지(사유·until)를 판단해 OP에 알려 주세요.';
    notices.push({ to: owner as Seat, key: `hold:${cell.id}:${owner}`,
      body: `노랑 칸 ${cell.id} traffic hold: ${!reason ? '사유 없음' : `사유 ${reason}`} ${attention ? `· ${attention}` : ''}. ${guidance} 자동 해제하지 않습니다.` });
  }
  return notices;
}

/** One durable msg per recipient/key per 30 minutes, even when two tick processes race. */
export function runHoldHygiene(deps: HygieneDeps): HygieneNotice[] {
  const notices = inspectHoldHygiene(deps);
  if (!notices.length) return [];
  const store = openMsgStore(join(deps.root, 'msg', 'messages.db'));
  const sent: HygieneNotice[] = [];
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS hold_hygiene_notices (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)`);
    for (const notice of notices) {
      store.db.transaction(() => {
        const prior = store.db.query('SELECT sent_at FROM hold_hygiene_notices WHERE key = ?').get(notice.key) as { sent_at: number } | null;
        if (prior && deps.now.getTime() - prior.sent_at < 30 * 60_000) return;
        store.append({ from: 'ORCHESTRATOR', to: notice.to, body: notice.body, kind: 'hold-hygiene' });
        store.db.query('INSERT INTO hold_hygiene_notices(key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at')
          .run(notice.key, deps.now.getTime());
        sent.push(notice);
      }).immediate();
    }
  } finally { store.close(); }
  return sent;
}
