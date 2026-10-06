import { describe, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../chat/index.js';
import { FEATURE_MATURITY } from './feature-maturity.js';
import { botUnavailableSlashReply, deriveTuiSlashAvailability, formatBotUnavailableSlashReply } from './tui-slash-availability.js';
import { slashMaturity, slashVisibleFor } from './tui-slash-maturity.js';

describe('deriveTuiSlashAvailability', () => {
  test('projects every registered canonical TUI command in registry order with its grade and bot availability', () => {
    const entries = deriveTuiSlashAvailability();
    expect(entries.map(({ name }) => name)).toEqual(SLASH_COMMANDS.map(({ name }) => name));
    for (const entry of entries) {
      expect(entry.maturity).toBe(FEATURE_MATURITY.tuiSlash[entry.name as keyof typeof FEATURE_MATURITY.tuiSlash]);
      expect(entry.telegram).toBe(Object.hasOwn(FEATURE_MATURITY.telegramCommand, entry.name));
      expect(entry.discord).toBe(Object.hasOwn(FEATURE_MATURITY.discordCommand, entry.name));
    }
    expect(entries.length).toBeGreaterThan(0);
    for (const surface of ['telegram', 'discord'] as const) {
      const graded = new Set(Object.keys(FEATURE_MATURITY[`${surface}Command`]));
      expect(entries.filter((entry) => entry[surface]).map(({ name }) => name).sort())
        .toEqual(SLASH_COMMANDS.filter(({ name }) => graded.has(name)).map(({ name }) => name).sort());
    }
  });

  test('formats the existing per-surface reply while hiding system and available entries', () => {
    const entry = { name: 'model', maturity: 'stable', telegram: false, discord: false } as const;
    expect(formatBotUnavailableSlashReply('model', 'telegram'))
      .toBe('/model은(는) 텔레그램에서 아직 지원되지 않습니다. TUI에서 /model을(를) 사용하세요.');
    expect(botUnavailableSlashReply(entry, 'discord'))
      .toBe('/model은(는) 디스코드에서 아직 지원되지 않습니다. TUI에서 /model을(를) 사용하세요.');
    expect(botUnavailableSlashReply({ ...entry, maturity: 'system' }, 'discord')).toBeNull();
    expect(botUnavailableSlashReply({ ...entry, discord: true }, 'discord')).toBeNull();
    expect(botUnavailableSlashReply(undefined, 'discord')).toBeNull();
  });

  test('preserves existing TUI grade lookup and audience visibility', () => {
    expect(slashMaturity('help')).toBe('stable');
    expect(slashVisibleFor('help', 'general', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('not-registered', 'owner', { showBeta: true })).toBe(false);
  });

  test('reads injected registry and grades rather than requiring an updated expectation list', () => {
    const grades = {
      tuiSlash: { invented: 'beta' },
      telegramCommand: {},
      discordCommand: { invented: 'tool' },
    } as const;
    expect(deriveTuiSlashAvailability([{ name: 'invented' }], grades)).toEqual([
      { name: 'invented', maturity: 'beta', telegram: false, discord: true },
    ]);
    expect(() => deriveTuiSlashAvailability([{ name: 'invented' }], { ...grades, tuiSlash: {} }))
      .toThrow('TUI slash command /invented has no maturity grade');
  });
});
