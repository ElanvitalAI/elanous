import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditProvenance, type ProvenanceAuditResult } from './provenance-audit';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'provenance-audit-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('auditProvenance', () => {
  test('returns sorted exported-symbol overlap between repository and reference src trees', () => {
    const repositoryRoot = tree({
      'src/a.ts': 'export const Zebra = 1; export type SharedType = string; const Private = 1;',
      'src/nested/b.ts': 'export { local as ReExported }; const local = 1; export class Alpha {}',
    });
    const referenceRoot = tree({
      'src/a.ts': 'export const Zebra = 2; export interface SharedType { value: string }; export const Other = 1;',
      'src/nested/b.ts': 'export const ReExported = 1; export class Alpha {}',
    });

    const result: ProvenanceAuditResult = auditProvenance({ repositoryRoot, referenceRoot });

    expect(result).toEqual({
      overlappingSymbols: ['Alpha', 'ReExported', 'SharedType', 'Zebra'],
      justified: [],
      unjustified: ['Alpha', 'ReExported', 'SharedType', 'Zebra'],
      unmeasured: [],
    });
  });

  test('accepts an injected source directory and de-duplicates repeated declarations', () => {
    const repositoryRoot = tree({ 'src/one.ts': 'export const Duplicate = 1;' });
    const referenceSource = tree({
      'one.ts': 'export const Duplicate = 2;',
      'two.ts': 'export { Duplicate };',
    });

    expect(auditProvenance({ repositoryRoot, referenceRoot: referenceSource })).toEqual({
      overlappingSymbols: ['Duplicate'],
      justified: [],
      unjustified: ['Duplicate'],
      unmeasured: [],
    });
  });

  test('discovers destructured bindings and namespace exports as public symbols', () => {
    const repositoryRoot = tree({
      'src/exports.ts': 'export const { Shared: Renamed, nested: { DeepShared } } = value; export * as NamespaceShared from \'./module\';',
    });
    const referenceRoot = tree({
      'src/exports.ts': 'export const Renamed = 1; export const DeepShared = 2; export * as NamespaceShared from \'./module\';',
    });

    expect(auditProvenance({ repositoryRoot, referenceRoot })).toEqual({
      overlappingSymbols: ['DeepShared', 'NamespaceShared', 'Renamed'],
      justified: [],
      unjustified: ['DeepShared', 'NamespaceShared', 'Renamed'],
      unmeasured: [],
    });
  });

  test('discovers exported namespace declarations without collecting their members', () => {
    const repositoryRoot = tree({
      'src/exports.ts': 'export namespace Shared { export const Internal = 1; }',
    });
    const referenceRoot = tree({
      'src/exports.ts': 'export namespace Shared { export const OtherInternal = 2; }',
    });

    expect(auditProvenance({ repositoryRoot, referenceRoot })).toEqual({
      overlappingSymbols: ['Shared'],
      justified: [],
      unjustified: ['Shared'],
      unmeasured: [],
    });
  });

  test('discovers exported import aliases without collecting implementation namespace names', () => {
    const repositoryRoot = tree({
      'src/exports.ts': 'namespace Impl {} export import Shared = Impl;',
    });
    const referenceRoot = tree({
      'src/exports.ts': 'export namespace Shared {}',
    });

    expect(auditProvenance({ repositoryRoot, referenceRoot })).toEqual({
      overlappingSymbols: ['Shared'],
      justified: [],
      unjustified: ['Shared'],
      unmeasured: [],
    });
  });

  test('uses default rather than local declaration names for default exports', () => {
    const repositoryRoot = tree({
      'src/exports.ts': [
        'export default function Local() {}',
        'export default class NamedClass {}',
        'export default function () {}',
        'export default class {}',
        'export default (() => 1);',
      ].join('\n'),
    });
    const referenceRoot = tree({
      'src/exports.ts': 'export const Local = 1; export const NamedClass = 2; export default 1;',
    });

    expect(auditProvenance({ repositoryRoot, referenceRoot })).toEqual({
      overlappingSymbols: ['default'],
      justified: [],
      unjustified: ['default'],
      unmeasured: [],
    });
  });

  test('requires a repository src directory and never scans repository root fallbacks', () => {
    const repositoryRoot = tree({
      'scripts/leak.ts': 'export const Leaked = 1;',
      'test/leak.test.ts': 'export const AlsoLeaked = 1;',
      'node_modules/package/leak.ts': 'export const DependencyLeak = 1;',
    });
    const referenceRoot = tree({
      'src/exports.ts': 'export const Leaked = 1; export const AlsoLeaked = 1; export const DependencyLeak = 1;',
    });

    expect(() => auditProvenance({ repositoryRoot, referenceRoot })).toThrow(
      `Repository source directory does not exist: ${join(repositoryRoot, 'src')}`,
    );
  });

  test('puts an unlisted overlap in unjustified and a spec term in justified', () => {
    const repositoryRoot = tree({
      'src/a.ts': 'export const microcompact = 1; export const code_verifier = 2;',
    });
    const referenceRoot = tree({
      'src/a.ts': 'export const microcompact = 1; export const code_verifier = 2;',
    });

    const result = auditProvenance({ repositoryRoot, referenceRoot });

    expect(result.unjustified).toContain('microcompact');
    expect(result.justified).toContainEqual({ symbol: 'code_verifier', reason: 'spec' });
    expect(result.overlappingSymbols).toEqual(['code_verifier', 'microcompact']);
  });

  test('records a missing reference tree on unmeasured and does not collapse unjustified to a measured empty', () => {
    const repositoryRoot = tree({
      'src/a.ts': 'export const microcompact = 1;',
    });
    const missing = join(repositoryRoot, 'no-such-reference-tree');

    const result = auditProvenance({ repositoryRoot, referenceRoot: missing });

    expect(result.unmeasured.length).toBeGreaterThan(0);
    expect(result.unjustified).toEqual([]);
    expect(result.overlappingSymbols).toEqual([]);
  });
});

describe('provenance-audit CLI', () => {
  test('exits 2 when --ref points at a path that does not exist', () => {
    const missing = join(tmpdir(), `provenance-audit-missing-${process.pid}`);
    const child = spawnSync(
      'bun',
      ['scripts/provenance-audit.ts', '--ref', missing, '--json'],
      { cwd: join(import.meta.dir, '..'), encoding: 'utf8' },
    );

    expect(child.status).toBe(2);
    const parsed = JSON.parse(child.stdout) as ProvenanceAuditResult;
    expect(parsed.unmeasured.length).toBeGreaterThan(0);
    expect(parsed.unjustified).toEqual([]);
  });
});
