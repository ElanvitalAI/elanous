import { createHash } from 'node:crypto';
import { redactSecretText } from '../debug/log.js';

export type RetroProposalSignalSource = 'incident' | 'doctor-visit';

/** Minimal, redacted signals from durable ledgers; raw log text is deliberately excluded. */
export interface RetroProposalSignal {
  readonly runId: string;
  readonly symptom: string;
  readonly at: string;
  readonly source: RetroProposalSignalSource;
}

export interface RetroFeatureProposal {
  readonly id: string;
  readonly title: string;
  readonly symptom: string;
  readonly evidence: {
    readonly runIds: readonly string[];
    readonly incidents: number;
    readonly doctorVisits: number;
  };
  readonly expectedEffect: string;
  readonly decisionSignal: string;
  readonly costPeak: { readonly status: 'unknown'; readonly reason: string };
  readonly localAndGlobalScope: { readonly status: 'unknown'; readonly reason: string };
}

export interface BuildRetroFeatureProposalsOptions {
  readonly from?: string;
  readonly to?: string;
  readonly minimumRuns?: number;
}

/** Build deterministic proposal cards from repeated, recorded symptoms only. */
export function buildRetroFeatureProposals(
  signals: readonly RetroProposalSignal[],
  options: BuildRetroFeatureProposalsOptions = {},
): RetroFeatureProposal[] {
  const minimumRuns = options.minimumRuns ?? 2;
  if (!Number.isSafeInteger(minimumRuns) || minimumRuns < 2) throw new Error('minimumRuns must be an integer >= 2');
  const from = options.from ? Date.parse(`${options.from}T00:00:00.000Z`) : -Infinity;
  const to = options.to ? Date.parse(`${options.to}T23:59:59.999Z`) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('from and to must be valid YYYY-MM-DD dates');
  if (from > to) throw new Error('from must be on or before to');

  const grouped = new Map<string, RetroProposalSignal[]>();
  for (const signal of signals) {
    if (signal.source !== 'incident' && signal.source !== 'doctor-visit') continue;
    const symptom = redactSecretText(signal.symptom).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const at = Date.parse(signal.at);
    const runId = signal.runId.trim().replace(/[^\w.-]/g, '').slice(0, 100);
    if (!runId || !symptom || !Number.isFinite(at) || at < from || at > to) continue;
    const rows = grouped.get(symptom) ?? [];
    rows.push({ ...signal, runId, symptom });
    grouped.set(symptom, rows);
  }

  return [...grouped.entries()].flatMap(([symptom, rows]) => {
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    if (runIds.length < minimumRuns) return [];
    const incidents = rows.filter((row) => row.source === 'incident').length;
    const doctorVisits = rows.filter((row) => row.source === 'doctor-visit').length;
    const id = createHash('sha256').update(`${symptom}\n${runIds.join('\n')}`).digest('hex').slice(0, 12);
    return [{
      id,
      title: `반복 증상 제안: ${symptom}`,
      symptom,
      evidence: { runIds, incidents, doctorVisits },
      expectedEffect: `다음 회고 기간의 '${symptom}' 고유 런 수 감소`,
      decisionSignal: `다음 기간에 같은 증상으로 기록된 고유 runId 수 < ${runIds.length}`,
      costPeak: { status: 'unknown', reason: '비용 정본 필드가 확인되지 않아 측정 불가' },
      localAndGlobalScope: { status: 'unknown', reason: '로컬/광역 사례 저장 정본이 확인되지 않아 범위 미정' },
    } satisfies RetroFeatureProposal];
  }).sort((a, b) => b.evidence.runIds.length - a.evidence.runIds.length
    || (a.symptom < b.symptom ? -1 : a.symptom > b.symptom ? 1 : 0));
}

export function renderRetroFeatureProposals(cards: readonly RetroFeatureProposal[]): string | undefined {
  if (cards.length === 0) return undefined;
  const lines = ['## 반복 증상 피처 제안 (근거 기반 · 초안)'];
  for (const card of cards) {
    lines.push(`### ${card.title} · ${card.id}`);
    lines.push(`- 증상: ${card.symptom}`);
    lines.push(`- 근거: ${card.evidence.runIds.length}개 고유 런 (${card.evidence.runIds.join(', ')}) · incident ${card.evidence.incidents} · doctor visit ${card.evidence.doctorVisits}`);
    lines.push(`- 예상 효과: ${card.expectedEffect}`);
    lines.push(`- 판정 신호: ${card.decisionSignal}`);
    lines.push(`- 비용 정점: 모름 (${card.costPeak.reason})`);
    lines.push(`- 로컬/광역 두 층: 모름 (${card.localAndGlobalScope.reason})`);
  }
  return lines.join('\n');
}
