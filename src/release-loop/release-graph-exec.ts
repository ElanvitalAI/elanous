/**
 * Release graph executor — the rocket-launch countdown (내부 문서 `release-loop-agent` §A7 · RELEASE-ROCKET L-0…L-9)
 * as a DAG that REPLAYS the manual quick-pass REL actually walked (0.3.30/0.3.31 QP-01…QP-09 · 0.3.35 critpath + rail).
 *
 * Principle (CEO 11-25 19:0x/19:2x):
 *   - Each step = the SAME command REL runs by hand. No new release mechanics.
 *   - Steps declare `needs:` (real data/ordering deps only); independent steps run concurrently under per-host caps.
 *   - Checks are ADVISORY: a failed predicate records a warning (+ one card in live) and the run continues.
 *     Hard stops are only: (a) a `hard` step's command exits non-zero (cut · prepare · publish preview · publish · npm),
 *     (b) a security NO-GO, (c) an explicit CEO/REL/OP NO-GO (`release graph nogo` or a NO-GO row in the poll ledger).
 *   - Manual-step parity: a step REL did by hand is auto-detected (steward shadow `actual` + direct probes) or marked
 *     (`release graph mark`) and the DAG continues from it. Before running a step in live, detection runs first — a
 *     publish REL already did is never re-run.
 *   - Modes: `shadow` records «would run <cmd> at <time>» and executes nothing; `live` executes — only when the config
 *     says `release.graph.mode = live` AND `release.graph.version = <this version>` (the per-version owner approval).
 *   - Stall guard (live): no step status change for 15 min while unfinished → wake REL + card to OP (once per stall).
 *
 * State: <stateRoot>/release-graph/<version>/{state.json, ledger.jsonl, logs/}. One tick = `tickRelease`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { evaluatePredicate, type ConditionProbes, type Predicate } from '../loops/trigger-conditions.js';

export type Mode = 'shadow' | 'live';
export type Phase = 'L-0' | 'L-1' | 'L-2' | 'L-3' | 'L-4' | 'L-5' | 'L-6' | 'L-7' | 'L-8' | 'L-9';
export type Host = 'mshq' | 'minim5' | 'remote' | 'none';
/** Capped hosts from the golden ledger (QUICKPASS-GOLDEN «host caps»); `none` = uncapped. */
export type GoldenHost = Exclude<Host, 'remote'> | 'node-b' | 'publish';
export type Anchor = 'rehearsal' | 'cut' | 'publish' | 'demo';
export type StepStatus = 'pending' | 'would-run' | 'running' | 'done' | 'failed' | 'skipped';

export interface Check {
  id: string;
  predicate: Predicate;
  /** What the manual quick-pass did when this did not hold (the waiver line in the ledger). */
  waive: string;
}

export interface StepDef {
  id: string;
  phase: Phase;
  label: string;
  needs: string[];
  /** Earliest start = anchor + offsetMin (a clock gate, not a dependency). */
  clock?: { anchor: Anchor; offsetMin: number };
  /** Phase clock: minutes after the step became runnable by which it should be done (late → advisory card). */
  maxWaitMin: number;
  host: GoldenHost;
  /** Non-zero exit stops the run (build/publish mechanics). Soft steps record a warning and continue. */
  hard: boolean;
  /** Cleanup that runs even after a stop (traffic-restore). */
  always?: boolean;
  /** In the quick path (default true). Full-path-only steps are skipped by --quick. */
  quick: boolean;
  /** Warm duration (minutes) measured in the golden ledger (0.3.35 receipts). */
  expectMin: number;
  /** The exact manual command (one shell line). `null` = a decision gate (checks only). */
  cmd: string | null;
  checks: Check[];
}

export interface ReleaseClock { rehearsalAt: string; cutAt: string; publishAt: string; demoAt?: string }

export interface StepState {
  status: StepStatus;
  readyAt?: string;
  wouldRunAt?: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  exit?: number | null;
  by?: string;
  ref?: string;
  /** REL's actual (detected or marked) time — the «REL actual» column of the shadow comparison. */
  actualAt?: string;
  actualEvidence?: string;
  warnings?: string[];
  lateCarded?: boolean;
  /** Progress watch: the step log's size and when it last grew (stall = no growth for STALL_MIN). */
  logSize?: number;
  lastOutputAt?: string;
  stallWoken?: boolean;
}

export interface RunState {
  version: string;
  quick: boolean;
  clock: ReleaseClock;
  notesFile: string;
  prepDir: string;
  createdAt: string;
  lastProgressAt: string;
  hardStop?: { at: string; by: string; reason: string; step?: string; noncritical?: boolean } | null;
  steps: Record<string, StepState>;
  done?: boolean;
  /** `rehearsal` = the dry-run subset of the same DAG (stored under <v>-rehearsal); absent = the release itself. */
  kind?: 'rehearsal';
  /**
   * `normal` = the guarded run: a failed advisory check or soft step STOPS (the old hand-run refusals). `quick-surgery`
   * (default) = the official publish path: non-critical refusals are warnings, parallel, mark/skip with a reason.
   * A `normal` run blocked by a non-critical stop switches itself to `quick-surgery` at publish − AUTO_SURGERY_MIN.
   */
  profile?: Profile;
}

export type Profile = 'normal' | 'quick-surgery';
/** CEO 11-25 23:4x: at T−60m a normal run blocked by non-critical refusals falls into the quick-surgery publish. */
export const AUTO_SURGERY_MIN = 60;

export interface LedgerRow { at: string; kind: string; step?: string; [k: string]: unknown }

/** An active step with no output for STALL_MIN → wake REL (the «Remaining seats: 26» case). */
export const STALL_MIN = 15; // CEO 11-25: no phase progress for 15 min in live → wake REL + card.
/** Per-host concurrency (QUICKPASS-GOLDEN: mshq 1 · minim5 1 · node-b 1 · the public publish 1). */
export const GOLDEN_HOST_CAP: Record<GoldenHost, number> = { mshq: 1, minim5: 1, 'node-b': 1, publish: 1, none: Number.POSITIVE_INFINITY };
/** @deprecated #40123 shape; the executor uses GOLDEN_HOST_CAP. */
export const HOST_CAP: Record<Host, { heavy: number; any: number }> = {
  mshq: { heavy: 1, any: 1 }, minim5: { heavy: 1, any: 1 }, remote: { heavy: 2, any: 2 }, none: { heavy: 99, any: 99 },
};
/** Security-4 marker: any step (or `release graph nogo --security`) that writes this file stops the run (boundary · auth · secret · destructive). */
/** Kingdom voters of the full-path L-2 poll (the quick path asks OP only at `go`). */
export const POLL_VOTERS = ['REL', 'JUD', 'RES', 'UX', 'TC'];
/** Security-4 env name handed to every step. */
export const SECURITY4_ENV = 'ELANOUS_RELEASE_GRAPH_SECURITY4';

