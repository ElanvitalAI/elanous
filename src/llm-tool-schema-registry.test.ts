import { expect, test } from 'bun:test';
import { assertNoTopLevelToolSchemaCombinators, ToolSchemaRejectedError } from './llm-tool-schema.js';
import { registerAllDefaultToolRuntimes } from './tool-runtime/index.js';
import { listToolRuntimes } from './tool-runtime/registry.js';
import { buildReplTools } from './repl/index.js';
import { buildRunShellTool } from './skills/tools/shell.js';
import { classifyTurnFailure } from './tui/chat/error-card.js';

test('every registered runtime tool schema passes the Claude top-level guard', () => {
  registerAllDefaultToolRuntimes({ mcpLazyBoot: true });
  const specs = listToolRuntimes().map((rt) => rt.spec).filter(Boolean);
  expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(['RunShell', 'Bash']));
  expect(() => assertNoTopLevelToolSchemaCombinators(specs, { provider: 'test' })).not.toThrow();
});

test('every seat REPL tool schema (coordinator and hand) passes the Claude top-level guard', () => {
  for (const seatRole of ['coordinator', 'hand'] as const) {
    const { specs } = buildReplTools({ nextTui: true, seatRole });
    expect(() => assertNoTopLevelToolSchemaCombinators(specs, { provider: 'test' })).not.toThrow();
  }
  expect(buildRunShellTool().parameters).not.toHaveProperty('oneOf');
});

test('a rejected schema is a named one-line error with a turn-failure cause, not a bare failure', () => {
  let caught: unknown;
  try {
    assertNoTopLevelToolSchemaCombinators([{ name: 'Bad', parameters: { type: 'object', oneOf: [{ required: ['a'] }] } }], { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
  } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ToolSchemaRejectedError);
  const err = caught as ToolSchemaRejectedError;
  expect(err.tools).toEqual(['Bad']);
  expect(err.provider).toBe('openrouter');
  expect(err.message.includes('\n')).toBe(false);
  expect(classifyTurnFailure(err.message)).toBe('A tool schema was rejected by the provider');
});
