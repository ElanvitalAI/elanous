'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { harnessAskSettled, harnessPhaseLabel } from '@/lib/chat-harness-ask';
import { getGraphStatus, type GraphStatus } from '@/lib/intake-front-door-api';

const POLL_MS = 5_000;
const MAX_MS = 60 * 60 * 1_000;
const NOT_FOUND = '접수 기록을 못 찾았습니다(데몬 재시작이면 사라질 수 있음)';

export function HarnessAskCard({ acceptanceId }: { acceptanceId: string }) {
  const { client } = useDaemon();
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setNotice(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      if (!active || Date.now() - startedAt >= MAX_MS) return;
      try {
        const next = await getGraphStatus(client, acceptanceId);
        if (!active) return;
        setStatus(next);
        setNotice(null);
        if (harnessAskSettled(next.phase)) return;
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'harness ask not found' || /^HTTP 404\b/.test(message)) {
          setNotice(NOT_FOUND);
          return;
        }
        setNotice(`상태 확인 실패 — ${message.split(/\r?\n/, 1)[0]!.slice(0, 200)}`);
      }
      if (active && Date.now() - startedAt < MAX_MS) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, acceptanceId]);

  const elapsed = typeof status?.elapsedSeconds === 'number' && Number.isFinite(status.elapsedSeconds)
    ? Math.max(0, Math.floor(status.elapsedSeconds)) : 0;
  const goalFile = typeof status?.goalFile === 'string' ? status.goalFile.split(/[\\/]/).pop() : undefined;
  return (
    <section aria-label="하니스 진행" className="rounded-md border border-border bg-card px-3 py-2 text-xs not-italic text-card-foreground">
      <span className="font-medium">{harnessPhaseLabel(status?.phase ?? 'accepted')}</span>
      {status?.runId && <span className="ml-2 font-mono">런 {status.runId.slice(0, 8)}</span>}
      {goalFile && <span className="ml-2 break-all">{goalFile}</span>}
      <span className="ml-2 text-muted-foreground">경과 {elapsed >= 60 ? `${Math.floor(elapsed / 60)}분` : `${elapsed}초`}</span>
      {notice && <p role="status" className="mt-1 text-destructive">{notice}</p>}
    </section>
  );
}