function q(s: string): string { return /^[\w./@:+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }

export interface PlanOptions { cli?: string; seatState?: string; uid?: number; pagesHost?: string; publicRepo?: string }
/** Where the golden commands run: the repo checkout (worktree parent) and the instance root (`--config-dir`). */
export interface PlanPaths { repo?: string; instanceRoot?: string }

/**
 * The step table = QUICKPASS-GOLDEN (seat-state/REL/QUICKPASS-GOLDEN.md · 0.3.35 actual with `<v>`): same ids, same commands,
 * same true deps, same policy. STOP = cut/prepare (build) · publish · npm exit ≠ 0, a security-4 marker, an explicit NO-GO.
 * Every other non-zero exit is a warning + card and the run continues.
 */
export function releaseSteps(version: string, clock: ReleaseClock, files: { notesFile: string; prepDir: string }, opts: PlanOptions = {}): StepDef[] {
  const paths = opts as PlanOptions & PlanPaths & { worktree?: string };
  const v = version;
  const seat = opts.seatState ?? join(homedir(), 'elanous-hq', 'seat-state');
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501);
  const pub = opts.publicRepo ?? 'ElanvitalAI/elanous';
  const repo = paths.repo ?? join(homedir(), 'elanous-hq', 'repo.git');
  const W = q(paths.worktree ?? join(repo, '.claude', 'wt', `release-${v}`));
  const home = dirname(files.prepDir);
  const N = q(files.notesFile); const NP = q(files.notesFile.replace(/\.md$/, '') + '.public.md');
  const SHA = q(join(home, 'cut.sha'));
  const D = q(files.prepDir);
  const NT = q((opts as { npmTokenFile?: string }).npmTokenFile ?? join(getElanousConfigDir(), 'secrets', 'npm-token'));
  const tree = `cd ${W} && bun bin/elanous.mjs${paths.instanceRoot ? ` --config-dir ${q(paths.instanceRoot)}` : ''}`;
  const pollLedger = join(seat, 'REL', `poll-${v}.jsonl`);
  const s = (d: Omit<StepDef, 'quick' | 'checks' | 'hard' | 'host' | 'maxWaitMin'> & Partial<Pick<StepDef, 'quick' | 'checks' | 'hard' | 'host' | 'maxWaitMin'>>): StepDef =>
    ({ quick: true, checks: [], hard: false, host: 'none', maxWaitMin: 120, ...d });
  const at = (anchor: Anchor, offsetMin = 0) => ({ anchor, offsetMin });
  return [
    // repo.git is a bare clone (no bin/): the tree CLI is checked in the cut worktree, the same tree prepare runs.
    s({ id: 'cli-fresh', phase: 'L-0', label: 'repo-tree CLI answers (installed copy hits ENOENT in prepare)', needs: ['cut'], clock: at('rehearsal'), expectMin: 0.5,
      cmd: `cd ${W} && bun bin/elanous.mjs --version` }),
    s({ id: 'notes', phase: 'L-0', label: 'notes: release/<v>-draft.md (fallback release/next.md) + sha256', needs: [], clock: at('rehearsal'), expectMin: 0.5,
      cmd: `mkdir -p ${q(dirname(files.notesFile))} && cd ${q(repo)} && (git show origin/main:release/${v}-draft.md > ${N} || git show origin/main:release/next.md > ${N}) && test -s ${N} && shasum -a 256 ${N}` }),
    s({ id: 'roster', phase: 'L-1', label: 'roster count (yellow → known-issue / next version; security-4 stops)', needs: [], clock: at('rehearsal'), expectMin: 0.5,
      cmd: `ELANOUS_TRACK=OP ${opts.cli ?? 'elanous'} release checklist status --version ${v}` }),
    s({ id: 'schedule', phase: 'L-0', label: 'schedule row', needs: [], clock: at('rehearsal'), expectMin: 0.5,
      cmd: `${opts.cli ?? 'elanous'} release schedule show --version ${v}` }),
    s({ id: 'rehearsal-hard', phase: 'L-0', label: 'hard rehearsal on the real path (prebuild→push→gate Pod) — full path only', needs: [], quick: false,
      clock: at('rehearsal'), maxWaitMin: 180, host: 'node-b', expectMin: 90, cmd: `${opts.cli ?? 'elanous'} release rehearsal tick --apply --json` }),
    s({ id: 'cut', phase: 'L-1', label: `cut: worktree from origin/main · version bump in 3 files · commit`, needs: [], clock: at('cut'), host: 'mshq', hard: true, expectMin: 2,
      checks: [{ id: 'rehearsal-receipt', predicate: { kind: 'json-field', path: join(home, 'rehearsal-receipt.json'), field: 'ok', equals: true },
        waive: 'rehearsal missing / partial → advisory input only (CEO 11-25 19:5x: never a stop)' }],
      cmd: `cd ${q(repo)} && git fetch -q origin main && git worktree add --detach ${W} origin/main && cd ${W} && perl -pi -e 's/${v.replace(/\./g, '\\.')}-dev\\.0/${v}/g' package.json server.json integrations/acp-registry/elanous/agent.json && git commit -qam ${q(`release: ${v}`)} && mkdir -p ${q(home)} && git rev-parse HEAD > ${SHA} && printf '{"sha":"%s"}\\n' "$(cat ${SHA})" > ${q(join(home, 'cut.json'))} && bun install --frozen-lockfile` }),
    s({ id: 'cut-push', phase: 'L-1', label: `push release/${v} (rejected → adopt or keep local SHA)`, needs: ['cut'], expectMin: 0.5,
      cmd: `cd ${W} && git push -q origin HEAD:refs/heads/release/${v}` }),
    s({ id: 'pregate', phase: 'L-2', label: 'light pregate on the cut (advisory side branch)', needs: ['cut'], host: 'minim5', expectMin: 20,
      cmd: `${q(join(seat, 'RES', 'tools', 'pregate'))} --host minim5 --light --base $(git -C ${W} rev-parse HEAD~1) $(cat ${SHA})` }),
    s({ id: 'prebuild', phase: 'L-2', label: 'gate image prebuild (host pre-warm, advisory side branch)', needs: ['cut'], host: 'node-b', maxWaitMin: 180, expectMin: 10,
      cmd: `cd ${W} && bun scripts/release-loop/version-node.ts gate-image-prebuild --version ${v} --cut $(cat ${SHA}) --json` }),
    s({ id: 'prepare', phase: 'L-4', label: 'prepare: critpath --dry-run (export · PWA · bundle · checksum · A158)', needs: ['cut', 'notes'], host: 'mshq', hard: true, expectMin: 3,
      cmd: `${tree} release critpath --version ${v} --cut-commit $(cat ${SHA}) --notes-file ${N} --dry-run` }),
    s({ id: 'rehearsal', phase: 'L-4', label: 'rehearsal: the same dry-run (publish · npm dry-run) — partial is a warning', needs: ['prepare'], host: 'mshq', expectMin: 1,
      cmd: `${tree} release critpath --version ${v} --cut-commit $(cat ${SHA}) --notes-file ${N} --dry-run` }),
    s({ id: 'go', phase: 'L-3', label: 'OP GO bound to cut — only an explicit NO-GO stops; missing proof is a card', needs: ['prepare', 'roster'], clock: at('publish', -30), expectMin: 0, cmd: null,
      checks: [{ id: 'op-go', predicate: { kind: 'poll-go', ledger: pollLedger, poll: `${v}:L-3`, voters: ['OP'], sha: { path: join(home, 'cut.json'), field: 'sha' } },
        waive: 'approval none / human proof unverified → card; the per-version live config is the OP delegation (0.3.35 06:02)' }] }),
    s({ id: 'notes-public', phase: 'L-4', label: 'public notes (no PR refs)', needs: ['notes'], expectMin: 0.5,
      cmd: `sed -E 's/ \\(#[0-9]+\\)//g' ${N} > ${NP}` }),
    s({ id: 'publish', phase: 'L-5', label: 'publish: public repo push + GH release + 5 assets', needs: ['prepare', 'go', 'notes-public'], clock: at('publish'), host: 'publish', hard: true, expectMin: 0.5,
      cmd: `${tree} release publish --dir ${D} --notes-file ${NP} --yes` }),
    s({ id: 'npm', phase: 'L-6', label: 'npm: present (publish it from the same tgz only when missing)', needs: ['publish'], hard: true, expectMin: 1,
      // NPM-STEP-AUTH (0.3.36 E404): the shell has no npm login — auth via a temp npmrc from the token file (never printed).
      // A missing or empty token file fails fast before npm publish (Terra r1).
      cmd: `npm view elanous@${v} version | grep -qx ${v} || (TOK=$(tr -d '\\n' < ${NT} 2>/dev/null); [ -n "$TOK" ] || { echo "npm: token file missing or empty: "${NT} >&2; exit 1; }; T=$(mktemp -d) && (umask 077; printf '//registry.npmjs.org/:_authToken=%s\\n' "$TOK" > $T/npmrc) && NPM_CONFIG_USERCONFIG=$T/npmrc npm publish ${D}/dist/elanous.tgz --ignore-scripts --access public --loglevel warn; rc=$?; rm -rf "$T"; exit $rc)` }),
    s({ id: 'verify', phase: 'L-7', label: 'verify (install · self-update · uninstall · notes page) — RC≠0 is a known-issue', needs: ['publish'], expectMin: 1,
      cmd: `${tree} release verify --version ${v} --public-repo ${pub}` }),
    s({ id: 'docs', phase: 'L-7', label: 'docs pages', needs: ['publish'], expectMin: 15,
      cmd: `cd ${W} && bun website/scripts/deploy-pages.ts --remote ${opts.pagesHost ?? 'minim5'} --yes` }),
    s({ id: 'rail', phase: 'L-8', label: 'rail every host', needs: ['publish'], host: 'mshq', expectMin: 2.5,
      cmd: `RAIL_HOSTS=${q('local mbp node-b minim5')} zsh ${q(join(seat, 'OP', 'tools', 'rail-now.sh'))}` }),
    s({ id: 'els-restart', phase: 'L-8', label: 'els server restart', needs: ['rail'], expectMin: 0.5, cmd: `launchctl kickstart -k gui/${uid}/dev.elanous.els` }),
    s({ id: 'update-all', phase: 'L-8', label: 'els update-all (after the server restart — a stale server breaks the migration)', needs: ['els-restart'], expectMin: 15, cmd: 'els update-all' }),
    s({ id: 'dev-bump', phase: 'L-8', label: 'main → next -dev.0 (missed after 0.3.35)', needs: ['publish'], expectMin: 15,
      cmd: `cd ${W} && bun scripts/release-loop/version-node.ts dev-bump --version ${v} --json` }),
    s({ id: 'traffic-restore', phase: 'L-8', label: 'traffic back to the pre-cut value (also after a stop)', needs: ['publish'], always: true, expectMin: 0.5,
      cmd: `zsh ${q(join(seat, 'OP', 'tools', 'traffic-knob.sh'))} restore` }),
    s({ id: 'telemetry', phase: 'L-9', label: 'published-build check before demo — full path only', needs: ['verify', 'update-all'], quick: false,
      clock: clock.demoAt ? at('demo', -60) : undefined, expectMin: 1,
      cmd: `npm view elanous@${v} version dist.integrity --json && gh release view v${v} --repo ${pub} --json tagName,isDraft,assets` }),
  ];
}

