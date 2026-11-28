import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDefinition } from './loader.js';
import { lintFederation } from './federation.js';

// Independent literal: deliberately not derived from the example file or schema.
const valid = {
  apiVersion: 'elanous/federation-bundle@1',
  members: {
    lead: { package: 'lead@1', plane: 'L1', manifest: { provides: { duties: ['review'] }, requires: { duties: [] } } },
    worker: { package: 'worker@2', plane: 'L0', manifest: { provides: { duties: ['build'] }, requires: { duties: ['review'] } } },
  },
  bindings: { review: 'lead' },
  edges: [{ type: 'supervises', from: 'lead', to: 'worker' }, { type: 'escalates', from: 'worker', to: 'lead' }],
  routes: [{ kind: 'mail', from: 'worker', to: 'lead' }],
};
const copy = () => structuredClone(valid);
const messages = (v: unknown) => lintFederation(v).map(e => e.message);
describe('federation bundle', () => {
  test('independent literal and illustrative declaration pass', () => {
    expect(lintFederation(valid)).toEqual([]);
    expect(loadDefinition(resolve(import.meta.dir, '../../examples/federation-bundle/federation.yaml')).errors).toEqual([]);
  });
  test('unbound or incorrectly provided duties fail', () => {
    const a = copy(); a.bindings.review = 'worker';
    expect(messages(a)).toContain('worker does not provide duty review');
    expect(messages(a)).toContain('unbound duty review');
  });
  test('L0 orphan, supervision and escalation cycles fail', () => {
    const a = copy(); a.edges = [];
    expect(messages(a)).toContain('L0 member worker has no escalation path');
    const b = copy(); b.edges.push({ type: 'supervises', from: 'worker', to: 'lead' }, { type: 'escalates', from: 'lead', to: 'worker' });
    expect(messages(b)).toContain('supervises cycle');
    expect(messages(b)).toContain('escalates cycle');
  });
  test('unknown typed relationships and route endpoints fail closed', () => {
    const a = copy(); a.edges.push({ type: 'bogus', from: 'worker', to: 'missing' }); a.routes[0]!.to = 'missing';
    expect(messages(a)).toContain('unknown edge type');
    expect(messages(a)).toContain('unknown member missing');
  });
  test('loader reports line and does not return invalid declaration', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fed-')), 'federation.yaml');
    writeFileSync(p, 'apiVersion: elanous/federation-bundle@1\nmembers: {}\nbindings: {}\nedges: []\nroutes: []\n');
    const result = loadDefinition(p);
    expect(result.kind).toBe('federation');
    expect(result.errors).toContainEqual({ line: 2, message: 'members must be a nonempty mapping' });
    expect(result.value).toBeUndefined();
  });
  test('def lint returns 0 for example and 1 for unbound duty', () => {
    const entry = new URL('./cli.ts', import.meta.url).pathname;
    const run = (path: string) => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const p = new Command(); registerDefinitionCommands(p); await p.parseAsync(['node','eln','def','lint',${JSON.stringify(path)}]);`], { stdout: 'pipe', stderr: 'pipe' });
    expect(run(resolve(import.meta.dir, '../../examples/federation-bundle/federation.yaml')).exitCode).toBe(0);
    const p = join(mkdtempSync(join(tmpdir(), 'fed-cli-')), 'federation.yaml');
    writeFileSync(p, `apiVersion: elanous/federation-bundle@1\nmembers:\n  x:\n    package: x@1\n    plane: L1\n    manifest:\n      provides: {duties: []}\n      requires: {duties: [missing]}\nbindings: {}\nedges: []\nroutes: []\n`);
    const result = run(p);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('unbound duty missing');
  });
  test('CLI rejects each required invalid relationship with exit 1', () => {
    const entry = new URL('./cli.ts', import.meta.url).pathname;
    const cases = [
      { members: { x: { package: 'x@1', plane: 'L1', manifest: { provides: { duties: [] }, requires: { duties: ['missing'] } } } }, bindings: {}, edges: [], routes: [] },
      { members: { x: { package: 'x@1', plane: 'L0', manifest: { provides: { duties: [] }, requires: { duties: [] } } } }, bindings: {}, edges: [], routes: [] },
      { members: { x: { package: 'x@1', plane: 'L1', manifest: { provides: { duties: [] }, requires: { duties: [] } } } }, bindings: {}, edges: [{ type: 'supervises', from: 'x', to: 'x' }], routes: [] },
      { members: { x: { package: 'x@1', plane: 'L1', manifest: { provides: { duties: [] }, requires: { duties: [] } } } }, bindings: {}, edges: [{ type: 'escalates', from: 'x', to: 'x' }], routes: [] },
    ];
    for (const [index, value] of cases.entries()) {
      const p = join(mkdtempSync(join(tmpdir(), 'fed-invalid-')), 'federation.yaml');
      // JSON is a YAML subset; each case is an independent literal, not derived from the valid fixture.
      writeFileSync(p, JSON.stringify({ apiVersion: 'elanous/federation-bundle@1', ...value }));
      const result = Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const p = new Command(); registerDefinitionCommands(p); await p.parseAsync(['node','eln','def','lint',${JSON.stringify(p)}]);`], { stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(['unbound duty missing', 'no escalation path', 'supervises cycle', 'escalates cycle'][index]!);
    }
  });
  test('old workspace federation is not reinterpreted as a bundle', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'workspace-fed-')), 'federation.yaml');
    writeFileSync(p, 'org:\n  role: coordinator\n');
    expect(loadDefinition(p).errors[0]?.message).toBe('unsupported definition kind');
  });
});
