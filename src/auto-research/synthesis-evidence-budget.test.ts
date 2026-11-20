import { expect, test } from 'bun:test';
import type { ResearchEvidenceEnvelope, SixLevelResearchQuestionLadder } from './question-ladder-contract.js';
import { researchTurnForGrounding } from './research-turn.js';
import {
  budgetResearchEvidenceForSynthesis, buildBudgetedSynthesisLedger, buildLedgerCitationRule, verifiedEvidenceUrls,
  RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS,
} from './synthesis-evidence-budget.js';

const QUESTION_COUNT = 6;
const ROWS = 58;
const questions = Array.from({ length: QUESTION_COUNT }, (_, i) => ({
  id: `q${i + 1}`, level: (i + 1) as 1 | 2 | 3 | 4 | 5 | 6, prompt: `Question ${i + 1}`, searchTerms: [`t${i + 1}`], sectionId: 's',
}));
const sentence = (n: number) => `Sentence ${n} of the captured page body with a figure ${n * 7}.`;
const body = (seed: number, length: number) => {
  let out = '';
  for (let n = 0; out.length < length; n += 1) out += `${sentence(seed * 1000 + n)} `;
  return out.trim();
};
function fixture(count = ROWS, bodyLength = 3_000): SixLevelResearchQuestionLadder {
  const evidence: ResearchEvidenceEnvelope[] = Array.from({ length: count }, (_, i) => ({
    questionId: `q${(i % QUESTION_COUNT) + 1}`,
    sourceKind: 'web-search',
    source: `https://publisher${i}.example.com/articles/${i}`,
    observedAt: '2026-11-20T00:00:00.000Z',
    publishedAt: `2026-0${(i % 9) + 1}-10T00:00:00.000Z`,
    content: body(i, bodyLength),
    outcome: 'complete', truncated: false,
  }));
  return { request: 'req', questions, evidence };
}
function run(ladder: SixLevelResearchQuestionLadder) {
  const output = [
    '# Research: req', '', '## Output contract\ncontract',
    ...questions.map(q => `## ${q.id} · Bloom ${q.level}: ${q.prompt}\nSearch terms: ${q.searchTerms.join(', ')}\n`
      + ladder.evidence.filter(e => e.questionId === q.id).map(e => `- [${e.outcome}] ${e.sourceKind} · ${e.source}: ${e.content}`).join('\n')),
    `## Parallel research angles\n${body(999, 20_000)} https://fanout.example.org/only-here`,
    `## Claim source trace\n${ladder.evidence.map(e => `- ${e.source}: ${e.content}`).join('\n')}`,
  ].join('\n\n');
  return researchTurnForGrounding({ ok: true, ladder, output });
}

test('a 58-row, ~190k char evidence set is bounded and reports overBudget false', () => {
  const grounding = run(fixture());
  expect(grounding.synthesisOutput).toBeDefined();
  expect(grounding.synthesisBudget?.overBudget).toBe(false);
  expect(grounding.synthesisBudget?.budgetChars).toBe(RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS);
  expect(grounding.synthesisBudget?.dropped).toBe(0);
  expect(grounding.synthesisBudget?.inputChars).toBe(grounding.output.length);
  expect(grounding.synthesisBudget && grounding.synthesisBudget.sourcesKept + grounding.synthesisBudget.sourcesMetaOnly).toBe(ROWS);
  // The full output stays untouched for the citation ledger.
  expect(grounding.output).toContain('https://fanout.example.org/only-here');
});

test('every source URL survives as an excerpt row or a metadata-only row', () => {
  const ladder = fixture();
  const grounding = run(ladder);
  for (const item of ladder.evidence) expect(grounding.synthesisOutput).toContain(`](${item.source})`);
  expect(grounding.synthesisBudget?.dropped).toBe(0);
  expect(grounding.synthesisOutput).toContain('https://fanout.example.org/only-here');
  expect(grounding.sourceUrls).toEqual(ladder.evidence.map(item => item.source));
  expect(grounding.synthesisOutput).toContain('미확인');
  expect(grounding.synthesisOutput).toContain('pub=');
});

const row = (questionId: string, i: number, extra: Partial<ResearchEvidenceEnvelope> = {}): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'k', source: `https://p${i}.example.com/`, content: 'x'.repeat(400), outcome: 'complete', truncated: false, ...extra,
});

