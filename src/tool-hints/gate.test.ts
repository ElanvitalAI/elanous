import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import type { SignalSnapshot } from './signals.js';
import { evaluateGate, resetGateCache } from './gate.js';
import { collectSignals, isResearchAgentIntent } from './signals.js';
import { resolveSessionSurfaceProfile } from '../session-runtime/index.js';

const TARGET_TOOL_ID = 'run_dev_harness';

const signals: SignalSnapshot = {
  hasPython: false,
  hasNodeProject: false,
  hasGitRemote: false,
  intentResearch: false,
  intentDiagram: false,
  recentNetworkError: false,
  intentBrowse: false,
  intentViz: false,
  intentCapture: false,
  intentOpsFleet: false,
  intentOpsUi: false,
  intentCoding: false,
  paidKeyGrok: false,
  paidCliFirecrawl: false,
  hasActivePtyModal: false,
  backgroundedPtyCount: 0,
  hasSessionAttention: false,
  fingerprint: 'gate-default-enabled-test',
};

function catalogWithDefaultEnabled(defaultEnabled: boolean): NativeToolCatalogEntry[] {
  return [{
    id: TARGET_TOOL_ID,
    kind: 'other',
    aliases: [],
    displayName: 'Run dev harness',
    description: 'Runs the development harness.',
    promptSummary: 'Run the development harness.',
    host: ['all'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled,
  }];
}

describe('evaluateGate defaultEnabled stage', () => {
  beforeEach(resetGateCache);
  afterEach(resetGateCache);

  test('excludes a default-disabled catalog entry', () => {
    const catalog = catalogWithDefaultEnabled(false);

    const decision = evaluateGate(catalog, [], signals);

    expect(decision.filtered).not.toContain(TARGET_TOOL_ID);
  });

  test('includes the same catalog entry when only defaultEnabled is true', () => {
    const catalog = catalogWithDefaultEnabled(true);

    const decision = evaluateGate(catalog, [], signals);

    expect(decision.filtered).toContain(TARGET_TOOL_ID);
  });
});

test('research turns keep a finite wider tool catalog while ordinary GPT turns keep top eight', () => {
  resetGateCache();
  const catalog = Array.from({ length: 18 }, (_, index) => ({
    ...catalogWithDefaultEnabled(true)[0]!,
    id: `tool_${index}`,
  }));
  const ordinary = evaluateGate(catalog, [], { ...signals, modelFamily: 'gpt', fingerprint: 'ordinary-gpt' });
  const research = evaluateGate(catalog, [], { ...signals, modelFamily: 'gpt', intentResearch: true, researchAgent: true, fingerprint: 'research-gpt' });
  expect(ordinary.filtered).toHaveLength(8);
  expect(research.filtered).toHaveLength(16);
});

test('tool hints recognize explanatory research without widening a code repair or simple fact', () => {
  expect(collectSignals({ recentUserText: '현재 채권 금리가 계속 올라가는 이유는요? omni market 활용' }).intentResearch).toBe(true);
  expect(collectSignals({ recentUserText: '현재 채권 금리가 계속 올라가는 이유는요? omni market 활용' }).researchAgent).toBe(true);
  expect(collectSignals({ recentUserText: '금리 상승 원인을 분석해줘' }).intentResearch).toBe(true);
  expect(collectSignals({ recentUserText: '이 함수 오류 원인을 분석해줘' }).intentResearch).toBe(false);
  expect(collectSignals({ recentUserText: '채권 금리 얼마야?' }).intentResearch).toBe(false);
  expect(collectSignals({ recentUserText: 'OpenAI 최신 모델이 뭐야?' }).researchAgent).toBe(false);
  expect(collectSignals({ recentUserText: 'omni-market 코드 고쳐줘' }).intentResearch).toBe(false);
});

test('surface and gate share one research-agent verdict for old, new and coding phrases', () => {
  for (const text of [
    '현재 채권 금리가 왜 올라가나요?', 'omni-crawl로 기후 전망 비교',
    'compare sources on inflation', '여러 소스 반응',
    '이 버그 조사해줘', 'omni-market 코드 고쳐줘', 'OpenAI 최신 모델이 뭐야?',
  ]) {
    const surfaceResearch = resolveSessionSurfaceProfile({ userText: text }).id === 'research/agent';
    expect(collectSignals({ recentUserText: text }).researchAgent).toBe(surfaceResearch);
    expect(isResearchAgentIntent(text)).toBe(surfaceResearch);
  }
});
