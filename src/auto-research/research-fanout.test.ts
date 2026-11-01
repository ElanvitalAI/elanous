import { expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { runResearchFanout, type ResearchFanoutWorker } from './research-fanout.js';
import { runResearchQuestionLadder } from './research-turn.js';
import type { BloomResearchQuestion } from './question-ladder-contract.js';

const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `fanout-q${index + 1}`,
  level: (index + 1) as BloomResearchQuestion['level'],
  prompt: `Question ${index + 1}`,
  searchTerms: [`term-${index + 1}`],
  sectionId: 'findings',
}));
const outputContract = {
  deliverable: 'Sourced answer', format: 'Memo',
  sections: [{ id: 'findings', title: 'Findings', purpose: 'Answer with sources.' }],
  completionCriteria: ['Support claims or state uncertainty.'],
};
const evidenceFor = (questionId: string) => ['one.example', 'two.example'].map((host) => ({
  questionId, sourceKind: 'web-search:fixture', source: `https://${host}/${questionId}`,
  content: `Finding for ${questionId} at ${host}`, outcome: 'complete' as const, truncated: false,
}));

test('three angle workers start concurrently, retain successful sources when one fails, and log runId', async () => {
  const runId = `run-research-fanout-${crypto.randomUUID()}`;
  const started: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const worker: ResearchFanoutWorker = async (angle) => {
    started.push(angle.id);
    if (started.length === 3) release();
    await barrier;
    if (angle.id === 'news-filings') throw new Error('fixture search timeout');
    return {
      text: `${angle.label} finding with a dated denominator`,
      sources: [{ url: `https://${angle.id}.example/source`, title: `${angle.label} source`, excerpt: 'Observed 2026-11-01' }],
    };
  };

  const result = await runResearchFanout('Why did the event happen?', worker, { runId });

  expect(started).toHaveLength(3);
  expect(result.angles.map(({ status }) => status)).toEqual(['complete', 'failed', 'complete']);
  expect(result.angles[1]?.error).toBe('fixture search timeout');
  expect(result.output).toContain('[1차 데이터 source](https://primary-data.example/source)');
  expect(result.output).toContain('[반대 근거 source](https://counterevidence.example/source)');
  expect(result.output).toContain('news-filings');
  const events = debug.events(500).filter((event) =>
    event.category === 'research.fanout' && (event.data as { runId?: string } | undefined)?.runId === runId);
  expect(events.map(({ event }) => event)).toEqual(['started', 'completed']);
  expect(events[1]?.data).toMatchObject({ completeCount: 2, failedAngleIds: ['news-filings'], sourceCount: 2 });
});

test('fanout never invents a parent runId when the caller has none', async () => {
  const inherited = process.env.ELANOUS_RUN_ID;
  delete process.env.ELANOUS_RUN_ID;
  const request = `Unattributed research ${'x'.repeat(100 + Math.floor(Math.random() * 100))}`;
  try {
    const result = await runResearchFanout(request, async (angle) => ({
      text: `${angle.label} has a finding`,
      sources: [{ url: `https://${angle.id}.example/source` }],
    }));
    const events = debug.events().filter((event) => event.category === 'research.fanout'
      && (event.data as { requestChars?: number } | undefined)?.requestChars === request.length);

    expect('runId' in result).toBe(false);
    expect(events.map(({ event }) => event)).toEqual(['started', 'completed']);
    expect(events.every((event) => !('runId' in (event.data as Record<string, unknown>)))).toBe(true);
  } finally {
    if (inherited === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = inherited;
  }
});

test('research turn joins fake native-search evidence with parallel sub-agent angle findings', async () => {
  const runId = `run-research-fanout-integration-${crypto.randomUUID()}`;
  const worker: ResearchFanoutWorker = async (angle) => ({
    text: `${angle.label}: event date 2026-11-01, denominator 4, state confirmed.`,
    sources: [{ url: `https://${angle.id}.example/primary` }],
  });
  const result = await runResearchQuestionLadder('Explain this research event', {
    generateContract: async () => JSON.stringify(outputContract),
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({ plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: evidenceFor(axis.id) })) }),
    researchFanoutWorker: worker,
    routeOutput: () => ({
      weight: 'light', weightSource: 'estimated', format: 'text',
      observation: { resultChars: 0, axisCount: 6, estimatedWeight: 'light' },
    }),
    allowOutputSkill: false,
    runId,
  });

  expect(result.ok).toBe(true);
  expect(result.ladder.evidence).toHaveLength(12);
  expect(result.output).toContain('## Parallel research angles');
  expect(result.output).toContain('2026-11-01, denominator 4, state confirmed');
  expect(result.output).toContain('https://primary-data.example/primary');
  expect(result.output).toContain('https://news-filings.example/primary');
  expect(result.output).toContain('https://counterevidence.example/primary');
  const events = debug.events(500).filter((event) =>
    event.category === 'research.fanout' && (event.data as { runId?: string } | undefined)?.runId === runId);
  expect(events.some(({ event }) => event === 'completed')).toBe(true);
});

test('fanout times out a stalled angle and withholds unsupported text without losing sourced angles', async () => {
  const startedAt = Date.now();
  const result = await runResearchFanout('A question with a sourced answer', async (angle, _request, signal) => {
    if (angle.id === 'primary-data') return { text: 'Verified finding', sources: [{ url: 'https://data.example/source' }] };
    if (angle.id === 'news-filings') return { text: 'Unsupported claim without a URL' };
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { workerTimeoutMs: 5 });

  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(result.angles.map(({ status }) => status)).toEqual(['complete', 'failed', 'failed']);
  expect(result.output).toContain('Verified finding');
  expect(result.output).toContain('https://data.example/source');
  expect(result.output).not.toContain('Unsupported claim without a URL');
  expect(result.output).toContain('no verifiable sources');
});
