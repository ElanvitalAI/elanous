import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSmokesWith } from '../cli/land-rail-watch-cli.js';
import { parseSuspects, readRailWatch, regressionCard, revertCommand, tickRailWatch, type RailWatchDeps, type SmokeResult, type Suspect } from './rail-watch.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const sus: Suspect[] = [{ pr: 40301, sha: '1'.repeat(40), title: 'feat(x): y' }, { pr: 40300, sha: '2'.repeat(40), title: 'fix(z): w' }];

/** A tiny rail world: the installed sha and the smoke outcome per rail are scripted; posts are collected. */
function world(seed: number) {
  const root = mkdtempSync(join(tmpdir(), `rail-watch-${seed}-`));
  let sha: string | null = A; let smoke: SmokeResult[] = [];
  const posts: Array<{ to: string; body: string }> = []; let smokeRuns = 0;
  const deps = (): RailWatchDeps => ({
    now: () => new Date('2026-11-26T12:00:00Z'), stateRoot: root, installedSha: () => sha,
    runSmokes: () => { smokeRuns++; return smoke; }, landedBetween: () => sus, post: (to, body) => posts.push({ to, body }), recipients: ['TC', 'OP'],
  });
  const ok = (ids: string[]) => ids.map(id => ({ id, ok: true, detail: 'exit 0' }));
  return { root, posts, deps, ok, set: (s: string | null, r: SmokeResult[]) => { sha = s; smoke = r; }, runs: () => smokeRuns };
}

describe('rail-watch (post-rail regression · never auto-reverts)', () => {
  for (const seed of [1, 7, 42, 1126, 38038]) {
    test(`seed ${seed}: baseline → same rail no re-run → green rail → regression card once → known break not re-carded → recovery`, () => {
      const w = world(seed);
      const ids = ['version', 'land-graph-status', 'loop-trigger-list', 'decisions-list'].sort(() => ((seed * 9301 + 49297) % 233280) / 233280 - 0.5);
      w.set(A, w.ok(ids));
      expect(tickRailWatch(w.deps()).status).toBe('baseline');
      expect(tickRailWatch(w.deps()).status).toBe('same-rail');
      expect(w.runs()).toBe(1);
      w.set(B, w.ok(ids));
      expect(tickRailWatch(w.deps()).status).toBe('ok');
      const broken = ids.map(id => id === 'land-graph-status' ? { id, ok: false, detail: 'exit 1 · TypeError: x is not a function' } : { id, ok: true, detail: 'exit 0' });
      w.set(C, broken);
      const r = tickRailWatch(w.deps());
      expect([r.status, r.regressed, r.carded, r.suspects?.map(s => s.pr)]).toEqual(['regressed', ['land-graph-status'], true, [40301, 40300]]);
      expect(w.posts.map(p => p.to)).toEqual(['TC', 'OP']);
      expect(w.posts[0]!.body).toContain('git revert --no-edit ' + '1'.repeat(40));
      expect(w.posts[0]!.body).toContain('Not auto-reverted');
      // Same commit again: no second smoke run, no second card.
      expect(tickRailWatch(w.deps()).status).toBe('same-rail');
      // Next rail still broken on the same smoke: a known break, not a new regression → no card.
      w.set('d'.repeat(40), broken);
      expect(tickRailWatch(w.deps()).status).toBe('known-break');
      expect(w.posts.length).toBe(2);
      // Recovery, then a fresh break regresses again → one new card.
      w.set('e'.repeat(40), w.ok(ids)); expect(tickRailWatch(w.deps()).status).toBe('ok');
      w.set('f'.repeat(40), broken); expect(tickRailWatch(w.deps()).carded).toBe(true);
      expect(w.posts.length).toBe(4);
    });
  }
  test('unreadable install record → unknown-sha, state untouched', () => {
    const w = world(0); w.set(null, []);
    expect(tickRailWatch(w.deps()).status).toBe('unknown-sha');
    expect(readRailWatch(w.root).sha).toBeNull();
  });
  test('a failure on the very first rail is the baseline, never a card', () => {
    const w = world(0); w.set(A, [{ id: 'version', ok: false, detail: 'exit 1' }]);
    expect(tickRailWatch(w.deps()).status).toBe('baseline');
    expect(w.posts).toEqual([]);
  });
});

