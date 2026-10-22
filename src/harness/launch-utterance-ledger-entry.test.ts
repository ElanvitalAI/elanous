import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function instance(): string {
  const root = mkdtempSync(join(tmpdir(), 'utterance-entry-'));
  roots.push(root);
  return root;
}

function rows(root: string): Array<{ launchId: string; utterance: string; source: string }> {
  const dir = join(root, 'launch-utterances');
  try {
    return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { launchId: string; utterance: string; source: string }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function untilRow(root: string, command: string[], source: string): Promise<void> {
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, ...command], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (rows(root).some((row) => row.source === source && row.utterance === command.at(-1))) return;
      if (child.exitCode !== null) break;
      await Bun.sleep(250);
    }
    throw new Error(`production ${source} did not record start (exit=${child.exitCode}; stderr=${output.slice(-500)})`);
  } finally { child.kill('SIGKILL'); }
}

test('two independent production CLI say launches use different IDs and stay in their own instances', async () => {
  const a = instance(); const b = instance();
  for (const [root, text] of [[a, 'unique say A'], [a, 'unique say B'], [b, 'unique say C']] as const) {
    await untilRow(root, ['harness', 'say', '--substrate', 'pod', text], 'say');
  }
  expect(rows(a).filter((row) => row.source === 'say').map((row) => row.utterance)).toEqual(['unique say A', 'unique say B']);
  expect(new Set(rows(a).map((row) => row.launchId)).size).toBe(2);
  expect(rows(b).map((row) => row.utterance)).toEqual(['unique say C']);
}, 220_000);

test('production CLI ask-file records exact source contents after successful read', async () => {
  const root = instance();
  const file = join(root, 'source.ask');
  const raw = '  ask 원문\n두 번째 줄\n\n';
  writeFileSync(file, raw);
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'ask', file], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let attempt = 0; attempt < 120 && rows(root).every((row) => row.source !== 'ask-file'); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(250);
    }
  } finally { child.kill('SIGKILL'); }
  expect(rows(root).filter((row) => row.source === 'ask-file').map((row) => row.utterance)).toEqual([raw]);
}, 120_000);

test('production pod ask-file records the raw source in the selected instance', async () => {
  const root = instance();
  const file = join(root, 'pod-source.ask');
  const raw = 'pod ask original\n';
  writeFileSync(file, raw);
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'ask', '--substrate', 'pod', file], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 120 && rows(root).length === 0; attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(250);
    }
    expect(rows(root).map((row) => ({ source: row.source, utterance: row.utterance })))
      .toEqual([{ source: 'ask-file', utterance: raw }]);
  } finally { child.kill('SIGKILL'); }
}, 120_000);

test('pod ask-file uses the recorded snapshot after the source is removed', async () => {
  const root = instance();
  const file = join(root, 'source-to-remove.ask');
  const raw = 'snapshot original\n';
  writeFileSync(file, raw);
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'ask', '--substrate', 'pod', '--pod-pool', 'invalid-pool:1', file], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try {
    for (let attempt = 0; attempt < 120 && rows(root).length === 0 && child.exitCode === null; attempt++) await Bun.sleep(250);
    expect(rows(root).map((row) => row.utterance)).toEqual([raw]);
    rmSync(file);
    for (let attempt = 0; attempt < 120 && child.exitCode === null; attempt++) await Bun.sleep(250);
    expect(child.exitCode).not.toBeNull();
    expect(stderr).toContain('골 완료 경계 누락');
    expect(stderr).not.toContain('ENOENT');
  } finally { child.kill('SIGKILL'); }
}, 120_000);

test('production say continues past a ledger preparation failure in its isolated ledger', async () => {
  const root = instance();
  const dir = join(root, 'launch-utterances');
  writeFileSync(dir, 'not a directory');
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'say', '--substrate', 'pod', 'append failure say'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try {
    for (let attempt = 0; attempt < 120 && !stderr.includes('[launch-utterance] prepare failed:'); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(250);
    }
    expect(stderr).toContain('[launch-utterance] prepare failed:');
    for (let attempt = 0; attempt < 120 && child.exitCode === null; attempt++) await Bun.sleep(250);
    expect(child.exitCode).not.toBeNull();
    // The launch flow proceeded past the ledger into the Pod substrate (its own outcome depends on the host).
    expect(stderr).toMatch(/harness\.substrate=pod|Pod 풀|Pod 실행/);
  } finally { child.kill('SIGKILL'); }
}, 120_000);

test('production ask-file missing source refuses launch and keeps isolated ledger empty', () => {
  const a = instance();
  const b = instance();
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', '--config-dir', a, 'harness', 'ask', join(a, 'missing.ask')], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: a }, encoding: 'utf8', timeout: 120_000,
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain('missing.ask');
  expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\[goal-author\] ground started|\[self-implement:|pod job/i);
  expect(rows(a)).toEqual([]);
  expect(rows(b)).toEqual([]);
  const pod = spawnSync('bun', ['bin/elanous.mjs', '--test', '--config-dir', a, 'harness', 'ask', '--substrate', 'pod', join(a, 'missing.ask')], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: a }, encoding: 'utf8', timeout: 120_000,
  });
  expect(pod.status).not.toBe(0);
  expect(`${pod.stdout}\n${pod.stderr}`).toContain('missing.ask');
  expect(rows(a)).toEqual([]);
}, 120_000);

test('production say continues past an append failure (date file is a directory)', async () => {
  const root = instance();
  mkdirSync(join(root, 'launch-utterances', `${new Date().toISOString().slice(0, 10)}.jsonl`), { recursive: true });
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'say', '--substrate', 'pod', 'append failure say'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try {
    for (let attempt = 0; attempt < 120 && child.exitCode === null; attempt++) await Bun.sleep(250);
    expect(stderr).toContain('[launch-utterance] append failed:');
    // The launch flow proceeded past the ledger into the Pod substrate (its own outcome depends on the host).
    expect(stderr).toMatch(/harness\.substrate=pod|Pod 풀|Pod 실행/);
  } finally { child.kill('SIGKILL'); }
}, 120_000);

test('a separate production say never reuses an inherited tl-* ID without the exact hand pair', async () => {
  const root = instance();
  const stale = 'tl-0123456789ab';
  const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'say', '--substrate', 'pod', 'separate say'], {
    cwd: process.cwd(),
    env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_HAND_LAUNCH_ID: stale, ELANOUS_TASK_CARD_ID: 'ta-stale' },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 120 && rows(root).length === 0 && child.exitCode === null; attempt++) await Bun.sleep(250);
    const said = rows(root).filter((row) => row.source === 'say');
    expect(said.map((row) => row.utterance)).toEqual(['separate say']);
    expect(said[0]?.launchId).toMatch(/^tl-[0-9a-f]{12}$/);
    expect(said[0]?.launchId).not.toBe(stale);
  } finally { child.kill('SIGKILL'); }
}, 120_000);

test('production say --dry-run records the exact received text, marked dryRun', () => {
  const root = instance();
  const text = '  dry 원문\n둘째 줄  ';
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, 'harness', 'say', '--dry-run', text], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, encoding: 'utf8', timeout: 120_000,
  });
  expect(result.status).toBe(0);
  const said = rows(root) as Array<{ source: string; utterance: string; dryRun?: boolean; argv?: string[] }>;
  expect(said.map((row) => ({ source: row.source, utterance: row.utterance, dryRun: row.dryRun, argv: row.argv })))
    .toEqual([{ source: 'say', utterance: text, dryRun: true, argv: [text] }]);
}, 120_000);
