import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import { redactSecrets } from '../task-cards/card-store.js';
import type { ScheduledDecision, TriageIssue } from './triage.js';
import type { StewardAsk } from './triage-plan.js';
import type { StewardCardStore } from './steward-cards.js';

export interface WorkingBackwardsDraft {
  prfaq: string;
  manual: string;
}

export class InvalidWorkingBackwardsDraft extends Error {
  constructor() { super('Invalid working-backwards draft'); }
}

/** Draft promises before implementation; no document, site, or channel is written here. */
export async function draftWorkingBackwards(issue: TriageIssue, ask: StewardAsk): Promise<WorkingBackwardsDraft> {
  const raw = await ask(`새 능력 소원의 구현 전 워킹 백워드 초안을 JSON 객체 {"prfaq":"...","manual":"...","signals":["판정 신호: 조건 = ...; 관측 = ...; 기대 = ..."]} 로만 써라. PR/FAQ 는 docs/marketing/TEMPLATE-prfaq-2026-09-29.md 모양의 ① 한 줄, 부제(누가), ② 문제(왜), ③ 해결(무엇), ④ 대표의 말(없는 인용은 확인 대기), ⑤ 시작하기, ⑥ 고객 FAQ(질문·답 셋 이상), ⑦ 내부 FAQ, ⑧ 판정 기준을 포함한다. 매뉴얼은 docs/marketing/TEMPLATE-manual-2026-10-02.md 모양으로 사용자가 칠 명령과 볼 화면을 제안하되 구현 전 가설이라고 명시한다. 아직 구현된 명령·화면이라고 주장하지 마라. 판정 신호 한두 문장은 PR/FAQ ⑧ 에 그대로 포함시켜라.\n소원: ${JSON.stringify(issue)}`, 'planning');
  let value: unknown = raw;
  if (typeof raw === 'string') {
    // A draft that is not JSON is as invalid as one with missing sections — the report must stop on it too.
    try { value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
    catch { throw new InvalidWorkingBackwardsDraft(); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidWorkingBackwardsDraft();
  const row = value as Record<string, unknown>;
  const prfaq = row.prfaq;
  const manual = row.manual;
  const faq = typeof prfaq === 'string' ? prfaq.split('⑥ 고객 FAQ')[1]?.split('⑦ 내부 FAQ')[0] ?? '' : '';
  const criteria = typeof prfaq === 'string' ? prfaq.split('⑧ 판정 기준')[1] ?? '' : '';
  const answered = faq.split('\n').filter(line => /^\|\s*[^|?]+\?\s*\|\s*[^|\s][^|]*\|/.test(line));
  if (typeof prfaq !== 'string' || typeof manual !== 'string' ||
      !Array.isArray(row.signals) || row.signals.length < 1 || row.signals.length > 2 ||
      !row.signals.every(signal => typeof signal === 'string' && /^판정 신호: 조건 = .+; 관측 = .+; 기대 = .+\.$/.test(signal) && criteria.includes(signal)) ||
      !['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'].every(section => prfaq.includes(section)) ||
      answered.length < 3 ||
      !/elanous\s+\S+/.test(manual) || !/화면/.test(manual)) throw new InvalidWorkingBackwardsDraft();
  return { prfaq: redactSecrets(prfaq), manual: redactSecrets(manual) };
}

/** Called during the steward report, after triage and before a launch can be recorded. */
export async function recordWorkingBackwardsOnCards(
  decisions: ScheduledDecision[], issues: TriageIssue[], store: StewardCardStore, ask: StewardAsk,
): Promise<void> {
  const byId = new Map(issues.map(issue => [issue.identifier, issue]));
  for (const decision of decisions) {
    const issue = byId.get(decision.issue);
    if (!issue) throw new Error(`Missing issue ${decision.issue}`);
    if (decision.capability !== 'new-capability' || decision.deferred || decision.duplicateOf || decision.rung === 'hitl') {
      debug.log('steward.working-backwards', 'skipped-existing', { issueId: issue.identifier, verdict: decision.capability ?? 'unknown' });
      continue;
    }
    const card = store.createCard({ goalId: `linear:${issue.identifier}`, title: redactSecrets(issue.title) });
    if (card.sections.some(section => section.key.startsWith('prfaq:')) && card.sections.some(section => section.key.startsWith('manual:'))) continue;
    if (card.sections.some(section => section.key.startsWith('launch:'))) throw new Error(`Working-backwards draft follows launch: ${issue.identifier}`);
    const draft = await draftWorkingBackwards(issue, ask);
    for (const [section, content] of [['prfaq', draft.prfaq], ['manual', draft.manual]] as const) {
      const key = `${section}:${createHash('sha256').update(content).digest('hex')}`;
      if (!card.sections.some(item => item.key === key)) store.appendSection(card.id, { key, owner: 'steward', content });
    }
    debug.log('steward.working-backwards', 'drafted', { issueId: issue.identifier, verdict: decision.capability });
  }
}
