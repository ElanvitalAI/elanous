// release-quickpass-world: a sim device that replays the manual quick pass that actually published
// 0.3.33–0.3.35 (spec: seat-state/REL/QUICKPASS-GOLDEN.md) with fake command runners, injects the failure
// classes that historically blocked releases, and checks the release graph's quick-path policy:
//   advisory failures → warn + card, and the run continues;
//   STOP only on build non-zero, publish non-zero, a security-4 finding, or an explicit NO-GO;
//   a step with no progress for 15 simulated minutes → REL wake;
//   `mark` / `--resume` work from any step.
// Time is virtual (minutes), so a whole release replays in milliseconds and runs are deterministic per seed.
//
// Adapter seam: the executor is the QuickpassExecutor interface. `referenceExecutor` below is the DAG
// executor the policy is written against. The real graph executor (feat/release-graph-executor) plugs in
// through `loadExecutor()` (env RELEASE_QUICKPASS_EXECUTOR=<module exporting `quickpassExecutor`>), so the
// same scenarios and the same table run against the real code.

export type StepPolicy = 'advisory' | 'build' | 'publish' | 'decision';
export type StepStatus = 'pass' | 'warn' | 'stop' | 'skipped' | 'marked';

export interface QuickpassStep {
  id: string;
  /** The exact manual command (golden ledger). Real runners execute it; fake runners only echo it. */
  command: string;
  /** What finished before this step could start (true dependencies only: the DAG edges). */
  deps: readonly string[];
  policy: StepPolicy;
  /** Typical duration in minutes, from 0.3.35 receipts. */
  minutes: number;
  /** Concurrency-capped host this step runs on (omit = uncapped). */
  host?: string;
  /** Receipt pattern a pass must print. */
  receipt: RegExp;
}