test('a tight budget prefers complete, dated, untruncated rows over partial or undated ones', () => {
  // 17 weak rows first in input order, then 3 structurally better rows; only the target number of sources keep an excerpt.
  const evidence = [
    ...Array.from({ length: 17 }, (_, i) => row('q1', i, { outcome: 'partial', truncated: true })),
    ...Array.from({ length: 3 }, (_, i) => row('q1', 17 + i, { publishedAt: '2026-10-01T00:00:00.000Z' })),
  ];
  const plan = budgetResearchEvidenceForSynthesis(evidence, 1_600, ['q1']);
  expect(plan.unchanged).toBe(false);
  expect(plan.rows.map(r => r.excerpt !== undefined)).toEqual([
    ...Array.from({ length: 13 }, () => true), false, false, false, false, true, true, true,
  ]);
  expect(plan.sourcesKept + plan.sourcesMetaOnly).toBe(evidence.length);
});

test('rounds serve every question before a question gets a second source', () => {
  const evidence = [...Array.from({ length: 18 }, (_, i) => row('q1', i)), row('q2', 18), row('q2', 19)];
  const plan = budgetResearchEvidenceForSynthesis(evidence, 1_600, ['q1', 'q2']);
  expect(plan.rows.slice(18).map(r => r.excerpt !== undefined)).toEqual([true, true]);
  expect(plan.rows.slice(0, 18).map(r => r.excerpt !== undefined)).toEqual([
    ...Array.from({ length: 14 }, () => true), false, false, false, false,
  ]);
});

test('an evidence set under the budget is returned byte-identical', () => {
  const ladder = fixture(3, 200);
  const output = ['# Research: req', ...ladder.evidence.map(e => `- ${e.source}: ${e.content}`)].join('\n\n');
  const grounding = researchTurnForGrounding({ ok: true, ladder, output });
  expect(grounding.synthesisOutput).toBeUndefined();
  expect(grounding.synthesisBudget).toBeUndefined();
  const plan = budgetResearchEvidenceForSynthesis(ladder.evidence, 24_000, ['q1']);
  expect(plan.unchanged).toBe(true);
  expect(plan.rows.map(r => r.excerpt)).toEqual(ladder.evidence.map(item => item.content));
});

// 출처: OP #113993 · RES WEBCHAT-A2DF-MK-113947 — sourcesKept=0 / 86k model text with a 24k budget.
const HEADER = ['## Claim-level source ledger'];
const longUrl = (i: number) => `https://news${i}.example.com/section/world/2026/11/${'segment-'.repeat(20)}${i}`;
function ledgerOf(count: number, extra: (i: number) => Partial<ResearchEvidenceEnvelope> = () => ({}), researchOutput = '# R') {
  const evidence: ResearchEvidenceEnvelope[] = Array.from({ length: count }, (_, i) => ({
    questionId: `q${(i % QUESTION_COUNT) + 1}`, sourceKind: 'web-search', source: longUrl(i),
    observedAt: '2026-11-20T00:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z',
    content: body(i, 2_500), outcome: 'complete', truncated: false, ...extra(i),
  }));
  const built = buildBudgetedSynthesisLedger({
    evidence, questions, researchOutput, budgetChars: RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS, headerLines: HEADER,
  });
  return { evidence, built };
}

test('60 long-URL rows keep excerpts and the whole model-visible text fits the budget', () => {
  const { built } = ledgerOf(60);
  expect(built.overBudget).toBe(false);
  expect(built.linkRows.some(item => item.hasExcerpt)).toBe(true);
  expect(built.sourcesKept).toBe(built.linkRows.filter(item => item.hasExcerpt).length);
  expect(built.sourcesKept + built.sourcesMetaOnly + built.omittedRows).toBe(60);
  expect(built.linkRows.length).toBe(built.sourcesKept + built.sourcesMetaOnly);
});

test('every unbounded part is bounded: oversized research sections, question heads, routed output and a long header', () => {
  const huge = 'z'.repeat(60_000);
  const researchOutput = [
    '# Research', `## Output contract\n${huge}`,
    ...questions.map(q => `## ${q.id} · Bloom ${q.level}: ${huge}\nSearch terms: ${huge}`),
    `## Parallel research angles\n${huge}`, `## Routed deck output (skill)\n${huge}`, `## Claim source trace\n${huge}`,
  ].join('\n\n');
  const { built } = ledgerOf(60, () => ({}), researchOutput);
  expect(built.overBudget).toBe(false);
  expect(built.linkRows.some(item => item.hasExcerpt)).toBe(true);
});

