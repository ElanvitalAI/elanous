import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { cutoffNotesEmpty, emitNodeResult, finishNode, latestGateOutput, readGraphContext, runNodeVerdict, signedT6KnownIssueGatePassed, type GraphContext } from './node-verdict.js';

const t6Cut = '7d951adb3163ba16a784d5b937d12732ef9be625';
const t6Run = '636f9e96-0aae-4cb0-babd-b509c44e2f34';
const signedT6Context = (): GraphContext => ({ graphId: 'release-loop', nodeId: 'pwa', runId: t6Run,
  input: { version: '0.3.15', previousVersion: '0.3.14' }, outputs: {
    'version-release': { outcome: 'ok', commit: t6Cut },
    gate: { outcome: 'error', commit: t6Cut, introduced: [],
      error: 'Error: remote gate refused: HQ shard result batch is incomplete (pod-68)' },
    'gate-heal-decision': { outcome: 'waived-known-issue', graphId: 'release-loop', runId: t6Run,
      nodeId: 'gate-heal-decision', decidedBy: 'OP', decidedAt: '2026-11-13T03:50:00.000Z' },
    'traffic-gate-passed': { outcome: 'ok' },
  } });

test('T6 PWA accepts only its same-run OP waiver after traffic-gate-passed', async () => {
  const context = signedT6Context();
  const run = async (value: typeof context) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      const code = await runNodeVerdict(['pwa'], { ELANOUS_GRAPH_CONTEXT: JSON.stringify(value) }, () =>
        ({ status: 0, stdout: '{"verdict":"pass"}\n', stderr: '' }));
      return { code, output: lastJsonObject(lines.join('\n')) };
    } finally { console.log = original; }
  };
  expect(signedT6KnownIssueGatePassed(context)).toBe(true);
  expect((await run(context)).code).toBe(0);
  const child = { ...structuredClone(context), runId: 'pwa-child-run', parentRunId: t6Run };
  expect(signedT6KnownIssueGatePassed(child)).toBe(true);
  expect((await run(child)).code).toBe(0);
  for (const change of [
    (value: typeof context) => { value.outputs['gate-heal-decision'].decidedBy = 'other'; },
    (value: typeof context) => { value.outputs['traffic-gate-passed'].outcome = 'fail'; },
    (value: typeof context) => { value.outputs.gate.introduced = ['new failure']; },
    (value: typeof context) => { value.runId = 'another-run'; },
  ]) {
    const invalid = structuredClone(context);
    change(invalid);
    expect(signedT6KnownIssueGatePassed(invalid)).toBe(false);
    expect((await run(invalid)).output?.summary).toBe('gate did not pass');
  }
});

test('emitted last line is read unchanged by graph runner', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try { emitNodeResult({ outcome: 'ok', verdict: 'flaky', summary: 'one line', commit: 'abc' }); }
  finally { console.log = original; }
  expect(lastJsonObject(`human output\n${lines.join('\n')}\n`)).toEqual({ outcome: 'ok', verdict: 'flaky', summary: 'one line', commit: 'abc' });
});

test('summary is a single line even when command failure includes newlines', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try { emitNodeResult({ outcome: 'fail', verdict: 'fail', summary: 'first\nsecond' }); }
  finally { console.log = original; }
  expect(lastJsonObject(lines.join('\n'))?.summary).toBe('first second');
});

test('failed node records summary and command tail in the graph ledger output and debug event', () => {
  const lines: string[] = [];
  const original = console.log;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  console.log = (line: string) => { lines.push(line); };
  let code: number;
  try {
    code = finishNode('export-check', '0.2.25', {
      outcome: 'fail', verdict: 'fail', summary: 'build failed:\nPWA dependencies missing (rc=1)',
      tail: 'Cannot find module next\nin apps/pwa', step: 'build',
    });
    expect(log).toHaveBeenCalledWith('release.node', 'failed', {
      node: 'export-check', summary: 'build failed: PWA dependencies missing (rc=1)',
      tail: 'Cannot find module next\nin apps/pwa',
    });
  } finally {
    console.log = original;
    log.mockRestore();
  }
  expect(code).toBe(1);
  expect(lastJsonObject(lines.join('\n'))).toMatchObject({
    outcome: 'fail', verdict: 'fail', summary: 'build failed: PWA dependencies missing (rc=1)',
    tail: 'Cannot find module next\nin apps/pwa', step: 'build',
  });
});

test('failed node without a command tail keeps its reason as the tail; successful output is unchanged', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    expect(finishNode('gate', '0.2.25', { outcome: 'fail', verdict: 'fail', summary: 'gate did not pass' })).toBe(1);
    expect(finishNode('gate', '0.2.25', { outcome: 'ok', verdict: 'pass', summary: 'gate passed' })).toBe(0);
  } finally { console.log = original; }
  expect(lastJsonObject(lines[0])).toEqual({ outcome: 'fail', verdict: 'fail', summary: 'gate did not pass', tail: 'gate did not pass' });
  expect(lastJsonObject(lines[1])).toEqual({ outcome: 'ok', verdict: 'pass', summary: 'gate passed' });
});

