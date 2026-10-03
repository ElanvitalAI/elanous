'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getSeats } from '@/lib/ops-api';
import { seatsNowLine } from './seats-now-line';

export function SeatsNowStrip() {
  const { client } = useDaemon();
  const [lines, setLines] = useState<ReturnType<typeof seatsNowLine>>([]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (!active || busy || document.hidden) return;
      busy = true;
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
      const result = await getSeats(client, date);
      busy = false;
      if (active) setLines(seatsNowLine(result.kind === 'ready' ? result.data : null, Date.now()));
    };
    setLines([]);
    void refresh();
    const interval = globalThis.setInterval(() => { void refresh(); }, 60_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client]);

  if (lines.length === 0) return null;
  const fullLine = lines.map(({ seat, text, ago }) => `${seat} ${text} · ${ago}`).join(' | ');
  return <div role="status" aria-label="지금 자리들이 하는 일" title={fullLine} className="h-8 min-h-8 min-w-0 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-border bg-background px-3 text-xs leading-8 text-muted-foreground">
    {lines.map(({ seat, text, ago }, index) => <span key={seat}>
      {index > 0 && ' | '}{seat} {text} · {ago}
    </span>)}
  </div>;
}
