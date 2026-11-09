import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeReleaseFailures } from './release-failure-attribution.js';
import { runGateRepairNode } from '../../scripts/release-loop/gate-repair-node.js';
import type { GraphContext } from '../../scripts/release-loop/node-verdict.js';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function put(repo: string, path: string, text: string): void {
  const target = join(repo, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, text);
}

function commit(repo: string, subject: string): string {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'release-failure-attribution-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Attribution test');
  git(repo, 'config', 'user.email', 'attribution@example.test');
  return repo;
}

test('attributes a failure to source files changed by one first-parent PR, excluding the test-only edit', () => {
  const repo = repository();
  try {
    put(repo, 'test/gate.test.ts', "import { check } from '../src/check.ts';\nimport '../src/setup.ts';\n// import '../src/ghost.ts'\n");
    put(repo, 'test/gate.spec.ts', "import { check } from '../src/check.ts';\n");
    put(repo, 'test/gate.spec.tsx', "import { check } from '../src/check.ts';\n");
    put(repo, 'src/check.ts', "import { value } from './value.ts';\nexport const check = value;\n");
    put(repo, 'src/value.ts', 'export const value = 1;\n');
    put(repo, 'src/setup.ts', "import './value.ts';\n");
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/value.ts', 'export const value = 2;\n');
    const sourceCommit = commit(repo, 'fix: adjust gate source (#12345)');
    put(repo, 'test/gate.test.ts', "import { check } from '../src/check.ts';\nimport '../src/setup.ts';\n// expectation updated\n");
    commit(repo, 'test: update expectation (#12346)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    const attributions = attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/gate.test.ts > gate rejects stale source', 'test/gate.test.ts > another failure',
        'test/gate.spec.ts > spec rejects stale source', 'test/gate.spec.tsx > jsx spec rejects stale source'] });
    const attribution = attributions.find((row) => row.testFile === 'test/gate.test.ts');
    expect(attribution).toMatchObject({ testFile: 'test/gate.test.ts', sourceFiles: ['src/check.ts', 'src/setup.ts', 'src/value.ts'],
      causePrs: [12345], confidence: 'high', method: 'first-parent-source-overlap',
      evidence: [{ commit: sourceCommit, subject: 'fix: adjust gate source (#12345)', files: ['src/value.ts'] }] });
    expect(attributions).toHaveLength(4);
    expect(attributions.every((row) => row.sourceFiles.includes('src/value.ts') && row.causePrs[0] === 12345)).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('keeps multiple source PRs ambiguous and reports no source overlap as unmeasured', () => {
  const repo = repository();
  try {
    put(repo, 'test/multi.test.ts', "import { left } from '../src/left.ts';\nimport { right } from '../src/right.ts';\n");
    put(repo, 'src/left.ts', 'export const left = 1;\n');
    put(repo, 'src/right.ts', 'export const right = 1;\n');
    put(repo, 'test/unmeasured.test.ts', "import { untouched } from '../src/untouched.ts';\n");
    put(repo, 'src/untouched.ts', 'export const untouched = true;\n');
    put(repo, 'test/unresolved.test.ts', "import { hidden } from '../src/generated-at-runtime.ts';\nimport { aliased } from '@/generated-at-runtime';\n");
    put(repo, 'package.json', JSON.stringify({ dependencies: { '@workspace/hidden': '^1.0.0',
      '@workspace/unmapped': '^1.0.0', '@external/library': '^1.0.0' } }));
    put(repo, 'packages/hidden/package.json', JSON.stringify({ name: '@workspace/hidden', version: '1.0.0' }));
    put(repo, 'packages/unmapped/package.json', JSON.stringify({ name: '@workspace/unmapped', version: '1.0.0' }));
    put(repo, 'tsconfig.json', JSON.stringify({ extends: './shared-tsconfig.json', compilerOptions: {
      baseUrl: '.', paths: { '@external/*': ['src/external/*'] } } }));
    put(repo, 'test/unresolved.test.ts', "import { hidden } from '../src/generated-at-runtime.ts';\nimport { aliased } from '@/generated-at-runtime';\nimport { internal } from '@workspace/hidden';\nimport { unmapped } from '@workspace/unmapped';\nimport { external } from '@external/library';\n");
    put(repo, 'test/unowned.test.ts', "import { unowned } from '../src/unowned.ts';\n");
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/left.ts', 'export const left = 2;\n');
    commit(repo, 'fix: left source (#12351)');
    put(repo, 'src/right.ts', 'export const right = 2;\n');
    commit(repo, 'fix: right source (#12352)');
    put(repo, 'docs/unrelated.md', 'no importing test reaches this file\n');
    commit(repo, 'docs: unrelated update (#12353)');
    put(repo, 'src/detached.ts', 'export const detached = 3;\n');
    commit(repo, 'fix: unrelated source after unresolved import (#12354)');
    put(repo, 'src/unowned.ts', 'export const unowned = 2;\n');
    const unownedCommit = commit(repo, 'source changed without PR identity');
    const cut = git(repo, 'rev-parse', 'HEAD');
    const results = attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/multi.test.ts > fails', 'test/unmeasured.test.ts > fails', 'test/unresolved.test.ts > fails',
        'test/unowned.test.ts > fails'] });
    expect(results).toEqual([
      expect.objectContaining({ testFile: 'test/multi.test.ts', sourceFiles: ['src/left.ts', 'src/right.ts'],
        causePrs: [12351, 12352], confidence: 'ambiguous', method: 'first-parent-source-overlap' }),
      expect.objectContaining({ testFile: 'test/unmeasured.test.ts', sourceFiles: ['src/untouched.ts'],
        causePrs: [], confidence: 'unmeasured', method: 'unmeasured', evidence: [] }),
      expect.objectContaining({ testFile: 'test/unowned.test.ts', sourceFiles: ['src/unowned.ts'], causePrs: [],
        confidence: 'unmeasured', method: 'unmeasured',
        evidence: [{ commit: unownedCommit, subject: 'source changed without PR identity', files: ['src/unowned.ts'] }] }),
      expect.objectContaining({ testFile: 'test/unresolved.test.ts', sourceFiles: [], causePrs: [],
        unresolvedImports: ['test/unresolved.test.ts -> ../src/generated-at-runtime.ts', 'test/unresolved.test.ts -> @/generated-at-runtime',
          'test/unresolved.test.ts -> @external/library', 'test/unresolved.test.ts -> @workspace/hidden', 'test/unresolved.test.ts -> @workspace/unmapped'],
        confidence: 'unmeasured', method: 'unmeasured' }),
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('returns unmeasured when the previous release tag is not on the cut first-parent chain', () => {
  const repo = repository();
  try {
    put(repo, 'test/gate.spec.ts', "import { check } from '../src/check.ts';\n");
    put(repo, 'src/check.ts', 'export const check = true;\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    git(repo, 'checkout', '--orphan', 'unrelated-cut');
    put(repo, 'README.md', 'unrelated release history\n');
    const cut = commit(repo, 'unrelated cut');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/gate.spec.ts > failure'] })).toMatchObject([
      { testFile: 'test/gate.spec.ts', confidence: 'unmeasured', method: 'unmeasured', causePrs: [], evidence: [] },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('resolves cut-local tsconfig path aliases including inherited config before assigning a source PR', () => {
  const repo = repository();
  try {
    put(repo, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }));
    put(repo, 'test/tsconfig.json', JSON.stringify({ extends: '../tsconfig.base.json' }));
    put(repo, 'test/fixtures/alias.test.ts', "import { check } from '@app/check';\n");
    put(repo, 'src/check.ts', 'export const check = true;\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/check.ts', 'export const check = false;\n');
    commit(repo, 'fix: aliased source regression (#12401)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/fixtures/alias.test.ts > alias regression'] })).toMatchObject([
      { testFile: 'test/fixtures/alias.test.ts', sourceFiles: ['src/check.ts'], causePrs: [12401],
        unresolvedImports: [], confidence: 'high', method: 'first-parent-source-overlap' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('prefers TypeScript source over a same-base JavaScript file for a .js path alias', () => {
  const repo = repository();
  try {
    put(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@fixture/*': ['src/*'] } } }));
    put(repo, 'test/js-substitution.test.ts', "import { codec } from '@fixture/codec.js';\n");
    put(repo, 'src/codec.js', 'export const codec = "runtime old";\n');
    put(repo, 'src/codec.ts', 'export const codec = "typed old";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/codec.ts', 'export const codec = "typed changed";\n');
    commit(repo, 'fix: aliased TypeScript implementation regression (#12411)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/js-substitution.test.ts > codec alias regression'] })).toMatchObject([
      { sourceFiles: ['src/codec.ts'], causePrs: [12411], unresolvedImports: [], confidence: 'high' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('resolves a workspace package import through its cut-local source entry before assigning its source PR', () => {
  const repo = repository();
  try {
    put(repo, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    put(repo, 'test/workspace.test.ts', "import { normalize } from '@fixture/codec';\n");
    put(repo, 'packages/codec/package.json', JSON.stringify({ name: '@fixture/codec', source: './src/index.ts' }));
    put(repo, 'packages/codec/src/index.ts', 'export const normalize = (value: string) => value.trim();\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'packages/codec/src/index.ts', 'export const normalize = (value: string) => value.toLowerCase().trim();\n');
    commit(repo, 'fix: workspace source regression (#12402)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/workspace.test.ts > workspace regression'] })).toMatchObject([
      { testFile: 'test/workspace.test.ts', sourceFiles: ['packages/codec/src/index.ts'], causePrs: [12402],
        unresolvedImports: [], confidence: 'high', method: 'first-parent-source-overlap' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('honors a matching TypeScript path alias before a same-named workspace package', () => {
  const repo = repository();
  try {
    put(repo, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    put(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
      '@fixture/codec': ['src/alias-codec.ts'] } } }));
    put(repo, 'test/alias-precedence.test.ts', "import { codec } from '@fixture/codec';\n");
    put(repo, 'src/alias-codec.ts', 'export const codec = "alias";\n');
    put(repo, 'packages/codec/package.json', JSON.stringify({ name: '@fixture/codec', source: './src/index.ts' }));
    put(repo, 'packages/codec/src/index.ts', 'export const codec = "workspace";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/alias-codec.ts', 'export const codec = "changed alias";\n');
    commit(repo, 'fix: aliased implementation regression (#12403)');
    put(repo, 'packages/codec/src/index.ts', 'export const codec = "changed workspace";\n');
    commit(repo, 'fix: unrelated workspace implementation (#12404)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/alias-precedence.test.ts > alias wins'] })).toMatchObject([
      { sourceFiles: ['src/alias-codec.ts'], causePrs: [12403], unresolvedImports: [], confidence: 'high' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('uses the most specific TypeScript path pattern when its target is missing', () => {
  const repo = repository();
  try {
    put(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
      '*': ['src/fallback/*'], '@fixture/*': ['src/specific/*'] } } }));
    put(repo, 'test/path-pattern.test.ts', "import { codec } from '@fixture/codec';\n");
    put(repo, 'src/fallback/codec.ts', 'export const codec = "fallback";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/fallback/codec.ts', 'export const codec = "changed fallback";\n');
    commit(repo, 'fix: broad fallback regression (#12406)');
    put(repo, 'packages/codec/src/index.ts', 'export const codec = "changed workspace";\n');
    commit(repo, 'fix: workspace regression (#12407)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/path-pattern.test.ts > specific alias is unresolved'] })).toMatchObject([
      { sourceFiles: [], causePrs: [], unresolvedImports: ['test/path-pattern.test.ts -> @fixture/codec'],
        confidence: 'unmeasured', method: 'unmeasured' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('falls back to a workspace package when the configured alias target is missing', () => {
  const repo = repository();
  try {
    put(repo, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    put(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
      '@fixture/*': ['src/missing/*'] } } }));
    put(repo, 'test/alias-workspace-fallback.test.ts', "import { codec } from '@fixture/codec';\n");
    put(repo, 'packages/codec/package.json', JSON.stringify({ name: '@fixture/codec', source: './src/index.ts' }));
    put(repo, 'packages/codec/src/index.ts', 'export const codec = "old";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'packages/codec/src/index.ts', 'export const codec = "new";\n');
    commit(repo, 'fix: workspace reached after missing alias target (#12409)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/alias-workspace-fallback.test.ts > alias target absent but workspace exists'] })).toMatchObject([
      { sourceFiles: ['packages/codec/src/index.ts'], causePrs: [12409], unresolvedImports: [],
        confidence: 'high', method: 'first-parent-source-overlap' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('keeps declaration order when matching TypeScript path patterns have equal prefixes', () => {
  const repo = repository();
  try {
    put(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
      '@fixture/*': ['src/missing/*'], '@fixture/*.js': ['src/second/*'] } } }));
    put(repo, 'test/path-tie.test.ts', "import { codec } from '@fixture/codec.js';\n");
    put(repo, 'src/second/codec.js', 'export const codec = "old";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'src/second/codec.js', 'export const codec = "changed";\n');
    commit(repo, 'fix: less-specific tied alias target (#12408)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/path-tie.test.ts > first matching alias target is missing'] })).toMatchObject([
      { sourceFiles: [], causePrs: [], unresolvedImports: ['test/path-tie.test.ts -> @fixture/codec.js'],
        confidence: 'unmeasured', method: 'unmeasured' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('resolves wildcard workspace exports and preserves missing or duplicate package entries as unmeasured', () => {
  const repo = repository();
  try {
    put(repo, 'package.json', JSON.stringify({ dependencies: { '@fixture/duplicate': '^1.0.0', '@fixture/missing': '^1.0.0' },
      workspaces: ['packages/*'] }));
    put(repo, 'test/workspace-edges.test.ts', "import { feature } from '@fixture/codec/features/format';\nimport { duplicate } from '@fixture/duplicate';\nimport { missing } from '@fixture/missing';\n");
    put(repo, 'packages/codec/package.json', JSON.stringify({ name: '@fixture/codec', exports: {
      './features/*': { import: './src/features/*.ts', default: './src/features/*.ts' } } }));
    put(repo, 'packages/codec/src/features/format.ts', 'export const feature = "old";\n');
    put(repo, 'packages/duplicate-a/package.json', JSON.stringify({ name: '@fixture/duplicate', source: './src/index.ts' }));
    put(repo, 'packages/duplicate-b/package.json', JSON.stringify({ name: '@fixture/duplicate', source: './src/index.ts' }));
    put(repo, 'packages/duplicate-a/src/index.ts', 'export const duplicate = "a";\n');
    put(repo, 'packages/duplicate-b/src/index.ts', 'export const duplicate = "b";\n');
    put(repo, 'packages/missing/package.json', JSON.stringify({ name: '@fixture/missing' }));
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'packages/codec/src/features/format.ts', 'export const feature = "new";\n');
    commit(repo, 'fix: wildcard workspace source regression (#12405)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/workspace-edges.test.ts > ambiguous and missing workspace entries'] })).toMatchObject([
      { sourceFiles: ['packages/codec/src/features/format.ts'], causePrs: [12405],
        unresolvedImports: ['test/workspace-edges.test.ts -> @fixture/duplicate', 'test/workspace-edges.test.ts -> @fixture/missing'],
        confidence: 'unmeasured', method: 'unmeasured' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('selects the most specific nested workspace export pattern', () => {
  const repo = repository();
  try {
    put(repo, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    put(repo, 'test/nested-export.test.ts', "import { feature } from '@fixture/codec/features/internal/format';\n");
    put(repo, 'packages/codec/package.json', JSON.stringify({ name: '@fixture/codec', exports: {
      './features/*': './src/features/*.ts',
      './features/internal/*': './src/internal-features/*.ts',
    } }));
    put(repo, 'packages/codec/src/features/internal/format.ts', 'export const feature = "broad old";\n');
    put(repo, 'packages/codec/src/internal-features/format.ts', 'export const feature = "specific old";\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    put(repo, 'packages/codec/src/features/internal/format.ts', 'export const feature = "broad changed";\n');
    commit(repo, 'fix: broad workspace export source (#12412)');
    put(repo, 'packages/codec/src/internal-features/format.ts', 'export const feature = "specific changed";\n');
    commit(repo, 'fix: nested workspace export source (#12413)');
    const cut = git(repo, 'rev-parse', 'HEAD');

    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: cut,
      failureIds: ['test/nested-export.test.ts > nested workspace export regression'] })).toMatchObject([
      { sourceFiles: ['packages/codec/src/internal-features/format.ts'], causePrs: [12413],
        unresolvedImports: [], confidence: 'high' },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('gate repair consumes source-to-PR attribution and writes the source file and owner into its simulated child request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-attribution-consumer-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Attribution test');
    git(repo, 'config', 'user.email', 'attribution@example.test');
    put(repo, 'test/gate.test.ts', "import { check } from '../src/gate-logic.ts';\n");
    put(repo, 'src/gate-logic.ts', 'export const check = true;\n');
    const base = commit(repo, 'release baseline');
    git(repo, 'tag', 'v0.3.5', base);
    put(repo, 'src/gate-logic.ts', 'export const check = false;\n');
    const cut = commit(repo, 'fix: introduced gate source failure (#12345)');
    const failureId = 'test/gate.test.ts > gate regression';
    const context: GraphContext = { runId: 'macro-attrib-consumer', input: { version: '0.3.6', previousVersion: '0.3.5' },
      nodeInput: { version: '0.3.6', runId: 'macro-attrib-consumer', commit: cut, failureIds: [failureId] }, outputs: {} };
    let featureBody = '';
    const result = await runGateRepairNode(context, { root, repo,
      startRepairChild: async (featureFile, baseBranch) => {
        expect(baseBranch).toBe('main');
        featureBody = readFileSync(featureFile, 'utf8');
        return { ok: true, prNumber: 90001, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/90001' };
      },
      inspectRepairPr: async (prNumber) => {
        expect(prNumber).toBe(90001);
        return { isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/gate-logic.ts'] };
      },
      waitForLanded: async (prNumber) => ({ schema: 1, prNumber, repairRunId: context.runId!, head: 'a'.repeat(40),
        mergeSha: 'b'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
      refreshMainlineHead: () => 'b'.repeat(40),
      isAncestor: () => true,
    });
    expect(featureBody).toContain('Attributed source file: src/gate-logic.ts');
    expect(featureBody).toContain('Attributed cause PR: #12345');
    expect(featureBody).toContain(failureId);
    expect(result).toMatchObject({ outcome: 'ok', repairedFiles: ['src/gate-logic.ts'],
      repairs: [{ file: 'src/gate-logic.ts', status: 'repaired', prNumber: 90001 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate repair routes a source file with multiple cause PRs to same-run HITL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-ambiguous-cause-'));
  const failureIds = ['test/a.test.ts > first regression', 'test/b.test.ts > second regression'];
  const context: GraphContext = { runId: 'macro-ambiguous-cause', input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'macro-ambiguous-cause', commit: 'a'.repeat(40), failureIds }, outputs: {} };
  let childStarts = 0;
  try {
    const result = await runGateRepairNode(context, { root, repo: root,
      attributeFailures: () => failureIds.map((failureId, index) => ({ failureId, testFile: `test/${index ? 'b' : 'a'}.test.ts`,
        confidence: 'high', method: 'first-parent-source-overlap', causePrs: [12345 + index],
        sourceFiles: ['src/shared.ts'], unresolvedImports: [], evidence: [] })),
      startRepairChild: async () => { childStarts++; return { ok: false, error: 'must not launch' }; },
    });
    expect(childStarts).toBe(0);
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', repairedFiles: [],
      humanRequired: [{ file: 'src/shared.ts', failureIds: failureIds.map((id) => `src/shared.ts > ${id}`),
        reason: 'source file has 2 cause PRs; exactly one is required for child repair' }],
      remainingFailureIds: failureIds });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate repair holds a confirmed source when a sibling failure has incomplete attribution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-incomplete-cause-'));
  const failureIds = ['test/confirmed.test.ts > confirmed', 'test/unmeasured.test.ts > unmeasured'];
  const context: GraphContext = { runId: 'macro-incomplete-cause', input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'macro-incomplete-cause', commit: 'a'.repeat(40), failureIds }, outputs: {} };
  let childStarts = 0;
  try {
    const result = await runGateRepairNode(context, { root, repo: root,
      attributeFailures: () => [
        { failureId: failureIds[0]!, testFile: 'test/confirmed.test.ts', confidence: 'high', method: 'first-parent-source-overlap',
          causePrs: [12345], sourceFiles: ['src/shared.ts'], unresolvedImports: [], evidence: [] },
        { failureId: failureIds[1]!, testFile: 'test/unmeasured.test.ts', confidence: 'unmeasured', method: 'unmeasured',
          causePrs: [], sourceFiles: ['src/shared.ts'], unresolvedImports: ['dependency closure incomplete'], evidence: [] },
      ],
      startRepairChild: async () => { childStarts++; return { ok: false, error: 'must not launch' }; },
    });
    expect(childStarts).toBe(0);
    expect(result).toMatchObject({ outcome: 'fail', repairedFiles: [], remainingFailureIds: failureIds,
      humanRequired: [{ file: 'src/shared.ts',
        reason: 'source file also has incomplete attribution; all related failures require same-run HITL' }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate repair preserves malformed original failure IDs that resemble a source prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-prefix-id-'));
  const malformedId = 'src/shared.ts > not-a-test';
  const confirmedId = 'test/confirmed.test.ts > confirmed';
  const failureIds = [confirmedId, malformedId];
  const context: GraphContext = { runId: 'macro-prefix-id', input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'macro-prefix-id', commit: 'a'.repeat(40), failureIds }, outputs: {} };
  try {
    const result = await runGateRepairNode(context, { root, repo: root,
      attributeFailures: () => [
        { failureId: confirmedId, testFile: 'test/confirmed.test.ts', confidence: 'high', method: 'first-parent-source-overlap',
          causePrs: [12345], sourceFiles: ['src/shared.ts'], unresolvedImports: [], evidence: [] },
        { failureId: malformedId, testFile: '', confidence: 'unmeasured', method: 'unmeasured',
          causePrs: [], sourceFiles: [], unresolvedImports: ['invalid test failure id'], evidence: [] },
      ],
      startRepairChild: async () => ({ ok: false, error: 'simulated child failure' }),
    });
    expect(result.outcome).toBe('fail');
    expect(result.remainingFailureIds).toContain(malformedId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retains unsafe or malformed failure IDs as unmeasured attribution rows', () => {
  const repo = repository();
  try {
    put(repo, 'README.md', 'fixture baseline\n');
    const base = commit(repo, 'fixture baseline');
    git(repo, 'tag', 'release/0.3.5', base);
    expect(attributeReleaseFailures({ repo, previousTag: 'release/0.3.5', cutCommit: base,
      failureIds: ['../../outside.test.ts > escape', 'not-a-test-path'] })).toEqual([
      expect.objectContaining({ failureId: '../../outside.test.ts > escape', testFile: '', confidence: 'unmeasured',
        unresolvedImports: ['invalid test failure id: ../../outside.test.ts > escape'] }),
      expect.objectContaining({ failureId: 'not-a-test-path', testFile: '', confidence: 'unmeasured',
        unresolvedImports: ['invalid test failure id: not-a-test-path'] }),
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
