// Slash-command picker ranking. The previous implementation fell back
// to a char-in-order match on each command's description, which meant
// typing a common 5-letter string like "teleg" polluted the picker with
// every command whose description happened to contain t-e-l-e-g in
// order (e.g. "toggle runtime tracer"). The new scorer drops that path
// and ranks prefix/substring matches explicitly.

import { describe, it, expect, afterEach } from 'bun:test';
import { filterSlashCommands, SLASH_COMMANDS, type SlashCommand } from '../src/chat/index.js';
import { createPickerState, type PickerBufferView } from '../src/chat/pickers/state.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { FEATURE_MATURITY } from '../src/maturity/feature-maturity.js';

describe('MAT1c slash picker visibility', () => {
  afterEach(() => setUserConfigOverlay(null));

  const buf = (text: string): PickerBufferView => ({ lines: [text], lineIdx: 0, colIdx: text.length });
  const setAudience = (tui?: unknown) => setUserConfigOverlay((config) => ({
    ...config, raw: { ...config.raw, tui },
  }));
  const picker = () => createPickerState({ commands: SLASH_COMMANDS });
  const names = (state: ReturnType<typeof picker>) => state.slashFiltered(buf('/')).map(({ name }) => name);

  it('keeps every command visible for absent or invalid role (owner)', () => {
    for (const tui of [undefined, { role: 'unknown' }]) {
      setAudience(tui);
      expect(names(picker())).toEqual(filterSlashCommands('', SLASH_COMMANDS).map(({ name }) => name));
    }
  });

  it('preserves a supplied command absent from the maturity catalogue for owner only', async () => {
    const state = createPickerState({ commands: [{ name: 'ghost', description: 'External registered slash' }] });
    for (const role of ['general', 'contributor'] as const) {
      setAudience({ role });
      expect(state.slashFiltered(buf('/ghost')).map(({ name }) => name)).not.toContain('ghost');
      expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, buf('/gh'))).toEqual({ consumed: false });
      expect(await state.dispatch({ name: 'enter' } as import('../src/tui.js').Key, buf('/ghost'))).toEqual({ consumed: false });
    }
    setAudience({ role: 'owner' });
    expect(state.slashFiltered(buf('/ghost')).map(({ name }) => name)).toEqual(['ghost']);
    expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, buf('/gh'))).toMatchObject({
      consumed: true, action: { kind: 'splice', text: '/ghost' },
    });
  });

  it('general hides tool and ops; showBeta adds beta only', () => {
    setAudience({ role: 'general' });
    const state = picker();
    expect(names(state)).toContain('help');
    expect(names(state)).not.toContain('research');
    for (const name of names(state)) expect(FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash]).toBe('stable');
    setAudience({ role: 'general', showBeta: true });
    expect(names(state)).toContain('research');
    for (const name of names(state)) expect(['stable', 'beta']).toContain(FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash]);
    expect(names(state)).not.toContain('debug');
    expect(names(state)).not.toContain('directive');
  });

  it('contributor sees tool and beta but not ops', () => {
    setAudience({ role: 'contributor' });
    const visible = names(picker());
    expect(visible).toContain('research');
    expect(visible).toContain('debug');
    expect(visible).not.toContain('directive');
    for (const name of visible) expect(FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash]).not.toBe('ops');
  });

  it('hidden slash is not suggested or autocompleted but exact typed name passes through Enter', async () => {
    setAudience({ role: 'general' });
    const state = picker();
    const typed = buf('/directive');
    await state.refresh(typed);
    expect(state.slashFiltered(typed)).toEqual([]);
    expect(await state.dispatch({ name: 'tab' } as import('../src/tui.js').Key, typed)).toEqual({ consumed: false });
    expect(await state.dispatch({ name: 'enter' } as import('../src/tui.js').Key, typed)).toEqual({ consumed: false });
    expect(state.mode(typed)).toBe('slash');
  });
});

describe('filterSlashCommands', () => {
  it('reorders only existing essential commands without changing the order of others', () => {
    const names = filterSlashCommands('', SLASH_COMMANDS).map(c => c.name);
    expect(names).not.toContain('new');
    expect(names.slice(0, 9)).toEqual([
      'help', 'resume', 'model', 'clear', 'status', 'now', 'wish', 'remaining', 'setup',
    ]);
    expect(names.slice(9)).toEqual([
      'quit', 'run-skill', 'ad', 'design', 'provider', 'reasoning', 'local', 'session', 'fork',
      'rewind', 'mission', 'resume-turn', 'context', 'paste', 'sync', 'plugin',
      'widget', 'log', 'memory', 'export', 'delta', 'theme', 'debug', 'rebind',
      'api-allow', 'prompt', 'history', 'research', 'harness', 'plan', 'chat',
      'dashboard', 'telegram', 'tablet', 'surface', 'term', 'claude', 'codex',
      'gemini', 'acp', 'conv', 'handoff', 'agent-room', 'showroom', 'reply',
      'capture', 'inject', 'relay', 'lane', 'control', 'default', 'qc', 'voice-chat',
      'auto-tts', 'directive',
    ]);
  });

  it('returns the input list unchanged for empty text', () => {
    const out = filterSlashCommands('', SLASH_COMMANDS);
    expect(out).toEqual(SLASH_COMMANDS);
  });

  it('prefers prefix-on-name over every other match kind', () => {
    const out = filterSlashCommands('teleg', SLASH_COMMANDS);
    expect(out[0]?.name).toBe('telegram');
  });

  it('does not include commands whose description char-in-order matches "teleg"', () => {
    // The old fuzzy path matched `/debug` ("Toggle runtime tracer…")
    // because 't' 'e' 'l'? no — the letters of "teleg" appear in
    // "Toggle runtime tracer: LLM req/resp + plugin dispatch → log
    // file + chat mirror" in order. Under the new rules, nothing
    // besides /telegram itself should match "teleg".
    const names = filterSlashCommands('teleg', SLASH_COMMANDS).map(c => c.name);
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
