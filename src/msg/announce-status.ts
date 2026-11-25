// ── ANNOUNCE-UPTAKE status — 공지 하나의 자리별 흡수 단계(L0..L5) · 계층(OP · coordinators · hands)별 집계 ──
//
// 단계(올라갈수록 깊다 · 자리마다 도달한 가장 높은 단계):
//   L0 = 닿지 않음(받는 칸에 delivered 근거 없음)
//   L1 = 큐에 올라감(delivered/started 영수 · announce.delivered)
//   L2 = 턴이 소화함 / ack(seen 이상 영수 · ack 행 · 커서 통과 · announce.turn) — «단순 ack» 는 여기서 멈춘다
//   L3 = 적용 한 줄(apply 칸 · announce.applied)
//   L4 = 기억에 남김(memory_save · announce.memory)
//   L5 = 행동이 실제로 바뀜 — 자리별 행동 지표가 아직 없다: «needs behavior metric» 훅으로만 둔다(측정 0 · 추정 0)
// 근거는 원장 구조 칸뿐이다(영수 · ack · 커서 · msg_announce_events). 본문·답장 문장은 읽지 않는다.

import type { Database } from 'bun:sqlite';
import { ANNOUNCE_EVENTS_SCHEMA, ANNOUNCE_KIND, announceIdOf, announceScopeOf, type AnnounceScope } from './announce.js';

export type AnnounceLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export const ANNOUNCE_LEVELS: readonly AnnounceLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export type AnnounceTier = 'OP' | 'coordinators' | 'hands';
export const ANNOUNCE_TIERS: readonly AnnounceTier[] = ['OP', 'coordinators', 'hands'];
export const ANNOUNCE_L5_HOOK = 'needs behavior metric';

export interface AnnounceSeatStatus {
  seat: string;
  tier: AnnounceTier;
  level: AnnounceLevel;
  messageId: number;
  turnOutcome?: string;
  apply?: string;
  memoryFiles: string[];
}

export interface AnnounceStatus {
  announceId: string;
  scope: AnnounceScope;
  from: string;
  postedAt: string;
  seats: AnnounceSeatStatus[];
  /** tier → level → count (every tier and level present, zero included). */
  byTier: Record<AnnounceTier, Record<AnnounceLevel, number>>;
  totals: Record<AnnounceLevel, number>;
  l5: string;
}

export interface AnnounceStatusDeps {
  /** Seat → tier. Default caller: federation roles (OP · coordinator role · everything else = hands). */
  tierOf: (seat: string) => AnnounceTier;
  /** Seats an `ALL` announce reaches (the registered federation seats). */
  allSeats?: () => readonly string[];
}

interface AnnounceRow { id: number; sender: string; recipient: string; created_at: string; refs_json: string | null }

