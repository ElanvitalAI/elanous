// Archon-port T2.1 (2026-05-08) — workflow YAML schema validator.

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateWorkflow,
  topoSort,
  parseWorkflowYaml,
} from '../src/workflow-runtime/index.js';

describe('validateWorkflow', () => {
  it('accepts a minimal valid workflow', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'demo workflow',
      nodes: [{ id: 'one', bash: 'echo hi' }],
    });
    expect(r.ok).toBe(true);
    expect(r.workflow?.nodes).toHaveLength(1);
  });

  it('rejects missing name + description + nodes', () => {
    const r = validateWorkflow({});
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path === 'name')).toBe(true);
    expect(r.issues.some(i => i.path === 'description')).toBe(true);
    expect(r.issues.some(i => i.path === 'nodes')).toBe(true);
  });

  it('rejects non-kebab name', () => {
    const r = validateWorkflow({
      name: 'BadName',
      description: 'x',
      nodes: [{ id: 'a', bash: 'true' }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path === 'name')).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const r = validateWorkflow({
      name: 'dup',
      description: 'x',
      nodes: [
        { id: 'a', bash: 'true' },
        { id: 'a', bash: 'true' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('duplicate'))).toBe(true);
  });

  it('rejects nodes with multiple variants', () => {
    const r = validateWorkflow({
      name: 'multi',
      description: 'x',
      nodes: [{ id: 'a', bash: 'true', prompt: 'hi' }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('multiple variants'))).toBe(true);
  });

  it('rejects unresolved depends_on', () => {
    const r = validateWorkflow({
      name: 'orphan',
      description: 'x',
      nodes: [{ id: 'a', bash: 'true', depends_on: ['ghost'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes("unknown dep 'ghost'"))).toBe(true);
  });

  it('rejects self-dependency', () => {
    const r = validateWorkflow({
      name: 'self',
      description: 'x',
      nodes: [{ id: 'a', bash: 'true', depends_on: ['a'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('depend on itself'))).toBe(true);
  });

  it('accepts all 5 node variants in one workflow', () => {
    const r = validateWorkflow({
      name: 'all-five',
      description: 'x',
      nodes: [
        { id: 'b', bash: 'echo' },
        { id: 'p', prompt: 'tell me' },
        { id: 's', skill: 'omni-digest' },
        { id: 'c', cft: 'pdca', config: { plan: 'x' } },
        { id: 'a', approval: { message: 'ok?' } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.workflow?.nodes).toHaveLength(5);
  });

  it('validates approval message presence', () => {
    const r = validateWorkflow({
      name: 'no-msg',
      description: 'x',
      nodes: [{ id: 'a', approval: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path === 'nodes[0].approval.message')).toBe(true);
  });

  // BACKLOG #4 (2026-05-11) — approval.delivery filter validation.
  it('accepts approval with valid delivery filter', () => {
    const r = validateWorkflow({
      name: 'with-delivery',
      description: 'x',
      nodes: [{ id: 'a', approval: { message: 'ok?', delivery: 'pushcut' } }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects approval.delivery with unknown channel id', () => {
    const r = validateWorkflow({
      name: 'bad-delivery',
      description: 'x',
      nodes: [{ id: 'a', approval: { message: 'ok?', delivery: 'sms' } }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path === 'nodes[0].approval.delivery')).toBe(true);
  });

  it('rejects approval.delivery with non-string', () => {
    const r = validateWorkflow({
      name: 'bad-delivery-type',
      description: 'x',
      nodes: [{ id: 'a', approval: { message: 'ok?', delivery: 123 } }],
    });
    expect(r.ok).toBe(false);
  });

  it('validates trigger_rule enum', () => {
    const r = validateWorkflow({
      name: 'tr',
      description: 'x',
      nodes: [
        { id: 'a', bash: 'true' },
        { id: 'b', bash: 'true', depends_on: ['a'], trigger_rule: 'bogus' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path.endsWith('.trigger_rule'))).toBe(true);
  });
});

describe('topoSort', () => {
  it('linear chain returns input order', () => {
    const order = topoSort([
      { id: 'a', bash: 'x' },
      { id: 'b', bash: 'x', depends_on: ['a'] },
      { id: 'c', bash: 'x', depends_on: ['b'] },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('detects cycle', () => {
    expect(() =>
      topoSort([
        { id: 'a', bash: 'x', depends_on: ['b'] },
        { id: 'b', bash: 'x', depends_on: ['a'] },
      ]),
    ).toThrow(/cycle/);
  });

  it('keeps stable order for parallel-ready nodes', () => {
    const order = topoSort([
      { id: 'root', bash: 'x' },
      { id: 'left', bash: 'x', depends_on: ['root'] },
      { id: 'right', bash: 'x', depends_on: ['root'] },
      { id: 'merge', bash: 'x', depends_on: ['left', 'right'] },
    ]);
    expect(order[0]).toBe('root');
    expect(order[3]).toBe('merge');
    expect(order.slice(1, 3).sort()).toEqual(['left', 'right']);
  });
});

describe('parseWorkflowYaml', () => {
  it('parses a YAML string', () => {
    const yaml = [
      'name: from-yaml',
      'description: parsed',
      'nodes:',
      '  - id: one',
      '    bash: echo hi',
    ].join('\n');
    const r = parseWorkflowYaml(yaml);
    expect(r.ok).toBe(true);
    expect(r.workflow?.name).toBe('from-yaml');
    expect(r.warnings.map(warning => warning.code)).toEqual(['no-trigger-node']);
  });

  it('returns schema errors from the lazy validator', () => {
    const yaml = [
      'name: from-yaml',
      'description: parsed',
      'nodes:',
      '  - id: one',
      '    bash: echo hi',
      '    manualTrigger: {}',
    ].join('\n');
    const r = parseWorkflowYaml(yaml);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([{ path: 'nodes[0]', message: 'node declares multiple variants (bash, manualTrigger) — pick one' }]);
    expect(r.warnings).toEqual([]);
  });

  it('returns parse error for invalid YAML', () => {
    const r = parseWorkflowYaml('::: not yaml :::');
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toContain('YAML');
  });

  it('preserves parser results in the Bun bundle', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'workflow-parser-bundle-'));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../src/workflow-runtime/parser.ts')],
        outdir: outDir,
        target: 'bun',
      });
      expect(built.success).toBe(true);
      const bundled = await import(pathToFileURL(join(outDir, 'parser.js')).href) as typeof import('../src/workflow-runtime/parser.js');
      const inputs = [
        ['name: from-yaml', 'description: parsed', 'nodes:', '  - id: one', '    bash: echo hi'].join('\n'),
        ['name: from-yaml', 'description: parsed', 'nodes:', '  - id: one', '    bash: echo hi', '    manualTrigger: {}'].join('\n'),
        '::: not yaml :::',
      ];
      for (const input of inputs) expect(bundled.parseWorkflowYaml(input)).toEqual(parseWorkflowYaml(input));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
