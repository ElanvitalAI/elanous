import { describe, expect, it } from 'bun:test';
import { flattenSchema, validateSchemaValue } from './schema-form';

describe('flattenSchema', () => {
  it('flattens nested properties and array items with metadata and parent-scoped required flags', () => {
    const input = {
      type: 'object', required: ['name', 'config'], properties: {
        name: { type: 'string', title: 'Display name', description: 'Friendly name', default: 'new', minLength: 2 },
        config: { type: 'object', required: ['token'], properties: {
          token: { type: 'string', format: 'password', writeOnly: true },
          mode: { type: 'string', enum: ['fast', 'slow'] },
          notes: { type: 'string', format: 'textarea' },
        } },
        ports: { type: 'array', items: { type: 'integer', minimum: 1 } },
      },
    };
    const result = flattenSchema(input);
    expect(result.unsupported).toEqual([]);
    expect(result.fields.map(({ path, type, required }) => ({ path, type, required }))).toEqual([
      { path: 'name', type: 'string', required: true },
      { path: 'config', type: 'object', required: true },
      { path: 'config.token', type: 'string', required: true },
      { path: 'config.mode', type: 'string', required: false },
      { path: 'config.notes', type: 'string', required: false },
      { path: 'ports', type: 'array', required: false },
      { path: 'ports[]', type: 'integer', required: false },
    ]);
    expect(result.fields[0]).toMatchObject({ label: 'Display name', description: 'Friendly name', default: 'new' });
    expect(result.fields[2]).toMatchObject({ secret: true, multiline: false });
    expect(result.fields[3]?.enum).toEqual(['fast', 'slow']);
    expect(result.fields[4]?.multiline).toBe(true);
  });

  it('reports unknown keywords at their locations rather than silently treating them as supported', () => {
    const result = flattenSchema({ type: 'object', oneOf: [], properties: {
      name: { type: 'string', custom: 1, allOf: [] },
      rows: { type: 'array', items: { type: 'string', const: 'only' } },
    } });
    expect(result.unsupported).toEqual(['oneOf', 'name.custom', 'name.allOf', 'rows[].const']);
    expect(result.fields.map((field) => field.path)).toEqual(['name', 'rows', 'rows[]']);
  });

  it('inspects depth 6 but never traverses properties or items beyond it', () => {
    let nested: unknown = { type: 'object', properties: { hidden: { type: 'string', surprise: true } }, mystery: true };
    for (let depth = 6; depth > 0; depth--) {
      nested = depth % 2
        ? { type: 'object', properties: { [`p${depth}`]: nested } }
        : { type: 'array', items: nested };
    }
    const result = flattenSchema(nested);
    expect(result.fields).toHaveLength(6);
    expect(result.unsupported).toEqual(['p1[].p3[].p5[].mystery']);
    expect(result.fields.map((field) => field.path).some((path) => path.includes('hidden'))).toBe(false);
  });

  it('flattens properties and required metadata without an explicit object type', () => {
    const result = flattenSchema({ required: ['settings'], properties: {
      settings: { required: ['name'], properties: { name: { type: 'string' } } },
    } });
    expect(result.unsupported).toEqual([]);
    expect(result.fields.map(({ path, type, required }) => ({ path, type, required }))).toEqual([
      { path: 'settings', type: 'object', required: true },
      { path: 'settings.name', type: 'string', required: true },
    ]);
  });

  it('flattens items without an explicit array type', () => {
    expect(flattenSchema({ properties: { rows: { items: { type: 'boolean' } } } }).fields
      .map(({ path, type }) => ({ path, type }))).toEqual([
      { path: 'rows', type: 'array' }, { path: 'rows[]', type: 'boolean' },
    ]);
  });

  it('does not mutate a schema or recurse forever on a cyclic input', () => {
    const child: Record<string, unknown> = { type: 'object' };
    child.properties = { itself: child };
    const before = child.properties;
    expect(flattenSchema({ type: 'object', properties: { child } }).unsupported).toEqual(['child.itself']);
    expect(child.properties).toBe(before);
  });
});

