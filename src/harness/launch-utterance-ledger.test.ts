import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
  assertLedgerPathPolicy, consumeHandLaunchId, handLaunchPairEnv, launchUtteranceDir, newLaunchUtteranceId,
  queryLaunchUtterances, recordLaunchUtterance, utteranceSha256, withHandLaunchPairContext,
} from './launch-utterance-ledger.js';

const dirs: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'utterance-unit-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = new Date('2026-10-20T12:00:00.000Z');

test('raw utterances, provenance and unique independent launch IDs stay in their instance', () => {
  const a = root(); const b = root();
  const first = newLaunchUtteranceId(); const second = newLaunchUtteranceId();
  expect(first).not.toBe(second);
  recordLaunchUtterance({ source: 'say', launchId: first, utterance: '  raw\nline  ' }, a, now);
  recordLaunchUtterance({ source: 'ask-file', launchId: second, utterance: 'raw\n\n' }, b, now);
  expect(queryLaunchUtterances({ root: a, now })).toEqual([{ event: 'start', source: 'say', launchId: first, utterance: '  raw\nline  ', sha256: utteranceSha256('  raw\nline  '), at: now.toISOString() }]);
  expect(queryLaunchUtterances({ root: b, now })).toHaveLength(1);
  expect(queryLaunchUtterances({ root: a, now })[0]?.utterance).not.toBe(queryLaunchUtterances({ root: b, now })[0]?.utterance);
});

test('root and parent symlinks cannot write or read another instance', () => {
  const a = root(); const b = root();
  const link = join(a, 'linked');
  symlinkSync(b, link, 'dir');
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'secret' }, join(link, 'nested'), now);
  expect(queryLaunchUtterances({ root: join(link, 'nested'), now })).toEqual([]);
  expect(queryLaunchUtterances({ root: b, now })).toEqual([]);
  symlinkSync(launchUtteranceDir(b), launchUtteranceDir(a), 'dir');
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'secret' }, a, now);
  expect(queryLaunchUtterances({ root: a, now })).toEqual([]);
  rmSync(launchUtteranceDir(a));
  mkdirSync(launchUtteranceDir(a));
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'other-instance' }, b, now);
  symlinkSync(join(launchUtteranceDir(b), '2026-10-20.jsonl'), join(launchUtteranceDir(a), '2026-10-20.jsonl'));
  expect(queryLaunchUtterances({ root: a, now })).toEqual([]);
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'do-not-cross' }, a, now);
  expect(queryLaunchUtterances({ root: b, now }).map((row) => row.utterance)).toEqual(['other-instance']);
});

test('bounded date files exclude future days and future row timestamps', () => {
  const a = root();
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'inside' }, a, now);
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'future' }, a, new Date('2026-10-22T00:00:00.000Z'));
  recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'old' }, a, new Date('2026-10-17T00:00:00.000Z'));
  const file = join(launchUtteranceDir(a), '2026-10-20.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ event: 'start', source: 'say', launchId: 'future', utterance: 'future-row', at: '2026-10-20T13:00:00.000Z' }) + '\n');
  writeFileSync(join(launchUtteranceDir(a), '2026-10-23.jsonl'), JSON.stringify({ event: 'start', source: 'say', launchId: 'future-file', utterance: 'future-file', at: '2026-10-20T12:00:00.000Z' }) + '\n');
  expect(queryLaunchUtterances({ root: a, now, sinceMs: 86_400_000 }).map((row) => row.utterance)).toEqual(['inside']);
  expect(() => queryLaunchUtterances({ root: a, sinceMs: 32 * 86_400_000 })).toThrow();
});

test('preparation and append failures are observable and fail open', () => {
  const a = root();
  writeFileSync(launchUtteranceDir(a), 'not a directory');
  expect(() => recordLaunchUtterance({ source: 'hand', launchId: newLaunchUtteranceId(), utterance: 'go' }, a, now)).not.toThrow();
  const b = root();
  mkdirSync(launchUtteranceDir(b));
  mkdirSync(join(launchUtteranceDir(b), '2026-10-20.jsonl'));
  expect(() => recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'go' }, b, now)).not.toThrow();
  expect(recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'go' }, b, now)).toBe(false);
  expect(recordLaunchUtterance({ source: 'say', launchId: 'tl-not-a-uuid', utterance: 'go' }, root(), now)).toBe(false);
});

