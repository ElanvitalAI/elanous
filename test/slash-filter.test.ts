// Slash-command picker ranking. The previous implementation fell back
// to a char-in-order match on each command's description, which meant
// typing a common 5-letter string like "teleg" polluted the picker with
// every command whose description happened to contain t-e-l-e-g in
// order (e.g. "toggle runtime tracer"). The new scorer drops that path
// and ranks prefix/substring matches explicitly.

import { describe, it, expect, afterEach } from 'bun:test';
import { displayedSlashCommandNames, filterSlashCommands, SLASH_COMMANDS, type SlashCommand } from '../src/chat/index.js';
import { createPickerState, type PickerBufferView } from '../src/chat/pickers/state.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { FEATURE_MATURITY } from '../src/maturity/feature-maturity.js';
import { readTuiSlashAudience, slashVisibleFor } from '../src/maturity/tui-slash-maturity.js';

describe('MAT1c slash picker visibility', () => {
  afterEach(() => setUserConfigOverlay(null));

  const buf = (text: string): PickerBufferView => ({ lines: [text], lineIdx: 0, colIdx: text.length });
  const setAudience = (tui?: unknown) => setUserConfigOverlay((config) => ({
    ...config, raw: { ...config.raw, tui },
  }));
  const picker = () => createPickerState({ commands: SLASH_COMMANDS });
  const names = (state: ReturnType<typeof picker>) => state.slashFiltered(buf('/')).map(({ name }) => name);

  it('keeps every command visible for absent or invalid role (owner)', () => {
    const menuNames = filterSlashCommands('', SLASH_COMMANDS).map(({ name }) => name);
    expect(menuNames).toHaveLength(15);
    for (const tui of [undefined, { role: 'unknown' }]) {
      setAudience(tui);
      expect(names(picker())).toEqual([...menuNames, 'directive']);
    }
    expect(names(picker())).toContain('directive');
    // The compact first-use menu remains a separate, fixed 15-command policy.
    expect(displayedSlashCommandNames()).not.toContain('directive');
  });

  it('legacy role preferences cannot hide the local owner /directive command', async () => {
    const state = picker();
    const ownerNames = names(state);
    for (const role of ['owner', 'general', 'contributor'] as const) {
      for (const showBeta of [false, true]) {
        setAudience({ role, showBeta });
        expect(names(state)).toEqual(ownerNames);
        expect(readTuiSlashAudience()).toEqual({ role: 'owner', showBeta: false });
        expect(state.slashFiltered(buf('/dir')).map(({ name }) => name)).toEqual(['directive']);
        expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, buf('/dir'))).toMatchObject({
          consumed: true, action: { kind: 'splice', text: '/directive' },
        });
      }
    }
  });

  it('owner picker preserves supplied commands absent from the maturity catalogue', async () => {
    const state = createPickerState({ commands: [{ name: 'ghost', description: 'External registered slash' }] });
    for (const role of ['owner', 'general', 'contributor'] as const) {
      setAudience({ role });
      expect(state.slashFiltered(buf('/ghost')).map(({ name }) => name)).toEqual(['ghost']);
      expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, buf('/gh'))).toMatchObject({
        consumed: true, action: { kind: 'splice', text: '/ghost' },
      });
    }
  });

  it('general visibility policy remains explicit while legacy general settings do not change the owner picker', () => {
    const state = picker();
    const ownerNames = names(state);
    setAudience({ role: 'general' });
    expect(names(state)).toEqual(ownerNames);
    expect(ownerNames).toContain('directive');
    setAudience({ role: 'general', showBeta: true });
    expect(names(state)).toEqual(ownerNames);
    expect(slashVisibleFor('help', 'general', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('directive', 'general', { showBeta: true })).toBe(false);
    expect(slashVisibleFor('research', 'general', { showBeta: false })).toBe(false);
    expect(slashVisibleFor('research', 'general', { showBeta: true })).toBe(true);
    expect(slashVisibleFor('debug', 'general', { showBeta: true })).toBe(false);
  });

  it('contributor visibility policy remains explicit while legacy contributor settings do not change the owner picker', () => {
    const ownerNames = names(picker());
    setAudience({ role: 'contributor' });
    expect(names(picker())).toEqual(ownerNames);
    expect(slashVisibleFor('help', 'contributor', { showBeta: false })).toBe(true);
    expect(slashVisibleFor('directive', 'contributor', { showBeta: false })).toBe(false);
    for (const name of Object.keys(FEATURE_MATURITY.tuiSlash)) {
      const grade = FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash];
      if (grade === 'tool' || grade === 'beta') expect(slashVisibleFor(name, 'contributor', { showBeta: false })).toBe(true);
    }
  });

  it('owner sees and autocompletes /directive even with a retired general preference', async () => {
    setAudience({ role: 'general' });
    const state = picker();
    const typed = buf('/directive');
    await state.refresh(typed);
    expect(state.slashFiltered(typed).map(({ name }) => name)).toEqual(['directive']);
    expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, buf('/dir'))).toMatchObject({
      consumed: true, action: { kind: 'splice', text: '/directive' },
    });
    expect(state.mode(typed)).toBe('slash');
  });

});

