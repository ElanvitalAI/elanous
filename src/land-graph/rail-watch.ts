/**
 * Post-rail regression watch (JUD-RELAX · CEO 11-26) — the safety net after JUD stopped judging each PR before it lands.
 *
 * S  Landing is now receipt ⊕ focused 0 fail ⊕ veto only. A regression that the focused set did not cover reaches main and,
 *    on the next rail, every host.
 * C  The CEO chose detect-after-rail and recover with a one-line revert PR. No auto-revert.
 * Q  How do we notice after each rail that the installed build regressed, and hand over the exact revert?
 * A  Each tick reads the installed commit (install.json, written by the rail). The first tick that sees a new commit runs
 *    a small smoke set of read-only CLI commands against that build. A smoke that passed on the previous rail and fails
 *    now is a regression. It raises ONE card (deduped per commit and smoke set) to the landing owner and OP. The card
 *    names the PRs that landed between the two rails as suspects, each with a ready revert command. A smoke that already
 *    failed on the previous rail is a known break, not a regression. The first tick only records the baseline.
 *
 * 세 얼굴: 관측 = <stateRoot>/land-graph/rail-watch.json (last commit · per-smoke result · cards) ⊕ the CLI JSON line ·
 * 판단 근거 = smoke id ⊕ exit/output tail ⊕ the rail range prev..now · 수복과 인계 = the card's revert commands (a person runs them).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Smoke { id: string; argv: string[] }
export interface SmokeResult { id: string; ok: boolean; detail: string }
export interface Suspect { pr: number; sha: string; title: string }

/** Read-only, fast (< 2 s each on mshq 11-26), and on the paths a broken build breaks first: boot, land graph, triggers, decisions. */
export const SMOKES: readonly Smoke[] = [
  { id: 'version', argv: ['--version'] },
  { id: 'land-graph-status', argv: ['land', 'graph', 'status', '--json'] },
  { id: 'loop-trigger-list', argv: ['loop', 'trigger', 'list'] },
  { id: 'decisions-list', argv: ['decisions', 'list'] },
];

export interface RailWatchState {
  sha: string | null;
  at: string | null;
  smoke: Record<string, boolean>;
  /** Dedupe keys of cards already raised («<sha12>:<smoke ids>»). */
  carded: string[];
}

export interface RailWatchDeps {
  now(): Date;
  stateRoot: string;
  /** Commit the rail installed (install.json `commit`); null = unreadable. */
  installedSha(): string | null;
  runSmokes(): SmokeResult[];
  /** Squash-merged PRs on main in (from, to] — the suspects of a regression between two rails. */
  landedBetween(from: string, to: string): Suspect[] | null;
  post(to: string, body: string): void;
  recipients: readonly string[];
}

export interface RailWatchResult {
  status: 'unknown-sha' | 'same-rail' | 'baseline' | 'ok' | 'known-break' | 'regressed';
  sha: string | null; prev: string | null;
  smoke?: SmokeResult[]; regressed?: string[]; suspects?: Suspect[]; carded?: boolean;
}

const statePath = (root: string) => join(root, 'land-graph', 'rail-watch.json');

export function readRailWatch(root: string): RailWatchState {
  try {
    const j = JSON.parse(readFileSync(statePath(root), 'utf8')) as Partial<RailWatchState>;
    return { sha: typeof j.sha === 'string' ? j.sha : null, at: typeof j.at === 'string' ? j.at : null,
      smoke: j.smoke && typeof j.smoke === 'object' ? j.smoke : {}, carded: Array.isArray(j.carded) ? j.carded.filter((x): x is string => typeof x === 'string') : [] };
  } catch { return { sha: null, at: null, smoke: {}, carded: [] }; }
}

function writeRailWatch(root: string, s: RailWatchState): void {
  mkdirSync(join(root, 'land-graph'), { recursive: true });
  const tmp = `${statePath(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, statePath(root)); // atomic: a crash mid-write never leaves a half state read as «no baseline»
}

/** The one-line revert a person runs (a revert PR through the normal land path — never an auto-revert). */
export function revertCommand(s: Suspect, smokes: readonly string[], railSha: string): string {
  const b = `revert-${s.pr}`;
  return `cd ~/elanous-hq/repo.git && git fetch -q origin main && git switch -c ${b} origin/main && git revert --no-edit ${s.sha} && git push -u origin ${b} `
    + `&& gh pr create --base main --head ${b} --title "revert: #${s.pr} (post-rail regression: ${smokes.join(', ')})" `
    + `--body "rail-watch: ${smokes.join(', ')} passed on the previous rail and fail on ${railSha.slice(0, 12)} · suspect #${s.pr} ${s.sha.slice(0, 12)}"`;
}

export function regressionCard(input: { sha: string; prev: string; failed: SmokeResult[]; suspects: Suspect[] | null }): string {
  const ids = input.failed.map(f => f.id);
  const lines = [`[rail-watch · post-rail regression] rail ${input.prev.slice(0, 12)} → ${input.sha.slice(0, 12)}: ${ids.join(', ')} passed before and fail now.`];
  for (const f of input.failed) lines.push(`  ✗ ${f.id}: ${f.detail.slice(0, 160)}`);
  if (input.suspects === null) lines.push('  suspects: main log unreadable — `git log --oneline ' + `${input.prev.slice(0, 12)}..${input.sha.slice(0, 12)}` + '`');
  else if (!input.suspects.length) lines.push('  suspects: no squash-merged PR in the range (host/config change?) — check the rail log');
  else {
    lines.push(`  suspects (${input.suspects.length}, newest first) · revert one with:`);
    for (const s of input.suspects) lines.push(`  #${s.pr} «${s.title.slice(0, 60)}» ${s.sha.slice(0, 12)}\n    ${revertCommand(s, ids, input.sha)}`);
  }
  lines.push('  Not auto-reverted. Revert the PR the failure names (check the smoke output), then the next rail re-checks.');
  return lines.join('\n');
}

