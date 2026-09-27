import { describe, expect, test } from 'bun:test';

import { expandPromptReferences } from '../src/prompt/references.js';
import type { TerminalSessionRegistry, TerminalSession } from '../src/terminal/session-registry.js';

/** Minimal TerminalSessionRegistry stub — just enough surface
 *  (get + list) for the @term expander to run. Avoids pulling in
 *  node-pty / PreviewTerminal for this unit test. */
function makeFakeRegistry(sessions: Array<{ id: string; title: string; render: string; cwd?: string }>): TerminalSessionRegistry {
  const arr: TerminalSession[] = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd ?? '/tmp',
    kind: 'shell',
    state: 'foreground',
    startedAt: 0,
    lastFocusedAt: 0,
    exitCode: null,
    attentionLevel: 0,
    preview: {
      render: () => s.render,
    } as unknown as TerminalSession['preview'],
    modal: null,
  } as unknown as TerminalSession));
  return {
    get: (id: string) => arr.find(s => s.id === id),
    list: () => arr,
  } as unknown as TerminalSessionRegistry;
}

describe('expandPromptReferences', () => {
  test('passes input untouched when no @ token is present', () => {
    const registry = makeFakeRegistry([{ id: 'term-session:1', title: 'x', render: 'body' }]);
    const r = expandPromptReferences('hello world', { terminalRegistry: registry });
    expect(r).toBe('hello world');
  });

  test('short-circuits when no expander deps provided', () => {
    const r = expandPromptReferences('see @term:abc', {});
    expect(r).toBe('see @term:abc');
  });

  test('expands @term:<id> via terminalRegistry', () => {
    const registry = makeFakeRegistry([{ id: 'term-session:1', title: 'probe', render: 'HELLO_CAPTURE' }]);
    const r = expandPromptReferences('see @term:term-session:1 here', { terminalRegistry: registry });
    expect(r).toContain('<terminal-session');
    expect(r).toContain('id="term-session:1"');
    expect(r).toContain('HELLO_CAPTURE');
    expect(r).toContain('see ');
    expect(r).toContain(' here');
  });

  test('accepts trailing-suffix @term id (endsWith match)', () => {
    const registry = makeFakeRegistry([{ id: 'term-session:42', title: 'x', render: 'BODY' }]);
    const r = expandPromptReferences('@term:42', { terminalRegistry: registry });
    expect(r).toContain('id="term-session:42"');
    expect(r).toContain('BODY');
  });

  test('leaves unknown @term id untouched', () => {
    const registry = makeFakeRegistry([]);
    const r = expandPromptReferences('@term:ghostzzz hi', { terminalRegistry: registry });
    expect(r).toContain('@term:ghostzzz');
  });

  test('omits @term expansion when no registry', () => {
    const r = expandPromptReferences('@term:abc', {});
    expect(r).toBe('@term:abc');
  });

  test('passes pane and window tokens through while expanding terminal references', () => {
    const registry = makeFakeRegistry([{ id: 'term-session:1', title: 'probe', render: 'TERMINAL_CAPTURE' }]);
    const input = '@pane:p1 안녕 @win:2/pane:p1 @win:2#all @term:term-session:1';
    const result = expandPromptReferences(input, { terminalRegistry: registry });
    expect(result).toContain('@pane:p1 안녕 @win:2/pane:p1 @win:2#all');
    expect(result).toContain('TERMINAL_CAPTURE');
    expect(result).toContain('<terminal-session id="term-session:1"');
  });
});
