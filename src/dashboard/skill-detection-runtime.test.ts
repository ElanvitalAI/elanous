import { describe, expect, test, spyOn } from 'bun:test';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import type { LLMClassifyResult } from '../skills/router.js';
import {
  detectDashboardSkillRoute,
  runAbortableDashboardSkillRoute,
  type DashboardSkillDetectionRuntimeDeps,
} from './skill-detection-runtime.js';

type StreamLLMOpts = NonNullable<Parameters<DashboardSkillDetectionRuntimeDeps['streamLLM']>[2]>;

describe('detectDashboardSkillRoute', () => {
  test('LLM classify 경로는 classify role pin(model/provider/usageRole)을 주입 streamLLM에 넘기고 debug 싱크에 site를 남긴다', async () => {
    const seen: StreamLLMOpts[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      setUserConfigOverlay(config => ({
        ...config,
        roleLlm: { ...config.roleLlm, classify: { provider: 'gemini', model: 'dashboard-fixture' } },
      }));
      const detection = await detectDashboardSkillRoute('classify 대상 입력', [], {
        llmFallback: true,
        keywordScoreThreshold: 0,
        llmConfidenceThreshold: 0,
        streamLLM: async (_messages, _onDelta, opts) => {
          seen.push(opts);
          return 'raw-fixture';
        },
        detectKeyword: () => ({ candidates: [], top: null, unambiguous: false }),
        detectWithLLM: async (_userText, _visibleIndex, opts) => {
          await opts?.classify?.('fixture prompt');
          return { candidates: [], top: null, unambiguous: false };
        },
        parseClassifier: raw => raw as unknown as LLMClassifyResult,
      });
      expect(detection).toEqual({ candidates: [], top: null, unambiguous: false });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        model: 'dashboard-fixture',
        provider: llm.PROVIDERS.gemini,
        usageRole: 'classify',
        maxTokens: 120,
        temperature: 0,
      });
      const pin = log.mock.calls.find(([category, event]) => category === 'llm.role-pin' && event === 'resolved')?.[2];
      expect(pin).toMatchObject({
        site: 'skill-detection-runtime',
        role: 'classify',
        model: 'dashboard-fixture',
        provider: 'gemini',
        source: 'config-role',
      });
    } finally {
      log.mockRestore();
      setUserConfigOverlay(null);
    }
  });

  test('llmFallback=false 키워드 전용 경로는 streamLLM 호출과 role-pin 기록 없이 키워드 탐지를 반환한다', async () => {
    const streamCalls: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const detection = await detectDashboardSkillRoute('keyword only', [], {
        llmFallback: false,
        keywordScoreThreshold: 0,
        llmConfidenceThreshold: 0,
        streamLLM: async () => {
          streamCalls.push('streamLLM');
          return 'raw-fixture';
        },
        detectKeyword: () => ({ candidates: [], top: null, unambiguous: false }),
        detectWithLLM: async () => {
          throw new Error('llm classify must not run when llmFallback=false');
        },
      });
      expect(detection).toEqual({ candidates: [], top: null, unambiguous: false });
      expect(streamCalls).toEqual([]);
      expect(log.mock.calls.find(([category, event]) => category === 'llm.role-pin' && event === 'resolved')).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});

describe('runAbortableDashboardSkillRoute', () => {
  test('탐지 중 ESC abort는 EMPTY_DETECTION와 aborted=true, cleanup 1회로 돌아간다', async () => {
    let cleanups = 0;
    const result = await runAbortableDashboardSkillRoute({
      attachKeys: controller => {
        controller.abort();
        return () => {
          cleanups += 1;
        };
      },
      detect: async signal => {
        if (signal.aborted) throw new Error('aborted during detect');
        return { candidates: [], top: null, unambiguous: false };
      },
    });
    expect(result).toEqual({
      detection: { candidates: [], top: null, unambiguous: false },
      aborted: true,
    });
    expect(cleanups).toBe(1);
  });
});
