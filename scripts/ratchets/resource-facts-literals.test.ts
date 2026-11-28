import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countSource, emptyCounts, growth, kindsInLine, readBaseline, scanRepo, shrink } from './resource-facts-literals';

test('the repo adds no new hardcoded host / account / model / expiry literal in src/', () => {
  expect(growth(scanRepo(), readBaseline())).toEqual([]);
});

test('graph and policy definitions cannot introduce host literals', () => {
  const root = mkdtempSync(join(tmpdir(), 'facts-ratchet-'));
  try {
    for (const dir of ['src', 'graphs/loop-agents/x', 'packs/release-ops']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'agent.yaml'), 'host: gcp2\n');
    writeFileSync(join(root, 'src/agent.yaml'), 'host: mbp\n');
    writeFileSync(join(root, 'src/config.js'), "const host = 'node-c';\n");
    writeFileSync(join(root, 'packs/release-ops/policy.py'), "host = 'aws2'\n");
    writeFileSync(join(root, 'graphs/loop-agents/x/binary.pdf'), Buffer.from([0, 109, 115, 98, 49]));
    writeFileSync(join(root, 'graphs/loop-agents/x/agent.yaml'), 'host: node-b\n');
    writeFileSync(join(root, 'packs/release-ops/policy.yaml'), 'host: minim5\n');
    expect(growth(scanRepo(root), emptyCounts())).toEqual([
      'agent.yaml: host 1 > 0',
      'graphs/loop-agents/x/agent.yaml: host 1 > 0',
      'packs/release-ops/policy.py: host 1 > 0',
      'packs/release-ops/policy.yaml: host 1 > 0',
      'src/agent.yaml: host 1 > 0',
      'src/config.js: host 1 > 0',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new host literal is caught (and only the line kinds that apply)', () => {
  expect(kindsInLine("const HOSTS = ['node-b', 'minim5'];")).toEqual(['host']);
  expect(kindsInLine("  const h = 'gcp7';")).toEqual(['host']);
  expect(kindsInLine('// node-b is fine in a comment')).toEqual([]);
  expect(kindsInLine(' * aws1 doc line')).toEqual([]);
  expect(kindsInLine("const name = 'mbpHost';")).toEqual([]);
});

test('seat identifiers and headquarters paths are caught', () => {
  expect(kindsInLine('seat: TC-H-CX-5')).toContain('seat');
  expect(kindsInLine('root: /Users/example/elanous-hq/seat-state')).toContain('path');
  expect(kindsInLine('root: /Users/example/source/ref')).toContain('path');
});

test('codex account names, model ids and expiry dates are caught', () => {
  expect(kindsInLine("const account = 'third';")).toEqual(['account']);
  expect(kindsInLine("useProfile('codex-team')")).toEqual(['account']);
  expect(kindsInLine("const role = 'team';")).toEqual([]);
  expect(kindsInLine('account: team')).toEqual(['account']);
  expect(kindsInLine('codex_account: third # selected')).toEqual(['account']);
  expect(kindsInLine('role: team')).toEqual([]);
  // Build fixture IDs at runtime so the separate scripts model ratchet does not count test data as configuration.
  expect(kindsInLine("const m = '" + 'gpt-' + "6.1-terra';")).toEqual(['model']);
  expect(kindsInLine("const m = '" + 'claude-' + "opus-4-7';")).toEqual(['model']);
  expect(kindsInLine("const END = '2026-11-21';")).toEqual(['expiry']);
  expect(kindsInLine("const createdAt = '2026-11-21';")).toEqual([]);
});

test('growth over the baseline fails; a file at or under it passes; registry files are exempt', () => {
  const base = countSource('src/x.ts', "const a = 'node-b';\n");
  const now = countSource('src/x.ts', "const a = 'node-b';\nconst b = 'node-c';\n");
  expect(growth(now, base)).toEqual(['src/x.ts: host 2 > 1']);
  expect(growth(base, base)).toEqual([]);
  const fresh = countSource('src/new.ts', "const h = 'aws9';\n");
  expect(growth(fresh, emptyCounts())).toEqual(['src/new.ts: host 1 > 0']);
  expect(countSource('src/kit/resource-facts/defaults.ts', "{ host: 'node-b' }\n").host).toEqual({});
  expect(countSource('src/model-tier/llm-tier-map.ts', "model: '" + 'gpt-' + "6-sol',\n").model).toEqual({});
});

test('--update only shrinks: a migrated file drops out, a grown file keeps its old allowance', () => {
  const base = { ...emptyCounts(), host: { 'src/a.ts': 3, 'src/b.ts': 1 } };
  const now = { ...emptyCounts(), host: { 'src/a.ts': 5 } };
  expect(shrink(now, base).host).toEqual({ 'src/a.ts': 3 });
  // a file the baseline never had gets no allowance from --update (only --grow admits it)
  const fresh = { ...emptyCounts(), host: { 'src/new.ts': 2 } };
  expect(shrink(fresh, emptyCounts()).host).toEqual({});
  expect(shrink(fresh, emptyCounts(), true).host).toEqual({ 'src/new.ts': 2 });
});
