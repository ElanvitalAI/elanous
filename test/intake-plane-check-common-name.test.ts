import { afterEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIntakeCheck } from '../src/intake-plane/check.js';
import { buildIntakeDocumentStageCallables } from '../src/intake-plane/runtime-callables.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Names are assembled at run time so this file never matches its own search.
const common = ['sample', 'common', 'name', 'k3'].join('-');
const specific = ['sample', 'specific', 'name', 'k3'].join('-');
const absent = ['sample', 'absent', 'name', 'k3'].join('-');

const fixture = () => createIntakeFakeRepo(roots, 'intake-common-');

/** Enough comment lines that the implementation byte budget runs out before any executable support. */
function makeCommon(root: string): void {
  writeFileSync(join(root, 'src/noise.py'), `# ${common}\n`.repeat(1_600_000));
}

test('a common name that exhausts the budget does not sink a claim whose other name is measured', () => {
  const deps = fixture();
  makeCommon(deps.root);
  writeFileSync(join(deps.root, 'src/specific.ts'), `export const value = '${specific}';\n`);
  const item = runIntakeCheck([{ text: `elanous 에 \`${common}\` 와 \`${specific}\` 가 있다` }], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.failures).toEqual([]);
  expect(item.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'behavior' && row.path === 'src/specific.ts')).toBe(true);
  expect(item.evidence.some((row) => row.axis === 'repo' && row.summary.includes(`${common}: 너무 흔한 이름`))).toBe(true);
}, 60_000);

test('a common name left unmeasured cannot let an absent other name produce 없음', () => {
  const deps = fixture();
  makeCommon(deps.root);
  const report = runIntakeCheck([{ text: `elanous 에 \`${common}\` 와 \`${absent}\` 가 있다` }], deps);
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.goalDraftPaths).toEqual([]);
}, 60_000);

test('a claim whose only name exhausts the budget is still 못 쟀다', () => {
  const deps = fixture();
  makeCommon(deps.root);
  const report = runIntakeCheck([{ text: `elanous 에 \`${common}\` 가 있다` }], deps);
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures.join(' ')).toContain('탐색 예산 소진');
  expect(report.goalDraftPaths).toEqual([]);
}, 60_000);

test('production preprocess prompt asks for specific identifiers instead of one-word generic names', async () => {
  let prompt = '';
  const stages = buildIntakeDocumentStageCallables({
    resolveRoleProvider: () => ({ provider: { name: 'fixture' } }),
    streamLLM: async (messages) => {
      prompt = messages[0]?.content ?? '';
      return JSON.stringify({ claims: [], discards: [{ quote: 'q', reason: 'r' }] });
    },
  });
  await stages.preprocess({ document: '문서', lenses: ['L1 능력'] });
  expect(prompt).toContain('구체적 식별자');
  expect(prompt).toMatch(/`run`.*한 낱말 일반어는 너무 흔해/);
});
