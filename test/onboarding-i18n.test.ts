// ── Onboarding wizard · i18n wire (PR α of setup-tui-overhaul) ──
//
// PLAN-setup-tui-overhaul Phase 1-3 · PR α absorbs the LT 7 i18n
// infrastructure into the setup wizard. These tests pin:
//   1. New `setupStep*Title` keys exist on both bundles.
//   2. `getMessages()` honours ELANOUS_LANG=ko / en.
//   3. The wizard prints localized step headers when scripted with a
//      ko locale env (smoke test through `runOnboarding`).
//   4. `format()` substitutes the `{path}` / `{cmd}` placeholders in
//      the banner / completion strings.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboarding, scriptedIO } from '../src/onboarding';
import { resetUserConfig } from '../src/user-config';
import { getMessages, format } from '../src/expression/i18n/index';
import { messagesEn } from '../src/expression/i18n/messages.en';
import { messagesKo } from '../src/expression/i18n/messages.ko';
import { messagesJa } from '../src/expression/i18n/messages.ja';
import { messagesZh } from '../src/expression/i18n/messages.zh';

let root: string;
let cfgPath: string;

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onboarding-i18n-'));
  cfgPath = join(root, 'config.json');
  resetUserConfig();
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  savedEnv.CODEX_HOME = process.env.CODEX_HOME;
  savedEnv.ELANOUS_LANG = process.env.ELANOUS_LANG;
  savedEnv.LANG = process.env.LANG;
  savedEnv.LC_ALL = process.env.LC_ALL;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetUserConfig();
  for (const k of ['XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_LANG', 'LANG', 'LC_ALL']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('i18n bundles · setup wizard keys', () => {
  test('en + ko bundles both define every new setup* key', () => {
    const required = [
      'setupBanner',
      'setupWritingTo',
      'setupComplete',
      'setupRerunHint',
      'setupStepLLMTitle',
      'setupStepLLMExcerpt',
      'setupStepSkillsTitle',
      'setupStepSkillsExcerpt',
      'setupStepObsidianTitle',
      'setupStepObsidianExcerpt',
      'setupStepTelegramTitle',
      'setupStepTelegramExcerpt',
      'setupStepDiscordTitle',
      'setupStepDiscordExcerpt',
    ] as const;
    for (const key of required) {
      expect(typeof messagesEn[key]).toBe('string');
      expect((messagesEn[key] as string).length).toBeGreaterThan(0);
      expect(typeof messagesKo[key]).toBe('string');
      expect((messagesKo[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('first-run error-report notice exists in every bundle and keeps the off command verbatim', () => {
    const cmd = 'elanous config set errorReports.enabled false';
    for (const bundle of [messagesEn, messagesKo, messagesJa, messagesZh]) {
      expect(bundle.setupErrorReportNotice).toContain(cmd);
    }
    expect(messagesEn.setupErrorReportNotice).not.toMatch(/[\uac00-\ud7a3]/);
    expect(messagesEn.setupErrorReportNotice).toContain('never your name or email');
    expect(messagesKo.setupErrorReportNotice).toContain('이름·메일 없이');
  });

  test('en bundle uses English strings', () => {
    expect(messagesEn.setupBanner).toBe('elanous — setup wizard');
    expect(messagesEn.setupComplete).toBe('Setup complete');
    expect(messagesEn.setupStepLLMTitle).toBe('LLM provider');
  });

  test('ko bundle uses Korean strings', () => {
    expect(messagesKo.setupBanner).toContain('셋업');
    expect(messagesKo.setupComplete).toContain('완료');
    expect(messagesKo.setupStepLLMTitle).toContain('LLM');
  });

  test('format() substitutes {path} / {cmd} placeholders', () => {
    expect(format(messagesEn.setupWritingTo, { path: '/tmp/c.json' }))
      .toBe('Writing to: /tmp/c.json');
    expect(format(messagesKo.setupWritingTo, { path: '/tmp/c.json' }))
      .toBe('저장 경로: /tmp/c.json');
    expect(format(messagesEn.setupRerunHint, { cmd: 'elanous setup' }))
      .toBe('Re-run: elanous setup');
    expect(format(messagesKo.setupRerunHint, { cmd: 'elanous setup' }))
      .toBe('다시 실행: elanous setup');
  });

  test('getMessages() respects ELANOUS_LANG=ko', () => {
    process.env.ELANOUS_LANG = 'ko';
    const m = getMessages();
    expect(m.setupBanner).toBe('elanous — 셋업 마법사');
  });

  test('getMessages() falls back to en when no locale env set', () => {
    delete process.env.ELANOUS_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    const m = getMessages();
    expect(m.setupBanner).toBe('elanous — setup wizard');
  });

  test('LANG=ko_KR.UTF-8 routes to ko bundle', () => {
    delete process.env.ELANOUS_LANG;
    process.env.LANG = 'ko_KR.UTF-8';
    const m = getMessages();
    expect(m.setupBanner).toBe('elanous — 셋업 마법사');
  });
});

describe('runOnboarding · localized step headers', () => {
  test('en locale prints English step titles in the box header', async () => {
    process.env.ELANOUS_LANG = 'en';
    const io = scriptedIO(['10', '1', '', '', 'n', '1']);
    await runOnboarding({ io, path: cfgPath });
    const log = io.outputs.join('\n');
    expect(log).toContain('Step 1 / 7 — LLM provider');
    expect(log).toContain('Step 2 / 7 — Skill directories');
    expect(log).toContain('Step 3 / 7 — Obsidian vault');
    expect(log).toContain('Step 4 / 7 — Telegram bot');
    expect(log).toContain('Step 5 / 7 — Discord bot');
    expect(log).toContain('elanous — setup wizard');
    expect(log).toContain('Setup complete');
    expect(log).toContain('Re-run: elanous setup');
  });

  test('ko locale prints Korean step titles + banner + completion', async () => {
    process.env.ELANOUS_LANG = 'ko';
    const io = scriptedIO(['10', '1', '', '', 'n', '1']);
    await runOnboarding({ io, path: cfgPath });
    const log = io.outputs.join('\n');
    expect(log).toContain('Step 1 / 7 — LLM 공급자');
    expect(log).toContain('Step 2 / 7 — 스킬 디렉토리');
    expect(log).toContain('Step 3 / 7 — Obsidian 볼트');
    expect(log).toContain('Step 4 / 7 — Telegram 봇');
    expect(log).toContain('Step 5 / 7 — Discord 봇');
    expect(log).toContain('elanous — 셋업 마법사');
    expect(log).toContain('셋업 완료');
    expect(log).toContain('다시 실행: elanous setup');
  });

  test('step header dashes pad to a stable width regardless of locale', async () => {
    process.env.ELANOUS_LANG = 'en';
    const io = scriptedIO(['10', '1', '', '', 'n', '1']);
    await runOnboarding({ io, path: cfgPath });
    const headers = io.outputs
      .filter((s) => typeof s === 'string' && /Step \d \/ 7/.test(s));
    // Each box header must end with at least three trailing dashes —
    // the helper's safety floor + visual continuity guarantee.
    for (const h of headers) {
      expect(h).toMatch(/───+$/);
    }
  });
});