export function stepsFor(state: Pick<RunState, 'version' | 'clock' | 'notesFile' | 'prepDir' | 'quick'>, opts?: PlanOptions): StepDef[] {
  if ((state as Partial<RunState>).kind === 'rehearsal') return rehearsalSteps(state.version, state.clock, { notesFile: state.notesFile, prepDir: state.prepDir }, opts);
  const all = releaseSteps(state.version, state.clock, { notesFile: state.notesFile, prepDir: state.prepDir }, opts);
  return state.quick ? all.filter(s => s.quick) : all;
}

/** The rehearsal = this subset of the release DAG, nothing after the dry-runs (no release push · publish · tag · rail · update-all). */
export const REHEARSAL_STEP_IDS = ['cli-fresh', 'notes', 'roster', 'schedule', 'cut', 'cut-push', 'pregate', 'prebuild', 'prepare', 'rehearsal', 'notes-public'];

/**
 * Rehearsal steps: the same commands as the release, run against a rehearsal cut — its own worktree, its own instance root
 * (`--config-dir <release home>/rehearsal/instance`, so the live critpath-prepared dir is untouched) and a throwaway
 * `rehearsal/<v>-<sha12>` ref for pregate (never release/<v>). Every step is advisory: the rehearsal walks to the end and
 * leaves a receipt the release run reads as an advisory input.
 */
export function rehearsalSteps(version: string, clock: ReleaseClock, files: { notesFile: string; prepDir: string }, opts: PlanOptions = {}): StepDef[] {
  const paths = opts as PlanOptions & PlanPaths;
  const repo = paths.repo ?? join(homedir(), 'elanous-hq', 'repo.git');
  const W = join(repo, '.claude', 'wt', `release-${version}-rehearsal`);
  const home = dirname(files.prepDir);
  const all = releaseSteps(version, clock, files, { ...opts, repo, instanceRoot: join(home, 'instance'), worktree: W } as PlanOptions);
  const SHA = q(join(home, 'cut.sha'));
  return all.filter(s => REHEARSAL_STEP_IDS.includes(s.id)).map(s => {
    const r: StepDef = { ...s, hard: false, always: false, clock: { anchor: 'rehearsal', offsetMin: 0 }, checks: [] };
    if (s.id === 'cut') r.cmd = `(git -C ${q(repo)} worktree remove --force ${q(W)} 2>/dev/null; true) && ${s.cmd}`;
    if (s.id === 'cut-push') r.cmd = `cd ${q(W)} && git push -q origin HEAD:refs/heads/rehearsal/${version}-$(cut -c1-12 ${SHA})`;
    if (s.id === 'pregate') r.needs = ['cut-push'];
    return r;
  });
}

