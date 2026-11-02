import type { DecisionEntry } from '../decisions/decision-ledger.js';

const kst = (at: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(at)) + ' KST';
const version = (e: DecisionEntry['version']) => e ? `released=${e.released ?? '-'} · dev=${e.dev ?? '-'}${e.codename ? ` «${e.codename}»` : ''}` : '판 미상';

export function formatDecisionRow(e: DecisionEntry): string {
  const recommendation = 'skipped' in e.recommendation ? '권고 생략' : `${e.recommendation.option} (${e.recommendation.why})`;
  return `${e.id} · ${e.category} · ${e.title} · ${recommendation} · ${e.raisedAt ? kst(e.raisedAt) : '올린 시각 미상'} · ${version(e.version)}`;
}
