/**
 * STALE-BASE-REVERT guard (P0 11-25 23:0x · #40164 silently reverted #40158/#40159/#40160, #40150 reverted #40133).
 *
 * Signature of a stale-base revert: the landing result wipes out EVERY line another recent commit (≤ windowHours, not on
 * this branch) still owns in a file — the branch carried a stale copy of that file (#40164 merged main, then committed
 * pre-#40158 copies). A real refactor edits around others' recent lines; a stale copy erases them all. We compute the
 * squash result with `git merge-tree --write-tree main head`, blame each changed file on main, and flag (file, commit)
 * pairs whose surviving lines are all deleted (≥ minLines). Any hit = refusal card «rebase/merge main first».
 *
 * CLI: bun src/land-guard/stale-base-revert.ts <mainRef> <headRef> [--repo <dir>] [--window-hours 48] [--min-lines 3] [--json]
 * exit 0 = clean · 1 = refused (card on stdout) · 2 = usage / git error (fail closed: callers treat ≠0 as STOP).
 */
import { spawnSync } from 'node:child_process';

export interface RevertHit { file: string; commit: string; subject: string; lines: number }
export interface StaleRevertResult { ok: boolean; mergeBase: string; hits: RevertHit[]; card?: string }

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

export function deletedRanges(unifiedZero: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of unifiedZero.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) out.push([start, count]);
  }
  return out;
}

export function detectStaleBaseRevert(repo: string, mainRef: string, headRef: string, opts: { windowHours?: number; minLines?: number; minCommitLines?: number; nowSec?: number } = {}): StaleRevertResult {
  const windowSec = (opts.windowHours ?? 48) * 3600;
  const minLines = opts.minLines ?? 3;
  const minCommitLines = opts.minCommitLines ?? 10;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const main = git(repo, ['rev-parse', mainRef]).trim();
  const head = git(repo, ['rev-parse', headRef]).trim();
  const mergeBase = git(repo, ['merge-base', main, head]).trim();
  const tree = git(repo, ['merge-tree', '--write-tree', main, head]).split('\n')[0]!.trim();
  const ownCommits = new Set(git(repo, ['log', '--format=%H', `${main}..${head}`]).split('\n').filter(Boolean));
  const counts = new Map<string, RevertHit>();
  for (const file of git(repo, ['diff', '--name-only', '--diff-filter=MD', main, tree]).split('\n').filter(Boolean)) {
    const ranges = deletedRanges(git(repo, ['diff', '-U0', main, tree, '--', file]));
    if (ranges.length === 0) continue;
    const deleted = new Set<number>();
    for (const [s0, n] of ranges) for (let i = 0; i < n; i += 1) deleted.add(s0 + i);
    // Blame the whole file on main: a commit is «wiped» when every line it still owns in main is gone from the result.
    const porcelain = git(repo, ['blame', '--line-porcelain', main, '--', file]);
    const owned = new Map<string, { total: number; gone: number; time?: number; subject?: string }>();
    let cur = '';
    for (const line of porcelain.split('\n')) {
      const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
      if (h) {
        cur = h[1]!;
        const row = owned.get(cur) ?? { total: 0, gone: 0 };
        row.total += 1;
        if (deleted.has(Number(h[2]))) row.gone += 1;
        owned.set(cur, row);
        continue;
      }
      const row = owned.get(cur);
      if (!row) continue;
      if (line.startsWith('committer-time ')) row.time = Number(line.slice(15));
      else if (line.startsWith('summary ')) row.subject = line.slice(8);
    }
    for (const [commit, row] of owned) {
      if (ownCommits.has(commit) || row.time === undefined || now - row.time > windowSec) continue;
      if (row.gone < minLines || row.gone < row.total) continue;
      counts.set(`${file}\0${commit}`, { file, commit, subject: row.subject ?? '', lines: row.gone });
    }
  }
  // A small edit of one recent line pair is a refactor; a stale copy wipes a whole PR. Require ≥ minCommitLines per commit.
  const perCommit = new Map<string, number>();
  for (const h of counts.values()) perCommit.set(h.commit, (perCommit.get(h.commit) ?? 0) + h.lines);
  const hits = [...counts.values()].filter((h) => (perCommit.get(h.commit) ?? 0) >= minCommitLines).sort((a, b) => b.lines - a.lines);
  if (hits.length === 0) return { ok: true, mergeBase, hits };
  const rows = hits.map((h) => `  - ${h.file}: ${h.lines} lines from ${h.commit.slice(0, 9)} ${h.subject}`);
  const card = [
    `REFUSE stale-base-revert: landing ${head.slice(0, 12)} would wipe out every line other recent PRs own in these files — a stale copy in the branch (merge-base ${mergeBase.slice(0, 12)}).`,
    ...rows,
    'Fix: rebase/merge main first (git fetch origin main && git merge origin/main), keep their lines, push, then land again.',
    'Meant to undo that PR on purpose (a revert)? Land with STALE_REVERT_OK=1 and say so in the PR body.',
  ].join('\n');
  return { ok: false, mergeBase, hits, card };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const repo = flag('--repo') ?? process.cwd();
  const windowHours = Number(flag('--window-hours') ?? 48);
  const minLines = Number(flag('--min-lines') ?? 3);
  const json = argv.includes('--json');
  const [mainRef, headRef] = argv.filter((a) => a !== '--json');
  if (!mainRef || !headRef) { console.error('usage: stale-base-revert.ts <mainRef> <headRef> [--repo dir] [--window-hours 48] [--min-lines 3] [--json]'); process.exit(2); }
  try {
    const r = detectStaleBaseRevert(repo, mainRef, headRef, { windowHours, minLines });
    if (json) console.log(JSON.stringify(r));
    else console.log(r.ok ? `OK stale-base-revert: none (merge-base ${r.mergeBase.slice(0, 12)})` : r.card);
    if (!r.ok && process.env.STALE_REVERT_OK === '1') { console.log('WARN STALE_REVERT_OK=1 — intended revert, not refusing'); process.exit(0); }
    process.exit(r.ok ? 0 : 1);
  } catch (error) {
    console.error(`STOP stale-base-revert check failed: ${(error as Error).message}`);
    process.exit(2);
  }
}
