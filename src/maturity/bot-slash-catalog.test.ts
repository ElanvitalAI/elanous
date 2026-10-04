import { describe, expect, test } from 'bun:test';
import { FEATURE_MATURITY } from './feature-maturity.js';
import { buildBotSlashCatalog } from './bot-slash-catalog.js';

const maturity = FEATURE_MATURITY;

describe('buildBotSlashCatalog', () => {
  test('projects the core registry for each channel without claiming dispatched commands are unsupported', () => {
    const coreCommands = [
      { name: 'status', description: 'Core status' },
      { name: 'relay', description: 'Core relay' },
      { name: 'showroom', description: 'Core showroom' },
      { name: 'model', description: 'Core model' },
      { name: 'nonexistent', description: 'Not graded' },
      { name: 'run-skill', description: 'Run skill' },
    ];
    const telegram = buildBotSlashCatalog({
      surface: 'telegram', coreCommands, maturity,
      handledCommands: [{ name: 'status', description: 'Actual Telegram status' }, { name: 'relay', description: 'Actual Telegram relay' }],
    });
    expect(telegram.commands.find((entry) => entry.name === 'status')).toEqual({
      name: 'status', description: 'Actual Telegram status', supported: true,
    });
    expect(telegram.unsupportedReply('status')).toBeNull();
    expect(telegram.unsupportedReply('relay')).toBeNull();
    expect(telegram.commands.some((entry) => entry.name === 'nonexistent')).toBe(false);
    expect(telegram.commands.some((entry) => entry.name === 'run-skill')).toBe(false); // Telegram cannot register hyphenated names.
    expect(telegram.commands.some((entry) => entry.name === 'model')).toBe(false);
    expect(telegram.unsupportedReply('model')).toBeNull();
    expect(telegram.unsupportedReply('not-in-registry')).toBeNull();
    const unsupportedTelegram = buildBotSlashCatalog({
      surface: 'telegram', coreCommands: [{ name: 'harness', description: 'Core harness' }], maturity,
      handledCommands: [],
    });
    expect(unsupportedTelegram.commands).toEqual([{ name: 'harness', description: 'Core harness (텔레그램 미지원)', supported: false }]);
    expect(unsupportedTelegram.unsupportedReply('harness')).toBe('/harness은(는) 텔레그램에서 아직 지원되지 않습니다. TUI에서 /harness을(를) 사용하세요.');

    const discord = buildBotSlashCatalog({
      surface: 'discord', coreCommands, maturity,
      handledCommands: [
        { name: 'status', description: 'Actual Discord status' },
        { name: 'relay', description: 'Actual Discord relay' },
        { name: 'showroom', description: 'Actual Discord showroom' },
      ],
    });
    for (const name of ['status', 'relay', 'showroom']) {
      expect(discord.commands.find((entry) => entry.name === name)?.supported).toBe(true);
      expect(discord.unsupportedReply(name)).toBeNull();
    }
    expect(discord.commands.some((entry) => entry.name === 'run-skill')).toBe(false);
    expect(discord.unsupportedReply('run-skill')).toBeNull();
    const unsupportedDiscord = buildBotSlashCatalog({
      surface: 'discord', coreCommands: [{ name: 'persona', description: 'Core persona' }], maturity,
      handledCommands: [],
    });
    expect(unsupportedDiscord.commands).toEqual([{ name: 'persona', description: 'Core persona (디스코드 미지원)', supported: false }]);
    expect(unsupportedDiscord.unsupportedReply('persona')).toBe('/persona은(는) 디스코드에서 아직 지원되지 않습니다. TUI에서 /persona을(를) 사용하세요.');
    expect(unsupportedDiscord.unsupportedReply('persona')?.includes('\n')).toBe(false);
  });

  test('refuses to silently drop commands when the channel registration limit is exceeded', () => {
    const handledCommands = Array.from({ length: 25 }, (_, index) => ({ name: `handled${index}`, description: 'Works' }));
    expect(() => buildBotSlashCatalog({
      surface: 'discord', coreCommands: [{ name: 'persona', description: 'Core persona' }], maturity, handledCommands,
    })).toThrow('discord command catalog exceeds 25 slots');
  });

  test('uses actual handler set rather than treating a missing or system grade as a nonworking command', () => {
    const catalog = buildBotSlashCatalog({
      surface: 'telegram', coreCommands: [
        { name: 'now', description: 'Core now' },
        { name: 'status', description: 'Core status' },
        { name: 'model', description: 'Core model' },
      ], maturity,
      handledCommands: [
        { name: 'now', description: 'Working now' },
        { name: 'cc_clear', description: 'Working clear' },
        { name: 'status', description: 'Working status' },
      ],
    });
    for (const name of ['now', 'cc_clear', 'status']) {
      expect(catalog.unsupportedReply(name)).toBeNull();
      expect(catalog.commands.find((entry) => entry.name === name)?.supported).toBe(true);
    }
    expect(catalog.commands.filter((entry) => entry.name === 'status')).toHaveLength(1);
    expect(catalog.unsupportedReply('model')).toBeNull();
  });
});
