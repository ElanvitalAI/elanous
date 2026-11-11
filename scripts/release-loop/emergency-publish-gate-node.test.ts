import { expect, mock, test } from 'bun:test';
import { readGitTreeEntry, runEmergencyPublishGateNode } from './emergency-publish-gate-node.js';
import { LIGHT_RC_ALWAYS_FILE, parseAlwaysIncludeList, type LightRcResult } from '../../src/release-loop/light-rc.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const hotfixCommit = 'b'.repeat(40);
const releaseCommit = 'c'.repeat(40);
const previousTagCommit = 'a'.repeat(40);
const mandatoryTests = parseAlwaysIncludeList(readFileSync(join(process.cwd(), LIGHT_RC_ALWAYS_FILE), 'utf8'));

function validGateResult(overrides: Partial<LightRcResult> = {}): LightRcResult {
  return { version: '0.3.6', base: previousTagCommit, measuredCommit: releaseCommit, worktreeHead: null,
    importerTests: 0, changedFiles: ['src/security/hotfix.ts', 'src/security/hotfix.test.ts'], testFiles: [...mandatoryTests, 'src/security/hotfix.test.ts'],
    introduced: 0, preexisting: 0, unclassified: 0, alwaysInclude: mandatoryTests.length,
    alwaysIncludeMissing: [], shards: 4, remote: 'aws1', gateExitCode: 0, ok: true, unmeasured: null, ...overrides };
}

function gateContext() {
  return { graphId: 'release-loop', nodeId: 'emergency-gate', runId: 'run-1',
    input: { version: '0.3.6', previousVersion: '0.3.5', emergencyPublish: { hotfixCommits: [hotfixCommit], remote: 'aws1' } },
    outputs: { 'version-release': { commit: releaseCommit },
      'emergency-switch': { action: 'switch', promoted: true, normalRunId: 'run-1', hotfixCommit } } };
}

async function invokeGate(result: LightRcResult) {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => result);
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) },
      runGate as never, { resolveCommit: () => previousTagCommit, isAncestor: () => true,
        pathsChangedByCommit: (commit) => { expect(commit).toBe(hotfixCommit); return ['src/security/hotfix.ts']; },
        treeEntryAt: () => ({ mode: '100644', type: 'blob', object: 'blob-hotfix' }) });
    return { exitCode, result: JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>, runGate };
  } finally { console.log = previousLog; }
}

test('emergency changed-file gate refuses when hotfix is the previous stable tag itself', async () => {
  const commit = 'a'.repeat(40);
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => { throw new Error('reduced gate must not run for an empty release range'); });
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify({
      graphId: 'release-loop', nodeId: 'emergency-gate', runId: 'run-1',
      input: { version: '0.3.6', previousVersion: '0.3.5', emergencyPublish: { hotfixCommits: [commit], remote: 'mshq' } },
      outputs: {
        'version-release': { commit: 'c'.repeat(40) },
        'emergency-switch': { action: 'switch', promoted: true, normalRunId: 'run-1', hotfixCommit: commit },
      },
    }) }, runGate as never, { resolveCommit: () => commit, isAncestor: () => true,
      pathsChangedByCommit: () => [], treeEntryAt: () => null });
    expect(exitCode).toBe(2);
    expect(runGate).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error',
      summary: 'hotfix commit must be in the release range after the previous stable tag' });
  } finally { console.log = previousLog; }
});

test('emergency changed-file gate normalizes SHA case before rejecting the previous stable tag itself', async () => {
  const commit = 'a'.repeat(40);
  const uppercaseCommit = commit.toUpperCase();
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => { throw new Error('reduced gate must not run for an empty release range'); });
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify({
      graphId: 'release-loop', nodeId: 'emergency-gate', runId: 'run-1',
      input: { version: '0.3.6', previousVersion: '0.3.5', emergencyPublish: { hotfixCommits: [uppercaseCommit], remote: 'mshq' } },
      outputs: {
        'version-release': { commit: 'c'.repeat(40) },
        'emergency-switch': { action: 'switch', promoted: true, normalRunId: 'run-1', hotfixCommit: uppercaseCommit },
      },
    }) }, runGate as never, { resolveCommit: () => commit, isAncestor: () => true,
      pathsChangedByCommit: () => [], treeEntryAt: () => null });
    expect(exitCode).toBe(2);
    expect(runGate).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error',
      summary: 'hotfix commit must be in the release range after the previous stable tag' });
  } finally { console.log = previousLog; }
});

test('reduced gate rejects an ancestral hotfix whose final release cut reverted its actual change', async () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => validGateResult());
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) }, runGate as never,
      { resolveCommit: () => previousTagCommit, isAncestor: () => true, pathsChangedByCommit: () => ['src/security/hotfix.ts'],
        treeEntryAt: (commit) => ({ mode: '100644', type: 'blob', object: commit === hotfixCommit ? 'hotfix-blob' : 'reverted-release-blob' }) });
    expect(exitCode).toBe(2);
    expect(runGate).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error',
      summary: 'hotfix commit changes are absent from the final release cut (reverted or superseded)' });
  } finally { console.log = previousLog; }
});

