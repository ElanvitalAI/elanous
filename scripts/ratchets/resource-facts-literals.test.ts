import { expect, test } from 'bun:test';
import { countSource, emptyCounts, growth, kindsInLine, readBaseline, scanRepo, shrink } from './resource-facts-literals';

test('the repo adds no new hardcoded host / account / model / expiry literal in src/', () => {
  expect(growth(scanRepo(), readBaseline())).toEqual([]);
});

test('a new host literal is caught (and only the line kinds that apply)', () => {
  expect(kindsInLine("const HOSTS = ['node-b', 'minim5'];")).toEqual(['host']);
  expect(kindsInLine("  const h = 'gcp7';")).toEqual(['host']);
  expect(kindsInLine('// node-b is fine in a comment')).toEqual([]);
  expect(kindsInLine(' * aws1 doc line')).toEqual([]);
  expect(kindsInLine("const name = 'mbpHost';")).toEqual([]);
});

test('codex account names, model ids and expiry dates are caught', () => {
  expect(kindsInLine("const account = 'third';")).toEqual(['account']);
  expect(kindsInLine("useProfile('codex-team')")).toEqual(['account']);
  expect(kindsInLine("const role = 'team';")).toEqual([]);
  expect(kindsInLine("const m = 'gpt-6.1-terra';")).toEqual(['model']);
  expect(kindsInLine("const m = 'claude-opus-4-7';")).toEqual(['model']);
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
  expect(countSource('src/model-tier/llm-tier-map.ts', "model: 'gpt-6-sol',\n").model).toEqual({});
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
