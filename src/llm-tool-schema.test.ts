import { describe, expect, test } from 'bun:test';
import { assertNoTopLevelToolSchemaCombinators } from './llm-tool-schema.js';

describe('Claude tool schema top-level composition', () => {
  test('accepts plain and nested schemas across the whole tool set', () => {
    expect(() => assertNoTopLevelToolSchemaCombinators([
      { name: 'plain', parameters: { type: 'object', properties: {} } },
      { name: 'nested', parameters: { type: 'object', properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } } } },
    ])).not.toThrow();
  });

  test('rejects every unsupported top-level composition and names all offending tools', () => {
    expect(() => assertNoTopLevelToolSchemaCombinators([
      { name: 'good', parameters: { type: 'object', properties: {} } },
      { name: 'choice', parameters: { type: 'object', oneOf: [{ required: ['a'] }] } },
      { name: 'union', parameters: { type: 'object', anyOf: [{ required: ['b'] }] } },
      { name: 'intersection', parameters: { type: 'object', allOf: [{ required: ['c'] }] } },
    ])).toThrow('Claude tool schema has unsupported top-level composition: choice (oneOf); union (anyOf); intersection (allOf)');
  });
});
