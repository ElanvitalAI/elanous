import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWHOW_PACK_MAX_BYTES, selectKnowhowPack } from './knowhow-pack.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'knowhow-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/roles/TC'), { recursive: true });
  const file = join(root, 'docs/roles/TC/KNOWHOW.md');
  writeFileSync(file, [
    '# TC',
    '## K-TC-1 scope-escape 의 경로 확인 (작성 2026-10-20)',
    '- 상황: src/self-implement/orchestrator.ts 에서 scope-escape 발생.',
    '- 처방(힐링): 대상 경로 밖 편집 여부를 먼저 확인한다.',
    '- 출처: 사례 1 · 상태: active',
    '## K-TC-2 일반 지식 (작성 2026-10-20)',
    '- 상황: src/other/file.ts 변경.',
    '- 출처: 사례 2 · 상태: active',
    '## K-TC-3 퇴역 지식 (작성 2026-10-20)',
    '- 상황: src/self-implement/orchestrator.ts 에서 scope-escape 발생.',
    '- 출처: 사례 3 · 상태: stale',
  ].join('\n'));
  return { root, file };
}

test('selects only matching promoted repository knowhow, bounded and without changing the source', () => {
  const { root, file } = fixture();
  const before = createHash('sha256').update(readFileSync(file)).digest('hex');
  const goal = '대상 경로: src/self-implement/orchestrator.ts\n실패 서명: scope-escape';
  const pack = selectKnowhowPack(root, goal);
  expect(pack.ids).toEqual(['K-TC-1']);
  expect(pack.text).toContain('대상 경로 밖 편집 여부');
  expect(pack.text).not.toContain('K-TC-3');
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text));
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
  expect(selectKnowhowPack(root, `${pack.text}\n\n${goal}`).ids).toEqual([]);
});

test('returns an empty pack for unrelated goals and excludes a source symlink outside roles', () => {
  const { root } = fixture();
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated.ts').ids).toEqual([]);
  mkdirSync(join(root, 'docs/roles/UX'), { recursive: true });
  symlinkSync(join(root, 'docs/roles/TC/KNOWHOW.md'), join(root, 'docs/roles/UX/KNOWHOW.md'));
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids).toEqual(['K-TC-1']);
});

test('sentence punctuation matches the path but an identical basename elsewhere does not', () => {
  const { root, file } = fixture();
  writeFileSync(file, readFileSync(file, 'utf8') + '\n## K-TC-4 different index\n- 상황: src/other/index.ts 변경.\n- 출처: 사례 4 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts.').ids).toEqual(['K-TC-1']);
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated/index.ts.').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated/index.ts.\n실패 서명: scope-escape').ids).toEqual([]);
});

test('selects no more than three entries within the UTF-8 byte budget', () => {
  const { root, file } = fixture();
  const sections = Array.from({ length: 8 }, (_, index) => `## K-TC-${index + 10} target\n- 상황: src/self-implement/orchestrator.ts.\n- 처방: ${'가'.repeat(450)}\n- 출처: 사례 · 상태: active`).join('\n');
  writeFileSync(file, sections);
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids.length).toBeLessThanOrEqual(3);
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
  expect(pack.ids.length).toBeGreaterThan(0);
});

test('three-entry limit applies when all four small entries fit the byte budget', () => {
  const { root, file } = fixture();
  writeFileSync(file, Array.from({ length: 4 }, (_, index) => `## K-TC-${index + 10} target\n- 상황: src/self-implement/orchestrator.ts.\n- 출처: 사례 · 상태: active`).join('\n'));
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids).toEqual(['K-TC-10', 'K-TC-11', 'K-TC-12']);
  expect(pack.bytes).toBeLessThan(KNOWHOW_PACK_MAX_BYTES);
});

test('preserves package prefixes and treats docs paths as explicit goal paths', () => {
  const { root, file } = fixture();
  writeFileSync(file, [
    '## K-TC-20 client scope\n- 상황: packages/client/src/index.ts scope-escape.\n- 출처: 사례 · 상태: active',
    '## K-TC-21 server scope\n- 상황: packages/server/src/index.ts scope-escape.\n- 출처: 사례 · 상태: active',
  ].join('\n'));
  expect(selectKnowhowPack(root, '대상 경로: packages/client/src/index.ts. 실패: scope-escape').ids).toEqual(['K-TC-20']);
  expect(selectKnowhowPack(root, '대상 경로: docs/one.md. 실패: scope-escape').ids).toEqual([]);
  expect(selectKnowhowPack(root, '실패 서명: scope-escape').ids).toEqual([]);
});

test('repository-root filenames are excluded and zero path matches never inject', () => {
  const { root, file } = fixture();
  writeFileSync(file, '## K-TC-30 package config\n- 상황: package.json no-progress.\n- 출처: 사례 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: tsconfig.json\n실패 서명: no-progress').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: package.json\n실패 서명: no-progress').ids).toEqual([]);
  writeFileSync(file, '## K-TC-31 general\n- 상황: no-progress.\n- 출처: 사례 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: package.json\n실패 서명: no-progress').ids).toEqual([]);
});

test('rejects paths outside the repository and matches other file extensions exactly', () => {
  const { root, file } = fixture();
  writeFileSync(file, [
    '## K-TC-40 TypeScript path\n- 상황: src/foo.ts.\n- 출처: 사례 · 상태: active',
    '## K-TC-41 Go path\n- 상황: src/foo.go.\n- 출처: 사례 · 상태: active',
    '## K-TC-42 Vue path\n- 상황: src/foo.vue.\n- 출처: 사례 · 상태: active',
  ].join('\n'));
  expect(selectKnowhowPack(root, '대상 경로: ../src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: /src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: ./src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: src/foo.go.').ids).toEqual(['K-TC-41']);
  expect(selectKnowhowPack(root, '대상 경로: src/foo.vue.').ids).toEqual(['K-TC-42']);
});
