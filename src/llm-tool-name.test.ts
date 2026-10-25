import { expect, test } from 'bun:test';
import { createProviderToolNameMap, sanitizeProviderToolName } from './llm-tool-name.js';

test('provider tool names use the accepted alphabet and reverse to exact source names', () => {
  const map = createProviderToolNameMap([
    'xcodebuild.session_show_defaults',
    'aside:repl',
    'plain_tool-1',
  ]);

  for (const source of ['xcodebuild.session_show_defaults', 'aside:repl', 'plain_tool-1']) {
    const providerName = map.toProviderName(source);
    expect(providerName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(map.toOriginalName(providerName)).toBe(source);
  }
  expect(map.toProviderName('plain_tool-1')).toBe('plain_tool-1');
  expect(sanitizeProviderToolName('')).toBe('tool');
});

test('colliding normalized names get stable unique suffixes, including collisions with existing names', () => {
  const map = createProviderToolNameMap([
    'a.b',
    'a_b',
    'a_b__2',
    'a:b',
    'a.b',
  ]);
  const names = ['a.b', 'a_b', 'a_b__2', 'a:b'].map(map.toProviderName);

  expect(names).toEqual(['a_b', 'a_b__2', 'a_b__2__2', 'a_b__3']);
  expect(new Set(names).size).toBe(names.length);
  for (const source of ['a.b', 'a_b', 'a_b__2', 'a:b']) {
    expect(map.toOriginalName(map.toProviderName(source))).toBe(source);
  }
  expect(map.toProviderName('unknown.name')).toBe('unknown_name');
  expect(map.toOriginalName('unknown_name')).toBe('unknown_name');
});
