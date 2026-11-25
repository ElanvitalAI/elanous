// RELEASE-PARALLEL-CRITPATH-LIVE — the manual critical path REL ran by hand for 0.3.28 and 0.3.29, as one command.
// prepare → (docs-node skipped · web notes ship via a docs PR + deploy-pages after merge) → approval wait.
// A local ledger human marker is unverified until a separate trust root exists, so this command cannot
// enter publish or npm from that marker. Explicit manual release publish is a separate command.
// RELEASE-AUTO-PUBLISH: only when the owner opts in (`release.autoPublish: "on-green"`) and every green condition holds for
// this exact cut + notes (autoPublishBlockers) does critpath record an AUTO decision (release-auto) and continue; off = unchanged.
// Every step lands in an append-only ledger
// (<instance>/release/<v>/critpath.json) so a rerun skips what is already done and the run is its own evidence.
import { createHash } from 'node:crypto';
import { verifyHumanApprovalProof, type DecisionTrustRoot, type HumanProof } from '../../src/decisions/decision-ledger.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publicWaiverReason } from './known-issues-node.js';
import { debug } from '../../src/debug/log.js';

export type CritpathStep = 'prepare' | 'approval' | 'publish' | 'npm' | 'verify';
export type CritpathOutcome = 'ok' | 'skipped' | 'dry-run' | 'waiting-approval' | 'staged' | 'fail';
export interface CritpathLedgerEntry { step: CritpathStep; cmd: string; outcome: CritpathOutcome; at: string; sha?: string; detail?: string }
/** A dry run that reached its end green for exactly this cut + notes (prepare · install e2e · publish preview · npm --dry-run). */
export interface DryRunPass { cutSha: string; notesSha256: string; tgzSha1: string; at: string }
export interface CritpathLedger { version: string; binding?: ApprovalBinding; waiveReason?: string; dryRunPass?: DryRunPass; entries: CritpathLedgerEntry[] }

/** What a human approves: exactly this version, cut commit and notes body. Anything else needs a new card. */
export interface ApprovalBinding { version: string; cutSha: string; notesSha256: string }
export type ApprovalState = { state: 'approved'; id: string } | { state: 'auto'; id: string } | { state: 'pending'; id: string } | { state: 'unverified'; id: string } | { state: 'declined'; id: string } | { state: 'none' };
/** The slice of a decision-ledger entry the approval check reads (src/decisions/decision-ledger.ts DecisionEntry). */
export interface ApprovalRecord { id: string; refs?: string[]; status: string; choice?: string; decidedBy?: { kind: string; agent?: string }; proof?: HumanProof }

export const APPROVE_OPTION = 'a';
/** Distinct from failure (1): the run is healthy and waits for a human publish decision. 75 = EX_TEMPFAIL (sysexits.h). */
export const CRITPATH_WAITING_EXIT = 75;
/** RELEASE-AUTO-PUBLISH — the only agent whose AUTO decision on the publish card counts, and only while the owner opted in. */
export const AUTO_PUBLISH_AGENT = 'release-auto';
/** A green dry run older than this does not authorize an automatic publish. */
export const AUTO_PUBLISH_DRY_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function approvalRef(b: ApprovalBinding): string {
  return `release-critpath/${b.version}/${b.cutSha}/${b.notesSha256}`;
}

/** A ledger human marker alone authorizes nothing: only a trust-root signature over this exact binding, verified out of band, approves. */
export function approvalState(records: readonly ApprovalRecord[], b: ApprovalBinding, trustRoots?: readonly DecisionTrustRoot[]): ApprovalState {
  const ref = approvalRef(b);
  const entry = records.filter((r) => r.refs?.includes(ref)).at(-1);
  if (!entry) return { state: 'none' };
  if (entry.status === 'open') return { state: 'pending', id: entry.id };
  // The ledger is writable by the same account as a seat. A human marker stays a claim
  // until a trust-root signature over this exact binding proves it out of band.
  if (entry.status === 'decided' && entry.choice === APPROVE_OPTION && entry.decidedBy?.kind === 'human')
    return verifyHumanApprovalProof(ref, entry.proof, trustRoots) ? { state: 'approved', id: entry.id } : { state: 'unverified', id: entry.id };
  // An AUTO record is not approval by itself: runCritpath re-checks the owner switch and every green condition on each run.
  if (entry.status === 'decided' && entry.choice === APPROVE_OPTION && entry.decidedBy?.kind === 'auto' && entry.decidedBy.agent === AUTO_PUBLISH_AGENT)
    return { state: 'auto', id: entry.id };
  return { state: 'declined', id: entry.id };
}

