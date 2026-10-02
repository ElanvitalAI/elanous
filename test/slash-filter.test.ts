// Slash-command picker ranking. The previous implementation fell back
// to a char-in-order match on each command's description, which meant
// typing a common 5-letter string like "teleg" polluted the picker with
// every command whose description happened to contain t-e-l-e-g in
// order (e.g. "toggle runtime tracer"). The new scorer drops that path
// and ranks prefix/substring matches explicitly.

import { describe, it, expect } from 'bun:test';
import { filterSlashCommands, SLASH_COMMANDS, type SlashCommand } from '../src/chat/index.js';

describe('filterSlashCommands', () => {
  it('reorders only existing essential commands without changing the order of others', () => {
    const names = filterSlashCommands('', SLASH_COMMANDS).map(c => c.name);
    expect(names).not.toContain('new');
    expect(names.slice(0, 8)).toEqual([
      'help', 'resume', 'model', 'clear', 'status', 'remaining', 'setup', 'quit',
    ]);
    expect(names.slice(8)).toEqual([
      'run-skill', 'ad', 'design', 'provider', 'reasoning', 'local', 'session', 'fork',
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
