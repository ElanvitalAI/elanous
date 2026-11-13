// Source-grep guard for the unified telegram inbound (2026-07-05).
//
// The nexus-hosted telegram bot was trigger-only (onMessage = no-op), so
// the bot could poll yet never answer Q&A — and a separate Q&A poller
// 409s against it (one getUpdates consumer per token). This wire makes
// the ONE nexus bot answer Q&A (botFromConfig) while still firing
// triggers (onTriggerTap). Per feedback_dep_inject_seam_must_be_wired +
// feedback_source_level_grep_test_value: guard the seam so a refactor
// can't silently drop back to trigger-only.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf-8');

describe('nexus telegram unified inbound (Q&A + triggers)', () => {
  const factory = read('src/nexus/api/telegram-trigger-bot.ts');
  const boot = read('src/nexus/index.ts');

  test('factory builds the Q&A bot via botFromConfig when userConfig is set', () => {
    expect(factory).toMatch(/import\s*\{[^}]*botFromConfig[^}]*\}\s*from\s*['"]\.\.\/\.\.\/telegram(\.js)?['"]/s);
    expect(factory).toMatch(/opts\.userConfig[\s\S]{0,400}?botFromConfig\(\{/);
  });

  test('the Q&A bot still carries the workflow trigger tap', () => {
    // onTriggerTap must be threaded through telegramBotOpts so one bot
    // does both roles.
    expect(factory).toMatch(/botFromConfig\(\{[\s\S]*telegramBotOpts:\s*\{[\s\S]*onTriggerTap/);
  });

  test('trigger-only fallback preserved when no userConfig', () => {
    expect(factory).toMatch(/onMessage:\s*async\s*\(\)\s*=>\s*undefined/);
  });

  test('nexus boot wires the trigger bot factory to channel-scoped Q&A config', () => {
    // Boot delegates per-channel creation to wireNexusTelegramQaPollers.
    // Assert both concrete edges: the real factory injection and the
    // channel-scoped userConfig forwarded through the injected factory.
    expect(boot).toMatch(/wireNexusTelegramQaPollers\(cfg,\s*workflowDaemon!,\s*\{[\s\S]{0,400}?createTriggerBot:\s*testApiBase[\s\S]{0,200}?:\s*createNexusTelegramTriggerBot/);
    expect(boot).toMatch(/resolveCurrentInstance\(\)\.kind === 'test'[\s\S]{0,120}?telegramTestApiBase\(process\.env\.ELANOUS_TELEGRAM_API_BASE\)/);
    expect(boot).toMatch(/deps\.createTriggerBot\(\{[\s\S]{0,400}?userConfig:\s*channelScopedConfig\b/);
  });
});
