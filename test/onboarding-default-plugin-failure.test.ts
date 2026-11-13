import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboarding } from '../src/onboarding.js';
import { nonInteractiveIO } from '../src/onboarding/non-interactive.js';
import { buildUserConfig, markOnboardingComplete, saveUserConfig } from '../src/user-config.js';

test('failed default plugin install does not mark onboarding complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-onboarding-plugin-failure-'));
  const path = join(root, 'config.json');
  // The installer cannot create a plugin directory over this file.
  writeFileSync(join(root, 'plugins'), 'blocked');
  try {
    const io = nonInteractiveIO({ answers: {
      llm: { provider: 'auto' },
      skills: { activeSet: 'codex' },
      obsidian: { vault: root },
      telegram: { enabled: false },
      discord: { enabled: false },
    }, env: {} });
    await expect(runOnboarding({ path, io })).rejects.toThrow('데모 플러그인');
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed rerun clears a previously completed onboarding marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-onboarding-plugin-rerun-'));
  const path = join(root, 'config.json');
  saveUserConfig(markOnboardingComplete(buildUserConfig(path)), path);
  writeFileSync(join(root, 'plugins'), 'blocked');
  try {
    const io = nonInteractiveIO({ answers: {
      llm: { provider: 'auto' }, skills: { activeSet: 'codex' },
      obsidian: { vault: root }, telegram: { enabled: false }, discord: { enabled: false },
    }, env: {} });
    await expect(runOnboarding({ path, io })).rejects.toThrow('데모 플러그인');
    expect(buildUserConfig(path).onboarding.completed).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