test('reduced gate rejects an empty hotfix commit even when prior release changes touched a hotfix path', async () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => validGateResult());
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) }, runGate as never,
      { resolveCommit: () => previousTagCommit, isAncestor: () => true, pathsChangedByCommit: () => [],
        treeEntryAt: () => ({ mode: '100644', type: 'blob', object: 'old-tree-blob' }) });
    expect(exitCode).toBe(2);
    expect(runGate).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error', summary: 'hotfix commit contains no changed paths' });
  } finally { console.log = previousLog; }
});

test('reduced gate rejects a final-cut mode change even when the hotfix blob is identical', async () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => validGateResult());
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) }, runGate as never,
      { resolveCommit: () => previousTagCommit, isAncestor: () => true,
        pathsChangedByCommit: () => ['src/security/hotfix.ts'],
        treeEntryAt: (commit) => ({ mode: commit === hotfixCommit ? '100755' : '100644', type: 'blob', object: 'same-hotfix-blob' }) });
    expect(exitCode).toBe(2);
    expect(runGate).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error',
      summary: 'hotfix commit changes are absent from the final release cut (reverted or superseded)' });
  } finally { console.log = previousLog; }
});

test('tree lookup uses a literal path and never substitutes a glob-matched sibling', () => {
  const argsSeen: string[][] = [];
  const entry = readGitTreeEntry(hotfixCommit, 'src/security/a[1].ts', (args) => {
    argsSeen.push(args);
    return { status: 0, stdout: '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tsrc/security/a1.ts\0'
      + '100755 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tsrc/security/a[1].ts\0', stderr: '' };
  });
  expect(argsSeen).toEqual([['--literal-pathspecs', 'ls-tree', '-z', hotfixCommit, '--', 'src/security/a[1].ts']]);
  expect(entry).toEqual({ mode: '100755', type: 'blob', object: 'b'.repeat(40) });
});

test('reduced gate accepts a hotfix deletion preserved in the final release cut', async () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => validGateResult());
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) }, runGate as never,
      { resolveCommit: () => previousTagCommit, isAncestor: () => true,
        pathsChangedByCommit: () => ['src/security/hotfix.ts'], treeEntryAt: () => null });
    expect(exitCode).toBe(0);
    expect(runGate).toHaveBeenCalledTimes(1);
  } finally { console.log = previousLog; }
});

test('only paths changed by the hotfix commit are required in measured changed-file evidence', async () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const runGate = mock(async () => validGateResult({ changedFiles: ['src/security/hotfix.ts'] }));
    const exitCode = await runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext()) }, runGate as never,
      { resolveCommit: () => previousTagCommit, isAncestor: () => true,
        pathsChangedByCommit: (commit) => {
          expect(commit).toBe(hotfixCommit);
          // A path changed earlier in the release range is deliberately absent here.
          return ['src/security/hotfix.ts'];
        },
        treeEntryAt: () => ({ mode: '100644', type: 'blob', object: 'same-hotfix-blob' }) });
    expect(exitCode).toBe(0);
    expect(runGate).toHaveBeenCalledTimes(1);
  } finally { console.log = previousLog; }
});

test('reduced gate passes only with measured changed files, selected tests, and every mandatory release test', async () => {
  const run = await invokeGate(validGateResult());
  expect(run.exitCode).toBe(0);
  expect(run.result).toMatchObject({ outcome: 'ok', verdict: 'pass', changedFiles: ['src/security/hotfix.ts', 'src/security/hotfix.test.ts'],
    testFiles: [...mandatoryTests, 'src/security/hotfix.test.ts'], alwaysInclude: mandatoryTests.length,
    alwaysIncludeMissing: [], introduced: 0, preexisting: 0, unclassified: 0 });
  expect(run.runGate).toHaveBeenCalledTimes(1);
});

test('reduced gate fails closed when changed-file or selected-test evidence is absent', async () => {
  const noChangedFiles = await invokeGate(validGateResult({ changedFiles: undefined }));
  expect(noChangedFiles.exitCode).toBe(1);
  expect(noChangedFiles.result.summary).toBe('emergency changed-file gate did not pass: reduced gate changed-file evidence is missing');

  const noTestFiles = await invokeGate(validGateResult({ testFiles: undefined }));
  expect(noTestFiles.exitCode).toBe(1);
  expect(noTestFiles.result.summary).toBe('emergency changed-file gate did not pass: reduced gate test-file evidence is missing');
});

test('reduced gate fails closed when a mandatory release test is missing or unmeasured', async () => {
  const firstMandatory = mandatoryTests[0]!;
  const result = await invokeGate(validGateResult({
    testFiles: mandatoryTests.filter((path) => path !== firstMandatory),
    alwaysInclude: mandatoryTests.length,
    alwaysIncludeMissing: [firstMandatory],
  }));
  expect(result.exitCode).toBe(1);
  expect(result.result.summary).toBe('emergency changed-file gate did not pass: reduced gate mandatory release tests are missing');
});