export function rehearsalKey(version: string): string { return `${version}-rehearsal`; }
export function rehearsalReceiptPath(version: string): string { return join(releaseHome(version), 'rehearsal-receipt.json'); }

/** Create the rehearsal run for <v> (stored under <v>-rehearsal), fired at clock.rehearsalAt. Idempotent. */
export function createRehearsal(stateRoot: string, input: { version: string; clock: ReleaseClock }, now: Date): RunState {
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error(`release graph: version must be x.y.z: ${input.version}`);
  const key = rehearsalKey(input.version);
  const existing = loadRun(stateRoot, key);
  if (existing) return existing;
  const home = join(releaseHome(input.version), 'rehearsal');
  const state: RunState = {
    version: input.version, quick: true, clock: input.clock, kind: 'rehearsal',
    notesFile: join(home, `notes-${input.version}-final.md`), prepDir: join(home, 'critpath-prepared'),
    createdAt: now.toISOString(), lastProgressAt: now.toISOString(), hardStop: null, steps: {},
  };
  for (const s of stepsFor(state)) state.steps[s.id] = { status: 'pending' };
  saveRun(stateRoot, state);
  ledger(stateRoot, key, { kind: 'created', rehearsal: true, clock: input.clock }, now);
  return state;
}

/** Topological order check + critical path (longest expected chain) — refuses a cycle or an unknown `needs`. */
export function criticalPath(steps: StepDef[]): { path: string[]; minutes: number; serialMinutes: number } {
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const s of steps) for (const n of s.needs) if (!byId.has(n)) throw new Error(`step ${s.id} needs unknown step ${n}`);
  const memo = new Map<string, { m: number; path: string[] }>();
  const visiting = new Set<string>();
  const longest = (id: string): { m: number; path: string[] } => {
    const hit = memo.get(id); if (hit) return hit;
    if (visiting.has(id)) throw new Error(`release graph cycle at ${id}`);
    visiting.add(id);
    const s = byId.get(id)!;
    let best = { m: 0, path: [] as string[] };
    for (const n of s.needs) { const r = longest(n); if (r.m > best.m || (r.m === best.m && !best.path.length)) best = r; }
    visiting.delete(id);
    const out = { m: best.m + s.expectMin, path: [...best.path, id] };
    memo.set(id, out); return out;
  };
  let top = { m: 0, path: [] as string[] };
  for (const s of steps) { const r = longest(s.id); if (r.m > top.m) top = r; }
  return { path: top.path, minutes: top.m, serialMinutes: steps.reduce((a, s) => a + s.expectMin, 0) };
}

function anchorAt(clock: ReleaseClock, a: Anchor): string | undefined {
  return a === 'rehearsal' ? clock.rehearsalAt : a === 'cut' ? clock.cutAt : a === 'publish' ? clock.publishAt : clock.demoAt;
}
export function earliestStart(step: StepDef, clock: ReleaseClock): number | null {
  if (!step.clock) return null;
  const base = anchorAt(clock, step.clock.anchor);
  return base ? Date.parse(base) + step.clock.offsetMin * 60_000 : null;
}

// ───────────────────────────── deps ─────────────────────────────

export interface Detected { at: string; evidence: string }

export interface ExecDeps {
  now(): Date;
  stateRoot: string;
  mode(version: string): Mode;
  probes: ConditionProbes;
  /** Did REL (or anyone) already do this step? Steward shadow `actual` + direct read-only probes. */
  detect(version: string, step: StepDef, state: RunState): Promise<Detected | null>;
  /** Start a step's command detached; must return a pid. Live only. */
  start(step: StepDef, cmd: string, logPath: string, rcPath: string, security4Path: string): number;
  alive(pid: number): boolean;
  /** Mail: returns an id. Cards go to OP; stall/NO-GO also wake REL. */
  post(to: string, kind: string, body: string): string;
  planOptions?: PlanOptions & PlanPaths;
}

/** The per-version release home the hand quick pass uses (<instance root>/release/<v> — same root as `release critpath`). */
export function releaseHome(version: string): string { return join(effectiveInstanceRoot(), 'release', version); }

export function runDir(stateRoot: string, version: string): string { return join(stateRoot, 'release-graph', version); }

export function loadRun(stateRoot: string, version: string): RunState | null {
  const p = join(runDir(stateRoot, version), 'state.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RunState;
}

export function saveRun(stateRoot: string, state: RunState): void {
  const dir = runDir(stateRoot, state.kind === 'rehearsal' ? rehearsalKey(state.version) : state.version);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, join(dir, 'state.json'));
}

export function ledger(stateRoot: string, version: string, row: Omit<LedgerRow, 'at'> & { at?: string }, now: Date): void {
  const dir = runDir(stateRoot, version);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: now.toISOString(), ...row })}\n`);
}

export function readLedger(stateRoot: string, version: string): LedgerRow[] {
  const p = join(runDir(stateRoot, version), 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LedgerRow);
}

export function listRuns(stateRoot: string): string[] {
  const dir = join(stateRoot, 'release-graph');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(v => /^\d+\.\d+\.\d+(-rehearsal)?$/.test(v) && existsSync(join(dir, v, 'state.json'))).sort();
}

export function createRun(stateRoot: string, input: { version: string; quick: boolean; clock: ReleaseClock; notesFile?: string; prepDir?: string; profile?: Profile }, now: Date): RunState {
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error(`release graph: version must be x.y.z: ${input.version}`);
  for (const [k, val] of Object.entries(input.clock)) if (val !== undefined && Number.isNaN(Date.parse(val))) throw new Error(`release graph: ${k} must be an ISO time: ${val}`);
  const existing = loadRun(stateRoot, input.version);
  if (existing) return existing;
  const home = releaseHome(input.version);
  const state: RunState = {
    version: input.version, quick: input.quick, clock: input.clock,
    notesFile: input.notesFile ?? join(home, `notes-${input.version}-final.md`), prepDir: input.prepDir ?? join(home, 'critpath-prepared'),
    createdAt: now.toISOString(), lastProgressAt: now.toISOString(), hardStop: null, steps: {}, profile: input.profile ?? 'quick-surgery',
  };
  for (const s of stepsFor(state)) state.steps[s.id] = { status: 'pending' };
  criticalPath(stepsFor(state)); // refuse a broken DAG at creation
  saveRun(stateRoot, state);
  ledger(stateRoot, input.version, { kind: 'created', quick: input.quick, clock: input.clock, profile: state.profile }, now);
  return state;
}

// ───────────────────────────── manual parity ─────────────────────────────

/** Resolve a phase («L-5») or step id to step ids. */
export function resolveTargets(steps: StepDef[], target: string): string[] {
  const ids = /^L-\d$/.test(target) ? steps.filter(s => s.phase === target).map(s => s.id) : steps.filter(s => s.id === target).map(s => s.id);
  if (!ids.length) throw new Error(`release graph: no step or phase ${target} (steps: ${steps.map(s => s.id).join(', ')})`);
  return ids;
}

export function markDone(stateRoot: string, version: string, target: string, by: string, ref: string, now: Date, opts?: PlanOptions): RunState {
  const state = loadRun(stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version} — start it with \`release graph run ${version}\``);
  if (!by.trim() || !ref.trim()) throw new Error('release graph mark: --by and --ref are required (who did it · msg#/receipt)');
  for (const id of resolveTargets(stepsFor(state, opts), target)) {
    const st = state.steps[id]!;
    state.steps[id] = { ...st, status: 'done', by, ref, endedAt: now.toISOString(), actualAt: st.actualAt ?? now.toISOString(), actualEvidence: st.actualEvidence ?? `marked by ${by}: ${ref}` };
    ledger(stateRoot, version, { kind: 'marked', step: id, by, ref }, now);
  }
  clearStopIfSurgered(stateRoot, state, resolveTargets(stepsFor(state, opts), target), by, ref, now);
  state.lastProgressAt = now.toISOString();
  saveRun(stateRoot, state);
  return state;
}