/** The golden path. Order = the order the person walked it on 0.3.35 (manual serial order). */
export const GOLDEN_STEPS: readonly QuickpassStep[] = [
  { id: 'cli-fresh', command: 'bun bin/elanous.mjs --version', deps: [], policy: 'advisory', minutes: 0.5, receipt: /\d+\.\d+\.\d+/u },
  { id: 'notes', command: 'git show origin/main:release/<v>-draft.md > notes-<v>-final.md && shasum -a 256 notes-<v>-final.md', deps: [], policy: 'advisory', minutes: 0.5, receipt: /[0-9a-f]{64}/u },
  { id: 'roster', command: 'ELANOUS_TRACK=OP eln release checklist status --version <v>', deps: [], policy: 'advisory', minutes: 0.5, receipt: /🟢\d+/u },
  { id: 'schedule', command: 'eln release schedule show --version <v>', deps: [], policy: 'advisory', minutes: 0.5, receipt: /cut/u },
  { id: 'cut', command: "git worktree add --detach <W> origin/main && perl -pi -e 's/<v>-dev\\.0/<v>/g' package.json server.json integrations/acp-registry/elanous/agent.json && git commit -qam 'release: <v>'", deps: [], policy: 'build', minutes: 2, host: 'mshq', receipt: /cut=[0-9a-f]{40}/u },
  { id: 'cut-push', command: 'git push -q origin HEAD:refs/heads/release/<v>', deps: ['cut'], policy: 'advisory', minutes: 0.5, receipt: /release\/\S+ pushed/u },
  { id: 'pregate', command: '~/elanous-hq/seat-state/RES/tools/pregate --host minim5 <cut>', deps: ['cut'], policy: 'advisory', minutes: 20, host: 'minim5', receipt: /GATES_PASS/u },
  { id: 'prebuild', command: 'gate-image-prebuild (node-b registry push)', deps: ['cut'], policy: 'advisory', minutes: 10, host: 'node-b', receipt: /elanous-harness:[0-9a-f]{12}/u },
  { id: 'prepare', command: 'bun bin/elanous.mjs --config-dir ~/.elanous release critpath --version <v> --cut-commit <SHA> --notes-file notes-<v>-final.md --dry-run', deps: ['cut', 'notes'], policy: 'build', minutes: 3, host: 'mshq', receipt: /A158 .*PASS/u },
  { id: 'rehearsal', command: '(same critpath --dry-run) → ✓ publish · dry-run · ✓ npm · dry-run', deps: ['prepare'], policy: 'advisory', minutes: 1, host: 'mshq', receipt: /nothing was published/u },
  { id: 'go', command: 'OP GO decision bound to version · cut SHA · notes sha', deps: ['prepare', 'roster'], policy: 'decision', minutes: 2, receipt: /GO/u },
  { id: 'notes-public', command: "sed -E 's/ \\(#[0-9]+\\)//g' notes-<v>-final.md > notes-<v>-public.md", deps: ['notes'], policy: 'advisory', minutes: 0.5, receipt: /public/u },
  { id: 'publish', command: 'bun bin/elanous.mjs --config-dir ~/.elanous release publish --dir ~/.elanous/release/<v>/critpath-prepared --notes-file notes-<v>-public.md --yes', deps: ['prepare', 'go', 'notes-public'], policy: 'publish', minutes: 0.5, host: 'publish', receipt: /assets=5/u },
  { id: 'npm', command: 'npm view elanous@<v> version', deps: ['publish'], policy: 'publish', minutes: 1, receipt: /\d+\.\d+\.\d+/u },
  { id: 'verify', command: 'bun bin/elanous.mjs --config-dir ~/.elanous release verify --version <v> --public-repo ElanvitalAI/elanous', deps: ['publish'], policy: 'advisory', minutes: 1, receipt: /설치 rc=0/u },
  { id: 'docs', command: 'bun website/scripts/deploy-pages.ts --remote <host> --yes', deps: ['publish'], policy: 'advisory', minutes: 15, receipt: /200/u },
  { id: 'rail', command: 'RAIL_HOSTS="local mbp node-b minim5" zsh ~/elanous-hq/seat-state/OP/tools/rail-now.sh', deps: ['publish'], policy: 'advisory', minutes: 2.5, host: 'mshq', receipt: /installed=/u },
  { id: 'els-restart', command: 'launchctl kickstart -k gui/$(id -u)/dev.elanous.els', deps: ['rail'], policy: 'advisory', minutes: 0.5, receipt: /pid=\d+/u },
  { id: 'update-all', command: 'els update-all', deps: ['els-restart'], policy: 'advisory', minutes: 15, receipt: /\| eln \| updated \|/u },
  { id: 'dev-bump', command: 'PR: package.json → <v+1>-dev.0 · empty release/next.md', deps: ['publish'], policy: 'advisory', minutes: 15, receipt: /merged/u },
  { id: 'traffic-restore', command: '~/elanous-hq/seat-state/OP/tools/traffic-knob.sh restore', deps: ['publish'], policy: 'advisory', minutes: 0.5, receipt: /restored/u },
];

/** Hosts whose steps run one at a time (mshq heavy work, the pod gate hosts, the single public publish). */
export const HOST_CAPS: Readonly<Record<string, number>> = { mshq: 1, minim5: 1, 'node-b': 1, publish: 1 };
export const STALL_WAKE_MINUTES = 15;

/** What a runner reports for one step. */
export interface StepOutcome {
  exitCode: number;
  output: string;
  minutes: number;
  /** False = the step printed no progress (e.g. the «Remaining seats: 26» counter): stall watch applies. */
  progress?: boolean;
  /** A security-4 finding surfaced by this step (boundary/auth/secret/destructive). */
  security4?: boolean;
  /** Decision steps: the explicit verdict. Anything other than 'NO-GO' is not a stop. */
  verdict?: 'GO' | 'NO-GO' | 'unverified';
}
export type StepRunner = (step: QuickpassStep) => StepOutcome;

export interface StepResult {
  id: string;
  status: StepStatus;
  startedAt: number;
  endedAt: number;
  reason?: string;
}
export interface Card { step: string; reason: string }
export interface Wake { seat: 'REL'; step: string; at: number; reason: string }
export interface RunOptions {
  /** Steps already done by hand (`mark <step>`): never re-run, count as satisfied. */
  marks?: readonly string[];
  /** `--resume <step>`: everything not downstream of this step counts as done; only it and its descendants run. */
  resumeFrom?: string;
  hostCaps?: Readonly<Record<string, number>>;
}
export interface RunResult {
  results: StepResult[];
  cards: Card[];
  wakes: Wake[];
  /** First STOP step, if any. */
  stoppedAt?: string;
  published: boolean;
  wallMinutes: number;
  /** Step ids in the order they started (for the start-before-deps check). */
  startOrder: string[];
}
export interface QuickpassExecutor {
  name: string;
  run(steps: readonly QuickpassStep[], runner: StepRunner, options?: RunOptions): RunResult | Promise<RunResult>;
}

