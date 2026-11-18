import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SeatCloseShare {
  readonly kind: 'claim' | 'promise' | 'pull-request' | 'wakeup';
  readonly id: string;
  readonly detail: string;
}

export interface SeatCloseRequest {
  readonly seat: string;
  readonly handoffTo?: string;
  readonly force?: boolean;
  readonly forceReason?: string;
  readonly now?: string;
}

export interface SeatCloseDeps {
  readonly home: string;
  readonly knownSeats: readonly string[];
  readonly shares: readonly SeatCloseShare[];
  readonly appendEvent?: (line: string) => void;
}

export type SeatCloseResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly event: string }
  | { readonly ok: false; readonly reason: string };

const SEAT_ID = /^[A-Z][A-Z0-9-]{0,15}$/;

function normalizeSeat(raw: string | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/** 닫기 전 목록. 받는 자리가 등록부에 없으면 거부. --force 는 사유가 있을 때만 사건으로 남긴다. */
export function planSeatClose(request: SeatCloseRequest, deps: SeatCloseDeps): SeatCloseResult {
  const seat = normalizeSeat(request.seat);
  const handoff = normalizeSeat(request.handoffTo);
  if (!SEAT_ID.test(seat)) return { ok: false, reason: `seat close refused: unknown seat ${request.seat}` };
  if (!request.force && !handoff) return { ok: false, reason: 'seat close refused: handoff seat required' };
  if (!request.force && handoff === seat) return { ok: false, reason: `seat close refused: handoff seat ${handoff} is the closing seat` };
  if (!request.force && !deps.knownSeats.map(normalizeSeat).includes(handoff)) {
    return { ok: false, reason: `seat close refused: handoff seat ${handoff || '(empty)'} is not in the seat registry` };
  }
  if (request.force) {
    const reason = (request.forceReason ?? '').trim();
    if (!reason) return { ok: false, reason: 'seat close refused: --force requires a reason' };
    if (handoff && !deps.knownSeats.map(normalizeSeat).includes(handoff)) {
      return { ok: false, reason: `seat close refused: handoff seat ${handoff} is not in the seat registry` };
    }
  }
  const lines = deps.shares.length
    ? deps.shares.map(share => `${share.kind}\t${share.id}\t${share.detail}`)
    : ['(none)'];
  const at = request.now ?? new Date().toISOString();
  const event = [
    'seat-close',
    `at=${at}`,
    `seat=${seat}`,
    `handoff=${handoff || '-'}`,
    `force=${request.force ? 'yes' : 'no'}`,
    `reason=${request.force ? (request.forceReason ?? '').trim() : '-'}`,
    `shares=${deps.shares.length}`,
  ].join(' ');
  return { ok: true, lines, event };
}

export function recordSeatClose(result: Extract<SeatCloseResult, { ok: true }>, deps: SeatCloseDeps): void {
  if (deps.appendEvent) {
    deps.appendEvent(result.event);
    return;
  }
  const dir = join(deps.home, 'elanous-hq', 'seat-state', 'events');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'seat-close.jsonl'), `${result.event}\n`);
}

/** 자리 = coord-tracks ⊕ ROLE.md 가 있는 seat-state/<자리>/. 폴더만 있는 비자리는 제외. */
export function readKnownSeatIds(home: string, repoRoot: string): string[] {
  const ids = new Set(readSeatRegistryIds(repoRoot));
  const root = join(home, 'elanous-hq', 'seat-state');
  if (!existsSync(root)) return [...ids];
  for (const name of readdirSync(root)) {
    const seat = normalizeSeat(name);
    if (!SEAT_ID.test(seat)) continue;
    try {
      const dir = join(root, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'ROLE.md'))) ids.add(seat);
    } catch { /* 없는 항목은 자리가 아니다 */ }
  }
  return [...ids];
}

export function readSeatRegistryIds(repoRoot: string): string[] {
  const path = join(repoRoot, 'scripts', 'coord-tracks.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { tracks?: unknown };
  if (!Array.isArray(raw.tracks)) return [];
  return raw.tracks.flatMap(track => {
    if (!track || typeof track !== 'object') return [];
    const id = (track as { id?: unknown }).id;
    return typeof id === 'string' && id.trim() ? [id.trim().toUpperCase()] : [];
  });
}
