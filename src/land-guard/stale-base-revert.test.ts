import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStaleBaseRevert, deletedRanges } from './stale-base-revert.js';

function repo(): { dir: string; run: (...a: string[]) => string; write: (f: string, body: string) => void; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'stale-revert-'));
  const run = (...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  run('init', '-q', '-b', 'main');
  return {
    dir, run,
    write: (f, body) => writeFileSync(join(dir, f), body),
    commit: (msg) => { run('add', '-A'); run('commit', '-q', '-m', msg); return run('rev-parse', 'HEAD'); },
  };
}

const twelve = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];

test('deletedRanges reads -U0 hunk headers (count 0 = pure insert)', () => {
  expect(deletedRanges('@@ -3,2 +3,0 @@\n@@ -9 +7 @@\n@@ -12,0 +11,4 @@\n')).toEqual([[3, 2], [9, 1]]);
});

test('stale copy of a file (branch merged main, then committed the old file) is refused with the wiped PR named', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.write('side.ts', 'one\n'); r.commit('base');
    r.run('checkout', '-q', '-b', 'feature');
    r.run('checkout', '-q', 'main');
    r.write('a.ts', `base\n${twelve.join('\n')}\n`); r.commit('feat: other work (#9001)');
    r.run('checkout', '-q', 'feature');
    r.run('merge', '-q', '--no-edit', 'main');
    r.write('a.ts', 'base\n'); r.write('side.ts', 'one\ntwo\n'); r.commit('fix: my side change (#9002)');
    expect(detectStaleBaseRevert(r.dir, 'main', 'feature').ok).toBe(false); // up to date with main still refused
    r.run('checkout', '-q', 'main'); r.write('c.ts', 'later\n'); r.commit('chore: later (#9004)');
    const out = detectStaleBaseRevert(r.dir, 'main', 'feature');
    expect(out.ok).toBe(false);
    expect(out.hits.map((h) => [h.file, h.lines, h.subject])).toEqual([['a.ts', 12, 'feat: other work (#9001)']]);
    expect(out.card).toContain('rebase/merge main first');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a real edit that keeps part of a recent PR passes · up-to-date head passes', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.commit('base');
    r.write('a.ts', `base\n${twelve.join('\n')}\n`); r.commit('feat: other work (#9001)');
    r.run('checkout', '-q', '-b', 'feature');
    r.write('a.ts', `base\n${twelve.slice(0, 6).join('\n')}\nmine\n`); r.commit('refactor: trim (#9003)');
    expect(detectStaleBaseRevert(r.dir, 'main', 'feature').ok).toBe(true); // head contains main
    r.run('checkout', '-q', 'main');
    r.write('b.ts', 'later\n'); r.commit('chore: later (#9004)');
    const out = detectStaleBaseRevert(r.dir, 'main', 'feature');
    expect(out.ok).toBe(true);
    expect(out.hits).toEqual([]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('wiped lines older than the window are not counted', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.commit('base');
    r.write('a.ts', `base\n${twelve.join('\n')}\n`); r.commit('feat: other work (#9001)');
    r.run('checkout', '-q', '-b', 'feature');
    r.write('a.ts', 'base\n'); r.commit('chore: drop (#9005)');
    r.run('checkout', '-q', 'main');
    r.write('b.ts', 'later\n'); r.commit('chore: later (#9004)');
    const future = Math.floor(Date.now() / 1000) + 49 * 3600;
    expect(detectStaleBaseRevert(r.dir, 'main', 'feature', { nowSec: future }).ok).toBe(true);
    expect(detectStaleBaseRevert(r.dir, 'main', 'feature').ok).toBe(false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
