'use client';

import type { SeatSummary } from '@/lib/daemon-client';
import { cn } from '@/lib/utils';

interface Props {
  seats: SeatSummary[];
  selected: string | null;
  onSelect: (seat: string | null) => void;
  disabled?: boolean;
}

export function SeatPicker({ seats, selected, onSelect, disabled }: Props) {
  if (seats.length === 0) return null;
  return <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="요청할 자리">
    {seats.map((seat) => <button
      key={seat.id}
      type="button"
      disabled={disabled}
      aria-pressed={selected === seat.id}
      onClick={() => onSelect(selected === seat.id ? null : seat.id)}
      className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected === seat.id ? 'border-accent bg-accent/15 font-semibold text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
        disabled && 'opacity-60')}
    >{seat.title}</button>)}
  </div>;
}
