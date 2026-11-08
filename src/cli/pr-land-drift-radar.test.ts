import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedExportNames, changedExportsFromSources, classifyDriftTypecheckResult, importsChangedExport, runTypeDriftRadar } from './pr-land-drift-radar.js';

describe('TYPE-DRIFT-RADAR', () => {
  test('separates measured type drift from remote or compiler failures', () => {
    expect(classifyDriftTypecheckResult({ status: 0, stdout: '[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.', stderr: '' }))
      .toMatchObject({ passed: true, measured: true });
    expect(classifyDriftTypecheckResult({ status: 1, stdout: '[tsc-gate] FAIL — 타입 에러가 있다', stderr: 'TS2345' }))
      .toMatchObject({ passed: false, measured: true });
    expect(classifyDriftTypecheckResult({ status: 1, stdout: '[tsc-gate] remote-infra: push-failed', stderr: '' }))
      .toMatchObject({ passed: false, measured: false });
    expect(classifyDriftTypecheckResult({ status: 1, stdout: '[tsc-gate] FAIL — tsc 를 «못 쟀다»', stderr: '' }))
      .toMatchObject({ passed: false, measured: false });
    expect(classifyDriftTypecheckResult({ status: null, stdout: '', stderr: '', error: new Error('spawn timeout') }))
      .toMatchObject({ passed: false, measured: false, output: expect.stringContaining('spawn timeout') });
  });

  test('extracts added and removed exported declarations and re-exports from changed TypeScript files', () => {
    expect(changedExportNames([
      '+++ b/src/api.ts', '+export interface NewContract { value: string }', '+export { internal as PublicName };',
      '-export type RemovedContract = string;',
      '+++ b/docs/readme.md', '+export type DocumentationOnly = string;',
    ].join('\n'))).toEqual(['NewContract', 'PublicName', 'RemovedContract']);
  });

  test('matches imported changed exports including aliases', () => {
    expect(importsChangedExport('+import type { NewContract as Contract } from "../api";', ['NewContract'], { NewContract: ['src/api.ts'] }, 'src/nested/consumer.ts')).toBe(true);
    expect(importsChangedExport('import type {\n  NewContract as Contract,\n} from "../api.js";', ['NewContract'], { NewContract: ['src/api.ts'] }, 'src/nested/consumer.ts')).toBe(true);
    expect(importsChangedExport('import type { NewContract } from "./api";', ['NewContract'], { NewContract: ['src/api.ts'] }, 'src/nested/consumer.ts')).toBe(false);
    expect(importsChangedExport('import { exportedDeclarations } from "./pr-land-drift-repair.js";', ['exportedDeclarations'],
      { exportedDeclarations: ['src/cli/pr-land-drift-repair.ts'] }, 'src/cli/pr-land-drift-radar.test.ts', process.cwd())).toBe(true);
    expect(importsChangedExport('+const NewContract = 1;', ['NewContract'])).toBe(false);
  });

  test('detects an exported contract whose declaration name stays the same but signature changes', () => {
    expect(changedExportsFromSources([
      { path: 'src/api.ts', before: 'export interface Contract { value: string }', after: 'export interface Contract { value: number }' },
      { path: 'src/removed.ts', before: 'export type Gone = string;', after: '' },
    ])).toEqual({ names: ['Contract', 'Gone'], paths: { Contract: ['src/api.ts'], Gone: ['src/removed.ts'] } });
  });

  test('scans a candidate importing an export from a deleted source file', () => {
    const changed = changedExportsFromSources([
      { path: 'src/removed/index.ts', before: 'export type Gone = string;', after: '' },
    ]);
    const result = runTypeDriftRadar({
      changedExports: () => changed.names,
      changedExportPaths: () => changed.paths,
      repoRoot: process.cwd(),
      openPullRequests: () => [{
        number: 9,
        diff: '',
        sources: [{ path: 'src/consumer.ts', content: 'import type { Gone } from "./removed/index.js";' }],
      }],
      typecheckOnLatestMain: () => ({ passed: false, measured: false, output: 'virtual merge conflict' }),
      notifyOwner: () => { throw new Error('unmeasured candidate must not be notified'); },
      observe: () => {},
    });
    expect(result).toEqual({ scanned: 1, warned: 0, skipped: 1 });
  });

  test('uses a deleted directory package entry to resolve an affected export import', () => {
    const changed = changedExportsFromSources([
      { path: 'src/removed/entry.ts', before: 'export type Gone = string;', after: '' },
    ]);
    const result = runTypeDriftRadar({
      changedExports: () => changed.names,
      changedExportPaths: () => changed.paths,
      changedModuleFiles: () => ({ 'src/removed/package.json': '{"types":"./entry.ts"}' }),
      repoRoot: process.cwd(),
      openPullRequests: () => [{
        number: 10,
        diff: '',
        sources: [{ path: 'src/consumer.ts', content: 'import type { Gone } from "./removed";' }],
      }],
      typecheckOnLatestMain: () => ({ passed: false, measured: false, output: 'virtual merge conflict' }),
      notifyOwner: () => { throw new Error('unmeasured candidate must not be notified'); },
      observe: () => {},
    });
    expect(result).toEqual({ scanned: 1, warned: 0, skipped: 1 });
  });

  test('uses the previous package entry and hides a new competing file when resolving a changed export', () => {
    const changed = changedExportsFromSources([
      { path: 'src/removed/entry.ts', before: 'export type Gone = string;', after: 'export type Present = number;' },
      { path: 'src/removed/package.json', before: '{"types":"./entry.ts"}', after: '{"types":"./current.ts"}' },
      { path: 'src/removed.ts', before: '', after: 'export type Other = number;' },
    ]);
    const checked: number[] = [];
    const result = runTypeDriftRadar({
      changedExports: () => changed.names,
      changedExportPaths: () => changed.paths,
      preChangeFiles: () => ({
        'src/removed/entry.ts': 'export type Gone = string;',
        'src/removed/package.json': '{"types":"./entry.ts"}',
        'src/removed.ts': null,
      }),
      repoRoot: process.cwd(),
      openPullRequests: () => [{
        number: 11,
        diff: '',
        sources: [{ path: 'src/nested/consumer.ts', content: 'import type { Gone } from "../removed";' }],
      }],
      typecheckOnLatestMain: (pr) => { checked.push(pr); return { passed: false, measured: false, output: 'virtual merge conflict' }; },
      notifyOwner: () => { throw new Error('unmeasured candidate must not be notified'); },
      observe: () => {},
    });
    expect(result).toEqual({ scanned: 1, warned: 0, skipped: 1 });
    expect(checked).toEqual([11]);
  });

  test('matches a newly added module import against the current tree', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'type-drift-radar-current-tree-'));
    try {
      mkdirSync(join(repoRoot, 'src'), { recursive: true });
      writeFileSync(join(repoRoot, 'src', 'api.ts'), 'export type Fresh = string;');
      expect(importsChangedExport(
        'import type { Fresh } from "../api";',
        ['Fresh'],
        { Fresh: ['src/api.ts'] },
        'src/nested/consumer.ts',
        repoRoot,
        {},
        { 'src/api.ts': null },
      )).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('tests only affected open PRs and notifies only failures with bounded diagnostics', () => {
    const events: string[] = [];
    const notices: string[] = [];
    const checked: number[] = [];
    const changed = changedExportsFromSources([
      { path: 'src/api.ts', before: 'export interface NewContract { value: string }', after: 'export interface NewContract { value: number }' },
      { path: 'src/removed.ts', before: 'export type RemovedContract = string;', after: '' },
    ]);
    const result = runTypeDriftRadar({
      changedExports: () => changed.names,
      changedExportPaths: () => changed.paths,
      openPullRequests: () => [
        { number: 1, author: 'alice', diff: '', sources: [{ path: 'src/nested/consumer.ts', content: 'import type { NewContract } from "../api.js";' }] },
        { number: 2, author: 'bob', diff: '', sources: [{ path: 'src/nested/other.ts', content: '+import { NewContract } from "./other";' }] },
      ],
      typecheckOnLatestMain: (pr) => { checked.push(pr); return { passed: false, output: 'TS2345: '.padEnd(1500, 'x') }; },
      notifyOwner: (pr, _author, body) => { notices.push(`${pr}:${body}`); return true; },
      observe: (event) => events.push(event),
    });
    expect(result).toEqual({ scanned: 1, warned: 1, skipped: 0 });
    expect(checked).toEqual([1]);
    expect(notices[0]).toContain('TS2345');
    expect(notices[0]!.length).toBeLessThan(1400);
    expect(events).toEqual(['scanned', 'warned']);
  });

  test('caps candidate PR checks at ten and reports excess candidates as skipped', () => {
    let checked = 0;
    const result = runTypeDriftRadar({
      changedExports: () => ['Thing'],
      openPullRequests: () => Array.from({ length: 12 }, (_, i) => ({ number: i + 1, diff: '+import { Thing } from "../api";' })),
      typecheckOnLatestMain: () => { checked++; return { passed: true, output: '' }; },
      notifyOwner: () => false,
    });
    expect(checked).toBe(10);
    expect(result).toEqual({ scanned: 10, warned: 0, skipped: 2 });
  });

  test('records an unmeasured virtual merge or timeout without sending a false breakage warning', () => {
    let notified = false;
    const events: string[] = [];
    const result = runTypeDriftRadar({
      changedExports: () => ['Contract'],
      changedExportPaths: () => ({ Contract: ['src/api.ts'] }),
      openPullRequests: () => [{ number: 8, diff: '', sources: [{ path: 'src/consumer.ts', content: 'import type { Contract } from "./api";' }] }],
      typecheckOnLatestMain: () => ({ passed: false, measured: false, output: 'virtual merge conflict' }),
      notifyOwner: () => { notified = true; return true; },
      observe: (event) => events.push(event),
    });
    expect(result).toEqual({ scanned: 1, warned: 0, skipped: 1 });
    expect(notified).toBe(false);
    expect(events).toEqual(['scanned', 'skipped']);
  });
});
