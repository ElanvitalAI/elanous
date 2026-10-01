import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUserConfig } from '../user-config.js';
import { USER_CONFIG_VERSION } from './config/types.js';
import { SKILLS_STEP_COMMAND, UNATTENDED_SETUP_COMMAND, unattendedSetupHint } from '../onboarding/entry-hints.js';
import {
  checkSetupStatus,
  readNexusSetupMode,
  setupBootMode,
  setupModeBootPlan,
  type SetupCheckResult,
  type SetupItem,
} from './setup-status.js';

function requiredItem(id: 'llm' | 'pwa-build', label: string, passed: boolean): SetupItem {
  return { id, label, passed, hint: '' };
}

test('empty setup status keeps the five checks and gives actionable onboarding hints', () => {
  const cfg = buildUserConfig();
  cfg.llm = { provider: 'local' };
  cfg.skills = { ...cfg.skills, activeSet: 'custom', dirs: ['/not-an-existing-skill-dir'] };
  const result = checkSetupStatus({
    cfg,
    nexusCfg: { version: USER_CONFIG_VERSION, global: {}, tabs: {} },
    pwaBuilt: false,
    exists: () => false,
  });
  expect(result.required.map(({ id, passed }) => ({ id, passed }))).toEqual([
    { id: 'llm', passed: false }, { id: 'pwa-build', passed: false },
  ]);
  expect(result.recommended.map(({ id, passed }) => ({ id, passed }))).toEqual([
    { id: 'channel-bot', passed: false }, { id: 'skill-dirs', passed: false },
    { id: 'os-install', passed: false },
  ]);
  expect(result.ok).toBe(false);
  for (const item of [result.required[0], result.recommended[0], result.recommended[1]]) {
    expect(item!.hint).toContain(unattendedSetupHint());
    expect(item!.hint).toContain(UNATTENDED_SETUP_COMMAND);
    expect(item!.hint).not.toContain('elanous setup --non-interactive --config');
  }
  expect(result.recommended[1]!.hint).toContain(SKILLS_STEP_COMMAND);
  expect(result.recommended[1]!.hint).toContain('create the missing skill directories');
  expect(result.required[0]!.hint).toContain('elanous onboarding llm');
  expect(result.required[1]!.hint).toBe('run `elanous nexus build`');
});

test('existing skill directory retains the passed status without a missing-dir hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-setup-skills-'));
  try {
    const cfg = buildUserConfig();
    cfg.llm = { provider: 'local', baseUrl: 'http://localhost:11434/v1' };
    cfg.skills = { ...cfg.skills, activeSet: 'custom', dirs: [dir] };
    const result = checkSetupStatus({
      cfg,
      nexusCfg: { version: USER_CONFIG_VERSION, global: {}, tabs: {} },
      pwaBuilt: true,
      exists: (path) => path === dir,
    });
    expect(result.ok).toBe(true);
    expect(result.recommended[1]).toMatchObject({
      id: 'skill-dirs', passed: true, detail: '1 dir · 1 exist',
      hint: '',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
