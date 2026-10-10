import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { publicExposureFiles, runExposeGate } from './expose-gate.js';
import { admitLandingMerge } from './frozen-merges.js';
import { releaseGitDiffPaths, releasePathHold, releasePathHoldShouldPost, releasePathHoldComment, releasePathHoldCommentsArgs, RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { detectTestInterference, parseFailureCount, runBunTest } from '../../scripts/detect-test-interference.js';
import { MAX_INSPECTED_TEST_FILES, runTestInterferenceGate } from '../../scripts/ci-test-interference-gate.js';
import { pwaGraph, pwaReach } from '../../scripts/ci-pwa-build-gate.js';

/** Use pr-land's PWA reachability (including its undecidable-graph build fallback), not a blanket src/** trigger. */
export function needsPwaBuild(files: readonly string[], repoRoot: string, graph: (root: string) => ReturnType<typeof pwaGraph> = pwaGraph): boolean {
  return pwaReach(files, () => graph(repoRoot)).reaches;
}

/**
 * Give a temporary checkout the source checkout's dependencies: link `<dir>/node_modules` when it is really installed
 * there (its `marker` package exists), otherwise install into the candidate. Shared by host regate and the task agent's
 * land worktree (TA-LAND-WORKTREE).
 */
export function provideCheckoutDependencies(candidate: string, sourceRoot: string, dir: string, marker: string, install: (cwd: string) => void): void {
  if (existsSync(join(candidate, dir, 'node_modules'))) return;
  if (existsSync(join(sourceRoot, dir, 'node_modules', marker, 'package.json'))) {
    symlinkSync(join(sourceRoot, dir, 'node_modules'), join(candidate, dir, 'node_modules'), 'dir');
  } else install(join(candidate, dir));
}

export interface HostRegateInput { prNumber: number; headCommit: string; repoRoot: string; goalFile?: string; verifyOnly?: boolean; /** TA-LIVE-LAND-2: run the full landing gates (release-path hold · neighbours · PR re-read) but stop before the freeze admission and `gh pr merge` — the task agent lands it later via `pr land --expected-head`. */ noMerge?: true; /** Called by a resume sweep that already holds this PR's claim. */ resumed?: true }
export interface HostRegateResult { passed: boolean; failures: Array<{ step: string; detail: string }>; os: string; status?: 'passed' | 'failed' | 'unmeasured' | 'frozen'; /** verifyOnly: 실제로 얹어 잰 base 끝 */ baseCommit?: string }
export type InterferenceVerdict = { passed: boolean; detail?: string; unmeasured?: boolean; /** neighbour tests left out so the selection fits the inspection cap */ neighborsTrimmed?: number };
export type HostRegateDeps = {
  command?: (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
  interference?: (files: readonly string[], cwd: string) => Promise<InterferenceVerdict>;
  /** Legacy injection for callers that supply an ephemeral worktree instead of a locked slot. */
  makeTemp?: () => string;
  removeTemp?: (path: string) => void;
  acquire?: (repoRoot: string) => Promise<() => void>;
  log?: (event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => void;
  freezeRoot?: string;
  /** Test seam for the operational freeze authority; production always uses the host root. */
  prodFreezeRoot?: string;
  runExposeGate?: typeof runExposeGate;
  syncMergedChecklist?: typeof import('../release-loop/merged-pr-checklist.js').syncMergedPrChecklist;
};

const SPAWN_MAX_BUFFER = 256 * 1024 * 1024;

const defaultCommand: NonNullable<HostRegateDeps['command']> = (bin, args, cwd, env) => {
  // bun ≥1.4 applies Node's 1MB default maxBuffer and silently truncates — test output here is often larger.
  const r = spawnSync(bin, [...args], { cwd, env: env ?? process.env, encoding: 'utf8', timeout: 600_000, maxBuffer: SPAWN_MAX_BUFFER });
  const overflow = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
  return { status: overflow ? null : r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `${r.error.message} (${overflow ? `output exceeded ${SPAWN_MAX_BUFFER} bytes` : 'command unavailable'})` : '') };
};

/** The informational pr-land gate always returns zero; enforce its measured report and the combined test result instead. */
export async function defaultInterference(files: readonly string[], cwd: string, opts: { neighbors?: boolean; detect?: typeof detectTestInterference } = {}): Promise<InterferenceVerdict> {
  const tests = [...new Set(files.filter((file) => /\.test\.tsx?$/.test(file)))].sort();
  const changed = new Set(tests);
  const neighbors = new Set<string>();
  // verifyOnly(승인 탭)는 «이 PR 이 바꾼 시험»만 잰다 — 이웃의 기존 실패가 이 PR 을 막지 않게
  //   (2026-09-28 #21239 실측: scripts/lib 이웃 9 · nl-routing-measurement 기존 1 fail).
  if (opts.neighbors !== false) for (const file of tests) {
    for (const sibling of readdirSync(join(cwd, dirname(file)))) {
      const path = join(dirname(file), sibling);
      if (/\.test\.tsx?$/.test(sibling) && !changed.has(path)) neighbors.add(path);
    }
  }
  // 이웃이 간섭 관문의 상한(MAX_INSPECTED_TEST_FILES)을 넘기면 그 관문이 잘라 «영영 측정 불가»가 된다
  //   (2026-10-08 #25180·#25187 실측: src/self-implement 시험 175 · src/seat-loop 11). 바뀐 시험은 전부 두고 남는 칸만 이웃으로 채운다.
  //   바뀐 시험만으로 상한을 넘으면 정직하게 «측정 불가»로 남는다.
  const sortedNeighbors = [...neighbors].sort();
  const room = Math.max(0, MAX_INSPECTED_TEST_FILES - tests.length);
  const kept = tests.length > MAX_INSPECTED_TEST_FILES ? sortedNeighbors : sortedNeighbors.slice(0, room);
  const neighborsTrimmed = sortedNeighbors.length - kept.length;
  const trimmed = neighborsTrimmed > 0 ? { neighborsTrimmed } : {};
  const trimNote = neighborsTrimmed > 0 ? ` · neighbours trimmed ${neighborsTrimmed} to fit inspection cap ${MAX_INSPECTED_TEST_FILES}` : '';
  const selected = [...tests, ...kept].sort();
  if (!selected.length) return { passed: true };
  // 간섭 관문은 시험 파일이 둘 이상일 때만 잰다 — 하나면 간섭이라는 말이 없으니 그 파일을 한 번 돌려 실패 수로 본다.
  if (selected.length === 1) {
    const run = await runBunTest(selected, undefined, cwd);
    const fail = run.signal || run.exitCode === null ? null : parseFailureCount(`${run.stdout}${run.stderr}`);
    if (fail === null) return { passed: false, unmeasured: true, detail: `single test run unmeasured: ${selected[0]}` };
    return fail === 0 ? { passed: true } : { passed: false, detail: `${selected[0]} — ${fail} fail` };
  }
  // The informational pr-land gate always returns zero; its measured report is the verdict.
  let report: Awaited<ReturnType<typeof detectTestInterference>> | undefined;
  await runTestInterferenceGate({
    args: ['--changed-files', ...selected], log: () => {},
    detect: async (paths) => (report = await (opts.detect ?? detectTestInterference)(paths, (batch) => runBunTest(batch, undefined, cwd))),
  });
  if (!report || report.status === 'unmeasurable' || selected.length > report.order.length) return { passed: false, unmeasured: true, ...trimmed, detail: `test interference measurement unavailable or truncated (selected ${selected.length}, changed tests ${tests.length}, cap ${MAX_INSPECTED_TEST_FILES})${trimNote}` };
  if (report.isolatedFailures !== 0 || report.combinedFailures !== 0 || report.status === 'interference') {
    return { passed: false, ...trimmed, detail: `isolated=${report.isolatedFailures}, combined=${report.combinedFailures}, interference=${report.status}${trimNote}` };
  }
  return { passed: true, ...trimmed, ...(trimNote ? { detail: trimNote.slice(3) } : {}) };
}

const SLOT_WAIT_MS = 30 * 60_000;

function slotOwnerAlive(slot: string): boolean {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireSlot(repoRoot: string, opts: { waitMs?: number; pollMs?: number; now?: () => number } = {}): Promise<(() => void) & { worktree: string }> {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (gitDir.status !== 0 || !gitDir.stdout.trim()) throw new Error('git common directory unavailable for host regate lock');
  const root = join(gitDir.stdout.trim(), 'elanous-host-regate');
  mkdirSync(root, { recursive: true });
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? SLOT_WAIT_MS);
  for (;;) {
    for (let i = 0; i < 2; i++) {
      const slot = join(root, `slot-${i}`);
      try {
        mkdirSync(slot);
        writeFileSync(join(slot, 'pid'), String(process.pid));
        return Object.assign(() => rmSync(slot, { recursive: true, force: true }), { worktree: join(root, `worktree-${i}`) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A slot left by a crashed host process would otherwise block every later run.
        // A slot without a pid file yet may be mid-acquire; only reclaim once its owner is known dead.
        if (existsSync(join(slot, 'pid')) && !slotOwnerAlive(slot)) {
          rmSync(slot, { recursive: true, force: true });
          debug.log('harness.host-regate', 'slot-reclaimed', { slot: `slot-${i}` });
        }
      }
    }
    if (now() >= deadline) throw new Error(`host regate slots busy for ${Math.round((opts.waitMs ?? SLOT_WAIT_MS) / 60_000)}m`);
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 250));
  }
}

function removeBrokenSlotRegistration(repoRoot: string, worktree: string): void {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (gitDir.status !== 0 || !gitDir.stdout.trim()) throw new Error('git common directory unavailable for slot repair');
  const registrations = join(gitDir.stdout.trim(), 'worktrees');
  if (!existsSync(registrations)) return;
  for (const name of readdirSync(registrations)) {
    const registration = join(registrations, name);
    if (!lstatSync(registration).isDirectory()) continue;
    const pointer = join(registration, 'gitdir');
    if (!existsSync(pointer) || lstatSync(pointer).isSymbolicLink()) continue;
    if (resolve(readFileSync(pointer, 'utf8').trim()) !== resolve(worktree, '.git')) continue;
    rmSync(registration, { recursive: true });
  }
}

/** Callers: podSelfImplementSpawn in src/task-orchestrator/surfaces/self-implement-pod.ts calls
 *  (options.hostRegate ?? runHostRegate)({ prNumber, headCommit, repoRoot: hostRoot, ... });
 *  sweepFrozenMerges in frozen-merges.ts also calls runHostRegate(entry); landing queue serialization stays there. */
export async function runHostRegate(input: HostRegateInput, deps: HostRegateDeps = {}): Promise<HostRegateResult> {
  const command = deps.command ?? defaultCommand;
  const log = deps.log ?? ((event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => debug.log('harness.host-regate', event, data));
  const failures: HostRegateResult['failures'] = [];
  let files: string[] = [];
  let base = '';
  let worktree: string | undefined;
  let attached = false;
  let ephemeral = false;
  let slotCommonDir: string | undefined;
  const verifySlot = (): void => {
    if (!worktree || !slotCommonDir || lstatSync(worktree).isSymbolicLink() || !lstatSync(worktree).isDirectory()) throw new Error('slot worktree mismatch');
    const pointer = join(worktree, '.git');
    if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error('slot worktree mismatch');
    const common = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree));
    const registration = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-dir'], worktree));
    if (common !== slotCommonDir || dirname(registration) !== join(slotCommonDir, 'worktrees')
      || resolve(readFileSync(join(registration, 'gitdir'), 'utf8').trim()) !== resolve(pointer)
      || resolve(readFileSync(pointer, 'utf8').trim().replace(/^gitdir: /, '')) !== registration
      || run('git', ['rev-parse', '--show-toplevel'], worktree) !== worktree) throw new Error('slot worktree mismatch');
  };
  let release: (() => void) | undefined;
  let endLanding: ((merged?: boolean) => void) | undefined;
  let landed = false;
  let verifiedBase: string | undefined;
  let interferenceNote: Record<string, unknown> = {};
  const result = (event: 'passed' | 'failed' | 'unmeasured', step?: string, detail?: string): HostRegateResult => {
    if (step) failures.push({ step, detail: detail ?? 'unknown' });
    log(event, { pr: input.prNumber, files, os: process.platform, ...interferenceNote, ...(step ? { failedStep: step, detail: (detail ?? 'unknown').slice(0, 300) } : {}) });
    return { passed: event === 'passed', failures, os: process.platform, ...(input.verifyOnly ? { status: event, ...(verifiedBase ? { baseCommit: verifiedBase } : {}) } : {}) };
  };
  const run = (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string => {
    const r = command(bin, args, cwd, env);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${bin} exited ${r.status}`).trim().slice(0, 300));
    return r.stdout.trim();
  };
  try {
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !/^[0-9a-f]{40}$/i.test(input.headCommit)) return result('unmeasured', 'input', 'invalid PR number or checked head SHA');
    release = await (deps.acquire ?? acquireSlot)(input.repoRoot);
    type PrView = { headRefOid?: string; baseRefName?: string; baseRefOid?: string; state?: string; isDraft?: boolean };
    const readPr = (): PrView => JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'headRefOid,baseRefName,baseRefOid,state,isDraft'], input.repoRoot));
    let view: PrView;
    try { view = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (view.headRefOid !== input.headCommit || view.state !== 'OPEN' || view.isDraft !== false || !view.baseRefName || !/^[0-9a-f]{40}$/i.test(view.baseRefOid ?? '')) return result('unmeasured', 'pr-head', 'PR head, base commit, ready state or open state unavailable or changed');
    const baseRefName = view.baseRefName;
    // verifyOnly(승인 탭): PR 에 기록된 base(baseRefOid)는 main 의 «지금 끝»보다 늙을 수 있다 — 지금 끝에 얹어 잰다.
    let baseCommit = view.baseRefOid!;
    // REGATE-STALE-BASE: GitHub's baseRefOid can stay at the PR-open tip after main moves. After the bounded re-reads the
    // regate measures on the fetched base tip (what the squash merge lands on) and records the stale PR base instead of failing.
    // The closing PR re-read must still show the last PR base seen here (a PR that changed again is not the PR we measured).
    let stalePrBase: string | undefined;
    const initialPrBase = baseCommit;
    let buildPwa = false;
    try {
      run('git', ['fetch', 'origin', `refs/heads/${baseRefName}`], input.repoRoot);
      let fetchedBase = run('git', ['rev-parse', 'FETCH_HEAD'], input.repoRoot);
      if (input.verifyOnly) { baseCommit = fetchedBase; verifiedBase = fetchedBase; }
      else {
        for (let attempt = 1; fetchedBase !== baseCommit; attempt++) {
          debug.log('harness.host-regate', 'base-moved-retry', { pr: input.prNumber, attempt, checked: baseCommit, fetched: fetchedBase });
          if (attempt === 3) {
            stalePrBase = baseCommit;
            debug.log('harness.host-regate', 'base-stale', { pr: input.prNumber, prBaseRefOidInitial: initialPrBase, prBaseRefOid: baseCommit, fetched: fetchedBase, candidateBase: fetchedBase });
            baseCommit = fetchedBase;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          view = readPr();
          if (view.headRefOid !== input.headCommit || view.state !== 'OPEN' || view.isDraft !== false || view.baseRefName !== baseRefName || !/^[0-9a-f]{40}$/i.test(view.baseRefOid ?? '')) {
            return result('unmeasured', 'pr-head', 'PR head, base commit, ready state or open state unavailable or changed');
          }
          baseCommit = view.baseRefOid!;
          run('git', ['fetch', 'origin', `refs/heads/${baseRefName}`], input.repoRoot);
          fetchedBase = run('git', ['rev-parse', 'FETCH_HEAD'], input.repoRoot);
        }
      }
      run('git', ['fetch', 'origin', `refs/pull/${input.prNumber}/head`], input.repoRoot);
      if (run('git', ['rev-parse', 'FETCH_HEAD'], input.repoRoot) !== input.headCommit) throw new Error('fetched PR head differs from checked SHA');
      const slotWorktree = (release as (() => void) & { worktree?: string }).worktree;
      ephemeral = !!deps.makeTemp || !slotWorktree;
      worktree = deps.makeTemp?.() ?? slotWorktree ?? mkdtempSync(join(tmpdir(), 'host-regate-'));
      if (ephemeral && slotWorktree && resolve(worktree) === resolve(slotWorktree)) throw new Error('temporary worktree overlaps locked slot');
      if (!ephemeral && !deps.acquire) {
        slotCommonDir = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], input.repoRoot));
      }
      if (!ephemeral && existsSync(worktree)) {
        if (slotCommonDir) verifySlot();
        attached = true;
        // A previous host may have died mid-merge; never carry its index or untracked files into this run.
        run('git', ['reset', '--hard'], worktree);
        run('git', ['clean', '-fdx', '-e', 'node_modules', '-e', '.next', '-e', '*.tsbuildinfo'], worktree);
        run('git', ['checkout', '--detach', baseCommit], worktree);
      }
      if (!attached) {
        if (!ephemeral && !deps.acquire) removeBrokenSlotRegistration(input.repoRoot, worktree);
        run('git', ['worktree', 'add', '--detach', worktree, baseCommit], input.repoRoot);
        attached = true;
      }
      if (run('git', ['rev-parse', 'HEAD'], worktree) !== baseCommit) throw new Error('worktree base HEAD mismatch');
      base = run('git', ['merge-base', baseCommit, input.headCommit], worktree);
      files = run('git', ['diff', '--name-only', base, input.headCommit], worktree).split('\n').filter(Boolean);
      if (!files.length) throw new Error('changed files unavailable');
      if (!input.verifyOnly) {
        // --name-only lists only the destination of a rename. Inspect both sides without
        // changing the gate's existing changed-file list or its test selection.
        const guardPaths = releaseGitDiffPaths(run('git', ['diff', '--find-renames', '--name-status', '-z', base, input.headCommit], worktree));
        const heldPath = releasePathHold(guardPaths);
        if (heldPath) {
          debug.log('self-dev.merge', 'release-path-hold', { number: input.prNumber, path: heldPath, label: RELEASE_PATH_LABEL, surface: 'host-regate' });
          try {
            const existing: unknown = JSON.parse(run('gh', ['label', 'list', '--search', RELEASE_PATH_LABEL, '--json', 'name'], input.repoRoot));
            if (!Array.isArray(existing)) throw new Error('invalid label list');
            if (!existing.some((item: unknown) => !!item && typeof item === 'object' && 'name' in item && item.name === RELEASE_PATH_LABEL)) {
              run('gh', ['label', 'create', RELEASE_PATH_LABEL, '--color', 'D93F0B', '--description', 'Release path requires OP approval'], input.repoRoot);
            }
            run('gh', ['pr', 'edit', String(input.prNumber), '--add-label', RELEASE_PATH_LABEL], input.repoRoot);
          } catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { number: input.prNumber, action: 'label', error: String(error) }); }
          try { if (releasePathHoldShouldPost(() => JSON.parse(run('gh', releasePathHoldCommentsArgs(input.prNumber), input.repoRoot)))) run('gh', ['pr', 'comment', String(input.prNumber), '--body', releasePathHoldComment(heldPath)], input.repoRoot); }
          catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { number: input.prNumber, action: 'comment', error: String(error) }); }
          return result('failed', 'release-path-hold', `OP approval required: ${heldPath}`);
        }
      }
      // Materialize the proposed merge of this exact PR head into the observed base.
      // A clean head checkout cannot expose integration breaks introduced by the base.
      try { run('git', ['merge', '--no-ff', '--no-commit', input.headCommit], worktree); }
      catch (e) { return result('failed', 'merge-conflict', String(e)); }
      run('git', ['-c', 'user.name=elanous host regate', '-c', 'user.email=regate@localhost', 'commit', '-m', 'host regate integration candidate'], worktree);
      if (run('git', ['rev-parse', 'HEAD^1'], worktree) !== baseCommit || run('git', ['rev-parse', 'HEAD^2'], worktree) !== input.headCommit) throw new Error('integration parents do not match PR base and checked head');
      if (!deps.command && !existsSync(join(worktree, 'scripts/ci-typecheck-changed.ts'))) throw new Error('typecheck gate unavailable in checked worktree');
      // Borrow the source checkout's dependencies only when they are really installed. The daemon's install source can be
      // a temporary checkout whose node_modules is empty or purged; linking it turned every gate into
      // «Cannot find package 'typescript'» (unmeasured · 2026-09-29 #21239). Install into the candidate instead.
      const candidate = worktree;
      const provide = (dir: string, marker: string): void => provideCheckoutDependencies(candidate, input.repoRoot, dir, marker, (cwd) => { run('bun', ['install', '--frozen-lockfile'], cwd); });
      provide('', 'typescript');
      buildPwa = needsPwaBuild(files, worktree);
      if (buildPwa && existsSync(join(worktree, 'apps/pwa'))) provide('apps/pwa', 'next');
    } catch (e) { return result('unmeasured', 'worktree', String(e)); }
    try {
      const interference = await (deps.interference ?? ((f: readonly string[], c: string) => defaultInterference(f, c, { neighbors: !input.verifyOnly })))(files, worktree);
      if (interference.neighborsTrimmed) interferenceNote = { neighborsTrimmed: interference.neighborsTrimmed, interferenceDetail: (interference.detail ?? '').slice(0, 300) };
      if (!interference.passed) return result(interference.unmeasured ? 'unmeasured' : 'failed', 'test-interference', interference.detail);
    } catch (e) { return result('unmeasured', 'test-interference', String(e)); }
    // Landing can also be initiated by the host after the child gate; judge the checked PR here too.
    if (publicExposureFiles(files).length > 0) {
      const exposure = (deps.runExposeGate ?? runExposeGate)(worktree, files,
        getUserConfig().harness?.exposeGate === 'strict' ? 'strict' : 'warn',
        (bin, args, dir) => command(bin, args, dir));
      if (!exposure.passed) return result('failed', 'expose', exposure.log);
    }
    // verifyOnly: 통합 후보는 «지금 main 끝»(baseCommit)에 얹은 것이다 — 옛 merge-base 로 비교하면 그사이 main 착지분
    //   수백 파일이 «이 PR 의 변경»으로 잡혀 저장소 전체 검사로 승격된다(2026-09-28 #21239 실측: 456파일 · PWA 636건).
    try { run('bun', ['scripts/ci-typecheck-changed.ts'], worktree, { ...process.env, TSC_BASE_REF: input.verifyOnly ? baseCommit : base }); }
    catch (e) { return result(String(e).includes('error TS') ? 'failed' : 'unmeasured', 'typecheck', String(e)); }
    // ⛔ 2026-09-28: a Pod landing brought `join(home, '.elanous', …)` into main without this gate, and every human
    //    `pr land` after it failed the isolation gate regardless of its own files (#21336 → #21343).
    if (deps.command || existsSync(join(worktree, 'scripts/ci-isolation-hardcode-gate.ts'))) {
      try { run('bun', ['scripts/ci-isolation-hardcode-gate.ts', '--changed-files', ...files], worktree); }
      catch (e) { return result(/\[isolation-gate\] FAIL/.test(String(e)) ? 'failed' : 'unmeasured', 'isolation-gate', String(e)); }
    }
    if (buildPwa) {
      try { run('bun', ['bin/elanous.mjs', '--test', 'nexus', 'build'], worktree); }
      catch (e) { return result(String(e).includes('command unavailable') ? 'unmeasured' : 'failed', 'nexus-build', String(e)); }
    }
    let current: PrView;
    try { current = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (current.headRefOid !== input.headCommit || current.baseRefName !== baseRefName || (!input.verifyOnly && current.baseRefOid !== (stalePrBase ?? baseCommit)) || current.state !== 'OPEN' || current.isDraft !== false) {
      return result('unmeasured', 'pr-base-changed', 'PR head or base changed during host regate; rerun against the new base');
    }
    // --match-head-commit pins the head. gh has no base pin, so the base was re-read just
    // above; the seconds between that read and the merge are checked after the fact below.
    if (input.verifyOnly) return result('passed');
    // TA-REJUDGE-ON-HEAD — 병합 없는 재게이트는 «잰 base 끝»을 같이 낸다(겹침 증거의 gate.baseCommit).
    if (input.noMerge) return { ...result('passed'), status: 'passed', baseCommit };
    const landing = admitLandingMerge({ prNumber: input.prNumber, headCommit: input.headCommit, repoRoot: input.repoRoot, ...(input.goalFile ? { goalFile: input.goalFile } : {}) }, deps.freezeRoot, {}, input.resumed ? undefined : { prNumber: input.prNumber, repoRoot: input.repoRoot, headCommit: input.headCommit }, { prodFreezeRoot: deps.prodFreezeRoot });
    if (landing.kind !== 'merge') {
      debug.log('harness.merge', 'frozen', { pr: input.prNumber, ...(landing.kind === 'held' ? { reason: landing.freeze.reason, until: landing.freeze.until } : { resumedElsewhere: true }) });
      return { passed: true, failures: [], os: process.platform, status: 'frozen' };
    }
    // The marker and claim are held through the merge «and» its confirmation; released in the outer finally.
    endLanding = landing.end;
    try { run('gh', ['pr', 'merge', String(input.prNumber), '--squash', '--match-head-commit', input.headCommit], input.repoRoot); }
    catch (e) { return result('failed', 'merge', String(e)); }
    type MergedView = { state?: string; mergeCommit?: { oid?: string } | null };
    let merged: MergedView;
    try { merged = JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'state,mergeCommit'], input.repoRoot)); }
    catch (e) { return result('unmeasured', 'merge-confirm', String(e)); }
    if (merged.state !== 'MERGED') return result('unmeasured', 'merge-confirm', `PR state after merge is ${merged.state ?? 'unknown'}`);
    landed = true;
    try {
      const sync = deps.syncMergedChecklist ?? (await import('../release-loop/merged-pr-checklist.js')).syncMergedPrChecklist;
      sync(input.prNumber, input.repoRoot, input.goalFile);
    } catch (error) {
      debug.log('release.checklist', 'merged-pr-sync-failed', { pr: input.prNumber, error: String(error) });
    }
    const mergeCommit = merged.mergeCommit?.oid ?? '';
    let mergedOnto = '';
    try {
      run('git', ['fetch', 'origin', mergeCommit], input.repoRoot);
      mergedOnto = run('git', ['rev-parse', `${mergeCommit}^1`], input.repoRoot);
    } catch (e) {
      // Merged, but the parent could not be read: "unknown" is not "raced".
      log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'merge-parent', mergeCommit: mergeCommit || null, detail: String(e).slice(0, 200) });
    }
    if (mergedOnto && mergedOnto !== baseCommit) {
      log('base-raced', { pr: input.prNumber, files, os: process.platform, checkedBase: baseCommit, mergedOnto, mergeCommit });
    }
    return result('passed');
  } catch (e) {
    return result('unmeasured', 'host-regate', String(e));
  } finally {
    try { endLanding?.(landed); } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'landing-release', detail: String(e) }); }
    try {
      if (attached && worktree) {
        if (slotCommonDir) verifySlot();
        run('git', ['reset', '--hard'], worktree);
        run('git', ['clean', '-fdx', '-e', 'node_modules', '-e', '.next', '-e', '*.tsbuildinfo'], worktree);
      }
    } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    if (ephemeral && worktree) {
      try {
        if (attached) run('git', ['worktree', 'remove', '--force', worktree], input.repoRoot);
      } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
      try {
        if (deps.removeTemp) deps.removeTemp(worktree);
        else rmSync(worktree, { recursive: true, force: true });
      } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    }
    try { release?.(); }
    catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'lock', detail: String(e) }); }
    if (failures.length && failures[0]?.step !== 'release-path-hold') {
      const { step, detail } = failures[0]!;
      const body = `호스트 재게이트 실패(${process.platform}): ${step} — ${detail.replace(/\s+/g, ' ').slice(0, 180)}`;
      try { run('gh', ['pr', 'comment', String(input.prNumber), '--body', body], input.repoRoot); }
      catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'comment', detail: String(e) }); }
    }
  }
}