/**
 * Quick surgery: the step that hard-stopped the run was fixed (mark) or skipped (skip) by hand with a reason → the stop
 * clears and the DAG continues from there (the stop card says exactly this). A security-4 stop or a NO-GO with no step
 * needs an explicit `run --resume`.
 */
function clearStopIfSurgered(stateRoot: string, state: RunState, ids: string[], by: string, ref: string, now: Date): void {
  const hs = state.hardStop;
  if (!hs?.step || !ids.includes(hs.step) || hs.reason.startsWith('security-4') || existsSync(security4Path(stateRoot, state.version))) return;
  state.hardStop = null; state.done = false;
  ledger(stateRoot, state.version, { kind: 'stop-cleared', step: hs.step, by, ref, was: hs.reason }, now);
}

/** Skip a step with a reason (surgery): it counts as satisfied for its dependents and never runs. */
export function skipStep(stateRoot: string, version: string, target: string, by: string, reason: string, now: Date, opts?: PlanOptions): RunState {
  const state = loadRun(stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version}`);
  if (!by.trim() || !reason.trim()) throw new Error('release graph skip: --by and --reason are required');
  const ids = resolveTargets(stepsFor(state, opts), target);
  for (const id of ids) {
    const st = state.steps[id] ?? { status: 'pending' as const };
    if (st.status === 'running') throw new Error(`release graph skip: ${id} is running — wait or mark it`);
    state.steps[id] = { ...st, status: 'skipped', by, ref: `skip: ${reason}`, endedAt: now.toISOString(), warnings: [...(st.warnings ?? []), `skipped by ${by}: ${reason}`] };
    ledger(stateRoot, version, { kind: 'skipped', step: id, by, reason }, now);
  }
  clearStopIfSurgered(stateRoot, state, ids, by, reason, now);
  state.lastProgressAt = now.toISOString();
  saveRun(stateRoot, state);
  return state;
}

/** Resume from a step/phase: only the target(s) and their descendants run again; every other step counts as done (by resume). */
export function resumeFrom(stateRoot: string, version: string, target: string, by: string, now: Date, opts?: PlanOptions): RunState {
  const state = loadRun(stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version}`);
  const steps = stepsFor(state, opts);
  const descendants = new Set<string>(resolveTargets(steps, target));
  let grew = true;
  while (grew) { grew = false; for (const s of steps) if (!descendants.has(s.id) && s.needs.some(n => descendants.has(n))) { descendants.add(s.id); grew = true; } }
  const kept: string[] = [];
  for (const s of steps) {
    const st = state.steps[s.id] ?? { status: 'pending' as const };
    if (descendants.has(s.id)) state.steps[s.id] = { status: 'pending', ...(st.actualAt ? { actualAt: st.actualAt, actualEvidence: st.actualEvidence } : {}) };
    else if (st.status !== 'done' && st.status !== 'skipped') { state.steps[s.id] = { ...st, status: 'done', by: `${by}(resume)`, ref: `resume ${target}`, endedAt: now.toISOString() }; kept.push(s.id); }
  }
  state.hardStop = null; state.done = false;
  rmSync(security4Path(stateRoot, version), { force: true });
  state.lastProgressAt = now.toISOString();
  saveRun(stateRoot, state);
  ledger(stateRoot, version, { kind: 'resumed', target, by, markedDone: kept, reopened: [...descendants] }, now);
  return state;
}

/** OP switches a run to the quick-surgery publish by hand (`run --quick-surgery`): a non-critical stop clears and its step is waived. */
export function enterQuickSurgery(stateRoot: string, version: string, by: string, now: Date, opts?: PlanOptions): RunState {
  const state = loadRun(stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version}`);
  if (state.profile === 'quick-surgery' && !state.hardStop?.noncritical) return state;
  const was = state.hardStop;
  state.profile = 'quick-surgery';
  if (was?.noncritical) {
    state.hardStop = null; state.done = false;
    const st = was.step ? state.steps[was.step] : undefined;
    if (st && st.status === 'failed') { st.status = 'done'; st.by = 'graph(soft-fail)'; st.warnings = [...(st.warnings ?? []), `waived by quick-surgery (${by}): ${was.reason}`]; }
  }
  for (const s of stepsFor(state, opts)) if (state.steps[s.id]?.status === 'failed' && !s.hard) state.steps[s.id] = { status: 'pending' };
  state.lastProgressAt = now.toISOString();
  saveRun(stateRoot, state);
  ledger(stateRoot, version, { kind: 'quick-surgery', by, was: was?.reason ?? null }, now);
  return state;
}

export function security4Path(stateRoot: string, version: string): string { return join(runDir(stateRoot, version), 'security4.jsonl'); }

/** Explicit NO-GO (CEO / REL / OP), or a security-4 finding (`security` set) — the only non-mechanical hard stops. */
export function noGo(stateRoot: string, version: string, by: string, reason: string, now: Date): RunState {
  return noGoWith(stateRoot, version, by, reason, now);
}

/** NO-GO with an optional security-4 kind (boundary · auth · secret · destructive). */
export function noGoWith(stateRoot: string, version: string, by: string, reason: string, now: Date, security?: string): RunState {
  const state = loadRun(stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version}`);
  if (security) appendFileSync(security4Path(stateRoot, version), `${JSON.stringify({ at: now.toISOString(), by, kind: security, reason })}\n`);
  state.hardStop = { at: now.toISOString(), by, reason: security ? `security-4 ${security}: ${reason}` : reason };
  saveRun(stateRoot, state);
  ledger(stateRoot, version, { kind: 'nogo', by, reason, security: security ?? null }, now);
  return state;
}

// ───────────────────────────── tick ─────────────────────────────

export interface TickSummary { version: string; mode: Mode; events: LedgerRow[]; done: boolean; hardStop: RunState['hardStop'] }

