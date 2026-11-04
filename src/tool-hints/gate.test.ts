import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import type { SignalSnapshot } from './signals.js';
import { evaluateGate, resetGateCache } from './gate.js';
import { collectSignals, isOrderedNonResearchWorkflow, isResearchAgentIntent } from './signals.js';
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

test('research tool budget keeps WebSearch, OmniSearch, and WebFetch in the selected set', () => {
  resetGateCache();
  const catalog = [
    ...['web_search', 'omni_search', 'web_fetch'].map(id => ({
      ...catalogWithDefaultEnabled(true)[0]!, id,
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      ...catalogWithDefaultEnabled(true)[0]!, id: `other_${index}`,
    })),
  ];
  const research = evaluateGate(catalog, [], {
    ...signals,
    modelFamily: 'gpt',
    intentResearch: true,
    researchAgent: true,
    fingerprint: 'research-tools-survive-gpt-cap',
  });
  expect(research.filtered).toContain('web_search');
  expect(research.filtered).toContain('omni_search');
  expect(research.filtered).toContain('web_fetch');
});

test('research intent reserves WebSearch and WebFetch even when higher-scored tools fill top eight', () => {
  resetGateCache();
  const catalog = [
    ...['web_search', 'web_fetch'].map(id => ({ ...catalogWithDefaultEnabled(true)[0]!, id })),
    ...Array.from({ length: 12 }, (_, index) => ({
      ...catalogWithDefaultEnabled(true)[0]!, id: `aaa_research_fixture_${index}`,
    })),
  ];
  const hints = Array.from({ length: 12 }, (_, index) => ({
    id: `research-fixture-hint-${index}`,
    kind: 'prefer' as const,
    tool: `aaa_research_fixture_${index}`,
    scope: 'turn' as const,
    createdAt: 0,
  }));
  const research = evaluateGate(catalog, hints, {
    ...signals,
    modelFamily: 'gpt',
    intentResearch: true,
    researchAgent: false,
    fingerprint: 'research-intent-reserves-native-search',
  });

  expect(research.filtered).toHaveLength(8);
  expect(research.filtered).toContain('web_search');
  expect(research.filtered).toContain('web_fetch');
  expect(research.filtered.filter(id => id.startsWith('aaa_research_fixture_'))).toHaveLength(6);
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

test('ordered operational workflows mentioning research do not select the research agent route', () => {
  const request = '먼저 리니어 이슈를 만들고, 그다음 리서치하고, aside 캡처한 뒤 마지막에 정리해 주세요.';
  expect(isOrderedNonResearchWorkflow(request)).toBe(true);
  expect(isResearchAgentIntent(request)).toBe(true);
  expect(resolveSessionSurfaceProfile({ userText: request }).id).toBe('coding/turn');
  const emailWorkflow = 'First send an email, then research the topic and summarize the findings.';
  expect(isOrderedNonResearchWorkflow(emailWorkflow)).toBe(true);
  expect(resolveSessionSurfaceProfile({ userText: emailWorkflow }).id).toBe('coding/turn');
  expect(isOrderedNonResearchWorkflow('First send an email and research the topic, then summarize.')).toBe(true);
  expect(isOrderedNonResearchWorkflow('First send a ticket, then research the topic.')).toBe(true);
  const deploymentWorkflow = 'First deploy the service, then research any errors and summarize them.';
  expect(isOrderedNonResearchWorkflow(deploymentWorkflow)).toBe(true);
  expect(resolveSessionSurfaceProfile({ userText: deploymentWorkflow }).id).toBe('coding/turn');
  const restartWorkflow = 'First restart the server, then research the errors.';
  expect(isOrderedNonResearchWorkflow(restartWorkflow)).toBe(true);
  expect(resolveSessionSurfaceProfile({ userText: restartWorkflow }).id).toBe('coding/turn');
  expect(isOrderedNonResearchWorkflow('First delete the old deployment, then research the errors.')).toBe(true);
  const researchTopic = 'First do deep research on email security, then summarize the findings.';
  expect(isOrderedNonResearchWorkflow(researchTopic)).toBe(false);
  expect(resolveSessionSurfaceProfile({ userText: researchTopic }).id).toBe('research/agent');
  const researchHowTo = 'First research how to send an email, then summarize the steps.';
  expect(isOrderedNonResearchWorkflow(researchHowTo)).toBe(false);
  expect(resolveSessionSurfaceProfile({ userText: researchHowTo }).id).toBe('research/agent');
});
