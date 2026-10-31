import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { cutoffNotesEmpty, emitNodeResult, finishNode, readGraphContext, runNodeVerdict } from './node-verdict.js';

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

test('context reads file input and previous outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-context-'));
  try {
    const file = join(dir, 'context.json');
    writeFileSync(file, JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } }));
    expect(readGraphContext({ ELANOUS_GRAPH_CONTEXT: file })).toMatchObject({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } });
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