export function tickRailWatch(d: RailWatchDeps): RailWatchResult {
  const sha = d.installedSha();
  const st = readRailWatch(d.stateRoot);
  const at = d.now().toISOString();
  if (!sha) return { status: 'unknown-sha', sha: null, prev: st.sha };
  if (st.sha === sha) { writeRailWatch(d.stateRoot, { ...st, at }); return { status: 'same-rail', sha, prev: st.sha }; }
  const smoke = d.runSmokes();
  // The rail may install again while the smokes run: results then belong to no single commit — re-run next tick.
  if (d.installedSha() !== sha) return { status: 'unknown-sha', sha, prev: st.sha };
  const now: Record<string, boolean> = Object.fromEntries(smoke.map(s => [s.id, s.ok]));
  if (!st.sha) { writeRailWatch(d.stateRoot, { sha, at, smoke: now, carded: st.carded }); return { status: 'baseline', sha, prev: null, smoke }; }
  // Regression = failed now AND observed passing on the previous rail. A smoke the previous rail never ran is unobserved:
  // its first result is its baseline, never a regression.
  const failed = smoke.filter(s => !s.ok && st.smoke[s.id] === true);
  if (!failed.length) { writeRailWatch(d.stateRoot, { sha, at, smoke: now, carded: st.carded }); return { status: smoke.every(s => s.ok) ? 'ok' : 'known-break', sha, prev: st.sha, smoke }; }
  const key = `${sha.slice(0, 12)}:${failed.map(f => f.id).sort().join(',')}`;
  const suspects = d.landedBetween(st.sha, sha);
  // One card per (commit · smoke set · recipient): a recipient that already got it is never posted again, a failed post
  // is retried next tick (the rail is not marked seen until every recipient has the card).
  const body = regressionCard({ sha, prev: st.sha, failed, suspects });
  const sent: string[] = []; let postFailed = false; let postError: unknown;
  for (const to of d.recipients) {
    const k = `${key}@${to}`;
    if (st.carded.includes(k)) continue;
    try { d.post(to, body); sent.push(k); } catch (e) { postFailed = true; postError = e; }
  }
  const carded = [...st.carded, ...sent].slice(-100);
  if (postFailed) { // a boolean, not the thrown value: `throw null` / `throw 0` is still a failed post
    writeRailWatch(d.stateRoot, { ...st, at, carded });
    throw postError instanceof Error ? postError : new Error(`card post failed: ${String(postError)}`);
  }
  // The failing smokes stay recorded as failing: the next rail cards only what regresses again from a pass.
  writeRailWatch(d.stateRoot, { sha, at, smoke: now, carded });
  return { status: 'regressed', sha, prev: st.sha, smoke, regressed: failed.map(f => f.id), ...(suspects ? { suspects } : {}), carded: sent.length > 0 };
}

/** `git log --format=%H%x09%s from..to` (first-parent squash subjects «… (#N)») → suspects, newest first. */
export function parseSuspects(log: string): Suspect[] {
  const out: Suspect[] = [];
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t'); if (tab < 0) continue;
    const sha = line.slice(0, tab); const title = line.slice(tab + 1);
    const m = /\(#(\d+)\)\s*$/.exec(title);
    if (m && /^[0-9a-f]{40}$/.test(sha)) out.push({ pr: Number(m[1]), sha, title: title.replace(/\s*\(#\d+\)\s*$/, '') });
  }
  return out;
}

export const installJsonCommit = (installRoot: string): string | null => {
  try {
    const p = join(installRoot, 'install.json'); if (!existsSync(p)) return null;
    const c = (JSON.parse(readFileSync(p, 'utf8')) as { commit?: unknown }).commit;
    return typeof c === 'string' && /^[0-9a-f]{7,40}$/i.test(c) ? c : null;
  } catch { return null; }
};
