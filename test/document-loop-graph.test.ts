import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeGate } from '../src/self-implement/graph-authority.js';
import { defaultGraphsDir, loadGraphTemplatesFrom } from '../src/self-implement/graph-templates.js';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';

const file = 'document-loop.yaml';
const source = readFileSync(join(defaultGraphsDir(), file), 'utf8');
const parsed = parseGraphTemplateYaml(source, file);

describe('document-loop YAML graph', () => {
  test('loads as the distinct document graph with document-specific nodes and landing recovery', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.template?.graphId).toBe('document-loop');
    expect(parsed.template?.entryNode).toBe('document-draft');
    expect(parsed.template?.nodes.map((node) => node.nodeId)).toEqual([
      'document-draft', 'gate', 'document-review', 'document-rework', 'document-blocked',
      'main-sync', 'regate', 'open-pr', 'merge', 'recover', 'landed', 'needs-human',
    ]);
    expect(parsed.template?.terminalNodes).toEqual(['landed', 'document-blocked', 'needs-human']);
    expect(loadGraphTemplatesFrom(defaultGraphsDir()).templates['document-loop']?.graphId).toBe('document-loop');
  });

  test('skips the gate only for document-only changes and fails safe otherwise', () => {
    const template = loadGraphTemplatesFrom(defaultGraphsDir()).templates['document-loop']!;
    expect(routeGate(template, ['docs/guide.md'])).toEqual({ runsGate: false, reason: 'documents-only' });
    expect(routeGate(template, ['src/document.ts'])).toEqual({ runsGate: true, reason: 'code-changed' });
    expect(routeGate(template, undefined)).toEqual({ runsGate: true, reason: 'changed-files-unknown' });
  });

  test('blocks review failures after rework exhaustion before PR creation or merge', () => {
    const template = parsed.template!;
    const route = (from: string, outcome: string): string | undefined => template.edges
      .find((edge) => edge.from === from && edge.on === 'outcome')?.map?.[outcome];

    const trace = [
      'document-review',
      route('document-review', 'fail'),
      route('document-rework', 'exhausted'),
    ];

    expect(trace).toEqual(['document-review', 'document-rework', 'document-blocked']);
    expect(template.terminalNodes).toContain('document-blocked');
    expect(template.edges.some((edge) => edge.from === 'document-blocked')).toBe(false);
    expect(trace).not.toContain('open-pr');
    expect(trace).not.toContain('merge');
  });
});