describe('validateSchemaValue', () => {
  const schema = { type: 'object', required: ['title', 'settings'], properties: {
    title: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' },
    settings: { type: 'object', required: ['count'], properties: {
      count: { type: 'integer', minimum: 1, maximum: 4 },
      enabled: { type: 'boolean' },
    } },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
  } };

  it('validates required keys on both root and nested objects without requiring optional keys', () => {
    expect(validateSchemaValue(schema, {})).toEqual([
      { path: 'title', message: 'Required.' }, { path: 'settings', message: 'Required.' },
    ]);
    expect(validateSchemaValue(schema, { title: 'ok', settings: {} })).toEqual([
      { path: 'settings.count', message: 'Required.' },
    ]);
    expect(validateSchemaValue(schema, { title: 'ok', settings: { count: 2 }, unknown: 'preserved' })).toEqual([]);
  });

  it('validates type, length, pattern, numeric bounds, enum and array items by path', () => {
    const errors = validateSchemaValue(schema, {
      title: 'A', settings: { count: 0, enabled: 'yes' }, tags: ['bad', 'a', 'b'],
    });
    expect(errors).toContainEqual({ path: 'title', message: 'Must have at least 2 characters.' });
    expect(errors).toContainEqual({ path: 'title', message: 'Does not match the required pattern.' });
    expect(errors).toContainEqual({ path: 'settings.count', message: 'Must be at least 1.' });
    expect(errors).toContainEqual({ path: 'settings.enabled', message: 'Must be a boolean.' });
    expect(errors).toContainEqual({ path: 'tags', message: 'Must have at most 2 items.' });
    expect(errors).toContainEqual({ path: 'tags[0]', message: 'Must be one of the allowed values.' });
    expect(validateSchemaValue(schema, { title: 'longer', settings: { count: 5 }, tags: [] }))
      .toEqual(expect.arrayContaining([
        { path: 'title', message: 'Must have at most 5 characters.' },
        { path: 'settings.count', message: 'Must be at most 4.' },
        { path: 'tags', message: 'Must have at least 1 items.' },
      ]));
  });

  it('compares JSON enum objects and arrays structurally, irrespective of object key order', () => {
    const enumSchema = { type: 'object', properties: {
      choice: { type: 'object', enum: [{ nested: [1, { valid: true }], label: 'ok' }] },
      entries: { type: 'array', enum: [[{ a: 1, b: 2 }, null]] },
    } };
    expect(validateSchemaValue(enumSchema, {
      choice: { label: 'ok', nested: [1, { valid: true }] },
      entries: [{ b: 2, a: 1 }, null],
    })).toEqual([]);
    expect(validateSchemaValue(enumSchema, {
      choice: { label: 'ok', nested: [1, { valid: false }] },
      entries: [{ b: 2, a: 1 }, null, 3],
    })).toEqual([
      { path: 'choice', message: 'Must be one of the allowed values.' },
      { path: 'entries', message: 'Must be one of the allowed values.' },
    ]);
  });

  it('counts Unicode code points for minLength and maxLength boundaries', () => {
    const lengthSchema = { type: 'string', minLength: 2, maxLength: 2 };
    expect(validateSchemaValue(lengthSchema, '😀a')).toEqual([]);
    expect(validateSchemaValue(lengthSchema, '😀')).toEqual([
      { path: '', message: 'Must have at least 2 characters.' },
    ]);
    expect(validateSchemaValue(lengthSchema, '😀ab')).toEqual([
      { path: '', message: 'Must have at most 2 characters.' },
    ]);
  });

  it('checks required on depth 6 itself but does not traverse properties beyond it', () => {
    let nested: unknown = { type: 'object', required: ['hidden'], properties: { hidden: { type: 'string' } } };
    for (let i = 6; i > 0; i--) nested = { type: 'object', properties: { [`p${i}`]: nested } };
    const value = { p1: { p2: { p3: { p4: { p5: { p6: {} } } } } } };
    expect(validateSchemaValue(nested, value)).toEqual([
      { path: 'p1.p2.p3.p4.p5.p6.hidden', message: 'Required.' },
    ]);
    expect(validateSchemaValue(nested, { p1: { p2: { p3: { p4: { p5: { p6: { hidden: 1 } } } } } } }))
      .toEqual([]);
  });

  it('validates items without an explicit array type', () => {
    expect(validateSchemaValue({ items: { type: 'boolean' } }, [true, 'wrong'])).toEqual([
      { path: '[1]', message: 'Must be a boolean.' },
    ]);
  });

  it('applies properties and required to object values when type is omitted', () => {
    const typeless = { required: ['settings'], properties: {
      settings: { required: ['name'], properties: { name: { type: 'string', minLength: 2 } } },
    } };
    expect(validateSchemaValue(typeless, {})).toEqual([{ path: 'settings', message: 'Required.' }]);
    expect(validateSchemaValue(typeless, { settings: {} })).toEqual([
      { path: 'settings.name', message: 'Required.' },
    ]);
    expect(validateSchemaValue(typeless, { settings: { name: 'a' } })).toEqual([
      { path: 'settings.name', message: 'Must have at least 2 characters.' },
    ]);
    expect(validateSchemaValue(typeless, { settings: { name: 'ok' } })).toEqual([]);
  });
});

describe('multi-line string fields (K3 실물 2026-09-30 · Markdown line breaks were dropped)', () => {
  const schema = {
    type: 'object',
    properties: {
      markdown: { type: 'string', title: 'Markdown 본문' },
      note: { type: 'string', title: 'Note', 'x-multiline': true },
      template: { type: 'string', title: '양식', enum: ['report', 'official-letter'] },
      path: { type: 'string', title: '입력 경로' },
      token: { type: 'string', title: 'Body token', format: 'password' },
    },
  };
  it('markdown/본문 and x-multiline become multi-line · enum, path and secrets stay single-line', () => {
    const fields = Object.fromEntries(flattenSchema(schema).fields.map((f) => [f.path, f]));
    expect(fields.markdown!.multiline).toBe(true);
    expect(fields.note!.multiline).toBe(true);
    expect(fields.template!.multiline).toBe(false);
    expect(fields.path!.multiline).toBe(false);
    expect(fields.token!.multiline).toBe(false);
    expect(flattenSchema(schema).unsupported.some((u) => u.includes('note'))).toBe(false);
  });
});
