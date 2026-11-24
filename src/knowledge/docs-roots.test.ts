import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveKnowledgeDocsRoots } from './docs-roots.js';

/** 이 패키지의 실제 docs/ — 자동 감지를 스텁으로 막지 않는 회귀의 기준. */
const REAL_TOOL_DOCS = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs'));

function fixture(): { root: string; toolDocs: string; workDocs: string; moduleUrl: string; scriptUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-roots-'));
  const toolHome = join(root, 'tool');
  const toolSrc = join(toolHome, 'src', 'knowledge');
  const toolDocs = join(toolHome, 'docs');
  const work = join(root, 'work');
  const workDocs = join(work, 'docs');
  mkdirSync(toolSrc, { recursive: true });
  mkdirSync(toolDocs, { recursive: true });
  mkdirSync(workDocs, { recursive: true });
  writeFileSync(join(toolHome, 'package.json'), JSON.stringify({ name: 'elanous' }));
  writeFileSync(join(work, '.git'), '');
  return {
    root,
    toolDocs,
    workDocs,
    moduleUrl: pathToFileURL(join(toolSrc, 'docs-roots.ts')).href,
    scriptUrl: pathToFileURL(join(toolHome, 'scripts', 'knowledge-ingest.ts')).href,
  };
}

describe('resolveKnowledgeDocsRoots', () => {
  test('설정 knowledge.docsRoots 가 있으면 그 경로만 쓰고 자동 감지를 섞지 않는다', () => {
    const fx = fixture();
    const configured = [join(fx.root, 'only-a'), join(fx.root, 'only-b')];
    const got = resolveKnowledgeDocsRoots({
      docsRoots: configured,
      toolModuleUrl: fx.moduleUrl,
      cwd: join(fx.root, 'work'),
    });
    expect(got.source).toBe('config');
    expect(got.roots.map((r) => r.path)).toEqual(configured.map((p) => join(p)));
    expect(got.roots.every((r) => r.source === 'config')).toBe(true);
    expect(got.roots.some((r) => r.path === fx.toolDocs || r.path === fx.workDocs)).toBe(false);
  });

  test('설정이 없고 도구 체크아웃만 있으면 도구 docs 만', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.scriptUrl,
      toolDocsSegments: ['..', 'docs'],
      cwd: join(fx.root, 'empty-cwd'),
      exists: (p) => p === fx.toolDocs,
      readPackageName: () => 'elanous',
      gitRoot: () => undefined,
    });
    expect(got.roots).toEqual([{ path: fx.toolDocs, source: 'tool-checkout' }]);
    expect(got.source).toBe('tool-checkout');
  });

  test('package.json 이름이 elanous 가 아니면 도구 체크아웃을 넣지 않는다', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.scriptUrl,
      toolDocsSegments: ['..', 'docs'],
      cwd: join(fx.root, 'work'),
      exists: (p) => p === fx.toolDocs,
      readPackageName: () => 'other-package',
      gitRoot: () => undefined,
    });
    expect(got.roots).toEqual([]);
    expect(got.source).toBe('none');
  });

  test('설정이 없고 작업 저장소 docs 만 있으면 작업 docs', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.moduleUrl,
      cwd: join(fx.root, 'work', 'nested'),
      exists: (p) => p === fx.workDocs,
      readPackageName: () => undefined,
      gitRoot: () => join(fx.root, 'work'),
    });
    expect(got.roots).toEqual([{ path: fx.workDocs, source: 'workdir' }]);
    expect(got.source).toBe('workdir');
  });

  test('같은 경로는 한 번만', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.scriptUrl,
      toolDocsSegments: ['..', 'docs'],
      cwd: join(fx.root, 'work'),
      // 현실적 스텁 — 참 스텁이면 현행 절 후보(실제 홈·도구 docs 아래 경로)까지 끌어들인다.
      exists: (p) => p === fx.toolDocs,
      readPackageName: () => 'elanous',
      gitRoot: () => join(fx.root, 'tool'),
    });
    expect(got.roots).toEqual([{ path: fx.toolDocs, source: 'tool-checkout' }]);
  });

  test('아무것도 없으면 빈 목록과 출처 none', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      docsRoots: ['  ', ''],
      toolModuleUrl: fx.moduleUrl,
      cwd: join(fx.root, 'nowhere'),
      exists: () => false,
      readPackageName: () => undefined,
      gitRoot: () => undefined,
    });
    expect(got.roots).toEqual([]);
    expect(got.source).toBe('none');
  });

  test('docsRoots 가 빈 배열이면 실제 도구 docs 가 있어도 자동 감지로 넘어가지 않는다', () => {
    const got = resolveKnowledgeDocsRoots({
      docsRoots: [],
      toolModuleUrl: import.meta.url,
      toolDocsSegments: ['..', '..', 'docs'],
      cwd: dirname(fileURLToPath(import.meta.url)),
    });
    expect(got).toEqual({ roots: [], source: 'none' });
    expect(REAL_TOOL_DOCS.endsWith('/docs')).toBe(true);
  });

  test('빈 .git 파일만 있는 디렉터리는 작업 저장소가 아니다', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.moduleUrl,
      cwd: join(fx.root, 'work'),
      exists: (p) => p === fx.workDocs,
      readPackageName: () => undefined,
    });
    expect(got.roots).toEqual([]);
    expect(got.source).toBe('none');
  });

  test('git rev-parse 가 인정한 작업 저장소 뿌리의 docs 만 수집한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-roots-git-'));
    const workDocs = join(root, 'docs');
    mkdirSync(workDocs, { recursive: true });
    const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    expect(init.status).toBe(0);
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: pathToFileURL(join(root, 'missing', 'docs-roots.ts')).href,
      cwd: root,
      exists: (p) => p === workDocs || p === realpathSync(workDocs),
      readPackageName: () => undefined,
    });
    expect(got.source).toBe('workdir');
    expect(got.roots).toEqual([{ path: realpathSync(workDocs), source: 'workdir' }]);
  });
});
