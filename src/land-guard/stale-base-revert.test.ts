import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStaleBaseRevert, deletedRanges, parseDeclaredRemovals } from './stale-base-revert.js';

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

test('own rewrite is refused with a filled declaration candidate, not automatically declared', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.commit('base');
    r.write('a.ts', `base\n${twelve.join('\n')}\n`); r.commit('feat: prior (#9001)');
    r.run('checkout', '-q', '-b', 'feature');
    r.write('a.ts', 'base\nreplacement\n'); r.commit('refactor: rewrite');
    const result = detectStaleBaseRevert(r.dir, 'main', 'feature');
    expect(result.ok).toBe(false);
    expect(result.card).toContain('의도된 삭제: a.ts (PR 수정으로 기존 줄 대체; 의도 확인 후 사용)');
    expect(result.hits.map((hit) => hit.file)).toEqual(['a.ts']);
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

// REVERT-GUARD-DECLARED-SUPERSEDE (11-27 · #40471 removes route-policy.default.json that #40401 added, on purpose).
test('PR-body «의도된 삭제» lines: path / #PR with a reason · no reason = no declaration', () => {
  expect(parseDeclaredRemovals('intro\n의도된 삭제: src/router/route-policy.default.json (kit 통합으로 대체)\n- 의도된 삭제: #40401, `src/x.ts` (superseded)\nIntended removal: #7 (old)\n의도된 삭제: src/y.ts'))
    .toEqual({ paths: ['src/router/route-policy.default.json', 'src/x.ts'], prs: [40401, 7] });
});

test('a declared path or PR is excluded from the wipe check · an undeclared wipe still refuses · the card suggests the line', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.write('b.ts', 'base\n'); r.commit('base');
    r.run('checkout', '-q', '-b', 'feature'); r.run('checkout', '-q', 'main');
    r.write('a.ts', `base\n${twelve.join('\n')}\n`); r.commit('feat: policy file (#40401)');
    r.write('b.ts', `base\n${twelve.map((x) => `${x}-2`).join('\n')}\n`); r.commit('feat: other (#40402)');
    r.run('checkout', '-q', 'feature'); r.run('merge', '-q', '--no-edit', 'main');
    r.write('a.ts', 'base\n'); r.write('b.ts', 'base\n'); r.commit('refactor: kit supersedes (#40471)');
    const none = detectStaleBaseRevert(r.dir, 'main', 'feature');
    expect(none.hits.map((h) => h.file).sort()).toEqual(['a.ts', 'b.ts']);
    expect(none.card).toContain('의도된 삭제: ');
    const byPath = detectStaleBaseRevert(r.dir, 'main', 'feature', { declared: { paths: ['a.ts'], prs: [] } });
    expect([byPath.ok, byPath.hits.map((h) => h.file)]).toEqual([false, ['b.ts']]);
    for (const body of [
      '의도된 삭제: a.ts (superseded)',
      '의도된 삭제: `a.ts` (superseded)',
      '의도된 삭제: **a.ts** (superseded)',
      '- 의도된 삭제: a.ts (superseded)',
      '의도된 삭제: - `a.ts` (superseded)',
    ]) {
      const declared = parseDeclaredRemovals(body);
      expect(declared).toEqual({ paths: ['a.ts'], prs: [] });
      const result = detectStaleBaseRevert(r.dir, 'main', 'feature', { declared });
      expect(result.ok).toBe(false);
      expect(result.hits.map((h) => h.file)).toEqual(['b.ts']);
      expect(result.card).toContain('REFUSE stale-base-revert:');
      const allowed = detectStaleBaseRevert(r.dir, 'main', 'feature', {
        declared: { paths: [...declared.paths, 'b.ts'], prs: declared.prs },
      });
      expect(allowed.ok).toBe(true);
      expect(allowed.hits).toEqual([]);
    }
    const both = detectStaleBaseRevert(r.dir, 'main', 'feature', { declared: { paths: ['a.ts'], prs: [40402] } });
    expect(both.ok).toBe(true);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a file the PR\'s own commit deleted is intended (no body line) · the same lines missing without a deletion still refuse', () => {
  const r = repo();
  try {
    r.write('a.ts', 'base\n'); r.commit('base');
    r.run('checkout', '-q', '-b', 'feature'); r.run('checkout', '-q', 'main');
    r.write('t.test.ts', `${twelve.join('\n')}\n`); r.commit('test: added today (#40373)');
    r.run('checkout', '-q', 'feature'); r.run('merge', '-q', '--no-edit', 'main');
    r.run('rm', '-q', 't.test.ts'); r.commit('chore: drop the superseded test (#40444)');
    expect(detectStaleBaseRevert(r.dir, 'main', 'feature').ok).toBe(true);
    r.run('checkout', '-q', '-b', 'stale', 'feature~1');
    r.write('t.test.ts', 'other\n'); r.commit('stale copy');
    expect(detectStaleBaseRevert(r.dir, 'main', 'stale').ok).toBe(false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
