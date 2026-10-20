import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runAdapter(dir: string, review: Record<string, unknown>) {
  const expectedHead = 'a'.repeat(40);
  const argsPath = join(dir, 'args.txt');
  const contextPath = join(dir, 'context.json');
  const responsePath = join(dir, 'response.json');
  const fakeEln = join(dir, 'eln');
  writeFileSync(contextPath, JSON.stringify({ input: {
    ask: 'ask intent',
    context: { pr: '#123', expectedHead },
  } }));
  writeFileSync(responsePath, JSON.stringify([review]));
  writeFileSync(fakeEln, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE_ARGS"\ncat "$REVIEW_RESPONSE"\n');
  chmodSync(fakeEln, 0o755);

  const run = spawnSync('bun', ['scripts/graph-harvest-unit.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath, ELANOUS_BIN: fakeEln, CAPTURE_ARGS: argsPath, REVIEW_RESPONSE: responsePath },
  });
  return { run, argsPath };
}

function validReview(overrides: Record<string, unknown> = {}) {
  const expectedHead = 'a'.repeat(40);
  return { pr: 123, reviewed: true, verdict: 'pass', mustFix: [], headCommit: expectedHead, currentHeadCommit: expectedHead, ...overrides };
}

test('graph adapter validates successful PR/head evidence and forwards PR and intent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harvest-adapter-'));
  tempDirs.push(dir);
  const expectedHead = 'a'.repeat(40);
  const { run, argsPath } = runAdapter(dir, validReview());

  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.outcome).toBe('done');
  expect(result.result).toMatchObject({ pr: '123', headCommit: expectedHead });
  expect(result.evidence).toMatchObject({ pr: '123', headCommit: expectedHead, verdict: 'pass' });
  expect(readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
    'self', 'review', '123', '--intent', 'ask intent', '--json', '--save', 'ta-harvest',
  ]);
});

test('graph adapter rejects a wrong PR, wrong head, and incomplete review response', () => {
  const cases = [
    validReview({ pr: 456 }),
    validReview({ headCommit: 'b'.repeat(40), currentHeadCommit: 'b'.repeat(40) }),
    { pr: 123, reviewed: true, verdict: 'pass', mustFix: [], headCommit: 'a'.repeat(40) },
  ];
  for (const review of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'harvest-adapter-reject-'));
    tempDirs.push(dir);
    const { run } = runAdapter(dir, review);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).outcome).toBe('needs-human');
  }
});
