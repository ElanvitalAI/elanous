'use client';

import type { ReactElement } from 'react';
import type { OpenDecision } from '@/lib/decisions-api';

type DecisionCardProps = {
  decision: OpenDecision;
  onChoose: (option: OpenDecision['options'][number]) => void;
  busy: boolean;
};

export function DecisionCard(props: DecisionCardProps): ReactElement {
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