function satisfied(st: StepState, step: StepDef, mode: Mode, nowMs: number): boolean {
  if (st.status === 'done' || st.status === 'skipped') return true;
  // Shadow walks the DAG virtually: a would-run step counts as finished after its expected duration, unless REL's actual is in.
  if (mode === 'shadow' && st.status === 'would-run' && st.wouldRunAt) return nowMs >= Date.parse(st.wouldRunAt) + step.expectMin * 60_000;
  return false;
}

/** One tick at a time per version (cron tick ∥ `run --watch`): an exclusive lock file; a lock older than 10 min is a dead tick. */
export async function tickRelease(version: string, deps: ExecDeps): Promise<TickSummary> {
  const lock = join(runDir(deps.stateRoot, version), 'tick.lock');
  mkdirSync(runDir(deps.stateRoot, version), { recursive: true });
  try { writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: 'wx' }); }
  catch {
    const since = Number(readFileSync(lock, 'utf8').split(' ')[1] ?? 0);
    if (Date.now() - since < 10 * 60_000) return { version, mode: deps.mode(version), events: [], done: false, hardStop: loadRun(deps.stateRoot, version)?.hardStop ?? null };
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
  }
  try { return await tickLocked(version, deps); } finally { rmSync(lock, { force: true }); }
}

function fileSize(path: string): number { try { return statSync(path).size; } catch { return 0; } }