test('partial node keeps its named graph outcome while returning a successful process status', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    expect(finishNode('publish', '0.3.7', { outcome: 'partial', verdict: 'fail', summary: 'release published; assets pending',
      partialPublish: { published: true, pendingAssets: ['dist.tgz'] } })).toBe(0);
  } finally { console.log = original; }
  expect(lastJsonObject(lines.join('\n'))).toEqual({ outcome: 'partial', verdict: 'fail', summary: 'release published; assets pending',
    partialPublish: { published: true, pendingAssets: ['dist.tgz'] } });
});

test('unknown publish status keeps its named graph outcome while returning a successful process status for HITL routing', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    expect(finishNode('publish', '0.3.7', { outcome: 'unknown', verdict: 'fail', summary: 'publication status unknown',
      publicationVerification: { state: 'unknown', commands: ['npm view elanous@0.3.7 version'] } })).toBe(0);
  } finally { console.log = original; }
  expect(lastJsonObject(lines.join('\n'))).toEqual({ outcome: 'unknown', verdict: 'fail', summary: 'publication status unknown',
    publicationVerification: { state: 'unknown', commands: ['npm view elanous@0.3.7 version'] } });
});

test('context reads file input and previous outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-context-'));
  try {
    const file = join(dir, 'context.json');
    writeFileSync(file, JSON.stringify({ graphId: 'release-loop', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } }));
    expect(readGraphContext({ ELANOUS_GRAPH_CONTEXT: file })).toMatchObject({ graphId: 'release-loop', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cutoff with a notes-empty escalation is a failed cut; other escalations are not', () => {
  expect(cutoffNotesEmpty({ escalate: [{ kind: 'notes-empty', featFixLandings: 1, nextMdLines: 0 }] })).toBe(true);
  expect(cutoffNotesEmpty({ escalate: [{ kind: 'command-removed', command: 'elanous b' }] })).toBe(false);
  expect(cutoffNotesEmpty({})).toBe(false);
  expect(cutoffNotesEmpty(undefined)).toBe(false);
});

test('the real PWA node entry applies traffic policy around its scenario command and restores it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-node-verdict-pwa-traffic-'));
  try {
    const traffic = join(root, 'traffic.json');
    const before = { global: 'green', reason: 'operator-owned', updatedAt: 'before', heavyLocalBan: false,
      seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) };
    writeFileSync(traffic, JSON.stringify(before));
    const env = { ELANOUS_TRAFFIC_SIGNAL: traffic,
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-node-verdict-pwa',
        input: { version: '0.2.41', previousVersion: '0.2.40' },
        outputs: { 'version-release': { commit: 'a'.repeat(40) }, gate: { outcome: 'ok' } } }) };
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    let code: number;
    try {
      code = await runNodeVerdict(['pwa'], env, (_command, args) => {
        const active = JSON.parse(readFileSync(traffic, 'utf8'));
        expect(args[0]).toBe('scripts/release-loop/pwa-scenarios-node.ts');
        expect(active.heavyLocalBan).toBe(true);
        expect(Object.values(active.seats).every((seat: any) => seat.perCycle === 3)).toBe(true);
        return { status: 0, stdout: JSON.stringify({ verdict: 'pass', summary: 'PWA scenarios pass' }) + '\n', stderr: '' };
      });
    } finally { console.log = original; }
    expect(lastJsonObject(lines.join('\n'))).toMatchObject({ outcome: 'ok', verdict: 'pass' });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(traffic, 'utf8'))).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the release graph PWA recipe selects the traffic-wrapped node-verdict entry', () => {
  const recipes = readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8');
  expect(recipes).toMatch(/^pwa:\n  command: 'bun scripts\/release-loop\/node-verdict\.ts pwa'$/m);
});

test('the real PWA node entry fails closed before invoking scenarios when policy cannot be applied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-node-verdict-pwa-invalid-'));
  try {
    const traffic = join(root, 'traffic.json');
    writeFileSync(traffic, JSON.stringify({ global: 'green', seats: { OP: { perCycle: 8 } } }));
    const env = { ELANOUS_TRAFFIC_SIGNAL: traffic,
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-node-verdict-pwa-invalid',
        input: { version: '0.2.41', previousVersion: '0.2.40' },
        outputs: { 'version-release': { commit: 'a'.repeat(40) }, gate: { outcome: 'ok' } } }) };
    let invoked = false;
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    let code: number;
    try {
      code = await runNodeVerdict(['pwa'], env, () => {
        invoked = true;
        return { status: 0, stdout: '{"verdict":"pass"}\n', stderr: '' };
      });
    } finally { console.log = original; }
    expect(invoked).toBe(false);
    expect(code).toBe(2);
    expect(lastJsonObject(lines.join('\n'))).toMatchObject({ outcome: 'error', verdict: 'fail' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('latest gate output follows ordered re-entry history and fails closed on a missing latest output', () => {
  const stale = { outcome: 'ok' };
  const current = { outcome: 'fail', introduced: ['new failure'] };
  expect(latestGateOutput({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { gate: current, 'residual-run': stale },
    nodeHistory: [{ nodeId: 'residual-run', output: stale }, { nodeId: 'gate', output: current }] })).toBe(current);
  expect(latestGateOutput({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { gate: current } })).toBe(current);
  expect(latestGateOutput({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { gate: current },
    nodeHistory: [{ nodeId: 'gate', output: current }, { nodeId: 'residual-run' }] })).toBeUndefined();
});
