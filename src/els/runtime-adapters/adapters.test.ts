// ELS-RUNTIME-ADAPTERS — detection, screen status, insert ops (never Enter), registry fallback. Literal expectations.
import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterFor, ANY_SCREEN, detectRuntime, quotePath, screenRulesFor, shellQuote } from './index.js';

const noEnter = (ops: ReadonlyArray<{ kind: string; text?: string; bytes?: string }>): boolean => ops.every((op) => !/[\r\n]/.test(op.text ?? op.bytes ?? ''));

describe('detect (the executable past wrappers decides)', () => {
  test('agents, shells, wrappers, other', () => {
    expect(detectRuntime({ cmdline: ['/usr/local/bin/claude', '--resume'] })).toBe('claude');
    expect(detectRuntime({ cmdline: ['codex', '-p', 'seat'] })).toBe('codex');
    expect(detectRuntime({ cmdline: ['bun', '/x/bin/elanous.mjs'] })).toBe('eln');
    expect(detectRuntime({ cmdline: ['node', 'npx', 'grok'] })).toBe('grok');
    expect(detectRuntime({ cmdline: ['-zsh'] })).toBe('shell');
    expect(detectRuntime({ cmdline: ['vim', 'claude'] })).toBeUndefined();          // an argument never decides
    expect(detectRuntime({ cmdline: [] })).toBeUndefined();
  });
  test('registry: recorded kind → adapter; unknown → shell fallback', () => {
    expect(adapterFor('claude').id).toBe('claude');
    expect(adapterFor('other').id).toBe('shell');
    expect(adapterFor(undefined).id).toBe('shell');
    expect(adapterFor('__proto__').id).toBe('shell');
    expect(ADAPTERS.map((one) => [one.id, one.capabilities.attach])).toEqual([['eln', true], ['claude', true], ['codex', true], ['grok', true], ['shell', false]]);
    expect(ADAPTERS.map((one) => one.label ?? '')).toEqual(['', 'claude-code', 'codex-cli', 'grok-cli', '']);
  });
});

describe('insertAttachment / insertText / interrupt', () => {
  const pane = { pane: 'p1' };
  test('@-mentions for eln, Claude Code and codex; quoted when a path has spaces or Korean; trailing space, no Enter', () => {
    expect(adapterFor('claude').insertAttachment(pane, ['/v/notes/a.md'])).toEqual([{ kind: 'paste', text: '@/v/notes/a.md ' }]);
    expect(adapterFor('codex').insertAttachment(pane, ['/v/my note.md', '/v/b.md'])).toEqual([{ kind: 'paste', text: '@"/v/my note.md" @/v/b.md ' }]);
    expect(adapterFor('eln').insertAttachment(pane, ['/v/회의.md'])).toEqual([{ kind: 'paste', text: '@"/v/회의.md" ' }]);
    expect(adapterFor('grok').insertAttachment(pane, ["/v/it's.md"])).toEqual([{ kind: 'paste', text: `'/v/it'\\''s.md' ` }]);
    expect(adapterFor('claude').insertAttachment(pane, [])).toEqual([]);
  });
  test('no op ever carries Enter; text control bytes become spaces', () => {
    for (const one of ADAPTERS) {
      expect(noEnter(one.insertAttachment(pane, ['/a b/c.md', '/x\ny.md']))).toBe(true);
      expect(noEnter(one.insertText(pane, 'line1\r\nline2'))).toBe(true);
    }
    expect(adapterFor('eln').insertText(pane, 'a\rb')).toEqual([{ kind: 'paste', text: 'a b' }]);
    expect(adapterFor('claude').interrupt(pane)).toEqual([{ kind: 'keys', bytes: '\u001b' }]);
    expect(adapterFor('shell').interrupt(pane)).toEqual([{ kind: 'keys', bytes: '\u0003' }]);
  });
  test('quoting helpers', () => {
    expect(quotePath('/a/b.md')).toBe('/a/b.md');
    expect(quotePath('/a/"q".md')).toBe('"/a/\\"q\\".md"');
    expect(shellQuote('/a b')).toBe("'/a b'");
  });
});

describe('status(screen)', () => {
  test('eln: Turn running / esc to interrupt = busy · approval panel = asking · prompt = idle · exited', () => {
    const eln = adapterFor('eln');
    expect(eln.status('⠋ Thinking (3s • esc to interrupt)\n❯ ')).toBe('busy');
    expect(eln.status('Turn running\n❯ ')).toBe('busy');
    expect(eln.status('Run bash?\n y run · Enter default N · Esc deny')).toBe('asking');
    expect(eln.status('done\n❯ ')).toBe('idle');
    expect(eln.status('anything', true)).toBe('exited');
  });
  test('claude / codex', () => {
    expect(adapterFor('claude').status('✻ Cogitating… (esc to interrupt)\n│ > │')).toBe('busy');
    expect(adapterFor('claude').status('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBe('asking');
    expect(adapterFor('codex').status('Would you like to run the following command?\n y yes  n no')).toBe('asking');
    expect(adapterFor('codex').status('› ')).toBe('idle');
  });
  test('screen rules: a known kind reads its own prompt; unknown reads every runtime (the pre-adapter rules)', () => {
    expect(screenRulesFor('codex').prompt?.exec('› hello')?.[1]).toBe('hello');
    expect(screenRulesFor('eln').prompt?.exec('│ > x │')).toBeNull();
    expect(screenRulesFor('claude').prompt?.exec('❯ @/a.md')?.[1]).toBe('@/a.md');          // Claude Code 2.x prompt row
    expect(screenRulesFor('claude').prompt?.exec('│ > old │')?.[1]).toBe('old');
    expect(screenRulesFor(undefined)).toBe(ANY_SCREEN);
    expect(ANY_SCREEN.prompt.exec('❯ a')?.[1]).toBe('a');
    expect(ANY_SCREEN.prompt.exec('│ > b │')?.[1]).toBe('b');
  });
});
