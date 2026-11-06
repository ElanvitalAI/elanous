import { describe, expect, test } from 'bun:test';
import { classifyTypecheckDrift, executeDriftPlan, parseTscErrors, resolveDriftAutorepairMode, type TypecheckDriftDependencies } from './pr-land-drift-repair.js';
import type { GateReceipt } from '../self-implement/gate-receipt-registry.js';

const head = '1'.repeat(40);
const oldBase = '2'.repeat(40);
const failBase = '3'.repeat(40);
const receipt: GateReceipt = {
  schema: 1, key: 'a'.repeat(64), verdict: 'passed', headCommit: head, baseCommit: oldBase,
  bunVersion: '1.2.0', lockfileHash: 'absent', radiusFiles: ['src/feature.ts'],
  checks: ['changed-file-typecheck'], envFingerprint: 'test', savedAt: '2026-11-05T00:00:00Z',
};
const gitResponse = (stdout: string) => ({ status: 0, stdout, stderr: '' });
const deps: TypecheckDriftDependencies = {
  loadGateReceipts: () => ({ [receipt.key]: receipt }),
  git: (args) => {
    if (args[0] === 'merge-base') return gitResponse('');
    if (args[0] === 'rev-list') return gitResponse('1\n');
    if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
    if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`) ? 'export interface ChangedType {}\n' : 'export interface ChangedType { required: string }\n');
    if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
    return gitResponse('+++ b/src/changed.ts\n+export interface ChangedType {}\n');
  },
};

describe('parseTscErrors', () => {
  test('parses standard tsc diagnostics and keeps source lines', () => {
    expect(parseTscErrors("src/a.ts(12,4): error TS2304: Cannot find name 'Missing'.\nnoise")).toEqual([{
      file: 'src/a.ts', line: 12, column: 4, code: 'TS2304', message: "Cannot find name 'Missing'.",
      symbols: ['Missing'], raw: "src/a.ts(12,4): error TS2304: Cannot find name 'Missing'.",
    }]);
  });

  test('accepts colon-position diagnostics', () => {
    expect(parseTscErrors('src/a.ts:7:9 - error TS2339: Property foo does not exist.')[0]).toMatchObject({
      file: 'src/a.ts', line: 7, column: 9, code: 'TS2339',
    });
  });

  test('includes the referenced type for removed-property diagnostics', () => {
    expect(parseTscErrors("src/use.ts(7,9): error TS2339: Property 'removed' does not exist on type 'ChangedType'.")[0]?.symbols)
      .toEqual(['removed', 'ChangedType']);
  });
});

describe('classifyTypecheckDrift', () => {
  const input = { repo: '.', headCommit: head, failBase, receiptPath: 'receipts.json', tscOutput: "src/use.ts(1,1): error TS2304: Cannot find name 'ChangedType'." };

  test('classifies contact with a changed export as drift', () => {
    expect(classifyTypecheckDrift(input, deps)).toMatchObject({ verdict: 'drift', receiptBase: oldBase, changedFiles: ['src/changed.ts'], symbols: ['ChangedType'] });
  });

  test('connects a required field added inside an existing exported interface', () => {
    const addedField: TypecheckDriftDependencies = {
      ...deps,
      git: (args) => {
        if (args[0] === 'merge-base') return gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`)
          ? 'export interface ChangedType { existing: string }\n'
          : 'export interface ChangedType { existing: string; required: number }\n');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse('');
      },
    };
    const tscOutput = "src/use.ts(1,1): error TS2741: Property 'required' is missing in type '{}' but required in type 'ChangedType'.";
    expect(parseTscErrors(tscOutput)[0].symbols).toEqual(['required', 'ChangedType']);
    expect(classifyTypecheckDrift({ ...input, tscOutput }, addedField).verdict).toBe('drift');
  });

  test('classifies removed fields on multiline exported type aliases as drift', () => {
    const multilineAlias: TypecheckDriftDependencies = {
      ...deps,
      git: (args) => {
        if (args[0] === 'merge-base') return gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`)
          ? 'export type Primitive = string\nexport type ChangedType =\n  {\n    retained: string;\n    removed: string;\n  }\n'
          : 'export type Primitive = string\nexport type ChangedType =\n  {\n    retained: string;\n  }\n');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse('+++ b/src/changed.ts\n-export type ChangedType = { retained: string; removed: string }\n+export type ChangedType = { retained: string }\n');
      },
    };
    const removedField = { ...input, tscOutput: "src/use.ts(7,9): error TS2339: Property 'removed' does not exist on type 'ChangedType'." };
    expect(classifyTypecheckDrift(removedField, multilineAlias).verdict).toBe('drift');
    const unionAlias: TypecheckDriftDependencies = { ...multilineAlias, git: (args) => {
      if (args[0] === 'merge-base') return gitResponse('');
      if (args[0] === 'rev-list') return gitResponse('1\n');
      if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
      if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`)
        ? 'export type ChangedType = string\n  | { retained: string; removed: string }\n'
        : 'export type ChangedType = string\n  | { retained: string }\n');
      if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
      return gitResponse('+++ b/src/changed.ts\n-export type ChangedType = string | { retained: string; removed: string }\n+export type ChangedType = string | { retained: string }\n');
    } };
    expect(classifyTypecheckDrift(removedField, unionAlias).verdict).toBe('drift');
  });

  test('rejects a branched receipt base and selects a later ancestor receipt', () => {
    const branchedBase = '4'.repeat(40);
    const branchedReceipt: GateReceipt = { ...receipt, key: 'c'.repeat(64), baseCommit: branchedBase };
    const candidates: TypecheckDriftDependencies = {
      ...deps,
      loadGateReceipts: () => ({ [branchedReceipt.key]: branchedReceipt, [receipt.key]: receipt }),
      git: (args) => {
        if (args[0] === 'merge-base') return args[2] === branchedBase
          ? { status: 1, stdout: '', stderr: 'not an ancestor' }
          : gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`)
          ? 'export interface ChangedType {}\n'
          : 'export interface ChangedType { required: string }\n');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse('');
      },
    };
    expect(classifyTypecheckDrift(input, candidates)).toMatchObject({ verdict: 'drift', receiptBase: oldBase });
  });

  test('classifies unrelated diagnostics separately', () => {
    const unrelated = { ...input, tscOutput: 'src/use.ts(1,1): error TS2304: Cannot find name Other.' };
    expect(classifyTypecheckDrift(unrelated, deps).verdict).toBe('drift-unrelated');
  });

  test('classifies a reference to a deleted export as drift', () => {
    const deletedExportDeps: TypecheckDriftDependencies = {
      ...deps,
      git: (args) => {
        if (args[0] === 'merge-base') return gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse(args[3] === failBase ? '' : '100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`) ? 'export interface ChangedType {}\n' : '');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse('--- a/src/changed.ts\n-export interface ChangedType {}\n');
      },
    };
    expect(classifyTypecheckDrift(input, deletedExportDeps).verdict).toBe('drift');
  });

  test('classifies an added file exporting the referenced type as drift', () => {
    const addedFile: TypecheckDriftDependencies = {
      ...deps,
      git: (args) => {
        if (args[0] === 'merge-base') return gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse(args[3] === oldBase ? '' : '100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse('export interface ChangedType { required: string }\n');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse('');
      },
    };
    expect(classifyTypecheckDrift(input, addedFile).verdict).toBe('drift');
  });

  test('does not treat string values or diagnostic prose as exported symbols', () => {
    const labelDeps: TypecheckDriftDependencies = {
      ...deps,
      git: (args) => {
        if (args[0] === 'merge-base') return gitResponse('');
        if (args[0] === 'rev-list') return gitResponse('1\n');
        if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
        if (args[0] === 'show') return gitResponse(args[1].startsWith(`${oldBase}:`) ? 'export interface ChangedType {}\n' : '');
        if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
        return gitResponse("--- a/src/changed.ts\n-export const label = 'old';\n+++ b/src/changed.ts\n+export const label = 'name';\n");
      },
    };
    const missing = { ...input, tscOutput: "src/use.ts(1,1): error TS2304: Cannot find name 'Missing'." };
    expect(parseTscErrors(missing.tscOutput)[0].symbols).toEqual(['Missing']);
    expect(classifyTypecheckDrift(missing, labelDeps).verdict).toBe('drift-unrelated');
  });

  test('skips a same-base first receipt and selects a later eligible older-base receipt', () => {
    const sameBaseReceipt: GateReceipt = { ...receipt, key: 'b'.repeat(64), baseCommit: failBase };
    const multipleReceipts: TypecheckDriftDependencies = {
      ...deps,
      loadGateReceipts: () => ({ [sameBaseReceipt.key]: sameBaseReceipt, [receipt.key]: receipt }),
    };
    expect(classifyTypecheckDrift(input, multipleReceipts)).toMatchObject({ verdict: 'drift', receiptBase: oldBase });
  });

  test('fails closed when no qualifying receipt is available', () => {
    expect(classifyTypecheckDrift(input, { ...deps, loadGateReceipts: () => ({}) })).toMatchObject({
      verdict: 'drift-unmeasured', reason: 'no same-head changed-file typecheck PASS receipt',
    });
  });

  test('fails closed when tsc diagnostics cannot be parsed', () => {
    expect(classifyTypecheckDrift({ ...input, tscOutput: 'typecheck failed without diagnostics' }, deps)).toMatchObject({
      verdict: 'drift-unmeasured', reason: 'tsc output contains no parseable diagnostics',
    });
  });

  test('fails closed when the base range cannot be measured', () => {
    expect(classifyTypecheckDrift(input, { ...deps, git: () => ({ status: 1, stdout: '', stderr: 'missing object' }) }).verdict).toBe('drift-unmeasured');
  });

  test('defaults to live launch and the off switch prevents launch', async () => {
    const plan = { action: 'launch' as const, goal: 'repair goal', boundaryFiles: ['src/feature.ts'] };
    expect(resolveDriftAutorepairMode(undefined)).toBe('live');
    expect(resolveDriftAutorepairMode('off')).toBe('off');
    let launches = 0;
    const launch = () => { launches++; };
    await executeDriftPlan(plan, resolveDriftAutorepairMode(undefined), launch, () => {});
    expect(launches).toBe(1);
    await executeDriftPlan(plan, resolveDriftAutorepairMode('off'), launch, () => {});
    expect(launches).toBe(1);
  });
});
