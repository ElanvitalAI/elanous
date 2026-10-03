import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pwaGraph, pwaReach, runPwaBuildGate, type BuildResult, type PwaGraph } from './ci-pwa-build-gate.js';

const graphOf = (files: string[], uncertain: string | null = null) => (): PwaGraph => ({ files: new Set(files), uncertain });

function run(changed: string[], graph: () => PwaGraph, build: BuildResult = { status: 0, output: '' }) {
  const lines: string[] = [];
  let builds = 0;
  const rc = runPwaBuildGate({
    args: ['--changed-files', ...changed], cwd: '/nowhere',
    log: (l) => lines.push(l), error: (l) => lines.push(l),
    graph, runBuild: () => { builds++; return build; },
  });
  return { rc, builds, out: lines.join('\n') };
}

describe('pwa build gate (GATE-PWA)', () => {
  test('a PWA-reached src file whose build breaks blocks (MAT1b shape)', () => {
    const r = run(['src/maturity/feature-maturity.ts'], graphOf(['src/maturity/feature-maturity.ts']), { status: 1, output: 'Module not found: ../tui/chat' });
    expect(r.builds).toBe(1);
    expect(r.rc).toBe(1);
    expect(r.out).toContain('[pwa-gate] FAIL');
  });

  test('an unrelated src change is «해당 없음» and builds nothing', () => {
    const r = run(['src/steward/triage.ts'], graphOf(['src/maturity/feature-maturity.ts']));
    expect(r).toMatchObject({ rc: 0, builds: 0 });
    expect(r.out).toContain('[pwa-gate] 해당 없음');
  });

  test('any apps/pwa change builds once — test files included (round 3 must-fix)', () => {
    for (const f of ['apps/pwa/src/app/page.tsx', 'apps/pwa/src/lib/use-operator.test.ts']) {
      // An empty graph: only the apps/pwa rule itself can make this build.
      const r = run([f], graphOf([]));
      expect(r).toMatchObject({ rc: 0, builds: 1 });
      expect(r.out).toContain('apps/pwa 변경');
    }
  });

  test('build output folders under apps/pwa do not trigger a build', () => {
    const r = run(['apps/pwa/.next/cache/x.js', 'apps/pwa/out/index.html'], graphOf([]));
    expect(r.builds).toBe(0);
  });

  test('an unreadable or undecidable graph counts as reaching the PWA', () => {
    expect(run(['src/a.ts'], () => { throw new Error('tsc crashed'); }).builds).toBe(1);
    expect(run(['src/a.ts'], graphOf([], 'tsconfig unreadable')).builds).toBe(1);
  });

  test('a build that cannot run at all is «측정 불가» and exits 1', () => {
    const r = run(['apps/pwa/src/app/page.tsx'], graphOf([]), { status: null, output: 'apps/pwa/node_modules incomplete after install' });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('측정 불가');
  });

  test('non-TS files under src/ (css, js beside a .d.ts) build conservatively', () => {
    expect(pwaReach(['src/shared/styles.css'], graphOf([])).reaches).toBe(true);
    expect(pwaReach(['src/lib/bridge.js'], graphOf(['src/lib/bridge.d.ts'])).reaches).toBe(true);
  });

  test('docs-only changes never read the graph', () => {
    const r = run(['docs/x.md', 'release/next.md'], () => { throw new Error('graph must not be needed'); });
    expect(r).toMatchObject({ rc: 0, builds: 0 });
  });

  test('a tree without apps/pwa is «해당 없음» without reading anything', () => {
    const lines: string[] = [];
    const rc = runPwaBuildGate({ args: ['--changed-files', 'src/a.ts'], cwd: '/nowhere', log: (l) => lines.push(l), error: (l) => lines.push(l), runBuild: () => { throw new Error('no build'); } });
    expect(rc).toBe(0);
    expect(lines.join('\n')).toContain('apps/pwa 가 없다');
  });
});

describe('pwaGraph — the TypeScript program decides reach', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'pwa-gate-'));
    const w = (p: string, s: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s); };
    w('apps/pwa/tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', include: ['src/**/*.ts', 'src/**/*.tsx'] }));
    // An inherited alias (round 1·2 must-fix): `shared/*` resolves into repo src/ only through `extends`.
    w('apps/pwa/tsconfig.base.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { 'shared/*': ['../../src/shared/*'] }, noEmit: true } }));
    w('apps/pwa/src/page.ts', "import { a } from 'shared/a';\nimport type { T } from '../../../src/types/t';\nimport { b } from './bridge';\nexport const x: T = a + b;\n");
    w('apps/pwa/src/bridge.ts', "export { m as b } from '../../../src/maturity/m';\n");
    w('src/shared/a.ts', 'export const a = 1;\n');
    w('src/types/t.ts', 'export type T = number;\n');
    w('src/maturity/m.ts', 'export const m = 2;\n');
    w('src/dyn/loader.ts', "export const load = (n: string) => import(`./plugins/${n}`);\n");
    w('src/unrelated.ts', 'export const u = 3;\n');
    return root;
  }

  test('aliases via extends, type-only imports and in-app hops are all in the closure', () => {
    const root = fixture();
    try {
      const g = pwaGraph(root);
      expect(g.uncertain).toBeNull();
      for (const f of ['src/shared/a.ts', 'src/types/t.ts', 'src/maturity/m.ts']) expect(g.files.has(f)).toBe(true);
      expect(g.files.has('src/unrelated.ts')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a non-literal import() pulls its whole directory in (bundler context)', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'apps/pwa/src/page.ts'), "import { load } from '../../../src/dyn/loader';\nexport const p = load;\n");
      mkdirSync(join(root, 'src/dyn/plugins'), { recursive: true });
      writeFileSync(join(root, 'src/dyn/sibling.ts'), 'export const s = 1;\n');
      const g = pwaGraph(root);
      expect(g.files.has('src/dyn/sibling.ts')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