/** Descendants of `id` (inclusive) in the step DAG. */
export function downstream(steps: readonly QuickpassStep[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) if (!out.has(step.id) && step.deps.some((dep) => out.has(dep))) { out.add(step.id); grew = true; }
  }
  return out;
}

function classify(step: QuickpassStep, outcome: StepOutcome): { status: 'pass' | 'warn' | 'stop'; reason?: string } {
  if (outcome.security4) return { status: 'stop', reason: 'security-4 finding' };
  if (step.policy === 'decision') {
    if (outcome.verdict === 'NO-GO') return { status: 'stop', reason: 'explicit NO-GO' };
    if (outcome.verdict !== 'GO') return { status: 'warn', reason: `approval ${outcome.verdict ?? 'missing'} — card, not a stop` };
    return { status: 'pass' };
  }
  const receiptOk = step.receipt.test(outcome.output);
  if (outcome.exitCode === 0 && receiptOk) return { status: 'pass' };
  const why = outcome.exitCode !== 0 ? `exit ${outcome.exitCode}` : 'receipt missing';
  if ((step.policy === 'build' || step.policy === 'publish') && outcome.exitCode !== 0) return { status: 'stop', reason: `${step.policy} ${why}` };
  return { status: 'warn', reason: why };
}

/**
 * Reference DAG executor (discrete-event, virtual minutes): starts every step whose deps are satisfied and whose
 * host has a free slot; parallel where the DAG allows, serial only on real deps and host caps. A STOP lets running
 * steps finish but starts nothing new; `traffic-restore` still runs after a stop (it is the cleanup).
 */
export const referenceExecutor: QuickpassExecutor = {
  name: 'reference-dag',
  run(steps, runner, options = {}) {
    const caps = options.hostCaps ?? HOST_CAPS;
    const byId = new Map(steps.map((step) => [step.id, step]));
    const preDone = new Set<string>(options.marks ?? []);
    if (options.resumeFrom) {
      if (!byId.has(options.resumeFrom)) throw new Error(`unknown resume step: ${options.resumeFrom}`);
      const rerun = downstream(steps, options.resumeFrom);
      for (const step of steps) if (!rerun.has(step.id)) preDone.add(step.id);
      for (const id of rerun) if (!(options.marks ?? []).includes(id)) preDone.delete(id);
    }
    const results = new Map<string, StepResult>();
    for (const id of preDone) results.set(id, { id, status: 'marked', startedAt: 0, endedAt: 0 });
    const cards: Card[] = [];
    const wakes: Wake[] = [];
    const startOrder: string[] = [];
    const running: { step: QuickpassStep; outcome: StepOutcome; startedAt: number; endsAt: number }[] = [];
    const busy = new Map<string, number>();
    let now = 0;
    let stoppedAt: string | undefined;
    const finished = (id: string) => results.has(id);
    const ready = (step: QuickpassStep) => !finished(step.id) && !running.some((r) => r.step.id === step.id)
      && step.deps.every((dep) => finished(dep) && results.get(dep)!.status !== 'stop' && results.get(dep)!.status !== 'skipped')
      && (step.host === undefined || (busy.get(step.host) ?? 0) < (caps[step.host] ?? Number.POSITIVE_INFINITY));
    for (;;) {
      for (const step of steps) {
        if (finished(step.id) || running.some((r) => r.step.id === step.id)) continue;
        if (stoppedAt) {
          if (step.id !== 'traffic-restore') continue; // cleanup always runs, deps or not
        } else if (!ready(step)) continue;
        const outcome = runner(step);
        startOrder.push(step.id);
        if (step.host) busy.set(step.host, (busy.get(step.host) ?? 0) + 1);
        running.push({ step, outcome, startedAt: now, endsAt: now + Math.max(0, outcome.minutes) });
        if (outcome.progress === false && outcome.minutes > STALL_WAKE_MINUTES) {
          wakes.push({ seat: 'REL', step: step.id, at: now + STALL_WAKE_MINUTES, reason: `no progress for ${STALL_WAKE_MINUTES} min` });
        }
      }
      if (running.length === 0) break;
      running.sort((a, b) => a.endsAt - b.endsAt || a.step.id.localeCompare(b.step.id));
      const done = running.shift()!;
      now = done.endsAt;
      if (done.step.host) busy.set(done.step.host, (busy.get(done.step.host) ?? 1) - 1);
      const verdict = classify(done.step, done.outcome);
      results.set(done.step.id, { id: done.step.id, status: verdict.status, startedAt: done.startedAt, endedAt: done.endsAt, reason: verdict.reason });
      if (verdict.status === 'warn') cards.push({ step: done.step.id, reason: verdict.reason ?? 'warn' });
      if (verdict.status === 'stop' && !stoppedAt) stoppedAt = done.step.id;
    }
    for (const step of steps) if (!results.has(step.id)) results.set(step.id, { id: step.id, status: 'skipped', startedAt: now, endedAt: now, reason: stoppedAt ? `run stopped at ${stoppedAt}` : 'deps not satisfied' });
    const publish = results.get('publish');
    return {
      results: steps.map((step) => results.get(step.id)!),
      cards,
      wakes,
      stoppedAt,
      published: publish !== undefined && (publish.status === 'pass' || publish.status === 'warn'),
      wallMinutes: now,
      startOrder,
    };
  },
};

