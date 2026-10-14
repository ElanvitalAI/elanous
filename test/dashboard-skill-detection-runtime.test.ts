import { describe, expect, test } from 'bun:test';

import {
  detectDashboardSkillRoute,
  runAbortableDashboardSkillRoute,
} from '../src/dashboard/skill-detection-runtime.js';
import { setUserConfigOverlay } from '../src/user-config.js';

async function detectWithClassifyFixture(...args: Parameters<typeof detectDashboardSkillRoute>) {
  // A real LLM classify route resolves its role before calling the injected stream.
  // Pin that role explicitly so the test also runs with an empty HOME and no keys.
  setUserConfigOverlay(config => ({
    ...config,
    roleLlm: { ...config.roleLlm, classify: { provider: 'gemini', model: 'dashboard-fixture' } },
  }));
  try {
    return await detectDashboardSkillRoute(...args);
  } finally {
    setUserConfigOverlay(null);
  }
}

describe('detectDashboardSkillRoute', () => {
  test('returns keyword detection when llm fallback is disabled', async () => {
    const result = await detectDashboardSkillRoute('deploy docs', [], {
      llmFallback: false,
      keywordScoreThreshold: 2,
      llmConfidenceThreshold: 0.5,
      streamLLM: async () => {
        throw new Error('should not run');
      },
      detectKeyword: () => ({
        top: {
          name: 'deploy-skill',
          score: 2,
          matchedTriggers: ['deploy'],
          matchedExtractedTriggers: [],
          autoTrigger: true,
          description: 'desc',
        },
        candidates: [{
          name: 'deploy-skill',
          score: 2,
          matchedTriggers: ['deploy'],
          matchedExtractedTriggers: [],
          autoTrigger: true,
          description: 'desc',
        }],
        unambiguous: true,
      }),
    });

    expect(result.top?.name).toBe('deploy-skill');
  });

  test('routes through llm fallback when enabled', async () => {
    const events: string[] = [];
    const result = await detectWithClassifyFixture('deploy docs', [{
      name: 'deploy-skill',
      description: 'deploy docs',
      triggers: ['deploy'],
      extractedTriggers: [],
      autoTrigger: true,
    }], {
      llmFallback: true,
      keywordScoreThreshold: 2,
      llmConfidenceThreshold: 0.5,
      streamLLM: async (messages) => {
        events.push(String(messages[0]?.content));
        return '{"skill":"deploy-skill","confidence":0.9}';
      },
      detectKeyword: () => ({ top: null, candidates: [], unambiguous: false }),
      detectWithLLM: async (_text, _index, opts) => {
        const verdict = await opts.classify?.('prompt');
        expect(verdict).toEqual({ skill: 'deploy-skill', confidence: 0.9, reason: undefined });
        return {
          top: {
            name: 'deploy-skill',
            score: 1.8,
            matchedTriggers: [],
            matchedExtractedTriggers: [],
            autoTrigger: true,
            description: 'desc',
          },
          candidates: [{
            name: 'deploy-skill',
            score: 1.8,
            matchedTriggers: [],
            matchedExtractedTriggers: [],
            autoTrigger: true,
            description: 'desc',
          }],
          unambiguous: true,
        };
      },
    });

    expect(events).toEqual(['prompt']);
    expect(result.top?.name).toBe('deploy-skill');
  });

  test('forwards the supplied signal through LLM classification', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await detectWithClassifyFixture('deploy docs', [], {
      llmFallback: true,
      keywordScoreThreshold: 2,
      llmConfidenceThreshold: 0.5,
      signal: controller.signal,
      streamLLM: async (_messages, _onDelta, opts) => {
        receivedSignal = opts.signal;
        return '{"skill":null,"confidence":0}';
      },
      detectKeyword: () => ({ top: null, candidates: [], unambiguous: false }),
      detectWithLLM: async (_text, _index, opts) => {
        await opts?.classify?.('prompt', opts?.signal);
        return { top: null, candidates: [], unambiguous: false };
      },
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe('runAbortableDashboardSkillRoute', () => {
  test('returns an empty detection after abort and cleans up once', async () => {
    let cleanupCalls = 0;
    const result = await runAbortableDashboardSkillRoute({
      attachKeys: (controller) => {
        setTimeout(() => controller.abort(), 10);
        return () => { cleanupCalls += 1; };
      },
      detect: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });

    expect(result).toEqual({
      detection: { candidates: [], top: null, unambiguous: false },
      aborted: true,
    });
    expect(cleanupCalls).toBe(1);
  });

  test('preserves successful detection and cleans up once', async () => {
    let cleanupCalls = 0;
    const detection = { candidates: [], top: null, unambiguous: false };
    const result = await runAbortableDashboardSkillRoute({
      attachKeys: () => () => { cleanupCalls += 1; },
      detect: async () => detection,
    });

    expect(result).toEqual({ detection, aborted: false });
    expect(cleanupCalls).toBe(1);
  });
});
