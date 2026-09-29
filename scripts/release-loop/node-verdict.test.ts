import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject } from '../../src/graph-runner/runner.js';
import { emitNodeResult, readGraphContext } from './node-verdict.js';

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

test('context reads file input and previous outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-context-'));
  try {
    const file = join(dir, 'context.json');
    writeFileSync(file, JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } }));
    expect(readGraphContext({ ELANOUS_GRAPH_CONTEXT: file })).toMatchObject({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) } } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