describe('card text and suspects', () => {
  test('parseSuspects keeps only squash subjects «… (#N)», newest first', () => {
    const log = `${'1'.repeat(40)}\tfeat(x): y (#40301)\n${'3'.repeat(40)}\tMerge branch main\n${'2'.repeat(40)}\tfix(z): w (#40300)\n`;
    expect(parseSuspects(log)).toEqual(sus);
  });
  test('revert command = branch from main · git revert the squash sha · revert PR (a person runs it)', () => {
    expect(revertCommand(sus[0]!, ['version'], C)).toBe(
      `cd ~/elanous-hq/repo.git && git fetch -q origin main && git switch -c revert-40301 origin/main && git revert --no-edit ${'1'.repeat(40)} && git push -u origin revert-40301 `
      + `&& gh pr create --base main --head revert-40301 --title "revert: #40301 (post-rail regression: version)" --body "rail-watch: version passed on the previous rail and fail on cccccccccccc · suspect #40301 111111111111"`);
  });
  test('no suspects / unreadable log say so', () => {
    expect(regressionCard({ sha: C, prev: B, failed: [{ id: 'version', ok: false, detail: 'exit 1' }], suspects: [] })).toContain('no squash-merged PR in the range');
    expect(regressionCard({ sha: C, prev: B, failed: [{ id: 'version', ok: false, detail: 'exit 1' }], suspects: null })).toContain('git log --oneline bbbbbbbbbbbb..cccccccccccc');
  });
});

describe('rail-watch edges (Terra r1)', () => {
  test('a smoke the previous rail never ran is unobserved: failing on its first rail is no regression', () => {
    const w = world(3); w.set(A, [{ id: 'version', ok: true, detail: 'exit 0' }]); tickRailWatch(w.deps());
    w.set(B, [{ id: 'version', ok: true, detail: 'exit 0' }, { id: 'new-smoke', ok: false, detail: 'exit 1' }]);
    expect(tickRailWatch(w.deps()).status).toBe('known-break');
    expect(w.posts).toEqual([]);
  });
  test('a post that fails after another succeeded: the next tick retries only the missing recipient', () => {
    const w = world(4); w.set(A, [{ id: 'version', ok: true, detail: 'exit 0' }]); tickRailWatch(w.deps());
    w.set(B, [{ id: 'version', ok: false, detail: 'exit 1' }]);
    let fail = true; const sent: string[] = [];
    const d = () => ({ ...w.deps(), post: (to: string) => { if (to === 'OP' && fail) throw new Error('msg store busy'); sent.push(to); } });
    expect(() => tickRailWatch(d())).toThrow('msg store busy');
    fail = false;
    expect(tickRailWatch(d()).status).toBe('regressed');
    expect(sent).toEqual(['TC', 'OP']);
    expect(tickRailWatch(d()).status).toBe('same-rail');
  });
  test('a falsy thrown value (throw null) is still a failed post: rail not marked seen', () => {
    const w = world(6); w.set(A, [{ id: 'version', ok: true, detail: 'exit 0' }]); tickRailWatch(w.deps());
    w.set(B, [{ id: 'version', ok: false, detail: 'exit 1' }]);
    // eslint-disable-next-line no-throw-literal
    expect(() => tickRailWatch({ ...w.deps(), post: () => { throw null; } })).toThrow('card post failed: null');
    expect(readRailWatch(w.root).sha).toBe(A);
  });
  test('every suspect gets its revert command (no truncation)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ pr: 40400 + i, sha: String(i % 10).repeat(40), title: `t${i}` }));
    const body = regressionCard({ sha: C, prev: B, failed: [{ id: 'version', ok: false, detail: 'exit 1' }], suspects: many });
    expect(many.every(s => body.includes(`git switch -c revert-${s.pr} `))).toBe(true);
  });
  test('the rail installing again mid-smoke → results discarded, re-run next tick', () => {
    const w = world(5); w.set(A, [{ id: 'version', ok: true, detail: 'exit 0' }]); tickRailWatch(w.deps());
    let calls = 0;
    const d = { ...w.deps(), installedSha: () => (calls++ === 0 ? B : C), runSmokes: () => [{ id: 'version', ok: false, detail: 'exit 1' }] };
    expect(tickRailWatch(d).status).toBe('unknown-sha');
    expect(readRailWatch(w.root).sha).toBe(A);
  });
});


describe('smoke runner', () => {
  test('a hung smoke is recorded as «exit timeout», not a signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rail-smoke-'));
    const hang = join(dir, 'hang.mjs'); writeFileSync(hang, 'setTimeout(() => {}, 120000);\n');
    // Real runtime, a script that never ends, a 1.5 s bound (cold-Pod boot room · the production bound is 60 s).
    const r = runSmokesWith(hang, process.execPath, 1500);
    expect(r.every(x => !x.ok && x.detail.startsWith('exit timeout'))).toBe(true);
  }, 30_000);
});