/** The real executor when RELEASE_QUICKPASS_EXECUTOR names a module exporting `quickpassExecutor`; else the reference. */
export async function loadExecutor(env: Record<string, string | undefined> = process.env): Promise<QuickpassExecutor> {
  const path = env.RELEASE_QUICKPASS_EXECUTOR;
  if (!path) return referenceExecutor;
  const mod = await import(path) as { quickpassExecutor?: QuickpassExecutor };
  if (!mod.quickpassExecutor || typeof mod.quickpassExecutor.run !== 'function') throw new Error(`${path} does not export quickpassExecutor.run`);
  return mod.quickpassExecutor;
}

// ---------------------------------------------------------------------------------------------------------------
// Fake runners and the historical blocker catalogue

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOOD_OUTPUT: Record<string, string> = {
  'cli-fresh': '0.3.99 261126_1400 deadbeef',
  notes: `ef1c429d720bbdd0452faf03d423642fbc86d15e227aaf42fc3cdd7fa02f8d73  notes-final.md`,
  roster: '🟢62 🟡0 🔴0',
  schedule: 'cut 2026-11-26 16:00',
  cut: 'cut=e6eddfaf0d4727ea8487c89393cccdb39cfe400d',
  'cut-push': 'release/0.3.99 pushed',
  pregate: 'GATES_PASS L3',
  prebuild: 'elanous-harness:e6eddfaf0d47 pushed',
  prepare: '⑤ 체크섬 OK\nA158 nexus health=200/ok=true app=200 PASS\n✓ prepare · ok',
  rehearsal: '✓ publish · dry-run\n✓ npm · dry-run\ndry run — nothing was published',
  go: 'GO',
  'notes-public': 'public notes written · 0 PR refs',
  publish: 'v0.3.99 draft=false assets=5',
  npm: '0.3.99',
  verify: '설치 rc=0 · self-update rc=0 · 제거 rc=0 · notes 200',
  docs: 'notes=200',
  rail: 'mshq: installed=0.3.99',
  'els-restart': 'els serve pid=4242',
  'update-all': '| p1 | OP | eln | updated |',
  'dev-bump': 'dev-bump PR merged',
  'traffic-restore': 'traffic restored',
};

/** One fault applied to one step's outcome. */
export interface Fault { step: string; apply: (outcome: StepOutcome) => StepOutcome }