test('system-owned OS alias symlinks (macOS /var, /tmp) are allowed; user-made parent links are refused', () => {
  const a = root();
  expect(() => assertLedgerPathPolicy(join(a, 'launch-utterances'))).not.toThrow();
  expect(recordLaunchUtterance({ source: 'say', launchId: newLaunchUtteranceId(), utterance: 'via os alias' }, a, now)).toBe(true);
  const link = join(root(), 'user-link');
  symlinkSync(a, link, 'dir');
  expect(() => assertLedgerPathPolicy(join(link, 'deeper', 'launch-utterances'))).toThrow(/symlink refused/);
});

test('ask-file bytes that are not lossless UTF-8 keep a byte-exact base64 copy', () => {
  const a = root();
  const raw = Buffer.from([0x61, 0xff, 0x0a, 0x20]);
  expect(recordLaunchUtterance({ source: 'ask-file', launchId: newLaunchUtteranceId(), utterance: raw.toString('utf8'), rawBytes: raw }, a, now)).toBe(true);
  const [row] = queryLaunchUtterances({ root: a, now });
  expect(Buffer.from(row!.utteranceBase64!, 'base64').equals(raw)).toBe(true);
  expect(row!.sha256).toBe(utteranceSha256(raw));
  const ok = Buffer.from('정확한 원문\n  ', 'utf8');
  recordLaunchUtterance({ source: 'ask-file', launchId: newLaunchUtteranceId(), utterance: ok.toString('utf8'), rawBytes: ok }, a, now);
  expect(queryLaunchUtterances({ root: a, now })[1]?.utteranceBase64).toBeUndefined();
});

test('only the explicit hand→say pair inherits the ID, exactly once, and descendants never see it', () => {
  const id = newLaunchUtteranceId();
  expect(id).toMatch(/^tl-[0-9a-f]{12}$/);
  const env: NodeJS.ProcessEnv = { ELANOUS_RUN_ID: 'run-1', ...handLaunchPairEnv(id, 'hand text', 'run-1', '  hand text\n') };
  expect(consumeHandLaunchId('hand text', env)).toEqual({ launchId: id, inherited: true, utterance: '  hand text\n' });
  expect(Object.keys(env).filter((k) => k.startsWith('ELANOUS_HAND_LAUNCH'))).toEqual([]);
  const again = consumeHandLaunchId('hand text', env);
  expect(again.inherited).toBe(false);
  expect(again.launchId).not.toBe(id);
  const otherText: NodeJS.ProcessEnv = { ELANOUS_RUN_ID: 'run-1', ...handLaunchPairEnv(id, 'hand text', 'run-1') };
  expect(consumeHandLaunchId('a separate say', otherText).launchId).not.toBe(id);
  expect(otherText.ELANOUS_HAND_LAUNCH_ID).toBeUndefined();
  const otherRun: NodeJS.ProcessEnv = { ELANOUS_RUN_ID: 'run-2', ...handLaunchPairEnv(id, 'hand text', 'run-1') };
  expect(consumeHandLaunchId('hand text', otherRun).launchId).not.toBe(id);
  const bareInherited: NodeJS.ProcessEnv = { ELANOUS_HAND_LAUNCH_ID: id, ELANOUS_TASK_CARD_ID: 'ta-1' };
  expect(consumeHandLaunchId('hand text', bareInherited).launchId).not.toBe(id);
  const mismatchedOriginal: NodeJS.ProcessEnv = { ELANOUS_RUN_ID: 'run-1', ...handLaunchPairEnv(id, 'hand text', 'run-1', 'other') };
  expect(consumeHandLaunchId('hand text', mismatchedOriginal)).toEqual({ launchId: id, inherited: true, utterance: 'hand text' });
  const independent = consumeHandLaunchId('x', {}).launchId;
  expect(independent).not.toBe(consumeHandLaunchId('x', {}).launchId);
});

test('hand launcher seam adds the pair env only for harness say with launchId and runId', () => {
  const id = newLaunchUtteranceId();
  const ctx = { runId: 'run-1', launchId: id, env: { ELANOUS_RUN_ID: 'run-1' }, launchUtterance: ' raw ' };
  const paired = withHandLaunchPairContext(['harness', 'say', '--substrate', 'pod', 'raw'], ctx);
  expect(paired.env).toEqual({ ELANOUS_RUN_ID: 'run-1', ...handLaunchPairEnv(id, 'raw', 'run-1', ' raw ') });
  expect(ctx.env).toEqual({ ELANOUS_RUN_ID: 'run-1' });
  expect(withHandLaunchPairContext(['pr', 'land', '--cwd', '/x'], ctx)).toBe(ctx);
  expect(withHandLaunchPairContext(['harness', 'say'], ctx)).toBe(ctx);
});
