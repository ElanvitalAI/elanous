import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { formFields, getPath, SchemaForm, setPath } from './SchemaForm';
import { flattenSchema } from './schema-form';

const schema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', title: 'Query', format: 'multiline' },
    apiKey: { type: 'string', title: 'API key', format: 'secret' },
    mode: { type: 'string', enum: ['fast', 'deep'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    dryRun: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: { region: { type: 'string' } } },
  },
};

describe('SchemaForm helpers', () => {
  test('setPath writes a new object, keeps keys outside the schema, and drops undefined', () => {
    const before = { query: 'a', keepMe: 1 };
    const after = setPath(before, 'nested.region', 'kr');
    expect(after).toEqual({ query: 'a', keepMe: 1, nested: { region: 'kr' } });
    expect(before).toEqual({ query: 'a', keepMe: 1 });
    expect(setPath(after, 'query', undefined)).toEqual({ keepMe: 1, nested: { region: 'kr' } });
    expect(getPath(after, 'nested.region')).toBe('kr');
  });

  test('formFields renders scalars as fields and leaves arrays to YAML', () => {
    const { leaves, arrays } = formFields(flattenSchema(schema).fields);
    expect(leaves.map((f) => f.path).sort()).toEqual(['apiKey', 'dryRun', 'limit', 'mode', 'nested.region', 'query']);
    expect(arrays.map((f) => f.path)).toEqual(['tags']);
  });
});

describe('SchemaForm render', () => {
  const html = renderToStaticMarkup(<SchemaForm schema={schema} value={{}} onChange={() => {}} />);
  test('multiline → textarea · secret → password · enum → select · boolean → checkbox · integer → number', () => {
    expect(html).toContain('<textarea id="schema-query"');
    expect(html).toMatch(/id="schema-apiKey"[^>]*type="password"|type="password"[^>]*id="schema-apiKey"/);
    expect(html).toContain('<select id="schema-mode"');
    expect(html).toMatch(/type="checkbox"/);
    expect(html).toMatch(/type="number"/);
  });
  test('a missing required field shows one error line', () => {
    expect(html).toContain('data-schema-error="query"');
  });
  test('no internal markers on the user screen', () => {
    expect(html).not.toMatch(/[\u{1F150}-\u{1F169}]|<state>|RFC-/u);
  });
});
