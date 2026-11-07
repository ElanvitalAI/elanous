'use client';

import { useEffect, useState } from 'react';
import type { NexusClient } from '@/nexus/client';

export interface AppSimLiveEvent {
  kind: string;
  ts: number;
  appId?: string;
  runId?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AppSimReceipt {
  id: string;
  createdAt: string | number;
  outcome: 'passed' | 'failed' | 'blocked' | 'unknown';
  summary?: string;
  runId?: string;
}

export interface AppSimLiveViewProps {
  appId: string;
  appName: string;
  client: Pick<NexusClient, 'subscribeEvents'>;
  receipts: readonly AppSimReceipt[];
  onBack?: () => void;
  initialEvents?: readonly AppSimLiveEvent[];
}

const MAX_EVENTS = 100;
const APP_EVENT_PREFIX = 'app.sim.';
const EMPTY_EVENTS: readonly AppSimLiveEvent[] = [];

function eventBelongsToApp(event: AppSimLiveEvent, appId: string): boolean {
  return event.appId === appId || event.data?.appId === appId;
}

function formatTime(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function eventLabel(event: AppSimLiveEvent): string {
  const details = event.data;
  const step = typeof details?.step === 'string' ? ` · ${details.step}` : '';
  const message = typeof details?.message === 'string' ? ` — ${details.message}` : '';
  return `${event.kind}${step}${message}`;
}

/** App-scoped simulation monitor. The app lifecycle owner supplies its persisted receipts. */
export function AppSimLiveView({ appId, appName, client, receipts, onBack, initialEvents = EMPTY_EVENTS }: AppSimLiveViewProps) {
  const initialAppEvents = initialEvents.filter((event) => eventBelongsToApp(event, appId)).slice(-MAX_EVENTS);
  const [eventState, setEventState] = useState(() => ({ appId, events: initialAppEvents }));
  // A render for a newly selected app must not briefly expose the previous app's stream.
  const events = eventState.appId === appId ? eventState.events : initialAppEvents;

  useEffect(() => {
    setEventState({ appId, events: initialEvents.filter((event) => eventBelongsToApp(event, appId)).slice(-MAX_EVENTS) });
    return client.subscribeEvents({
      topics: [APP_EVENT_PREFIX],
      onEvent: (event) => {
        const appEvent = event as AppSimLiveEvent;
        if (!eventBelongsToApp(appEvent, appId)) return;
        setEventState((current) => ({
          appId,
          events: [...(current.appId === appId ? current.events : []), appEvent].slice(-MAX_EVENTS),
        }));
      },
    });
  }, [appId, client, initialEvents]);

  const recentReceipts = [...receipts].sort((a, b) => {
    const aTime = typeof a.createdAt === 'number' ? a.createdAt : Date.parse(a.createdAt);
    const bTime = typeof b.createdAt === 'number' ? b.createdAt : Date.parse(b.createdAt);
    return bTime - aTime;
  }).slice(0, 5);

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6" data-testid="app-sim-live-view" data-app-id={appId}>
      <header className="flex items-center gap-3">
        {onBack && <button type="button" onClick={onBack} aria-label="앱 목록으로">←</button>}
        <div>
          <p className="text-sm text-muted-foreground">🧪 시뮬레이션</p>
          <h1 className="text-2xl font-semibold">{appName}</h1>
        </div>
        <span className="ml-auto rounded-full border px-3 py-1 text-sm" role="status">실시간 관측</span>
      </header>

      <section aria-labelledby="app-sim-events-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="app-sim-events-heading" className="text-lg font-medium">사건 흐름</h2>
          <span className="text-sm text-muted-foreground">최근 {events.length}건</span>
        </div>
        {events.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">시뮬레이션 사건을 기다리고 있습니다.</p>
        ) : (
          <ol className="space-y-2" aria-live="polite">
            {[...events].reverse().map((event, index) => (
              <li key={`${event.ts}-${event.kind}-${index}`} className="flex gap-3 rounded-lg border p-3">
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(event.ts).toISOString()}>{formatTime(event.ts)}</time>
                <span className="break-all text-sm">{eventLabel(event)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="app-sim-receipts-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="app-sim-receipts-heading" className="text-lg font-medium">최근 영수증</h2>
          <span className="text-sm text-muted-foreground">{receipts.length}건</span>
        </div>
        {recentReceipts.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">아직 시뮬레이션 영수증이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {recentReceipts.map((receipt) => (
              <li key={receipt.id} className="flex items-start justify-between gap-4 rounded-lg border p-3" data-receipt-id={receipt.id}>
                <div className="min-w-0">
                  <p className="break-all font-medium">{receipt.id}</p>
                  {receipt.summary && <p className="text-sm text-muted-foreground">{receipt.summary}</p>}
                  <time className="text-xs text-muted-foreground" dateTime={new Date(receipt.createdAt).toISOString()}>{formatTime(receipt.createdAt)}</time>
                </div>
                <span className="shrink-0 rounded-full border px-2 py-1 text-xs">{receipt.outcome}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