async function tickLocked(version: string, deps: ExecDeps): Promise<TickSummary> {
  const now = deps.now(); const nowMs = now.getTime(); const at = now.toISOString();
  const state = loadRun(deps.stateRoot, version);
  if (!state) throw new Error(`release graph: no run for ${version}`);
  const mode = deps.mode(state.version);
  const steps = stepsFor(state, deps.planOptions);
  const byId = new Map(steps.map(s => [s.id, s]));
  const events: LedgerRow[] = [];
  const log = (row: { kind: string; step?: string; [k: string]: unknown }) => { const full: LedgerRow = { ...row, at, mode }; events.push(full); ledger(deps.stateRoot, version, full, now); };
  const progress = () => { state.lastProgressAt = at; };
  const dir = runDir(deps.stateRoot, version);
  const logs = join(dir, 'logs');
  const wake = (step: string, body: string, extra: Record<string, unknown> = {}) => {
    if (mode !== 'live') { log({ kind: 'would-wake', to: 'REL', step, body, ...extra }); return; }
    try { log({ kind: 'wake', to: 'REL', step, id: deps.post('REL', 'request', body), ...extra }); } catch (e) { log({ kind: 'wake-failed', step, error: String(e) }); }
  };
  const card = (step: string, key: string, body: string) => {
    if (mode !== 'live') { log({ kind: 'would-card', step, key, body }); return; }
    try { log({ kind: 'card', step, key, id: deps.post('OP', 'request', body), body }); } catch (e) { log({ kind: 'card-failed', step, key, error: String(e) }); }
  };
  const stop = (step: string, by: string, reason: string, noncritical = false) => {
    if (state.hardStop) return;
    state.hardStop = { at, by, reason, step, ...(noncritical ? { noncritical: true } : {}) };
    log({ kind: 'hard-stop', step, reason });
    wake(step, `[release graph NO-GO · ${version}] ${step}: ${reason} — REL standby summon: fix, then \`eln release graph mark ${version} ${step} --by REL --ref <receipt>\` or \`eln release graph run ${version} --resume ${step}\`.`);
    card(step, `hard:${step}`, `[release graph NO-GO · ${version}] ${step}: ${reason}; REL woken. Resume: eln release graph run ${version} --resume ${step}`);
  };

  // 0a. Auto-switch: a normal run blocked only by a non-critical refusal becomes the quick-surgery publish at T−60m.
  if (state.profile === 'normal' && state.hardStop?.noncritical && nowMs >= Date.parse(state.clock.publishAt) - AUTO_SURGERY_MIN * 60_000) {
    const was = state.hardStop;
    state.profile = 'quick-surgery'; state.hardStop = null; state.done = false;
    const st = was.step ? state.steps[was.step] : undefined;
    if (st && st.status === 'failed') { st.status = 'done'; st.by = 'graph(soft-fail)'; st.warnings = [...(st.warnings ?? []), `waived by quick-surgery: ${was.reason}`]; }
    for (const s of steps) if (state.steps[s.id]?.status === 'failed' && !s.hard) state.steps[s.id] = { status: 'pending' };
    progress();
    log({ kind: 'auto-quick-surgery', step: was.step, was: was.reason, publishAt: state.clock.publishAt });
    card(was.step ?? 'go', 'auto-surgery', `[release graph · ${version}] normal run blocked by a non-critical refusal (${was.reason}) at T−${AUTO_SURGERY_MIN}m → switched to the quick-surgery publish (official path). Receipts continue in the same ledger.`);
  }
  const strict = state.profile === 'normal';

  // 0. Security-4 ledger (written by `nogo --security` or by any step through $ELANOUS_RELEASE_GRAPH_SECURITY4).
  if (!state.hardStop && existsSync(security4Path(deps.stateRoot, version))) {
    const row = readFileSync(security4Path(deps.stateRoot, version), 'utf8').split('\n').filter(Boolean)[0];
    const parsed = row ? JSON.parse(row) as { step?: string; kind?: string; by?: string } : {};
    stop(parsed.step ?? 'go', parsed.by ?? 'security-4', `security-4 finding (${parsed.kind ?? 'unspecified'})`);
  }

  // 1. Manual parity: detect what REL already did (both modes; first observation = REL actual).
  for (const step of steps) {
    const st = state.steps[step.id] ?? (state.steps[step.id] = { status: 'pending' });
    if (st.actualAt) continue;
    let hit: Detected | null = null;
    try { hit = await deps.detect(version, step, state); } catch (e) { log({ kind: 'detect-error', step: step.id, error: String(e) }); }
    if (!hit) continue;
    st.actualAt = hit.at; st.actualEvidence = hit.evidence;
    log({ kind: 'actual', step: step.id, actualAt: hit.at, evidence: hit.evidence, graphWouldRunAt: st.wouldRunAt ?? null });
    if (st.status !== 'done' && st.status !== 'running') { st.status = 'done'; st.by = 'REL(detected)'; st.ref = hit.evidence; st.endedAt = at; progress(); }
  }

  // 2. Running steps (live): exits, security markers, and the no-output stall watch.
  for (const step of steps) {
    const st = state.steps[step.id]!;
    if (st.status !== 'running') continue;
    const rcPath = join(logs, `${step.id}.rc`);
    const rc = existsSync(rcPath) ? Number(readFileSync(rcPath, 'utf8').trim()) : null;
    if (rc === null && st.pid && deps.alive(st.pid)) {
      const size = fileSize(join(logs, `${step.id}.log`));
      if (size !== st.logSize) { st.logSize = size; st.lastOutputAt = at; continue; }
      const quietSince = Date.parse(st.lastOutputAt ?? st.startedAt ?? at);
      if (!st.stallWoken && nowMs - quietSince >= STALL_MIN * 60_000) {
        st.stallWoken = true;
        const stallAt = new Date(quietSince + STALL_MIN * 60_000).toISOString();
        log({ kind: 'stall', step: step.id, quietSince: new Date(quietSince).toISOString(), stallAt });
        wake(step.id, `[release graph STALL · ${version}] ${step.id}:running — no output for ${STALL_MIN} min. Judge from the step log (${join(logs, `${step.id}.log`)}), not a counter; take over by hand and mark it.`, { stallAt, reason: `no progress for ${STALL_MIN} min` });
      }
      continue;
    }
    const exit = rc === null ? -1 : rc;
    st.exit = exit; st.endedAt = at; progress();
    if (existsSync(join(logs, `${step.id}.security4`))) {
      st.status = 'failed';
      log({ kind: 'step-failed', step: step.id, exit, security4: true });
      stop(step.id, 'security-4', `security-4 finding surfaced by ${step.id}`);
      continue;
    }
    if (exit === 0) { st.status = 'done'; st.by = 'graph'; log({ kind: 'step-done', step: step.id, exit }); continue; }
    if (step.hard) {
      st.status = 'failed';
      log({ kind: 'step-failed', step: step.id, exit, log: join(logs, `${step.id}.log`), hard: true });
      stop(step.id, 'graph', `${step.id} exited ${exit}${rc === null ? ' (process gone without rc)' : ''}`);
    } else if (strict) {
      st.status = 'failed';
      log({ kind: 'step-failed', step: step.id, exit, hard: false, noncritical: true });
      stop(step.id, 'guard', `${step.id} exited ${exit} (non-critical refusal · normal profile)`, true);
    } else {
      st.status = 'done'; st.by = 'graph(soft-fail)'; st.warnings = [...(st.warnings ?? []), `exit ${exit} waived (advisory step)`];
      log({ kind: 'step-warn', step: step.id, exit });
      card(step.id, `soft:${step.id}`, `[release graph warning · ${version}] ${step.id} exited ${exit} — waived and continuing. Log ${join(logs, `${step.id}.log`)}`);
    }
  }

  // 3. Ready steps → advisory checks → run (live) or would-run (shadow), under host caps. Repeat to a fixpoint so a gate
  //    that passes this tick releases its dependents in the same tick.
  const running = (host: GoldenHost) => steps.filter(s => s.host === host && state.steps[s.id]!.status === 'running').length;
  for (let changed = true; changed;) {
    changed = false;
    for (const step of steps) {
      const st = state.steps[step.id]!;
      if (st.status !== 'pending') continue;
      // A non-critical stop (normal profile) waits for the quick-surgery switch: no cleanup (traffic-restore) before publish.
      if (state.hardStop) { if (!step.always || state.hardStop.noncritical) continue; }
      else {
        if (!step.needs.every(n => satisfied(state.steps[n]!, byId.get(n)!, mode, nowMs))) continue;
        const earliest = earliestStart(step, state.clock);
        if (earliest !== null && nowMs < earliest) continue;
      }
      st.readyAt ??= at;
      const warnings: string[] = [];
      for (const check of state.hardStop ? [] : step.checks) {
        try {
          const r = await evaluatePredicate(check.predicate, deps.probes, { expand: x => x, sinceIso: state.createdAt });
          if (r.blocked) { stop(step.id, 'poll', `explicit NO-GO: ${r.blocked}`); break; }
          if (!r.met) warnings.push(`${check.id}: ${r.evidence} → waived: ${check.waive}`);
        } catch (e) { warnings.push(`${check.id}: could not measure (${String(e)}) → waived: ${check.waive}`); }
      }
      if (!state.hardStop && strict && warnings.length) { stop(step.id, 'guard', `refused: ${warnings.join(' | ')}`, true); continue; }
      if (state.hardStop && !step.always) { continue; }
      if (warnings.length) { st.warnings = [...(st.warnings ?? []), ...warnings]; log({ kind: 'advisory', step: step.id, warnings }); card(step.id, `adv:${step.id}`, `[release graph advisory · ${version}] ${step.id}: ${warnings.join(' | ')} — continuing.`); }
      if (step.cmd === null) { st.status = 'done'; st.by = 'graph(gate)'; st.startedAt = at; st.endedAt = at; progress(); log({ kind: 'gate-passed', step: step.id }); changed = true; continue; }
      if (mode === 'shadow') {
        st.status = 'would-run'; st.wouldRunAt = at; progress(); changed = true;
        log({ kind: 'would-run', step: step.id, phase: step.phase, host: step.host, cmd: step.cmd });
        continue;
      }
      if (running(step.host) >= GOLDEN_HOST_CAP[step.host]) { log({ kind: 'host-cap-wait', step: step.id, host: step.host }); continue; }
      mkdirSync(logs, { recursive: true });
      const logPath = join(logs, `${step.id}.log`); const rcPath = join(logs, `${step.id}.rc`);
      rmSync(rcPath, { force: true });
      try {
        st.pid = deps.start(step, step.cmd, logPath, rcPath, join(logs, `${step.id}.security4`));
        st.status = 'running'; st.startedAt = at; st.logSize = fileSize(logPath); st.lastOutputAt = at; st.stallWoken = false; progress(); changed = true;
        log({ kind: 'started', step: step.id, pid: st.pid, cmd: step.cmd, host: step.host });
      } catch (e) {
        st.status = 'failed'; st.exit = -1; st.endedAt = at; progress();
        log({ kind: 'start-failed', step: step.id, error: String(e) });
        if (step.hard) stop(step.id, 'graph', `${step.id} could not start: ${String(e)}`);
      }
    }
  }

  // 4. Phase clocks (advisory late cards).
  for (const step of state.hardStop ? [] : steps) {
    const st = state.steps[step.id]!;
    if (st.lateCarded || !st.readyAt || st.status !== 'running') continue;
    if (nowMs >= Date.parse(st.readyAt) + step.maxWaitMin * 60_000) {
      st.lateCarded = true;
      log({ kind: 'phase-late', step: step.id, phase: step.phase, readyAt: st.readyAt, maxWaitMin: step.maxWaitMin });
      card(step.id, `late:${step.id}`, `[release graph late · ${version}] ${step.phase} ${step.id} still running ${step.maxWaitMin}m after ready.`);
    }
  }
  const anyRunning = steps.some(s => state.steps[s.id]!.status === 'running');
  const finished = state.hardStop
    ? !state.hardStop.noncritical && !anyRunning && steps.filter(s => s.always).every(s => state.steps[s.id]!.status !== 'pending')
    : steps.every(s => ['done', 'skipped'].includes(state.steps[s.id]!.status) || (mode === 'shadow' && satisfied(state.steps[s.id]!, s, mode, nowMs)));
  if (finished && !state.done) {
    state.done = true; log({ kind: 'finished', hardStop: state.hardStop?.reason ?? null });
    if (state.kind === 'rehearsal' && mode === 'live') {
      const rows = steps.map(s => ({ step: s.id, status: state.steps[s.id]!.status, exit: state.steps[s.id]!.exit ?? null, warnings: state.steps[s.id]!.warnings ?? [] }));
      const ok = !state.hardStop && rows.every(r => r.status === 'done' && r.warnings.length === 0);
      let cutSha: string | null = null;
      try { cutSha = readFileSync(join(dirname(state.prepDir), 'cut.sha'), 'utf8').trim() || null; } catch { /* no cut */ }
      const receipt = rehearsalReceiptPath(state.version);
      mkdirSync(dirname(receipt), { recursive: true });
      writeFileSync(receipt, `${JSON.stringify({ version: state.version, kind: 'rehearsal', at, ok, cutSha, hardStop: state.hardStop?.reason ?? null, steps: rows }, null, 1)}\n`);
      log({ kind: 'rehearsal-receipt', path: receipt, ok });
    }
  }
  saveRun(deps.stateRoot, state);
  return { version, mode, events, done: !!state.done, hardStop: state.hardStop ?? null };
}