test('rows that do not fit collapse into one omitted-count line and never carry a URL', () => {
  const { built, evidence } = ledgerOf(400);
  expect(built.overBudget).toBe(false);
  expect(built.omittedRows).toBe(evidence.length - built.linkRows.length);
  const urlsInText = evidence.filter(item => built.text.includes(`](${item.source})`)).length;
  expect(urlsInText).toBe(built.linkRows.length);
});

test('structural rank: within a question a failed row is rendered only once every complete row of that question is', () => {
  const { built, evidence } = ledgerOf(400, i => (Math.floor(i / QUESTION_COUNT) % 2 === 0 ? { outcome: 'failed', content: '' } : {}));
  const renderedUrls = new Set(built.linkRows.map(item => item.url));
  for (const question of questions) {
    const own = evidence.filter(item => item.questionId === question.id);
    const failedRendered = own.filter(item => item.outcome === 'failed' && renderedUrls.has(item.source)).length;
    const completeOmitted = own.filter(item => item.outcome === 'complete' && !renderedUrls.has(item.source)).length;
    expect(failedRendered === 0 || completeOmitted === 0).toBe(true);
  }
});

test('a 16-source ledger carries one citable link row per verified source and the revise rule states that count', () => {
  const evidence: ResearchEvidenceEnvelope[] = Array.from({ length: 16 }, (_, i) => ({
    questionId: `q${(i % QUESTION_COUNT) + 1}`, sourceKind: 'web-search', source: `https://source${i}.example.org/a/${i}`,
    observedAt: '2026-11-20T00:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z',
    content: body(i, 3_000), outcome: i % 4 === 3 ? 'partial' : 'complete', truncated: false,
  }));
  const verified = evidence.filter(item => item.outcome === 'complete');
  const built = buildBudgetedSynthesisLedger({
    evidence, questions, researchOutput: '# R', budgetChars: RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS, headerLines: HEADER,
  });
  expect(built.overBudget).toBe(false);
  expect(built.verifiedCount).toBe(verified.length);
  expect(verifiedEvidenceUrls(evidence).length).toBe(verified.length);
  const verifiedLinkRowsInText = verified.filter(item => built.text.includes(`[${new URL(item.source).hostname}](${item.source})`)).length;
  expect(verifiedLinkRowsInText).toBe(verified.length);
  expect(built.linkRows.filter(item => item.verified).length).toBe(verified.length);
  const rule = buildLedgerCitationRule(built.verifiedCount);
  expect(rule).toContain(`${verified.length} verified sources`);
  expect(rule).toContain(`${verified.length} distinct ledger links`);

  // A fake model that echoes the ledger links: final links == verified sources.
  const echoed = built.linkRows.filter(item => item.verified).map(item => `[${item.title}](${item.url})`).join('\n');
  const finalLinks = evidence.filter(item => echoed.includes(`](${item.source})`));
  expect(finalLinks.length).toBe(verified.length);
  expect(finalLinks.map(item => item.source)).toEqual(verified.map(item => item.source));
});

test('no verified source means no citation rule', () => {
  expect(buildLedgerCitationRule(0)).toBe('');
});

test('grounding result reports the verified count for both the unbudgeted and the budgeted ledger', () => {
  const small = fixture(3, 200);
  const smallOutput = researchTurnForGrounding({ ok: true, ladder: small, output: '# R\n\n' + small.evidence.map(e => e.source).join('\n') });
  expect(smallOutput.verifiedSourceCount).toBe(verifiedEvidenceUrls(small.evidence).length);
  const big = fixture();
  expect(run(big).verifiedSourceCount).toBe(verifiedEvidenceUrls(big.evidence).length);
});


test('compact citation rule (reduced synthesis cap): at most the compact link count is required and the sources line goes first', () => {
  const compact = buildLedgerCitationRule(12, { compactLinks: 3 });
  expect(compact).toContain('Start the answer with one short sources line that links at least 3');
  expect(compact).toContain('before the answer text');
  expect(buildLedgerCitationRule(2, { compactLinks: 3 })).toContain('Cite every one of them');
  expect(buildLedgerCitationRule(12)).toContain('12 distinct ledger links');
});