export interface Blocker {
  id: string;
  /** Where it bit, from receipts. */
  history: string;
  faults: Fault[];
  /** Old guards (main today, as observed in receipts): did the release stop, and at which step? */
  oldGuard: { stops: boolean; at: string; evidence: string };
  /** Expected graph quick-path outcome. */
  expect: 'continue' | 'stop';
}

const fail = (exitCode: number, output: string, extra: Partial<StepOutcome> = {}) => (o: StepOutcome): StepOutcome => ({ ...o, exitCode, output, ...extra });

/** Historical blockers (advisory: the run must continue) followed by the must-stop controls. */
export const BLOCKERS: readonly Blocker[] = [
  { id: 'cli-freshness', history: '0.3.33 · 0.3.34 release run RC=1', faults: [{ step: 'cli-fresh', apply: fail(1, '⛔ git status failed while checking release CLI freshness') }], oldGuard: { stops: true, at: 'release run preflight', evidence: 'OP/evidence/2026112{3,4}/release-run-033{3,4}.log RUN_RC=1' }, expect: 'continue' },
  { id: 'notes-empty', history: '0.3.16 notes-empty cut stop', faults: [{ step: 'notes', apply: fail(1, 'release/<v>-draft.md: empty') }], oldGuard: { stops: true, at: 'cut (notes-empty)', evidence: 'memory release-notes-into-next-md-before-cut (11-16)' }, expect: 'continue' },
  { id: 'stale-pregate', history: '0.3.32 gate interrupted · 0.3.33 postgate unmeasured', faults: [{ step: 'pregate', apply: fail(2, 'pregate receipt head mismatch (stale)') }], oldGuard: { stops: true, at: 'gate / gate-triage', evidence: 'run a901 resume --waive gate · run dc80a36f still at gate-triage' }, expect: 'continue' },
  { id: 'schedule-row-missing', history: '11-04 release run without cut-at (30 min lost)', faults: [{ step: 'schedule', apply: fail(1, 'no schedule row for <v>') }], oldGuard: { stops: true, at: 'release run (schedule cut-at)', evidence: 'memory release-run-preflight-four (11-04)' }, expect: 'continue' },
  { id: 'yellow-cells', history: 'every release: 🟡 cells at cut', faults: [{ step: 'roster', apply: fail(3, '🟢4 🟡68 🔴0 — HOLD') }], oldGuard: { stops: true, at: 'checklist-gate', evidence: 'release-loop checklist-gate · OPS-RULES waiver by hand' }, expect: 'continue' },
  { id: 'rehearsal-partial', history: '0.3.35 approval none in dry-run', faults: [{ step: 'rehearsal', apply: fail(1, '✓ publish · dry-run\n✗ npm · dry-run timeout') }], oldGuard: { stops: true, at: 'hard rehearsal (OP hold)', evidence: 'memory hard-rehearsal-t-minus-4h' }, expect: 'continue' },
  { id: 'prebuild-timeout', history: '0.3.33 image pack failed (no PWA out)', faults: [{ step: 'prebuild', apply: fail(124, 'gate-image-prebuild timeout', { minutes: 45 }) }], oldGuard: { stops: true, at: 'gate-image-prebuild', evidence: 'REL/POSTGATE-0333.md r1 pack fail' }, expect: 'continue' },
  { id: 'push-rejected', history: 'release branch exists / non-fast-forward', faults: [{ step: 'cut-push', apply: fail(1, '! [rejected] release/<v> (fetch first)') }], oldGuard: { stops: true, at: 'cut-branch', evidence: 'release-loop cut-branch fail edge' }, expect: 'continue' },
  { id: 'approval-unverified', history: '0.3.35 critpath rc=75 «human proof unverified»', faults: [{ step: 'go', apply: (o) => ({ ...o, verdict: 'unverified', output: 'human proof unverified' }) }], oldGuard: { stops: true, at: 'approval (critpath rc=75)', evidence: 'OP/evidence/20261125/critpath-publish{2,3}.log' }, expect: 'continue' },
  { id: 'verify-notes-page', history: '0.3.35 verify RC=1 «노트 페이지 없음»', faults: [{ step: 'verify', apply: fail(1, '설치 rc=0 · 노트 페이지 없음') }], oldGuard: { stops: true, at: 'verify → traffic-failed-restore (post-publish)', evidence: 'OP/evidence/20261125/verify-0335.log RC=1' }, expect: 'continue' },
  { id: 'els-restart-fail', history: '11-23 migrated seats left exited', faults: [{ step: 'els-restart', apply: fail(1, 'launchctl: service did not restart') }], oldGuard: { stops: true, at: 'post-publish chain (rail/els)', evidence: 'ELS-UPDATE-ALL-MIGRATE-EXITS (11-23)' }, expect: 'continue' },
  { id: 'update-all-stuck', history: '0.3.35 «Remaining seats: 26» for 15 min, RC=1', faults: [{ step: 'update-all', apply: fail(1, 'els update-all: Remaining seats: 26 · 1557s remaining', { minutes: 25, progress: false }) }], oldGuard: { stops: true, at: 'update-all timeout (RC=124/1)', evidence: 'OP/evidence/20261125/ua-post0335.log · updateall-2{3,4}.log' }, expect: 'continue' },
  { id: 'dev-bump-blocked', history: '0.3.32 version-dev-bump PR blocked', faults: [{ step: 'dev-bump', apply: fail(1, 'pr land --hold rc=1') }], oldGuard: { stops: true, at: 'release-post-publish-join', evidence: 'OP/HANDOFF-els-1122.md' }, expect: 'continue' },
  // Must-stop controls: the graph must stop here, exactly like the old guards.
  { id: 'CONTROL build non-zero', history: 'control', faults: [{ step: 'prepare', apply: fail(1, 'PWA build failed') }], oldGuard: { stops: true, at: 'prepare', evidence: 'control' }, expect: 'stop' },
  { id: 'CONTROL publish non-zero', history: 'control', faults: [{ step: 'publish', apply: fail(1, 'gh release create failed') }], oldGuard: { stops: true, at: 'publish', evidence: 'control' }, expect: 'stop' },
  { id: 'CONTROL npm non-zero', history: 'control', faults: [{ step: 'npm', apply: fail(1, 'npm publish E403') }], oldGuard: { stops: true, at: 'npm-publish', evidence: 'control' }, expect: 'stop' },
  { id: 'CONTROL security-4', history: 'control: 🔴 security-4 cell at GO time', faults: [{ step: 'roster', apply: (o) => ({ ...o, security4: true, output: '🟢60 🟡0 🔴1 (security-4)' }) }], oldGuard: { stops: true, at: 'checklist-gate', evidence: 'control' }, expect: 'stop' },
  { id: 'CONTROL NO-GO', history: 'control', faults: [{ step: 'go', apply: (o) => ({ ...o, verdict: 'NO-GO', output: 'NO-GO' }) }], oldGuard: { stops: true, at: 'approval', evidence: 'control' }, expect: 'stop' },
];