// ───────────────────────────── comparison ─────────────────────────────

export interface CompareRow { step: string; phase: Phase; status: StepStatus; graphAt: string | null; relActual: string | null; deltaMin: number | null; by: string | null; cmd: string | null; warnings: number }

/** «graph would-run vs REL actual» per step — the shadow-night deliverable. */
export function compareTable(state: RunState, opts?: PlanOptions): CompareRow[] {
  return stepsFor(state, opts).map(s => {
    const st = state.steps[s.id] ?? { status: 'pending' as const };
    const graphAt = st.wouldRunAt ?? st.startedAt ?? null;
    const delta = graphAt && st.actualAt ? Math.round((Date.parse(st.actualAt) - Date.parse(graphAt)) / 60_000) : null;
    return { step: s.id, phase: s.phase, status: st.status, graphAt, relActual: st.actualAt ?? null, deltaMin: delta, by: st.by ?? null, cmd: s.cmd, warnings: st.warnings?.length ?? 0 };
  });
}

// ───────────────────────────── defaults ─────────────────────────────

/** `release.graph.mode` = live only together with `release.graph.version` = this version; anything else is shadow. */
export function configuredMode(version: string, raw: unknown): Mode {
  const g = (raw as { release?: { graph?: { mode?: unknown; version?: unknown } } } | null)?.release?.graph;
  return g?.mode === 'live' && g.version === version ? 'live' : 'shadow';
}

const STEWARD_TO_STEP: Record<string, string> = {
  notes: 'notes', 'schedule-row': 'schedule', rehearsal: 'rehearsal', cut: 'cut', gonogo: 'go', publish: 'publish',
  verify: 'verify', rail: 'rail', 'els-restart': 'els-restart',
};

/** KST «2026-11-26 04:00» (steward shadow format) → ISO. */
function stewardTime(s: string): string { const d = Date.parse(s.replace(' ', 'T') + ':00+09:00'); return Number.isNaN(d) ? s : new Date(d).toISOString(); }

/** Read-only detection: the steward shadow's `actual` table (REL-ABSORB-STEWARD) first, then cheap direct probes. */
export function defaultDetect(opts: { seatState: string; repo: string; run?: (cmd: string, args: string[]) => { status: number | null; stdout: string } }) {
  const run = opts.run ?? ((cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 45_000 }); return { status: r.status, stdout: String(r.stdout ?? '') }; });
  const cache = new Map<string, { status: number | null; stdout: string }>();
  const once = (cmd: string, args: string[]) => { const k = [cmd, ...args].join(' '); if (!cache.has(k)) cache.set(k, run(cmd, args)); return cache.get(k)!; };
  return async (version: string, step: StepDef, state: RunState): Promise<Detected | null> => {
    const now = new Date().toISOString();
    try {
      const steward = JSON.parse(readFileSync(join(opts.seatState, 'REL', 'evidence', 'steward-shadow', 'state.json'), 'utf8')) as { actual?: Record<string, { at: string; evidence: string }> };
      for (const [k, a] of Object.entries(steward.actual ?? {})) {
        const [v, sid] = k.split(':');
        if (v === version && STEWARD_TO_STEP[sid!] === step.id) return { at: stewardTime(a.at), evidence: `steward-shadow: ${a.evidence}` };
      }
    } catch { /* steward not running → direct probes */ }
    switch (step.id) {
      case 'cut': case 'cut-push': { const r = once('git', ['-C', opts.repo, 'ls-remote', 'origin', `refs/heads/release/${version}`]); return r.status === 0 && r.stdout.trim() ? { at: now, evidence: `release/${version}=${r.stdout.split(/\s/)[0]!.slice(0, 12)}` } : null; }
      case 'prepare': return existsSync(join(state.prepDir, 'release.json')) ? { at: now, evidence: `prepared: ${join(state.prepDir, 'release.json')}` } : null;
      case 'publish': { const r = once('gh', ['release', 'view', `v${version}`, '--repo', 'ElanvitalAI/elanous', '--json', 'publishedAt,isDraft']);
        if (r.status !== 0) return null; const j = JSON.parse(r.stdout) as { publishedAt?: string; isDraft?: boolean };
        return j.publishedAt && !j.isDraft ? { at: j.publishedAt, evidence: `GH v${version} published` } : null; }
      case 'npm': { const r = once('npm', ['view', `elanous@${version}`, 'version']); return r.status === 0 && r.stdout.trim() === version ? { at: now, evidence: `npm elanous@${version} visible` } : null; }
      case 'dev-bump': { const r = once('git', ['-C', opts.repo, 'show', 'origin/main:package.json']);
        if (r.status !== 0) return null; const pv = (JSON.parse(r.stdout) as { version?: string }).version ?? '';
        const [a, b, c] = version.split('.').map(Number); return pv === `${a}.${b}.${c! + 1}-dev.0` ? { at: now, evidence: `main package.json ${pv}` } : null; }
      default: return null;
    }
  };
}

export function defaultStart(cwd: string) {
  return (_step: StepDef, cmd: string, logPath: string, rcPath: string, security4Path: string): number => {
    // The step runs exactly as REL's hand run: the tick's graph-runner context (ELANOUS_GRAPH_*) must not leak in — version-node
    // would otherwise read the tick's run input as its own graph context.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('ELANOUS_GRAPH_')) delete env[key];
    // The tick runs from cron (PATH=/usr/bin:/bin): give the step the toolchain REL's shell has — this bun, the installed
    // elanous/eln/els shims, Homebrew (gh · npm · git).
    env.PATH = [dirname(process.execPath), join(homedir(), '.local', 'share', 'elanous', 'bin'), join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':');
    const child = spawn('/bin/zsh', ['-c', `(${cmd}) > ${q(logPath)} 2>&1; echo $? > ${q(rcPath)}`], { cwd, detached: true, stdio: 'ignore', env: { ...env, ELANOUS_TRACK: process.env.ELANOUS_TRACK ?? 'REL', [SECURITY4_ENV]: security4Path } });
    child.unref();
    if (!child.pid) throw new Error('spawn returned no pid');
    return child.pid;
  };
}

export function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
