import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildImporterTestIndex, isSourceLikeSpecifier, isTestPath } from './importer-test-index.js';
import { resolveGateScope } from './gate-scope.js';

function fixture(files: Record<string, string>): { cwd: string; dispose: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'importer-test-index-'));
  for (const [path, content] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe('buildImporterTestIndex — ordered TypeScript extension resolution', () => {
  test('a tracked scripts/ source is indexed from a relative test import without changing src/ resolution', () => {
    const repo = fixture({
      'scripts/compute.ts': 'export const compute = 1;\n',
      'src/service.ts': 'export const service = 1;\n',
      'test/compute.test.ts': "import '../scripts/compute.js';\nimport '../src/service.js';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/compute.test.ts'], ['scripts/compute.ts', 'src/service.ts']);
      expect(index?.testsBySource.get('scripts/compute.ts')).toEqual(['test/compute.test.ts']);
      expect(index?.testsBySource.get('src/service.ts')).toEqual(['test/compute.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally { repo.dispose(); }
  });
  test('a .js specifier registers only its first existing .ts candidate when .ts and .js coexist', () => {
    const repo = fixture({
      'src/x.ts': 'export const ts = true;\n',
      'src/x.js': 'export const js = true;\n',
      'test/importer.test.ts': "import '../src/x.js';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/x.ts', 'src/x.js']);
      expect(index).not.toBeNull();
      expect(index?.testsBySource.get('src/x.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.testsBySource.get('src/x.js')).toBeUndefined();

      const scope = resolveGateScope(['src/x.ts', 'src/x.js'], () => false, index ?? undefined);
      expect(scope.importerTestsNotRun).toMatchObject({ total: 1, files: ['test/importer.test.ts'], truncated: false });
    } finally {
      repo.dispose();
    }
  });

  test('a .jsx specifier resolves to .tsx before a coexisting .jsx source', () => {
    const repo = fixture({
      'src/view.tsx': 'export const View = null;\n',
      'src/view.jsx': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view.jsx';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.tsx', 'src/view.jsx']);
      expect(index).not.toBeNull();
      expect(index?.testsBySource.get('src/view.tsx')).toEqual(['test/importer.test.ts']);
      expect(index?.testsBySource.get('src/view.jsx')).toBeUndefined();
    } finally {
      repo.dispose();
    }
  });

  test('an extensionless directory import resolves its index source and removes its unresolved observation', () => {
    const repo = fixture({
      'src/compact/index.ts': 'export const compact = true;\n',
      'test/importer.test.ts': "import '../src/compact';\n",
    });
    try {
      const unresolved = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], []);
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/compact/index.ts']);
      expect(unresolved?.unresolvedRelativeSpecifiers).toBe(1);
      expect(index?.testsBySource.get('src/compact/index.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  // ⭐ 2026-08-25 — 못 푼 지정자 **20건 중 16건(80%)**이 이 한 가지였다.
  //   `apps/pwa/**` 의 시험이 «같은 모듈을 다른 목으로 여러 번» 부르려고 Bun 쿼리를 쓴다.
  //   ⛔ 그 접미사를 안 벗기면 실재하는 `SubjectList.tsx` 를 «못 찾고», 그 실패가
  //   「해석기의 사각」이 아니라 「소스가 없다」로 잘못 세어진다.
  test('⭐ 모듈 «쿼리» 접미사를 벗기고 해석한다 — `./view?mock` 은 `./view` 다', () => {
    const repo = fixture({
      'src/view.ts': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view?first';\nimport '../src/view?second';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.ts']);
      expect(index?.testsBySource.get('src/view.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  test('⭐ 확장자 «⊕» 쿼리가 같이 와도 해석한다 — `./view.js?mock`', () => {
    const repo = fixture({
      'src/view.ts': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view.js?mock';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.ts']);
      expect(index?.testsBySource.get('src/view.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  // ⛔ 쿼리를 벗겼다고 «자원» import 까지 소스로 세면 안 된다 — 그 수가 부풀면
  //   「해석기가 못 읽은 소스」라는 뜻이 다시 흐려진다.
  test('⛔ 자원 import 는 쿼리가 붙어도 «미해결로 세지 않는다» — `./data.json?raw`', () => {
    const repo = fixture({
      'test/importer.test.ts': "import '../fixtures/data.json?raw';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], []);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

// ⛔⭐ 무인 리뷰 must-fix 둘의 회귀 가드 — 「고쳤다」가 «실물»과 갈리지 않게.
test('treats an extensionless relative import as source-like even when the path starts with dots', () => {
  // 📏 종전 판 `^[^.]*$` 는 `../src/missing` 을 «못 물어» 미해결 수를 과소 집계했다.
  expect(isSourceLikeSpecifier('../src/missing')).toBe(true);
  expect(isSourceLikeSpecifier('./sibling')).toBe(true);
  expect(isSourceLikeSpecifier('../src/thing.js')).toBe(true);
  // 자원 import 는 «미해결이 아니라 대상이 아니다» — 세면 수가 부푼다.
  expect(isSourceLikeSpecifier('./fixtures/data.json')).toBe(false);
  expect(isSourceLikeSpecifier('../styles/app.css')).toBe(false);
});

test('recognises a tracked test path that contains a space', () => {
  // 📏 종전 판은 `\\S+` 라 «공백이 든 유효 경로»를 조용히 버렸다 — 그리고 그 판정이 seams 에도 «복제»돼 있었다.
  expect(isTestPath('test/dir with space/thing.test.ts')).toBe(true);
  expect(isTestPath('src/a/b.ts')).toBe(false);
});
