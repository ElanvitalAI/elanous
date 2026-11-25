/** Fixture models for the two demo scenes (no live data). */
import type { FederationBoardSnapshot } from './federation-board.js';
import type { InvestResearchModel } from './invest-research.js';

export const FEDERATION_BOARD_FIXTURE: FederationBoardSnapshot = {
  release: '0.3.37',
  landedPerHour: 14,
  landTarget: 20,
  greenPerHour: 11,
  greenTarget: 10,
  seats: { working: 6, idle: 2, blocked: 1 },
  handsOpen: 2,
  hostLoad: { host: 'node-b', value: 38, max: 64, threshold: 40 },
  releaseSteps: [
    { label: 'Rehearse', state: 'done', note: '14:00 hard rehearsal passed' },
    { label: 'Cut', state: 'active', note: '16:00' },
    { label: 'Publish', state: 'todo', note: '18:00' },
  ],
};

/** Sample figures only — the live wiring is DEMO-1126-INVEST-ORCH. OP and every child run on terra (codex). */
export const INVEST_RESEARCH_FIXTURE: InvestResearchModel = {
  title: 'Samsung Electronics (005930.KS) — 2027 outlook · Panel of 3',
  fanout: {
    parent: { name: 'OP', modelTail: 'terra', state: 'running' },
    children: [
      { name: 'News', modelTail: 'terra', state: 'done', progress: 1, elapsedMs: 42_000, lastLine: '18 stories (sample)' },
      { name: 'Sentiment', modelTail: 'terra', state: 'running', progress: 0.6, elapsedMs: 31_000, lastLine: '240 posts (sample)' },
      { name: 'Market data', modelTail: 'terra · codex CLI', state: 'waiting', progress: null, elapsedMs: 0, lastLine: 'queued behind News' },
    ],
  },
  steps: [
    { label: 'Plan', state: 'done', note: '3 angles' },
    { label: 'Fan-out', state: 'done' },
    { label: 'Collect', state: 'active', note: '1 of 3 back' },
    { label: 'Panel', state: 'todo' },
  ],
  result: {
    title: '005930.KS · 2027 outlook',
    subtitle: 'Hold, leaning buy (sample figures)',
    sections: [{ heading: 'Why', lines: ['HBM demand keeps memory prices firm into 2027 [1]', 'Retail sentiment cooled this week [2]'] }],
    evidence: [
      { n: 1, label: 'Sample memory price series', url: 'example.com/dram' },
      { n: 2, label: 'Sample sentiment set', url: 'example.com/sentiment' },
    ],
    disclaimer: 'Sample data for the demo. Not investment advice.',
  },
};
