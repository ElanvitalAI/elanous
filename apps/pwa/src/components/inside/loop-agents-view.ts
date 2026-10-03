import type { OpsSeats } from '@/lib/ops-api';
import type { HarnessRunsResponse } from '@/nexus/client';
import { toPublicText } from './public-text';

export type LoopSeat = 'COO' | 'CMO' | 'CTO' | 'CXO';
export interface LoopAgentsView {
  seats: Array<{ seat: LoopSeat; now: string; landedToday: number | '못 읽음'; blocked: number | '못 읽음'; decisionsWaiting: number | '못 읽음' }>;
  runs: Array<{ id6: string; stage: string; elapsedSec: number | '못 읽음' }>;
}

const SEATS = [
  { id: 'OP', seat: 'COO' }, { id: 'MK', seat: 'CMO' },
  { id: 'TC', seat: 'CTO' }, { id: 'UX', seat: 'CXO' },
] as const;

function publicLine(value: string): string {
  return toPublicText(value.replace(/\s+/g, ' ')).trim();
}

/** Show a seat's work, not the channel post's header, recipients or kind. */
export function seatNowLine(raw: string): string {
  const lines = raw.split('\n');
  const clean = (line: string, header: boolean): string => {
    let text = line.trim();
    if (header) {
      text = text.replace(/^\*\*\[[^\]]+\]\*\*\s*/, '');
      text = text.replace(/^(?:📌\S*\s*)?\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*KST\s*/, '');
    }
    text = text.replace(/^→\s*(?:[A-Z]{1,4}|전원|전체)(?=\s|·|$)(?:\s*·\s*(?:[A-Z]{1,4}|전원|전체)(?=\s|·|$))*\s*(?:·)?\s*/u, '');
    // Only the dash right after the recipient list is header; a dash later in the body is content (10-03: «… 4 — HARV2» lost its head).
    text = text.replace(/^—\s*/, '');
    text = text.replace(/^[-*]\s+/, '').replace(/\*\*|`|__/g, '').replace(/^#+\s*/, '').trim();
    text = text.replace(/^(?:보고|요청|정정|결정|사고|안내)\s*·\s*/, '');
    text = text.replace(/^(?:\p{Extended_Pictographic}\uFE0F?)+\s*/u, '');
    text = text.replace(/^(?:보고|요청|정정|결정|사고|안내)\s*·\s*/, '');
    return publicLine(text);
  };
  const first = clean(lines[0] ?? '', true);
  if (first) return first;
  const next = lines.slice(1).find((line) => line.trim());
  return next ? clean(next, false) : '';
}

function publicId6(value: string): string {
  const id = value.replace(/^run-/i, '');
  if (!/^[a-z0-9]{6}/i.test(id)) return '못 읽음';
  return publicLine(id.slice(0, 6)) || '못 읽음';
}

export function loopAgentsView(seats: OpsSeats | null, runs: HarnessRunsResponse | null, now = Date.now()): LoopAgentsView {
  return {
    seats: SEATS.map(({ id, seat }) => {
      const row = seats?.seats.find((entry) => entry.seat === id);
      return {
        seat,
        now: row?.now ? Array.from(seatNowLine(row.now.text)).slice(0, 40).join('') || '못 읽음' : '못 읽음',
        landedToday: row?.landed == null ? '못 읽음' : row.landed.length,
        blocked: row?.blocked == null ? '못 읽음' : row.blocked.length,
        decisionsWaiting: row?.pendingDecisions ?? '못 읽음',
      };
    }),
    runs: (runs?.entries ?? [])
      .filter((entry) => entry.status === 'running')
      .sort((a, b) => (Date.parse(b.lastActivityTimestamp ?? '') || 0) - (Date.parse(a.lastActivityTimestamp ?? '') || 0))
      .slice(0, 6)
      .map((entry) => {
        const lastActivity = Date.parse(entry.lastActivityTimestamp ?? '');
        return {
          id6: publicId6(entry.runId),
          stage: publicLine(entry.lastPhase || entry.status) || '못 읽음',
          elapsedSec: Number.isFinite(lastActivity) ? Math.max(0, Math.floor((now - lastActivity) / 1000)) : '못 읽음',
        };
      }),
  };
}