function refsOf(row: Pick<AnnounceRow, 'refs_json'>): string[] {
  try { const parsed = row.refs_json ? JSON.parse(row.refs_json) : []; return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}

const hasTable = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;

/** `latest` → the newest announce's id; an id → itself when the ledger has it; otherwise null. */
export function resolveAnnounceId(db: Database, ref: string): string | null {
  const rows = db.query(`SELECT id, refs_json FROM msg_messages WHERE kind = ? ORDER BY id DESC LIMIT 500`).all(ANNOUNCE_KIND) as Array<Pick<AnnounceRow, 'id' | 'refs_json'>>;
  for (const row of rows) {
    const id = announceIdOf(refsOf(row));
    if (id !== null && (ref === 'latest' || id === ref)) return id;
  }
  return null;
}

function rank(level: AnnounceLevel): number { return ANNOUNCE_LEVELS.indexOf(level); }

export function announceStatus(db: Database, announceId: string, deps: AnnounceStatusDeps, options: { scope?: AnnounceScope } = {}): AnnounceStatus | null {
  const needle = `%${JSON.stringify(`announce:${announceId}`)}%`;
  const rows = (db.query(`SELECT id, sender, recipient, created_at, refs_json FROM msg_messages WHERE kind = ? AND refs_json LIKE ? ORDER BY id`)
    .all(ANNOUNCE_KIND, needle) as AnnounceRow[]).filter(row => announceIdOf(refsOf(row)) === announceId);
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const postedScope = announceScopeOf(refsOf(first));
  const scope = options.scope ?? postedScope;

  // Recipients: one seat per row; ALL → the federation seats (sender excluded); group → its active members.
  const targets = new Map<string, number>();
  const groups = hasTable(db, 'msg_group_memberships');
  for (const row of rows) {
    const seats = row.recipient === 'ALL' ? (deps.allSeats?.() ?? []).filter(seat => seat !== row.sender)
      : row.recipient.startsWith('group:') ? (groups ? (db.query('SELECT DISTINCT seat FROM msg_group_memberships WHERE address = ? AND left_after_id IS NULL').all(row.recipient) as Array<{ seat: string }>).map(r => r.seat) : [])
        : [row.recipient];
    for (const seat of seats) if (!targets.has(seat)) targets.set(seat, row.id);
  }

  db.exec(ANNOUNCE_EVENTS_SCHEMA);
  const events = db.query('SELECT seat, event, detail, at FROM msg_announce_events WHERE announce_id = ? ORDER BY id').all(announceId) as Array<{ seat: string; event: string; detail: string; at: string }>;
  const receipts = hasTable(db, 'msg_receipts');
  const acks = hasTable(db, 'msg_message_acks');

  const seats: AnnounceSeatStatus[] = [];
  for (const [seat, messageId] of targets) {
    const tier = deps.tierOf(seat);
    if (scope === 'coordinators' && tier === 'hands') continue;
    const mine = events.filter(event => event.seat === seat);
    const states = receipts ? (db.query('SELECT state FROM msg_receipts WHERE message_id = ? AND recipient = ?').all(messageId, seat) as Array<{ state: string }>).map(r => r.state) : [];
    const acked = acks && db.query('SELECT 1 FROM msg_message_acks WHERE message_id = ? AND recipient = ?').get(messageId, seat) !== null;
    const cursor = (db.query('SELECT last_id FROM msg_cursors WHERE recipient = ?').get(seat) as { last_id: number } | null)?.last_id ?? 0;
    const turn = mine.find(event => event.event === 'turn');
    const applied = mine.filter(event => event.event === 'applied').at(-1);
    const memoryFiles = mine.filter(event => event.event === 'memory').map(event => event.detail);
    let level: AnnounceLevel = 'L0';
    if (mine.some(event => event.event === 'delivered') || states.some(state => state === 'delivered' || state === 'started')) level = 'L1';
    if (turn !== undefined || acked || cursor >= messageId || states.some(state => ['seen', 'accepted', 'rejected', 'done'].includes(state))) level = 'L2';
    if (applied !== undefined) level = 'L3';
    if (memoryFiles.length > 0) level = 'L4';
    seats.push({ seat, tier, level, messageId,
      ...(turn ? { turnOutcome: turn.detail } : acked ? { turnOutcome: 'ack' } : {}),
      ...(applied ? { apply: applied.detail } : {}), memoryFiles });
  }
  seats.sort((a, b) => ANNOUNCE_TIERS.indexOf(a.tier) - ANNOUNCE_TIERS.indexOf(b.tier) || rank(b.level) - rank(a.level) || a.seat.localeCompare(b.seat));

  const zero = (): Record<AnnounceLevel, number> => Object.fromEntries(ANNOUNCE_LEVELS.map(level => [level, 0])) as Record<AnnounceLevel, number>;
  const byTier = Object.fromEntries(ANNOUNCE_TIERS.map(tier => [tier, zero()])) as Record<AnnounceTier, Record<AnnounceLevel, number>>;
  const totals = zero();
  for (const seat of seats) { byTier[seat.tier][seat.level] += 1; totals[seat.level] += 1; }
  return { announceId, scope, from: first.sender, postedAt: first.created_at, seats, byTier, totals, l5: ANNOUNCE_L5_HOOK };
}

const LEVEL_LABEL: Record<AnnounceLevel, string> = {
  L0: 'not delivered', L1: 'queued', L2: 'turn/ack only', L3: 'applied', L4: 'applied+memory', L5: 'behavior changed',
};

/** Human view: header · per tier counts and seats · totals · the L5 hook line. */
export function formatAnnounceStatus(status: AnnounceStatus): string[] {
  const count = (counts: Record<AnnounceLevel, number>) => ANNOUNCE_LEVELS.map(level => `${level}=${counts[level]}`).join(' ');
  const lines = [`announce ${status.announceId} · scope ${status.scope} · from ${status.from} · posted ${status.postedAt} · ${status.seats.length} seats`];
  for (const tier of ANNOUNCE_TIERS) {
    const members = status.seats.filter(seat => seat.tier === tier);
    if (members.length === 0) continue;
    lines.push(`${tier} (${members.length}): ${count(status.byTier[tier])}`);
    for (const seat of members) {
      const extra = [seat.turnOutcome ? `turn=${seat.turnOutcome}` : '', seat.apply ? `적용: ${seat.apply}` : '',
        seat.memoryFiles.length > 0 ? `memory=${seat.memoryFiles.join(',')}` : ''].filter(Boolean).join(' · ');
      lines.push(`  ${seat.seat.padEnd(8)} ${seat.level} ${LEVEL_LABEL[seat.level]}${extra ? ` · ${extra}` : ''}`);
    }
  }
  lines.push(`total: ${count(status.totals)}`);
  lines.push(`L5: ${status.l5} (not measured)`);
  return lines;
}
