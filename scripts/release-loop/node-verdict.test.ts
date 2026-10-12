import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { cutoffNotesEmpty, emitNodeResult, finishNode, readGraphContext } from './node-verdict.js';

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
