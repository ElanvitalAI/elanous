import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBundle } from './bundle.js';
import { installSimulationBundle, judgeInstalledSimulationBundle, judgeSimulationBundle, loadInstalledSimulationBundlePolicy, loadSimulationBundlePolicy } from './bundle-simulation.js';

function fixture(provides = '  policies: [./policy.yaml]\n') {
  const root = mkdtempSync(join(tmpdir(), 'bundle-preflight-'));
  writeFileSync(join(root, 'elanous.package.yaml'), `name: test\nversion: 1.0.0\nprovides:\n${provides}`);
  writeFileSync(join(root, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 75\n');
  return root;
}
describe('bundle preflight (not installation)', () => {
  test('loads and validates a declared policy', () => {
    expect(inspectBundle(fixture())).toEqual({ units: ['policies:./policy.yaml'], errors: [] });
  });
  test('rejects invalid definitions and unsupported categories', () => {
    const root = fixture('  policies: [./policy.yaml]\n  roles: [./role.yaml]\n');
    writeFileSync(join(root, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 101\n');
    const result = inspectBundle(root);
    expect(result.errors.some(e => e.includes('unsupported category'))).toBe(true);
    expect(result.errors.some(e => e.includes('invalid'))).toBe(true);
  });
  test('rejects unknown categories even when empty or named like object properties', () => {
    const result = inspectBundle(fixture('  policies: [./policy.yaml]\n  roles: []\n  toString: []\n'));
    expect(result.errors).toEqual(['roles: unsupported category', 'toString: unsupported category']);
  });
  test('rejects duplicate paths, missing paths, traversal and symlink escape', () => {
    const root = fixture('  policies: [./policy.yaml, ./policy.yaml, ./missing.yaml, ../outside.yaml, ./escape/policy.yaml]\n');
    const outside = mkdtempSync(join(tmpdir(), 'bundle-outside-'));
    writeFileSync(join(outside, 'policy.yaml'), 'version: 1\n');
    symlinkSync(outside, join(root, 'escape'));
    const result = inspectBundle(root);
    expect(result.errors.length).toBe(4);
    expect(result.errors.some(e => e.includes('duplicate unit path'))).toBe(true);
    expect(result.errors.some(e => e.includes('path escapes bundle'))).toBe(true);
  });
  test('rejects YAML parse errors and empty manifests', () => {
    const root = fixture();
    writeFileSync(join(root, 'elanous.package.yaml'), 'name: [broken\n');
    expect(inspectBundle(root).errors.length).toBeGreaterThan(0);
    expect(inspectBundle(fixture('  agents: []\n')).errors.length).toBeGreaterThan(0);
  });
});

describe('isolated simulation installation', () => {
  test('runs the previously installed snapshot even after its source changes', async () => {
    const source = fixture();
    const policy = join(source, 'policy.yaml');
    writeFileSync(policy, 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: installed-model\n');
    const { root } = installSimulationBundle(source);
    writeFileSync(policy, 'not: [valid');
    const calls: string[] = [];
    const observed = await judgeInstalledSimulationBundle(root, async ({ model }) => {
      calls.push(model);
      return { text: 'snapshot result' };
    });
    expect(observed.result.ok).toBe(true);
    expect(calls).toEqual(['installed-model']);
  });
  test('rejects an installed snapshot with a tampered ledger', () => {
    const { root } = installSimulationBundle(fixture());
    writeFileSync(join(root, 'defs/installed.json'), JSON.stringify({ simulation: true, packages: [{ name: '../outside', units: [] }] }));
    expect(() => loadInstalledSimulationBundlePolicy(root)).toThrow('invalid simulation ledger');
  });
  test('reinstall after changing only the model changes the real judge request', async () => {
    const source = fixture();
    const path = join(source, 'policy.yaml');
    const original = 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: sim-model-a\n';
    writeFileSync(path, original);
    const seen: string[] = [];
    const call = async ({ model }: { model: string }) => {
      seen.push(model);
      return { text: 'fixture transport' };
    };
    const first = await judgeSimulationBundle(source, call);
    writeFileSync(path, original.replace('sim-model-a', 'sim-model-b'));
    const second = await judgeSimulationBundle(source, call);
    expect(first.root).not.toBe(second.root);
    expect(readFileSync(join(first.root, 'defs/packages/test/policy.yaml'), 'utf8')).toBe(original);
    expect(seen).toEqual(['sim-model-a', 'sim-model-b']);
    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);
  });
  test('two installed policies drive the real judge resolver via an injected call', async () => {
    const a = fixture(), b = fixture();
    writeFileSync(join(a, 'policy.yaml'), 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: sim-model-a\n');
    writeFileSync(join(b, 'policy.yaml'), 'version: 1\nroles:\n  classify:\n    provider: openai-codex\n    model: sim-model-b\n');
    const seen: Array<{ provider: string; model: string }> = [];
    const call = async ({ provider, model }: { provider: string; model: string }) => {
      seen.push({ provider, model });
      return { text: 'isolated response' };
    };
    const first = await judgeSimulationBundle(a, call);
    const second = await judgeSimulationBundle(b, call);
    expect(first.root).not.toBe(second.root);
    expect(seen).toEqual([{ provider: 'anthropic', model: 'sim-model-a' }, { provider: 'openai-codex', model: 'sim-model-b' }]);
    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);
  });
  test('installed role routes the actual prompt and validates structured decisions', async () => {
    const source = fixture();
    writeFileSync(join(source, 'policy.yaml'), 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: sim-model-a\n');
    const seen: unknown[] = [];
    const schema = (value: unknown) => {
      const decision = (value as { decision?: unknown } | null)?.decision;
      return decision === 'allow' || decision === 'deny' ? decision : null;
    };
    const valid = await judgeSimulationBundle(source, async (args) => {
      seen.push(args);
      return { text: '{"decision":"allow"}' };
    }, { prompt: 'assess fixture', schema });
    expect(seen).toEqual([{ prompt: 'assess fixture', signal: undefined, provider: 'anthropic', model: 'sim-model-a' }]);
    expect(valid.result.ok && valid.result.value).toBe('allow');
    const invalid = await judgeSimulationBundle(source, async () => ({ text: '{"decision":"unknown"}' }), { schema });
    expect(invalid.result).toEqual({ ok: false, reason: 'schema', rawText: '{"decision":"unknown"}' });
  });
  test('transport error remains a judge failure and is not reported as success', async () => {
    const source = fixture();
    writeFileSync(join(source, 'policy.yaml'), 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: sim-model-a\n');
    const failure = new Error('isolated transport failure');
    const result = await judgeSimulationBundle(source, async () => { throw failure; });
    expect(result.result).toEqual({ ok: false, reason: 'call', error: failure });
  });
  test('missing classify model fails before injected transport', async () => {
    const source = fixture();
    writeFileSync(join(source, 'policy.yaml'), 'version: 1\nroles:\n  classify:\n    provider: openai-codex\n');
    let called = false;
    await expect(judgeSimulationBundle(source, async () => { called = true; return { text: 'unexpected' }; })).rejects.toThrow('simulation requires an explicit classify provider and model');
    expect(called).toBe(false);
  });
  test('loads installed policy values in independent temporary universes', () => {
    const firstSource = fixture();
    const secondSource = fixture();
    writeFileSync(join(secondSource, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 31\n');
    const first = loadSimulationBundlePolicy(firstSource);
    const second = loadSimulationBundlePolicy(secondSource);
    expect(first.root).not.toBe(second.root);
    expect(first.loaded.filePresent).toBe(true);
    expect(first.loaded.valid).toBe(true);
    expect(first.loaded.path).toBe(join(first.root, 'defs/packages/test/policy.yaml'));
    expect(first.loaded.sources['caps.codex.harness']).toBe('file');
    expect(first.loaded.policy.caps.codex.harness).toBe(75);
    expect(second.loaded.policy.caps.codex.harness).toBe(31);
    writeFileSync(join(firstSource, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 99\n');
    expect(readFileSync(first.loaded.path, 'utf8')).toContain('harness: 75');
    expect(second.loaded.policy.caps.codex.harness).toBe(31);
  });
  test('refuses to load an invalid installed policy', () => {
    const source = fixture();
    writeFileSync(join(source, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 101\n');
    expect(() => loadSimulationBundlePolicy(source)).toThrow();
  });
  test('writes declared units and installed ledger to a fresh temporary universe', () => {
    const source = fixture();
    const first = installSimulationBundle(source), second = installSimulationBundle(source);
    expect(first.root).not.toBe(second.root);
    expect(first.installed).toEqual(['policies:./policy.yaml']);
    const ledger = JSON.parse(readFileSync(join(first.root, 'defs/installed.json'), 'utf8'));
    expect(ledger.simulation).toBe(true);
    expect(ledger.packages[0].units).toEqual(first.installed);
    writeFileSync(join(source, 'policy.yaml'), 'changed');
    expect(readFileSync(join(first.root, 'defs/packages/test/policy.yaml'), 'utf8')).toContain('harness: 75');
  });
  test('refuses a symlinked manifest before installing', () => {
    const source = fixture();
    const indirect = mkdtempSync(join(tmpdir(), 'def-bundle-link-'));
    symlinkSync(join(source, 'elanous.package.yaml'), join(indirect, 'elanous.package.yaml'));
    expect(() => installSimulationBundle(indirect)).toThrow('manifest symlink');
  });
  test('refuses invalid definitions, escaping paths and unsafe names', () => {
    const invalid = fixture();
    writeFileSync(join(invalid, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 101\n');
    expect(() => installSimulationBundle(invalid)).toThrow();
    expect(() => installSimulationBundle(fixture('  policies: [../outside.yaml]\n'))).toThrow();
    const badName = fixture();
    writeFileSync(join(badName, 'elanous.package.yaml'), 'name: ../bad\nversion: 1.0.0\nprovides:\n  policies: [./policy.yaml]\n');
    expect(() => installSimulationBundle(badName)).toThrow('invalid package name');
  });
});


describe('simulation agent reference files', () => {
  function fixture(soul: string, knowhow = 'knowhow.md'): string {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-agent-refs-'));
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'elanous.package.yaml'), `apiVersion: elanous/package@1\nkind: package\nname: refs-test\nversion: 1.0.0\nprovides:\n  agents:\n    - agents/agent.yaml\n`);
    writeFileSync(join(dir, 'agents', 'agent.yaml'), `apiVersion: elanous/loop-agent@3
manifest: { name: a1, version: 0.1.0, requires: { executor: loop-agent@3, kits: [kpi], node_kinds: [gate], facts: [res.slots] }, provides: { agent: a1, kpis: [k1] } }
identity: { id: a1, soul: ${soul} }
memory: { knowhow: ${knowhow} }
soul: { purpose: keep k1 up, values: [facts first], do_not: [never guess], voice: short, serves: [TC] }
supervisor: { duty: landing }
policies: { k1_min: 3, slots: { fact: res.slots, default: 2 } }
kpis: [{ name: k1, at_least: $policies.k1_min }]
wake: { trigger: { condition: { predicate: { kind: state-changed, parts: [{ file: '{stateRoot}/sim/wake' }] } } } }
body: { entry_node: s, terminal_nodes: [done], nodes: [{ node_id: s, kind: gate }, { node_id: done, kind: gate }], edges: [{ from: s, map: { ok: done } }] }
`);
    return dir;
  }
  test('copies soul and knowhow into the isolated package', () => {
    const dir = fixture('soul.md');
    writeFileSync(join(dir, 'agents', 'soul.md'), 'soul text');
    writeFileSync(join(dir, 'agents', 'knowhow.md'), 'knowhow text');
    const { root } = installSimulationBundle(dir);
    const agents = join(root, 'defs', 'packages', 'refs-test', 'agents');
    expect(readFileSync(join(agents, 'soul.md'), 'utf8')).toBe('soul text');
    expect(readFileSync(join(agents, 'knowhow.md'), 'utf8')).toBe('knowhow text');
  });
  test('rejects an agent-relative path escaping its directory', () => {
    const dir = fixture('../outside.md');
    writeFileSync(join(dir, 'outside.md'), 'outside');
    writeFileSync(join(dir, 'agents', 'knowhow.md'), 'knowhow');
    expect(() => installSimulationBundle(dir)).toThrow();
  });
  test('rejects a soul symlink even when its target is inside the agent directory', () => {
    const dir = fixture('soul.md');
    writeFileSync(join(dir, 'agents', 'real.md'), 'real');
    writeFileSync(join(dir, 'agents', 'knowhow.md'), 'knowhow');
    symlinkSync('real.md', join(dir, 'agents', 'soul.md'));
    expect(() => installSimulationBundle(dir)).toThrow();
  });
  test('rejects a knowhow symlink to outside the bundle', () => {
    const dir = fixture('soul.md');
    const outside = mkdtempSync(join(tmpdir(), 'bundle-agent-outside-'));
    writeFileSync(join(dir, 'agents', 'soul.md'), 'soul');
    writeFileSync(join(outside, 'knowhow.md'), 'outside');
    symlinkSync(join(outside, 'knowhow.md'), join(dir, 'agents', 'knowhow.md'));
    expect(() => installSimulationBundle(dir)).toThrow();
  });
});