describe('filterSlashCommands', () => {
  it('keeps registry order while omitting commands outside the 15-item menu', () => {
    const names = filterSlashCommands('', SLASH_COMMANDS).map(c => c.name);
    expect(names).not.toContain('new');
    expect(names).toEqual(SLASH_COMMANDS.filter((command) => !command.hidden).map((command) => command.name));
    for (const visible of ['context', 'remaining', 'session', 'setup', 'decide']) expect(names).toContain(visible);
    expect(names).not.toContain('research');
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns the input list unchanged for empty text', () => {
    const out = filterSlashCommands('', SLASH_COMMANDS);
    expect(out).toEqual(SLASH_COMMANDS.filter((command) => !command.hidden));
  });

  it('prefers prefix-on-name over every other match kind', () => {
    const out = filterSlashCommands('teleg', [
      { name: 'debug', description: 'Toggle runtime tracer: LLM req/resp + plugin dispatch → log file + chat mirror' },
      { name: 'telegram', description: 'Telegram things' },
    ]);
    expect(out[0]?.name).toBe('telegram');
  });

  it('does not include commands whose description char-in-order matches "teleg"', () => {
    // The old fuzzy path matched `/debug` ("Toggle runtime tracer…")
    // because 't' 'e' 'l'? no — the letters of "teleg" appear in
    // "Toggle runtime tracer: LLM req/resp + plugin dispatch → log
    // file + chat mirror" in order. Under the new rules, nothing
    // besides /telegram itself should match "teleg".
    const names = filterSlashCommands('teleg', [
      { name: 'debug', description: 'Toggle runtime tracer: LLM req/resp + plugin dispatch → log file + chat mirror' },
      { name: 'telegram', description: 'Telegram things' },
    ]).map(c => c.name);
    expect(names).toEqual(['telegram']);
  });

  it('ranks prefix-on-alias above substring-on-name', () => {
    const cmds: SlashCommand[] = [
      { name: 'foo-sync', description: 'substring match on name' },
      { name: 'sidebar', aliases: ['sy'], description: 'alias prefix match' },
    ];
    const out = filterSlashCommands('sy', cmds);
    expect(out.map(c => c.name)).toEqual(['sidebar', 'foo-sync']);
  });

  it('matches word-start in description as a last resort', () => {
    const cmds: SlashCommand[] = [
      { name: 'alpha', description: 'nothing related' },
      { name: 'beta', description: 'Telegram things' },
    ];
    const out = filterSlashCommands('telegram', cmds);
    // /telegram doesn't exist here — only `beta` matches via desc word-start.
    expect(out.map(c => c.name)).toEqual(['beta']);
  });

  it('does NOT match mid-word chars in description', () => {
    // "gram" appears inside "Telegram" but not at a word boundary.
    const cmds: SlashCommand[] = [
      { name: 'alpha', description: 'Telegram bot controls' },
    ];
    expect(filterSlashCommands('gram', cmds)).toEqual([]);
  });

  it('orders ties by name ascending', () => {
    const cmds: SlashCommand[] = [
      { name: 'zebra', description: '' },
      { name: 'apple', description: '' },
      { name: 'mango', description: '' },
    ];
    // All three substring-match "a"; names sort alphabetically.
    const out = filterSlashCommands('a', cmds);
    expect(out.map(c => c.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('handles regex metacharacters safely', () => {
    const cmds: SlashCommand[] = [
      { name: 'regex', description: 'contains . and *' },
    ];
    // The dot is a regex metachar; must be escaped before being
    // compiled into the word-start check.
    expect(() => filterSlashCommands('.*', cmds)).not.toThrow();
  });
});