export interface PreparedRelease { dir: string; version: string; tag: string; publicRepo: string; sourceRef: string; sourceCommit: string; publicCommit: string; tgz: string; tgzSha1: string; e2eOk: boolean; checksumsOk: boolean }
export interface NpmState { visible: boolean; shasum?: string }

/** Every side effect is injected — the CLI wires the real `release prepare/publish/verify` and npm-publish-node. */
export interface CritpathDeps {
  readPrepared(dir: string): PreparedRelease | null;
  /** Fetch origin/<branch> and return the 40-hex commit it points to now (git fetch + rev-parse). */
  resolveBranch(branch: string): string;
  prepare(input: { version: string; source: string; out: string }): Promise<PreparedRelease>;
  githubReleaseExists(tag: string, repo: string): boolean;
  publish(input: { dir: string; notesFile: string; yes: boolean }): Promise<void>;
  npmRegistry(version: string): Promise<NpmState>;
  npmDryRun(tgz: string, version: string): { ok: boolean; detail: string };
  npmPublish(input: { version: string; tgz: string }): Promise<{ ok: boolean; npm?: string; summary: string }>;
  verify(version: string, repo: string): Promise<{ ok: boolean; summary: string }>;
  approvalRecords(): ApprovalRecord[];
  /** Trust-root public keys for out-of-band human approval proofs; absent = every human marker stays unverified. */
  trustRoots?: () => readonly DecisionTrustRoot[];
  requestApproval(b: ApprovalBinding, waiveReason?: string): { id: string };
  /** RELEASE-AUTO-PUBLISH — owner opt-in seam (`release.autoPublish: "on-green"`). Absent or mode 'off' = the card waits for a human. */
  autoPublish?: AutoPublishDeps;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface AutoPublishDeps {
  mode(): 'off' | 'on-green';
  /** 🔴 (critical) checklist items for the version. */
  redCount(version: string): number | Promise<number>;
  /** Open HOLD decisions for the version (ids). */
  openHolds(version: string): string[] | Promise<string[]>;
  /** Record the publish choice on the card as an AUTO decision (actor release-auto). */
  decide(cardId: string, reason: string): void;
  /** After-the-fact report to the owner (OP mail · CEO channel). Failure never blocks the release. */
  notify(body: string): void;
}

/** Why an automatic publish is not allowed now; empty = every green condition holds for this exact cut + notes. */
export function autoPublishBlockers(input: { version: string; binding: ApprovalBinding; preparedCommit: string; branchHead: string | Error; dryRunPass?: DryRunPass; now: Date; redCount: number | Error; openHolds: string[] | Error }): string[] {
  const reasons: string[] = [];
  const dry = input.dryRunPass;
  if (!dry) reasons.push('no green dry run recorded');
  else if (dry.cutSha !== input.binding.cutSha || dry.notesSha256 !== input.binding.notesSha256) reasons.push(`dry run was for another cut/notes (cut ${dry.cutSha.slice(0, 12)} · notes ${dry.notesSha256.slice(0, 12)})`);
  else {
    const age = input.now.getTime() - Date.parse(dry.at);
    if (!(age >= 0 && age <= AUTO_PUBLISH_DRY_RUN_MAX_AGE_MS)) reasons.push(`dry run stale (${dry.at} · max 6h)`);
  }
  if (input.branchHead instanceof Error) reasons.push(`branch-read-failed: ${input.branchHead.message.slice(0, 120)}`);
  else if (input.branchHead !== input.preparedCommit) reasons.push(`cut branch head moved: release/${input.version} ${input.branchHead.slice(0, 12)} ≠ prepared ${input.preparedCommit.slice(0, 12)}`);
  if (input.redCount instanceof Error) reasons.push(`checklist unreadable: ${input.redCount.message.slice(0, 120)}`);
  else if (input.redCount > 0) reasons.push(`checklist 🔴 ${input.redCount}`);
  if (input.openHolds instanceof Error) reasons.push(`decisions unreadable: ${input.openHolds.message.slice(0, 120)}`);
  else if (input.openHolds.length) reasons.push(`open HOLD decision ${input.openHolds.join(', ')}`);
  return reasons;
}

export interface CritpathOptions {
  version: string;
  notesFile: string;
  cutCommit?: string;
  branch?: string;
  waiveReason?: string;
  dryRun?: boolean;
  /** Prepared output folder (default <instance>/release/<v>/critpath-prepared). */
  out: string;
  /** Ledger path (default <instance>/release/<v>/critpath.json). */
  ledgerPath: string;
}

export interface CritpathResult { status: 'done' | 'dry-run' | 'waiting-approval' | 'failed'; exitCode: number; step?: CritpathStep; cmd?: string; resume?: string; approval?: ApprovalState; remaining?: string[]; ledger: string }

function readLedger(path: string, version: string): CritpathLedger {
  if (!existsSync(path)) return { version, entries: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CritpathLedger;
  if (parsed.version !== version || !Array.isArray(parsed.entries)) throw new Error(`critpath ledger ${path} belongs to another version`);
  return parsed;
}

function writeLedger(path: string, ledger: CritpathLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Pin the notes bytes the approval is bound to: publish reads this 0600 copy, never the editable source file again. */
function pinNotes(notesFile: string, ledgerPath: string): { sha256: string; path: string } {
  const bytes = readFileSync(notesFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = join(dirname(ledgerPath), `critpath-notes.${sha256}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return { sha256, path };
}

/** One rerun line: the same command — done steps are skipped from the ledger and the live state. */
export function critpathCommand(o: Pick<CritpathOptions, 'version' | 'notesFile' | 'cutCommit' | 'branch' | 'waiveReason' | 'dryRun'>): string {
  return ['elanous release critpath', `--version ${o.version}`, `--notes-file ${o.notesFile}`,
    o.cutCommit ? `--cut-commit ${o.cutCommit}` : `--branch ${o.branch}`,
    ...(o.waiveReason ? [`--waive-reason ${JSON.stringify(o.waiveReason)}`] : []), ...(o.dryRun ? ['--dry-run'] : [])].join(' ');
}

export async function runCritpath(o: CritpathOptions, deps: CritpathDeps): Promise<CritpathResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(o.version)) throw new Error(`not a release version: ${o.version}`);
  if (Boolean(o.cutCommit) === Boolean(o.branch)) throw new Error('give exactly one of --cut-commit <sha> or --branch release/<v>');
  if (o.cutCommit && !/^[0-9a-f]{40}$/i.test(o.cutCommit)) throw new Error(`--cut-commit must be a full 40-hex commit: ${o.cutCommit}`);
  if (o.branch && o.branch !== `release/${o.version}`) throw new Error(`--branch must be release/${o.version}: ${o.branch}`);
  // The waiver text is public: same rule as known-issues-node (no fixed/resolved/no longer/addressed, no internal markers).
  const waiveReason = o.waiveReason === undefined ? undefined : publicWaiverReason(o.waiveReason);
  if (!existsSync(o.notesFile)) throw new Error(`notes file missing: ${o.notesFile}`);
  const source = o.cutCommit ? o.cutCommit.toLowerCase() : `origin/${o.branch}`;
  const rerun = critpathCommand({ ...o, dryRun: false });
  const ledger = readLedger(o.ledgerPath, o.version);
  const prepareCmd = `elanous release prepare --version ${o.version} --source ${source} --out ${o.out}`;
  if (waiveReason) ledger.waiveReason = waiveReason;
  const record = (step: CritpathStep, cmd: string, outcome: CritpathOutcome, sha?: string, detail?: string) => {
    ledger.entries.push({ step, cmd, outcome, at: now().toISOString(), ...(sha ? { sha } : {}), ...(detail ? { detail } : {}) });
    writeLedger(o.ledgerPath, ledger);
    log(`${outcome === 'fail' ? '✗' : outcome === 'waiting-approval' ? '⏸' : '✓'} ${step} · ${outcome}${detail ? ` · ${detail}` : ''}`);
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ').slice(0, 500);
  // RELEASE-AUTO-PUBLISH — set once an AUTO decision approved this run: the owner then always hears the result (done or the stop step).
  let autoReport: string | undefined;
  const report = (r: CritpathResult): CritpathResult => {
    if (!autoReport || !deps.autoPublish) return r;
    const body = r.status === 'done'
      ? `auto-published v${o.version} · cut ${(ledger.binding?.cutSha ?? '').slice(0, 12)} · checks ${autoReport}`
      : `auto-publish v${o.version} approved on green but stopped at ${r.step ?? '?'} · ${r.resume ?? ''} · checks ${autoReport}`;
    try { deps.autoPublish.notify(body); }
    catch (e) { debug.log('release.auto-publish', 'notify-failed', { version: o.version, reason: message(e) }); log(`· release.auto-publish notify failed: ${message(e)}`); }
    return r;
  };
  const fail = (step: CritpathStep, cmd: string, detail: string, sha?: string): CritpathResult => {
    record(step, cmd, 'fail', sha, detail);
    const resume = `fix the cause, then rerun from ${step} (done steps are skipped): ${rerun}`;
    log(`⛔ stopped at ${step}\n   command: ${cmd}\n   resume:  ${resume}`);
    return report({ status: 'failed', exitCode: 1, step, cmd, resume, ledger: o.ledgerPath });
  };

  // ① prepare — the cut is a commit, never a branch name: --branch resolves to the commit origin/release/<v> points to
  // now, so a branch that moved after prepare (recover/append) is never published from the old prepare or old approval.
  let cut = source;
  if (o.branch) {
    const resolveCmd = `git fetch origin ${o.branch} && git rev-parse ${source}`;
    let resolved: string;
    let readError: string | undefined;
    try { resolved = deps.resolveBranch(o.branch).trim().toLowerCase(); }
    catch (e) { resolved = ''; readError = message(e); }
    if (!readError && !/^[0-9a-f]{40}$/.test(resolved)) readError = `${source} did not resolve to a 40-hex commit: ${resolved.slice(0, 80)}`;
    if (readError) {
      // RELEASE-AUTO-PUBLISH (Terra #40028): with the owner switch on, an unreadable cut branch is a red check — the
      // release waits (rc 75) with the skip reason instead of failing; switch off keeps the failure exactly as before.
      if (!o.dryRun && deps.autoPublish?.mode() === 'on-green') {
        const reason = `branch-read-failed: ${readError}`;
        debug.log('release.auto-publish', 'skipped', { version: o.version, reason });
        log(`· release.auto-publish skipped {${reason}}`);
        const resume = `cut branch ${o.branch} unreadable; the publish waits — fix the branch read, then rerun: ${rerun}`;
        log(`⏸ waiting for publish approval\n   ${resume}`);
        return { status: 'waiting-approval', exitCode: CRITPATH_WAITING_EXIT, step: 'approval', cmd: resolveCmd, resume, ledger: o.ledgerPath };
      }
      return fail('prepare', resolveCmd, readError);
    }
    cut = resolved;
  }
  const moved = (preparedCommit: string) => fail('prepare', prepareCmd,
    `branch moved: prepared ${preparedCommit} · branch now ${cut} — re-prepare: move ${o.out} aside (e.g. mv ${o.out} ${o.out}.${preparedCommit.slice(0, 12)}), then rerun: ${rerun}`);
  let prepared = deps.readPrepared(o.out);
  if (prepared) {
    if (prepared.version === o.version && o.branch && prepared.sourceRef === source && prepared.sourceCommit !== cut) return moved(prepared.sourceCommit);
    if (prepared.version !== o.version || prepared.sourceCommit !== cut) return fail('prepare', prepareCmd, `${o.out} holds another prepare (${prepared.version} @ ${prepared.sourceCommit.slice(0, 12)}) — move it aside`);
    if (!prepared.e2eOk || !prepared.checksumsOk) return fail('prepare', prepareCmd, `${o.out} is not a clean prepare (e2e ${prepared.e2eOk} · checksums ${prepared.checksumsOk}) — move it aside`);
    record('prepare', prepareCmd, 'skipped', prepared.sourceCommit, 'already prepared');
  } else {
    try { prepared = await deps.prepare({ version: o.version, source, out: o.out }); }
    catch (e) { return fail('prepare', prepareCmd, message(e)); }
    // The branch can move between the resolve and prepare's own fetch: the prepare must be of the resolved commit.
    if (prepared.sourceCommit !== cut) return o.branch ? moved(prepared.sourceCommit) : fail('prepare', prepareCmd, `prepare produced ${prepared.sourceCommit} ≠ cut ${cut}`);
    record('prepare', prepareCmd, 'ok', prepared.sourceCommit);
  }
  log('· docs-node skipped (it requires an upgrade-ok graph output) — web notes: docs PR, then after merge `bun website/scripts/deploy-pages.ts --remote <host> --yes`');

  const notes = pinNotes(o.notesFile, o.ledgerPath);
  const binding: ApprovalBinding = { version: o.version, cutSha: cut, notesSha256: notes.sha256 };
  ledger.binding = binding;
  const publishCmd = `elanous release publish --dir ${o.out} --notes-file ${notes.path}`;
  const npmCmd = `npm publish ${prepared.tgz} --ignore-scripts --access public --loglevel warn (temp npmrc · npm-publish-node)`;
  const verifyCmd = `elanous release verify --version ${o.version} --public-repo ${prepared.publicRepo}`;

  const releaseExists = deps.githubReleaseExists(prepared.tag, prepared.publicRepo);
  let npm: NpmState;
  try { npm = await deps.npmRegistry(o.version); }
  catch (e) { return fail('npm', npmCmd, `registry read failed: ${message(e)}`); }
  // Never republish over a different archive: a visible version must be byte-identical (sha1 = npm dist.shasum).
  if (npm.visible && npm.shasum !== prepared.tgzSha1) return fail('npm', npmCmd, `npm ${o.version} exists with shasum ${npm.shasum} ≠ prepared ${prepared.tgzSha1} — never republish`);
  const npmDone = npm.visible;
  const npmStaged = !npmDone && ledger.entries.some((e) => e.step === 'npm' && (e.outcome === 'staged' || e.outcome === 'ok') && e.sha === prepared!.tgzSha1);

  if (o.dryRun) {
    if (releaseExists) record('publish', publishCmd, 'skipped', prepared.publicCommit, `release ${prepared.tag} already exists`);
    else {
      try { await deps.publish({ dir: o.out, notesFile: notes.path, yes: false }); }
      catch (e) { return fail('publish', publishCmd, message(e)); }
      record('publish', publishCmd, 'dry-run', prepared.publicCommit);
    }
    if (npmDone) record('npm', npmCmd, 'skipped', prepared.tgzSha1, 'already on the registry with the same shasum');
    else {
      const dry = deps.npmDryRun(prepared.tgz, o.version);
      if (!dry.ok) return fail('npm', `${npmCmd} --dry-run`, dry.detail);
      record('npm', `${npmCmd} --dry-run`, 'dry-run', prepared.tgzSha1);
    }
    if (prepared.e2eOk && prepared.checksumsOk) {
      ledger.dryRunPass = { cutSha: binding.cutSha, notesSha256: binding.notesSha256, tgzSha1: prepared.tgzSha1, at: now().toISOString() };
      writeLedger(o.ledgerPath, ledger);
    }
    const approval = approvalState(deps.approvalRecords(), binding, deps.trustRoots?.());
    const remaining = [rerun, verifyCmd, 'bun website/scripts/deploy-pages.ts --remote <host> --yes   # after the docs PR merges'];
    log(`· approval ${approval.state} for v${o.version} cut ${binding.cutSha} notes sha256 ${binding.notesSha256}`);
    log(`dry run — nothing was published. Remaining:\n${remaining.map((c) => `   ${c}`).join('\n')}`);
    return { status: 'dry-run', exitCode: 0, approval, remaining, ledger: o.ledgerPath };
  }

  // ② approval — only while an irreversible step is still ahead.
  if (!releaseExists || (!npmDone && !npmStaged)) {
    const approvalCmd = `approval record ${approvalRef(binding)}`;
    const approval = approvalState(deps.approvalRecords(), binding, deps.trustRoots?.());
    if (approval.state === 'declined') return fail('approval', approvalCmd, `publish card ${approval.id} was not approved — a changed cut or notes raises a new card`);
    // RELEASE-AUTO-PUBLISH (대표 11-25 «오토파일럿이면 큰 문제 없을 때 이 절차도 생략») — owner opt-in only; any red check keeps the human wait.
    let autoCard: string | undefined;
    if (approval.state !== 'approved' && approval.state !== 'unverified' && deps.autoPublish?.mode() === 'on-green') {
      const ap = deps.autoPublish;
      const attempt = async <T>(f: () => T | Promise<T>): Promise<T | Error> => { try { return await f(); } catch (e) { return e instanceof Error ? e : new Error(String(e)); } };
      // --branch resolved the head this run; --cut-commit still asks where release/<v> points now (a moved branch is not auto-published).
      const branchHead = o.branch ? cut : await attempt(() => deps.resolveBranch(`release/${o.version}`).trim().toLowerCase());
      const blockers = autoPublishBlockers({ version: o.version, binding, preparedCommit: prepared.sourceCommit, branchHead, dryRunPass: ledger.dryRunPass, now: now(),
        redCount: await attempt(() => ap.redCount(o.version)), openHolds: await attempt(() => ap.openHolds(o.version)) });
      if (blockers.length) {
        const reason = blockers.join('; ');
        debug.log('release.auto-publish', 'skipped', { version: o.version, cut: binding.cutSha, reason });
        log(`· release.auto-publish skipped {${reason}}`);
      } else {
        const checks = `dry-run ✓ ${ledger.dryRunPass!.at} (prepare · install · publish preview · npm --dry-run) · checklist 🔴 0 · cut head = prepared ${binding.cutSha.slice(0, 12)} · no open HOLD`;
        const card = approval.state === 'auto' ? { id: approval.id } : approval.state === 'pending' ? { id: approval.id } : deps.requestApproval(binding, waiveReason);
        if (approval.state !== 'auto') {
          try { ap.decide(card.id, `auto-publish on green (release.autoPublish on-green): ${checks}`); }
          catch (e) {
            debug.log('release.auto-publish', 'skipped', { version: o.version, cut: binding.cutSha, reason: `decide failed: ${message(e)}` });
            log(`· release.auto-publish skipped {decide failed: ${message(e)}}`);
          }
        }
        const after = approval.state === 'auto' ? approval : approvalState(deps.approvalRecords(), binding, deps.trustRoots?.());
        if (after.state === 'auto' && after.id === card.id) {
          autoCard = card.id;
          autoReport = checks;
          debug.log('release.auto-publish', 'decided', { version: o.version, cut: binding.cutSha, card: card.id });
        }
      }
    }
    if (autoCard) record('approval', approvalCmd, 'ok', binding.cutSha, `card ${autoCard} · AUTO ${AUTO_PUBLISH_AGENT}`);
    else if (approval.state !== 'approved') {
      const card = approval.state === 'pending' || approval.state === 'unverified' || approval.state === 'auto' ? { id: approval.id } : deps.requestApproval(binding, waiveReason);
      record('approval', approvalCmd, 'waiting-approval', binding.cutSha, `card ${card.id}${approval.state === 'unverified' ? ' · human proof unverified' : ''}`);
      const resume = approval.state === 'unverified'
        ? `decision ${card.id} claims human approval but has no trusted out-of-band proof; automatic critpath publication remains disabled`
        : `card ${card.id} awaits a trusted out-of-band approval; automatic critpath publication remains disabled`;
      log(`⏸ waiting for publish approval\n   version ${o.version} · cut ${binding.cutSha} · notes sha256 ${binding.notesSha256}${waiveReason ? `\n   waiver: ${waiveReason}` : ''}\n   ${resume}`);
      return { status: 'waiting-approval', exitCode: CRITPATH_WAITING_EXIT, step: 'approval', cmd: approvalCmd, resume, approval: approval.state === 'unverified' ? approval : { state: 'pending', id: card.id }, ledger: o.ledgerPath };
    } else record('approval', approvalCmd, 'ok', binding.cutSha, `card ${approval.id}`);
  }

  // ③ publish (public repo push + GitHub release) — an existing release is treated as done, never recreated.
  if (releaseExists) record('publish', publishCmd, 'skipped', prepared.publicCommit, `release ${prepared.tag} already exists`);
  else {
    try { await deps.publish({ dir: o.out, notesFile: notes.path, yes: true }); }
    catch (e) { return fail('publish', `${publishCmd} --yes`, message(e), prepared.publicCommit); }
    record('publish', `${publishCmd} --yes`, 'ok', prepared.publicCommit);
  }

  // ④ npm — PUT 202 means staged (visible ~14–20 min later); a staged version is never published again.
  if (npmDone) record('npm', npmCmd, 'skipped', prepared.tgzSha1, 'already on the registry with the same shasum');
  else if (npmStaged) record('npm', npmCmd, 'staged', prepared.tgzSha1, 'staged earlier — not republished; rerun later to confirm');
  else {
    let result: { ok: boolean; npm?: string; summary: string };
    try { result = await deps.npmPublish({ version: o.version, tgz: prepared.tgz }); }
    catch (e) { return fail('npm', npmCmd, message(e), prepared.tgzSha1); }
    if (!result.ok || result.npm !== 'staged-not-visible') {
      // E409 or a visible publish: done only when the registry holds these exact bytes.
      let after: NpmState;
      try { after = await deps.npmRegistry(o.version); }
      catch (e) { return fail('npm', npmCmd, `${result.summary} · registry read failed: ${message(e)}`, prepared.tgzSha1); }
      if (!after.visible || after.shasum !== prepared.tgzSha1) return fail('npm', npmCmd, result.ok ? `${result.summary} · registry shasum ${after.shasum ?? 'missing'} ≠ ${prepared.tgzSha1}` : result.summary, prepared.tgzSha1);
      record('npm', npmCmd, 'ok', prepared.tgzSha1, result.ok ? result.summary : `E409 — registry already holds the same shasum`);
    } else record('npm', npmCmd, 'staged', prepared.tgzSha1, result.summary);
  }

  // ⑤ verify — read-only; a pass for this public commit is not rerun.
  if (ledger.entries.some((e) => e.step === 'verify' && e.outcome === 'ok' && e.sha === prepared!.publicCommit)) record('verify', verifyCmd, 'skipped', prepared.publicCommit, 'already verified');
  else {
    let verified: { ok: boolean; summary: string };
    try { verified = await deps.verify(o.version, prepared.publicRepo); }
    catch (e) { return fail('verify', verifyCmd, message(e), prepared.publicCommit); }
    if (!verified.ok) return fail('verify', verifyCmd, `${verified.summary} (notes page missing → deploy pages after the docs PR merges)`, prepared.publicCommit);
    record('verify', verifyCmd, 'ok', prepared.publicCommit, verified.summary);
  }
  log(`✅ critpath v${o.version} done — ledger ${o.ledgerPath}`);
  return report({ status: 'done', exitCode: 0, ledger: o.ledgerPath });
}