/** Fake runner: golden outputs, ±20% seeded duration jitter, then the faults. */
export function fakeRunner(seed: number, faults: readonly Fault[] = []): StepRunner {
  // Jitter is a pure function of (seed, step) so a slow branch never shifts unrelated steps' durations.
  const jitterOf = (id: string) => rng(seed * 1_000_003 + [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))();
  const byStep = new Map<string, Fault[]>();
  for (const fault of faults) byStep.set(fault.step, [...(byStep.get(fault.step) ?? []), fault]);
  return (step) => {
    const jitter = 0.8 + jitterOf(step.id) * 0.4;
    let outcome: StepOutcome = { exitCode: 0, output: GOOD_OUTPUT[step.id] ?? 'ok', minutes: step.minutes * jitter, progress: true };
    if (step.policy === 'decision') outcome = { ...outcome, verdict: 'GO' };
    for (const fault of byStep.get(step.id) ?? []) outcome = fault.apply(outcome);
    return outcome;
  };
}

/** Manual serial wall time: the person ran the golden steps one after another in ledger order. */
export function manualSerialMinutes(steps: readonly QuickpassStep[], runner: StepRunner): number {
  return steps.reduce((sum, step) => sum + Math.max(0, runner(step).minutes), 0);
}

/** Check that no step started before its deps ended (ledger timestamps). Returns violations. */
export function depOrderViolations(steps: readonly QuickpassStep[], result: RunResult): string[] {
  const at = new Map(result.results.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const step of steps) {
    const r = at.get(step.id)!;
    if (r.status === 'skipped' || r.status === 'marked') continue;
    for (const dep of step.deps) {
      const d = at.get(dep)!;
      if (d.status !== 'marked' && r.startedAt < d.endedAt) out.push(`${step.id} started at ${r.startedAt} before ${dep} ended at ${d.endedAt}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The proof table (CEO 19:1x «confirm it in the simulation world»)

export interface Row { blocker: string; history: string; oldStops: string; graph: string; cards: number; wakes: number; published: string; ok: boolean }

function verdictOf(result: RunResult): string {
  if (result.stoppedAt) return `stopped @ ${result.stoppedAt}`;
  const warned = result.results.filter((r) => r.status === 'warn').map((r) => r.id);
  return warned.length > 0 ? `continued · warned (${warned.join(', ')})` : 'continued · clean';
}

export async function proofTable(executor: QuickpassExecutor, seeds: readonly number[] = [1, 2, 3]) {
  const rows: Row[] = [];
  const scenarios: { blocker: Blocker; faults: Fault[] }[] = BLOCKERS.map((blocker) => ({ blocker, faults: blocker.faults }));
  const advisory = BLOCKERS.filter((b) => b.expect === 'continue');
  scenarios.push({
    blocker: { id: 'ALL historical blockers at once', history: `${advisory.length} faults`, faults: [], oldGuard: { stops: true, at: 'release run preflight (first one hit)', evidence: 'union' }, expect: 'continue' },
    faults: advisory.flatMap((b) => b.faults),
  });
  for (const { blocker, faults } of scenarios) {
    const outcomes: RunResult[] = [];
    for (const seed of seeds) outcomes.push(await executor.run(GOLDEN_STEPS, fakeRunner(seed, faults)));
    const verdicts = [...new Set(outcomes.map(verdictOf))];
    const published = outcomes.every((o) => o.published) ? 'yes' : outcomes.every((o) => !o.published) ? 'no' : 'mixed';
    const ok = blocker.expect === 'continue'
      ? outcomes.every((o) => !o.stoppedAt && o.published && o.cards.length > 0)
      : outcomes.every((o) => o.stoppedAt !== undefined);
    rows.push({
      blocker: blocker.id,
      history: blocker.history,
      oldStops: blocker.oldGuard.stops ? `STOP @ ${blocker.oldGuard.at}` : 'continue',
      graph: verdicts.join(' / '),
      cards: Math.max(...outcomes.map((o) => o.cards.length)),
      wakes: Math.max(...outcomes.map((o) => o.wakes.length)),
      published,
      ok,
    });
  }
  // Wall time and race checks.
  const wall = seeds.map((seed) => {
    const dag = referenceIndependentRun(executor, seed);
    return dag.then((d) => ({ seed, serial: manualSerialMinutes(GOLDEN_STEPS, fakeRunner(seed)), dag: d.wallMinutes, publishAt: d.results.find((r) => r.id === 'publish')!.startedAt }));
  });
  const walls = await Promise.all(wall);
  const races = await Promise.all(seeds.map((seed) => raceCheck(executor, seed)));
  return { rows, walls, races };
}

async function referenceIndependentRun(executor: QuickpassExecutor, seed: number): Promise<RunResult> {
  return executor.run(GOLDEN_STEPS, fakeRunner(seed));
}

export interface RaceReport { seed: number; publishStartBaseline: number; publishStartWithSlowBranch: number; unrelatedEqual: boolean; violations: string[]; ok: boolean }

/** A slow (120 min) failing prebuild and a failing pregate must not move publish nor change unrelated branches. */
export async function raceCheck(executor: QuickpassExecutor, seed: number): Promise<RaceReport> {
  const baseline = await executor.run(GOLDEN_STEPS, fakeRunner(seed));
  const faults: Fault[] = [
    { step: 'prebuild', apply: fail(124, 'prebuild timeout', { minutes: 120, progress: false }) },
    { step: 'pregate', apply: fail(2, 'pregate RED', { minutes: 60 }) },
  ];
  const slowed = await executor.run(GOLDEN_STEPS, fakeRunner(seed, faults));
  const publishAt = (r: RunResult) => r.results.find((x) => x.id === 'publish')!.startedAt;
  const slowBranch = new Set(['prebuild', 'pregate']);
  const unrelatedEqual = baseline.results.every((b) => {
    if (slowBranch.has(b.id)) return true;
    const s = slowed.results.find((x) => x.id === b.id)!;
    return s.status === b.status && s.startedAt === b.startedAt && s.endedAt === b.endedAt;
  });
  const violations = [...depOrderViolations(GOLDEN_STEPS, baseline), ...depOrderViolations(GOLDEN_STEPS, slowed)];
  return { seed, publishStartBaseline: publishAt(baseline), publishStartWithSlowBranch: publishAt(slowed), unrelatedEqual, violations, ok: unrelatedEqual && violations.length === 0 && publishAt(baseline) === publishAt(slowed) && slowed.published };
}

const fmt = (n: number) => n.toFixed(1);

export function renderTable(executorName: string, table: Awaited<ReturnType<typeof proofTable>>): string {
  const advisory = table.rows.filter((r) => !r.blocker.startsWith('CONTROL'));
  const controls = table.rows.filter((r) => r.blocker.startsWith('CONTROL'));
  const oldStops = advisory.filter((r) => r.oldStops.startsWith('STOP')).length;
  const graphStops = advisory.filter((r) => r.graph.includes('stopped')).length;
  const lines = [
    `# release-quickpass-world: proof table (executor = ${executorName} · seeds ${table.walls.map((w) => w.seed).join(',')})`,
    '',
    `Headline: historical blockers that stopped the release under the old guards: **${oldStops}/${advisory.length}**. Under the graph quick path: **${graphStops}/${advisory.length}** (each of the others warned, raised a card, and the release still published). Must-stop controls stopped: **${controls.filter((r) => r.ok).length}/${controls.length}**. All rows as expected: **${table.rows.every((r) => r.ok) ? 'yes' : 'NO'}**.`,
    '',
    'Old-guard column = what receipts show the guards on main did (release run, critpath and release-loop edges), not a re-execution of main.',
    '',
    '| blocker (injected) | history | old guards → stop? at | graph quick-pass (3 seeds) | cards | REL wakes | published | as expected |',
    '|---|---|---|---|---|---|---|---|',
    ...table.rows.map((r) => `| ${r.blocker} | ${r.history} | ${r.oldStops} | ${r.graph} | ${r.cards} | ${r.wakes} | ${r.published} | ${r.ok ? '✅' : '❌'} |`),
    '',
    '## Wall time on the golden path: manual serial vs DAG parallel (virtual minutes)',
    '| seed | manual serial | DAG parallel | saved | publish starts at |',
    '|---|---|---|---|---|',
    ...table.walls.map((w) => `| ${w.seed} | ${fmt(w.serial)} | ${fmt(w.dag)} | ${fmt(w.serial - w.dag)} (${Math.round(100 * (1 - w.dag / w.serial))}%) | T+${fmt(w.publishAt)} |`),
    '',
    'Manual serial = the sum of step durations in the order walked on 0.3.35 (the 83-minute wait for 06:00 excluded). The DAG respects real deps and host caps (mshq 1 · minim5 1 · node-b 1 · publish 1).',
    '',
    '## Race check: a slow or failed parallel branch (prebuild 120 min timeout + pregate RED)',
    '| seed | publish start (baseline) | publish start (slow branch) | unrelated branches unchanged | publish before deps? | ok |',
    '|---|---|---|---|---|---|',
    ...table.races.map((r) => `| ${r.seed} | T+${fmt(r.publishStartBaseline)} | T+${fmt(r.publishStartWithSlowBranch)} | ${r.unrelatedEqual ? 'yes' : 'NO'} | ${r.violations.length === 0 ? 'never' : r.violations.join('; ')} | ${r.ok ? '✅' : '❌'} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const out = process.argv[2];
  const executor = await loadExecutor();
  const text = renderTable(executor.name, await proofTable(executor));
  if (out) await Bun.write(out, text);
  process.stdout.write(text);
}
