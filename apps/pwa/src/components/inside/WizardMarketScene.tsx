'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { fromWizardLogFrame, subscribeWizardSteps, type WizardStepEvent } from '@/lib/inside-events';
import { toPublicText } from './public-text';
import { wizardTimeline, type WizardTimelineRow } from './wizard-steps';

const TONE: Record<WizardTimelineRow['state'], string> = {
  done: 'border-green-500 bg-green-500/15 text-green-300',
  now: 'border-sky-400 bg-sky-500/15 text-sky-200',
  todo: 'border-slate-500 bg-slate-500/15 text-slate-300',
  failed: 'border-red-500 bg-red-500/15 text-red-300',
};

const STATUS: Record<WizardTimelineRow['state'], string> = {
  done: '완료', now: '진행 중', todo: '대기', failed: '실패',
};

export function WizardMarketView({ events }: { events: WizardStepEvent[] }) {
  const timeline = wizardTimeline(events);
  return <section aria-label="마법사 → 마켓" className="min-w-0 space-y-6 p-4 text-lg min-[1440px]:text-[22px]">
    {timeline.length === 0 ? <p>마법사가 아직 돌지 않았습니다 — <code>elanous plugin make "&lt;한 줄&gt;"</code> 로 시작</p> :
      <ol aria-label="마법사 단계" className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-6">
        {timeline.map(row => <li key={row.step} data-wizard-step={row.step} data-state={row.state}
          className={`min-w-0 rounded-xl border p-4 ${TONE[row.state]}`}>
          <div className="font-semibold">{row.label} <span className="font-normal">· {STATUS[row.state]}</span></div>
          {row.text && <p className="mt-3 overflow-hidden text-ellipsis whitespace-nowrap" title={toPublicText(row.text)}>{toPublicText(row.text)}</p>}
        </li>)}
      </ol>}
  </section>;
}

const BACKFILL_LIMIT = 50;
const eventKey = (event: WizardStepEvent) => `${event.wizardId}:${event.step}:${event.ts}:${event.text}`;

/** Merge history and live events: one per (wizard, step, ts, text), oldest first, newest 50 kept. */
export function mergeWizardEvents(previous: WizardStepEvent[], incoming: WizardStepEvent[]): WizardStepEvent[] {
  const byKey = new Map<string, WizardStepEvent>();
  for (const event of [...previous, ...incoming]) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-BACKFILL_LIMIT);
}

export function WizardMarketScene() {
  const { client } = useDaemon();
  const [source, setSource] = useState(() => ({ client, events: [] as WizardStepEvent[] }));
  useEffect(() => {
    let active = true;
    setSource({ client, events: [] });
    const add = (incoming: WizardStepEvent[]) => {
      if (active && incoming.length) setSource(previous => ({ client, events: mergeWizardEvents(previous.client === client ? previous.events : [], incoming) }));
    };
    // The live stream only carries lines after it connects; a finished (or reloaded) run comes from the log query (review should-fix).
    const fetchJson = (client as { fetchJson?: <T>(path: string) => Promise<T> }).fetchJson;
    if (typeof fetchJson === 'function') {
      void fetchJson.call(client, `/v1/logs?exactCategory=wizard.step&limit=${BACKFILL_LIMIT}`)
        .then((body) => {
          const rows = (body as { logs?: unknown[] } | null)?.logs;
          add(Array.isArray(rows) ? rows.map(fromWizardLogFrame).filter((event): event is WizardStepEvent => event !== null) : []);
        })
        .catch(() => { /* history is a convenience; the live stream still works */ });
    }
    const unsubscribe = subscribeWizardSteps(client, event => add([event]));
    return () => { active = false; unsubscribe(); };
  }, [client]);
  return <WizardMarketView events={source.client === client ? source.events : []} />;
}
