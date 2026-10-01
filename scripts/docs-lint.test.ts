import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const fixture = 'docs/goal-context/README.md';

function run(args: string[]) {
  return spawnSync(process.execPath, ['scripts/docs-lint.ts', fixture, ...args], { cwd: root, encoding: 'utf-8' });
}

test('docs lint의 코드 식별자 대조는 opt-in이며 기본 출력 계약을 보존한다', () => {
  const baseline = run([]);
  const checked = run(['--check-code-identifiers']);
  expect(baseline.status).toBe(0);
  expect(checked.status).toBe(0);
  expect(baseline.stdout).toContain('docs lint — 1개 검사');
  expect(baseline.stdout).not.toContain('코드 식별자 기준:');
  expect(checked.stdout).toContain('코드 식별자 기준: 문서의 단일 inline code(`name`)만 TypeScript AST Identifier 인벤토리와 대조한다');
}, 30_000);
