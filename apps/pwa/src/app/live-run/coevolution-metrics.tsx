import type { ReactNode } from 'react';
import fixedLedger from './coevolution-ledger.fixture.json';

/** Values are supplied by a run ledger snapshot. This view never estimates a missing round. */
export interface CoevolutionRoundMetrics {
  round: 1 | 2 | 3;
  evidenceBackedCards: number;
  remainingGaps: number;
  passedChecks: number;
}

export interface CoevolutionLedgerSnapshot {
  id: string;
  label: string;
  kind: 'fixture' | 'run-ledger';
  rounds: readonly CoevolutionRoundMetrics[];
}

/** A labeled, fixed JSON demonstration ledger; no value here is a live measurement. */
export const DEMO_COEVOLUTION_LEDGER = fixedLedger as CoevolutionLedgerSnapshot;

const METRICS = [
  { key: 'evidenceBackedCards', label: '근거 카드', color: 'bg-emerald-500' },
  { key: 'remainingGaps', label: '남은 빈칸', color: 'bg-amber-500' },
  { key: 'passedChecks', label: '통과 수', color: 'bg-sky-500' },
] as const;

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function CoevolutionMetricsPanel({ ledger }: { ledger: CoevolutionLedgerSnapshot }): ReactNode {
  const rounds = [...ledger.rounds].sort((a, b) => a.round - b.round);
  const valid = ledger.id.trim() !== '' && rounds.length > 0 && rounds.length <= 3
    && new Set(rounds.map(row => row.round)).size === rounds.length
    && rounds.every(row => [1, 2, 3].includes(row.round)
      && METRICS.every(metric => isCount(row[metric.key])));
  if (!valid) return <section aria-label="공진화 라운드 지표" role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-950">확인할 수 있는 라운드 원장 값이 없습니다.</section>;

  return (
    <section aria-label="공진화 라운드 지표" className="mx-auto w-full max-w-5xl rounded-3xl border border-slate-200 bg-white p-5 text-slate-900 shadow-sm sm:p-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">COEVOLUTION · RUN LEDGER</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">라운드가 채운 근거</h2>
          <p className="mt-2 text-sm text-slate-600">{ledger.label} · {ledger.id}</p>
        </div>
        <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
          {ledger.kind === 'fixture' ? '시연용 고정 원장 · 실측 아님' : 'run 원장 스냅샷'}
        </span>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        {rounds.map(row => (
          <article key={row.round} aria-label={`라운드 ${row.round}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <p className="mb-5 text-sm font-bold text-slate-700">ROUND {row.round}</p>
            <div className="space-y-5">
              {METRICS.map(metric => {
                const value = row[metric.key];
                const maximum = Math.max(1, ...rounds.map(item => item[metric.key]));
                return (
                  <div key={metric.key}>
                    <div className="mb-2 flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-slate-600">{metric.label}</span>
                      <strong className="text-xl tabular-nums">{value}</strong>
                    </div>
                    <div role="img" aria-label={`${metric.label} ${value}`} className="h-2.5 overflow-hidden rounded-full bg-slate-200">
                      <div className={`h-full rounded-full ${metric.color}`} style={{ width: `${(value / maximum) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      <p className="mt-5 text-xs text-slate-500">막대는 표시된 라운드의 항목별 최댓값을 기준으로 합니다. 숫자는 입력 원장 값을 그대로 표시합니다.</p>
    </section>
  );
}
