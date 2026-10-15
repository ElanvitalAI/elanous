import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import {
  PROJECT_ANCHOR_MAX_CHARS,
  PROJECT_ANCHOR_LOCAL_MAX_CHARS,
  loadProjectAnchor,
  setGlobalAnchorPathForTest,
  resetUniversalPreambleCache,
} from '../src/prompt-library/universal-preamble.js';

let root: string;
let cwd: string;
let globalFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anchor-inner-first-'));
  cwd = join(root, 'pkg');
  mkdirSync(join(root, '.git'));
  mkdirSync(cwd);
  globalFile = join(root, 'global-AGENTS.md');
  setGlobalAnchorPathForTest(null);
  resetUniversalPreambleCache();
});

afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  resetUniversalPreambleCache();
  rmSync(root, { recursive: true, force: true });
});

test('cwd 10K gets the shared budget before root 30K; outer-to-inner fences, marker, loss log and local budget remain', () => {
  const rootBody = 'R'.repeat(30 * 1024);
  const cwdBody = 'C'.repeat(10 * 1024);
  const localBody = 'L'.repeat(10 * 1024);
  writeFileSync(join(root, 'AGENTS.md'), rootBody);
  writeFileSync(join(cwd, 'AGENTS.md'), cwdBody);
  writeFileSync(join(cwd, 'AGENTS.local.md'), localBody);
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const log = debug.log;
  (debug as { log: unknown }).log = (category: string, event: string, data: Record<string, unknown>) => {
    events.push({ category, event, data });
  };
  let result;
  try { result = loadProjectAnchor(cwd); }
  finally { (debug as { log: unknown }).log = log; }
  const rootFile = result.files.find(f => f.layer === 'root' && f.filename === 'AGENTS.md')!;
  const cwdFile = result.files.find(f => f.layer === 'dir' && f.filename === 'AGENTS.md')!;
  const localFile = result.files.find(f => f.layer === 'local')!;
  expect(cwdFile).toMatchObject({ chars: cwdBody.length, truncated: false });
  expect(rootFile).toMatchObject({ truncated: true });
  expect(result.content).toContain('…[truncated to fit anchor budget]');
  expect(result.content).toContain(cwdBody);
  expect(result.content).toContain(localBody);
  expect(localFile).toMatchObject({ chars: localBody.length, truncated: false });
  expect(result.totalChars).toBe(PROJECT_ANCHOR_MAX_CHARS + PROJECT_ANCHOR_LOCAL_MAX_CHARS);
  expect(result.files.map(f => f.layer)).toEqual(['root', 'dir', 'local']);
  expect(result.content!.indexOf('=== Project canonical collaboration guide')).toBeLessThan(result.content!.indexOf(cwdBody));
  expect(result.content!.indexOf(cwdBody)).toBeLessThan(result.content!.indexOf(localBody));
  expect(events.some(e => e.category === 'chat.project-anchor' && e.event === 'budget-loss' &&
    (e.data.truncatedFiles as string[]).includes('AGENTS.md'))).toBe(true);
});

test('cwd takes precedence over parent, root and global despite outer-first display order', () => {
  const parent = join(root, 'pkg');
  const deep = join(parent, 'child');
  mkdirSync(deep);
  setGlobalAnchorPathForTest(globalFile);
  writeFileSync(globalFile, 'G'.repeat(5 * 1024));
  writeFileSync(join(root, 'AGENTS.md'), 'R'.repeat(30 * 1024));
  writeFileSync(join(parent, 'AGENTS.md'), 'P'.repeat(10 * 1024));
  writeFileSync(join(deep, 'AGENTS.md'), 'C'.repeat(10 * 1024));
  const result = loadProjectAnchor(deep);
  expect(result.files.find(f => f.layer === 'dir' && f.relDir === '')).toMatchObject({ chars: 10 * 1024, truncated: false });
  expect(result.files.find(f => f.layer === 'dir' && f.relDir === '..')).toMatchObject({ chars: 10 * 1024, truncated: false });
  expect(result.files.find(f => f.layer === 'root' && f.filename === 'AGENTS.md')?.truncated).toBe(true);
  expect(result.skipped).toContainEqual({ filename: 'global-AGENTS.md', relDir: expect.any(String), reason: 'budget-exhausted' });
  expect(result.files.map(f => f.layer)).toEqual(['root', 'dir', 'dir']);
  expect(result.content).not.toContain('G'.repeat(50));
  expect(result.content!.indexOf('R'.repeat(50))).toBeLessThan(result.content!.indexOf('P'.repeat(50)));
  expect(result.content!.indexOf('P'.repeat(50))).toBeLessThan(result.content!.indexOf('C'.repeat(50)));
});
