import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIntakeCheck } from '../src/intake-plane/check.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Assembled at run time so this file never matches its own search.
const token = ['sample', 'self', 'source', 'k5'].join('-');
const fact = { text: `elanous 에 \`${token}\` 가 있다` };

function fixture() {
  const deps = createIntakeFakeRepo(roots, 'intake-self-');
  mkdirSync(join(deps.root, 'src/intake-plane'));
  return deps;
}

test('a name that only the intake tool itself quotes is not present', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/intake-plane/prompts.ts'), `export const example = 'elanous 에 ${token} 가 있다';\n`);
  const item = runIntakeCheck([fact], deps).items[0]!;
  expect(item.verdict).not.toBe('있음');
  expect(item.evidence.some((row) => row.path?.startsWith('src/intake-plane/'))).toBe(false);
});

test('the same name in other source is still present evidence', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/intake-plane/prompts.ts'), `export const example = '${token}';\n`);
  writeFileSync(join(deps.root, 'src/ledger.ts'), `export const field = '${token}';\n`);
  const item = runIntakeCheck([fact], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'behavior' && row.path === 'src/ledger.ts')).toBe(true);
});
