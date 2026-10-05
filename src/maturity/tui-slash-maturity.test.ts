import { describe, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../chat/index';
import { FEATURE_MATURITY } from './feature-maturity';
import { deriveTuiSlashAvailability } from './tui-slash-availability';
import { readTuiSlashAudience, slashVisibleFor } from './tui-slash-maturity';

describe('MAT1c TUI slash audience', () => {
  test('missing or invalid tui config keeps the owner screen unchanged', () => {
    for (const raw of [undefined, null, false, [], {}, { role: 'admin' }, { role: 42 }]) {
      expect(readTuiSlashAudience(raw)).toEqual({ role: 'owner', showBeta: false });
    }
    expect(readTuiSlashAudience({ role: 'general', showBeta: 'true' })).toEqual({ role: 'general', showBeta: false });
  });

  test('recognized roles and exact true showBeta are read independently', () => {
    expect(readTuiSlashAudience({ role: 'general', showBeta: true })).toEqual({ role: 'general', showBeta: true });
    expect(readTuiSlashAudience({ role: 'contributor', showBeta: false })).toEqual({ role: 'contributor', showBeta: false });
    expect(readTuiSlashAudience({ role: 'owner', showBeta: true })).toEqual({ role: 'owner', showBeta: true });
  });
});

describe('MAT1b TUI slash maturity', () => {
  test('every canonical slash name is graded exactly once (no missing, no extra)', () => {
    const names = SLASH_COMMANDS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(FEATURE_MATURITY.tuiSlash).sort()).toEqual([...names].sort());
    expect(deriveTuiSlashAvailability().map(({ name }) => name)).toEqual(names);
  });

  test('a temporary registered command needs no expectation-list update but cannot be missing its grade', () => {
    const name = 'temporary-fake-command';
    const commands = [...SLASH_COMMANDS, { name }];
    const grades = {
      ...FEATURE_MATURITY,
      tuiSlash: { ...FEATURE_MATURITY.tuiSlash, [name]: 'beta' as const },
    };
    expect(deriveTuiSlashAvailability(commands, grades).at(-1)).toEqual({
      name, maturity: 'beta', telegram: false, discord: false,
    });
    expect(() => deriveTuiSlashAvailability(commands, FEATURE_MATURITY))
      .toThrow(`TUI slash command /${name} has no maturity grade`);
  });

  test('wish is beta in the canonical TUI maturity map', () => {
    expect(FEATURE_MATURITY.tuiSlash.wish).toBe('beta');
  });

  test('aliases inherit the canonical grade', () => {
    for (const command of SLASH_COMMANDS) for (const alias of command.aliases ?? [])
      for (const role of ['owner', 'contributor', 'general'] as const) for (const showBeta of [false, true])
        expect(slashVisibleFor(alias, role, { showBeta })).toBe(slashVisibleFor(command.name, role, { showBeta }));
  });

  test('general sees stable only, plus beta with showBeta, never tool or ops', () => {
    expect(slashVisibleFor('help', 'general', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('research', 'general', { showBeta: false })).toBe(false);
    expect(slashVisibleFor('research', 'general', { showBeta: true })).toBe(true);
    for (const command of SLASH_COMMANDS) {
      const grade = FEATURE_MATURITY.tuiSlash[command.name as keyof typeof FEATURE_MATURITY.tuiSlash];
      if (grade === 'tool' || grade === 'ops') expect(slashVisibleFor(command.name, 'general', { showBeta: true })).toBe(false);
    }
  });

  test('operator commands from the registry are excluded from the general palette', () => {
    const operators = deriveTuiSlashAvailability().filter(({ maturity }) => maturity === 'ops');
    expect(operators.length).toBeGreaterThan(0);
    for (const { name } of operators) {
      expect(slashVisibleFor(name, 'general', { showBeta: true })).toBe(false);
      expect(slashVisibleFor(name, 'owner', { showBeta: false })).toBe(true);
    }
  });

  test('contributor sees stable, beta and tool without showBeta; owner sees everything', () => {
    expect(slashVisibleFor('research', 'contributor', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('debug', 'contributor', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('directive', 'contributor', { showBeta: true })).toBe(false);
    for (const command of SLASH_COMMANDS) expect(slashVisibleFor(command.name, 'owner', { showBeta: false })).toBe(true);
  });

  test('unknown names fail closed', () => {
    expect(slashVisibleFor('not-registered', 'owner', { showBeta: true })).toBe(false);
  });
});
