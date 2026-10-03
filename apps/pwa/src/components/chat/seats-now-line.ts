import type { OpsSeats } from '@/lib/ops-api';
import { seatNowLine, type LoopSeat } from '@/components/inside/loop-agents-view';

const ORDER = [
  { id: 'OP', seat: 'COO' }, { id: 'MK', seat: 'CMO' },
  { id: 'TC', seat: 'CTO' }, { id: 'UX', seat: 'CXO' },
] as const;

export function seatsNowLine(seats: OpsSeats | null, now: number): Array<{ seat: LoopSeat; text: string; ago: string }> {
  if (!seats) return [];
  return ORDER.flatMap(({ id, seat }) => {
    const current = seats.seats.find((row) => row.seat === id)?.now;
    if (!current) return [];
    const text = Array.from(seatNowLine(current.text)).slice(0, 24).join('');
    if (!text) return [];
    const minutes = Math.max(0, Math.floor((now - Date.parse(current.at)) / 60_000));
    const ago = minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : '하루 넘음';
    return [{ seat, text, ago }];
  });
}
