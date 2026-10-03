'use client';

// R5.7 — `/sessions` route panel.
//
// Glues `/v1/sessions/active` polling → CardSweepView. Each swipe
// dispatches via POST /v1/sessions/:id/decision (R5.4).
//
// Cross-ref:
//   src/nexus/api/sessions-active.ts (GET endpoint)
//   src/nexus/api/sessions-decision.ts (POST endpoint)
//   apps/pwa/src/components/card-swipe/CardSweepView.tsx
//   내부 문서 `ROADMAP-pwa-pre-ios-gap-2026-05-09` §R5

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { debugLog } from '@/lib/debug';
import { userIntentLogger } from '@/lib/user-intent-logger';
import { CardSweepView, type CardDecision } from './CardSweepView';
import type { CardSessionData } from './SessionCard';

interface ActiveSnapshotResponse {
  ok: true;
  sessions: CardSessionData[];
  total: number;
  ts: string;
}

const POLL_MS = 15_000;

const DECISION_LABEL: Record<CardDecision, string> = {
  reject: '거절',
  approve: '승인',
  pause: '잠시 멈춤',
  expand: '펼치기',
};

export function SessionsDeckPanel() {
  const { config } = useDaemon();
  const [sessions, setSessions] = useState<CardSessionData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeStale, setIncludeStale] = useState(false);

  const fetchActive = useCallback(async (): Promise<void> => {
    if (!config.baseUrl) return;
    setLoading(true);
    try {
      const url = `${config.baseUrl}/v1/sessions/active${includeStale ? '?stale=1' : ''}`;
      const res = await fetch(url, {
        ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as ActiveSnapshotResponse;
      setSessions(body.sessions);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [config.baseUrl, config.token, includeStale]);

  useEffect(() => {
    void fetchActive();
    const id = setInterval(() => { void fetchActive(); }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchActive]);

  const onDecision = useCallback(
    (session: CardSessionData, decision: CardDecision): void => {
      const label = DECISION_LABEL[decision];
      debugLog('sessions.deck.decision', {
        sessionId: session.id, decision,
      });
      // β (BACKLOG-pwa-mobile-readiness §6.1 #2 metric · 2026-05-12) — emit
      // gesture event before dispatching server decision. decision string
      // (reject/approve/pause/expand) becomes the kind sub. session id =
      // target so dashboards group by session for the "card 결정 시간"
      // metric (decided/created interval).
      void userIntentLogger.emit({
        surface: 'pwa',
        intent: {
          layer: 'gesture',
          kind: `pwa.gesture.card_swipe_${decision}`,
          target: { kind: 'session', id: session.id },
          value: { decision, label },
        },
        context: { active_showroom_session_id: session.id },
      });
      toast.success(`${label} → ${session.id}`);
      // Fire-and-forget — server records + fans the event bus.
      // Failure is inert (the user already saw the toast); the
      // decision is captured locally via debugLog.
      if (config.baseUrl) {
        void fetch(
          `${config.baseUrl}/v1/sessions/${encodeURIComponent(session.id)}/decision`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
            },
            body: JSON.stringify({ decision }),
          },
        ).catch(() => { /* swallow */ });
      }
    },
    [config.baseUrl, config.token],
  );

  return (
    <section
      data-testid="sessions-deck-panel"
      className="mx-auto flex max-w-md flex-col gap-4 p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="font-heading text-lg font-medium">대화 카드 데크</h1>
          <p className="text-xs text-muted-foreground">
            ←/→/↑/↓ 스와이프로 거절·승인·잠시 멈춤·펼치기 결정.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="대화 새로고침"
          onClick={() => void fetchActive()}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </Button>
      </header>

      {error && (
        <p data-testid="sessions-deck-error" className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          fetch 실패: {error}
        </p>
      )}

      <CardSweepView sessions={sessions} onDecision={onDecision} />

      <footer className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{sessions.length} 대화 · {loading ? 'loading…' : 'live'}</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeStale}
            onChange={(e) => setIncludeStale(e.target.checked)}
            aria-label="오래된 대화 포함"
          />
          24시간 이전도 표시
        </label>
      </footer>
    </section>
  );
}
