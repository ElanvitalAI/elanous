import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasPendingFeedDraft, startFieldFeed } from './field-feed-auto.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() { const d = mkdtempSync(join(tmpdir(), 'field-feed-auto-')); dirs.push(d); return d; }
function fakeSpawn(calls: { cmd: string; args: string[] }[]) {
  return ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return { pid: 4242, unref() {} }; }) as never;
}

test('after a reel, the feed run starts once for the folder with the start script', () => {
  const dir = fixture(); const script = join(dir, 'start.ts'); writeFileSync(script, '');
  const calls: { cmd: string; args: string[] }[] = [];
  const r = startFieldFeed(dir, { enabled: true }, { spawn: fakeSpawn(calls), script, runtime: 'bun' });
  expect(r).toEqual({ started: true, pid: 4242 });
  expect(calls).toEqual([{ cmd: 'bun', args: [script, dir] }]);
});

test('a draft still waiting (not delivered) blocks a second feed run — no second «게시 대기» card', () => {
  const dir = fixture(); const script = join(dir, 'start.ts'); writeFileSync(script, '');
  mkdirSync(join(dir, 'feed'));
  writeFileSync(join(dir, 'feed', 'feed-draft.json'), JSON.stringify({ revision: 2, updatedBy: 'human' }));
  expect(hasPendingFeedDraft(dir)).toBe(true);
  const calls: { cmd: string; args: string[] }[] = [];
  expect(startFieldFeed(dir, { enabled: true }, { spawn: fakeSpawn(calls), script })).toEqual({ started: false, reason: 'pending-draft' });
  expect(calls).toHaveLength(0);
  writeFileSync(join(dir, 'feed', 'feed-draft.json'), JSON.stringify({ delivered: { at: 'x', path: 'daemon', revision: 2 } }));
  expect(startFieldFeed(dir, { enabled: true }, { spawn: fakeSpawn(calls), script }).started).toBe(true);
});

test('off switches: enabled:false, ELANOUS_FIELD_FEED_AUTO=0, and bun test unless asked', () => {
  const dir = fixture(); const script = join(dir, 'start.ts'); writeFileSync(script, '');
  const calls: { cmd: string; args: string[] }[] = [];
  expect(startFieldFeed(dir, { enabled: false }, { spawn: fakeSpawn(calls), script }).reason).toBe('disabled');
  expect(startFieldFeed(dir, {}, { spawn: fakeSpawn(calls), script }).reason).toBe('disabled'); // NODE_ENV=test
  process.env.ELANOUS_FIELD_FEED_AUTO = '0';
  try { expect(startFieldFeed(dir, { enabled: true }, { spawn: fakeSpawn(calls), script }).reason).toBe('disabled'); }
  finally { delete process.env.ELANOUS_FIELD_FEED_AUTO; }
  expect(calls).toHaveLength(0);
});

test('a missing start script is reported, not thrown', () => {
  const dir = fixture();
  expect(startFieldFeed(dir, { enabled: true }, { script: join(dir, 'nope.ts') })).toEqual({ started: false, reason: 'no-script' });
});
