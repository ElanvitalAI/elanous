import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDefinition } from './loader.js';

function fixture(text: string, name = 'definition.yaml'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'def-loader-')), name);
  writeFileSync(path, text);
  return path;
}
describe('definition loader', () => {
  test('existing land-steward definition remains valid', () => {
    const root = resolve(import.meta.dir, '../..');
    const result = loadDefinition(join(root, 'graphs/loop-agents/land-steward/agent.yaml'), { triggersDir: join(root, 'graphs/triggers') });
    expect(result.errors).toEqual([]);
    expect(result.value).toBeDefined();
  });
  test('unknown agent key and literal host have source lines', () => {
    const result = loadDefinition(fixture('apiVersion: elanous/loop-agent@3\nunknown_key: 1\nhost: node-b\n'));
    expect(result.errors).toContainEqual({ line: 2, message: 'unknown agent key unknown_key' });
    expect(result.errors).toContainEqual({ line: 3, message: 'literal host name is not portable' });
    expect(result.value).toBeUndefined();
  });
  test('rejects a configured host beyond the original four literals', () => {
    const result = loadDefinition(fixture('apiVersion: elanous/loop-agent@3\nhost: aws1\n'));
    expect(result.errors).toContainEqual({ line: 2, message: 'literal host name is not portable' });
    expect(result.value).toBeUndefined();
  });
  test('missing fact reports the nested policy line', () => {
    const result = loadDefinition(fixture('apiVersion: elanous/loop-agent@3\npolicies:\n  limit:\n    fact: absent_fact\n'));
    expect(result.errors).toContainEqual({ line: 4, message: 'policies.limit: fact absent_fact is not declared in manifest.requires.facts' });
    expect(result.value).toBeUndefined();
  });
  test('graph node errors identify the field within a sequence', () => {
    const result = loadDefinition(fixture('graph_id: example\nnodes:\n  - node_id: first\n    kind: invalid-kind\n  - node_id: second\n    kind: invalid-kind\n'));
    const kindErrors = result.errors.filter(error => error.message.includes('invalid-kind'));
    expect(kindErrors.map(error => error.line)).toEqual([4, 6]);
    expect(result.value).toBeUndefined();
  });
  test('versioned LLM policy uses the existing validator and reports source lines', () => {
    const valid = loadDefinition(fixture('version: 1\naccounts:\n  codex:\n    rotateAtPercent: 87\n', 'llm.yaml'));
    expect(loadDefinition(fixture('caps:\n  codex:\n    harness: 50\n', 'llm.yaml')).errors).toEqual([]);
    expect(loadDefinition(fixture('version: 1\n')).errors[0]?.message).toBe('unsupported definition kind');
    expect(valid.kind).toBe('policy');
    expect(valid.errors).toEqual([]);
    expect(valid.value).toBeDefined();
    const invalid = loadDefinition(fixture('version: 1\naccounts:\n  codex:\n    rotateAtPercent: 101\n    mystery: true\n', 'llm.yaml'));
    expect(invalid.errors).toContainEqual({ line: 4, message: 'policy.accounts.codex.rotateAtPercent is invalid' });
    expect(invalid.errors).toContainEqual({ line: 5, message: 'unknown field policy.accounts.codex.mystery' });
    expect(invalid.value).toBeUndefined();
    expect(loadDefinition(fixture('version: 2\n', 'llm.yaml')).errors).toContainEqual({ line: 1, message: 'policy.version is invalid' });
    expect(loadDefinition(fixture('version: 1\nother: 1\n', 'llm.yaml')).value).toBeUndefined();
  });
  test('unsupported and malformed YAML fail closed', () => {
    expect(loadDefinition(fixture('other: thing\n')).errors[0]?.message).toBe('unsupported definition kind');
    expect(loadDefinition(fixture('a: [\n')).errors).not.toEqual([]);
    expect(loadDefinition(fixture('a: 1\na: 2\n')).errors).not.toEqual([]);
  });
});
