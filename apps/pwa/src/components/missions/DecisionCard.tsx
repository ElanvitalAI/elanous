'use client';

import { useState, type ReactElement } from 'react';
import type { MissionRoomDecisionWire } from '@/lib/mission-room-api';
import type { OpenDecision } from '@/lib/decisions-api';

type DecisionCardProps = {
  decision: MissionRoomDecisionWire;
  onDecide?: (chosen: string) => void;
  decidingChoice: string | null;
} | {
  decision: OpenDecision;
  onChoose: (option: OpenDecision['options'][number]) => void;
  busy: boolean;
};

export function DecisionCard(props: DecisionCardProps): ReactElement {
  const [draft, setDraft] = useState('');
  if ('onChoose' in props) {
    const { decision, onChoose, busy } = props;
    return (
      <article className="rounded border border-border bg-card p-3" data-decision-card={decision.id}>
        <h3 className="text-sm font-semibold">{decision.title}</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{decision.situation}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {decision.options.map(option => (
            <button key={option.id} type="button" disabled={busy} onClick={() => onChoose(option)}
              className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50">
              {option.label}{'option' in decision.recommendation && decision.recommendation.option === option.id && <span className="ml-1 text-primary">추천</span>}
            </button>
          ))}
        </div>
      </article>
    );
  }
  const { decision, onDecide, decidingChoice } = props;
  const status = decision.resolution.status;
  const chosen = decision.resolution.status === 'decided' ? decision.resolution.chosen : null;
  return (
    <article className="rounded border border-zinc-200 bg-white p-3">
      <header className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{decision.question}</p>
        <time className="shrink-0 text-xs opacity-60" dateTime={new Date(decision.ts).toISOString()}>
          {new Date(decision.ts).toLocaleString()}
        </time>
      </header>
      <ul className="mt-2 flex flex-col gap-2">
        {decision.opinions.map((op, i) => (
          <li key={`${op.role}-${i}`} className="rounded bg-zinc-50 p-2 text-xs">
            <div className="font-medium">
              {op.role}{op.modelId ? <span className="opacity-60"> · {op.modelId}</span> : null}
            </div>
            <pre className="mt-1 whitespace-pre-wrap text-xs leading-snug">{op.text}</pre>
          </li>
        ))}
      </ul>
      <footer className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs opacity-70">
          resolution:{' '}
          {status === 'decided'
            ? <span className="font-medium text-emerald-700">decided → {chosen}</span>
            : <span className="text-amber-700">open</span>}
        </span>
        {onDecide && status === 'open' && (
          <form className="flex items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onDecide(draft.trim()); }}>
            <input className="w-32 rounded border border-zinc-300 px-2 py-0.5 text-xs"
              placeholder="chosen…" value={draft} onChange={(e) => setDraft(e.target.value)}
              disabled={decidingChoice !== null} />
            <button type="submit" className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white disabled:opacity-50"
              disabled={!draft.trim() || decidingChoice !== null}>
              {decidingChoice === draft ? '…' : 'apply'}
            </button>
          </form>
        )}
      </footer>
    </article>
  );
}
