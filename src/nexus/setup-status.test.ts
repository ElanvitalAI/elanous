import { describe, expect, test } from 'bun:test';

import {
  readNexusSetupMode,
  setupBootMode,
  setupModeBootPlan,
  type SetupCheckResult,
  type SetupItem,
} from './setup-status.js';

function requiredItem(id: 'llm' | 'pwa-build', label: string, passed: boolean): SetupItem {
  return { id, label, passed, hint: '' };
}

describe('setupBootMode', () => {
  test('required 전부 통과 → normal', () => {
    expect(setupBootMode({
      ok: true,
      required: [requiredItem('llm', 'LLM provider', true), requiredItem('pwa-build', 'PWA build', true)],
      recommended: [],
    })).toEqual({ mode: 'normal', missing: [] });
  });

  test('LLM 만 실패 → setup', () => {
    expect(setupBootMode({
      ok: false,
      required: [requiredItem('llm', 'LLM provider', false), requiredItem('pwa-build', 'PWA build', true)],
      recommended: [],
    })).toEqual({ mode: 'setup', missing: ['LLM provider'] });
  });

  test('PWA 빌드 실패(LLM 통과) → refuse', () => {
    expect(setupBootMode({
      ok: false,
      required: [requiredItem('llm', 'LLM provider', true), requiredItem('pwa-build', 'PWA build', false)],
      recommended: [],
    })).toEqual({ mode: 'refuse', missing: ['PWA build'] });
  });

  test('둘 다 실패 → refuse', () => {
    expect(setupBootMode({
      ok: false,
      required: [requiredItem('llm', 'LLM provider', false), requiredItem('pwa-build', 'PWA build', false)],
      recommended: [],
    })).toEqual({ mode: 'refuse', missing: ['LLM provider', 'PWA build'] });
  });
});

describe('setupModeBootPlan', () => {
  test('true 면 daemon·channel-bot 과 discovery·devices 를 건너뛰고 pwa-host 는 남긴다', () => {
    const plan = setupModeBootPlan(true);
    expect(plan.skipTabKinds).toContain('channel-bot');
    expect(plan.skipTabKinds).toContain('daemon');
    expect(plan.skipTabKinds).not.toContain('pwa-host');
    expect(plan.skipCrons).toEqual(['discovery', 'devices']);
  });

  test('false 면 두 배열이 비어 있다', () => {
    expect(setupModeBootPlan(false)).toEqual({ skipTabKinds: [], skipCrons: [] });
  });
});

describe('readNexusSetupMode', () => {
  function llmOnlyMissing(): SetupCheckResult {
    return {
      ok: false,
      required: [
        { id: 'llm', label: 'LLM provider', passed: false, hint: '' },
        { id: 'pwa-build', label: 'PWA build', passed: true, hint: '' },
      ],
      recommended: [],
    };
  }

  test('ELANOUS_NEXUS_SETUP_MODE=1 이고 LLM 만 빠지면 setupMode 와 LLM label', () => {
    const read = readNexusSetupMode({ ELANOUS_NEXUS_SETUP_MODE: '1' }, llmOnlyMissing);
    expect(read.setupMode).toBe(true);
    expect(read.setupMissing).toEqual(['LLM provider']);
  });

  test('env 가 없으면 setupMode false 이고 check 를 부르지 않는다', () => {
    let calls = 0;
    const read = readNexusSetupMode({}, () => {
      calls += 1;
      return llmOnlyMissing();
    });
    expect(read).toEqual({ setupMode: false, setupMissing: [] });
    expect(calls).toBe(0);
  });
});
