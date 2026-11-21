// RELEASE-PARALLEL-CRITPATH-LIVE — the manual critical path REL ran by hand for 0.3.28 and 0.3.29, as one command.
// prepare → (docs-node skipped · web notes ship via a docs PR + deploy-pages after merge) → approval wait.
// A local ledger human marker is unverified until a separate trust root exists, so this command cannot
// enter publish or npm from that marker. Explicit manual release publish is a separate command.
// Every step lands in an append-only ledger
// (<instance>/release/<v>/critpath.json) so a rerun skips what is already done and the run is its own evidence.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publicWaiverReason } from './known-issues-node.js';

export type CritpathStep = 'prepare' | 'approval' | 'publish' | 'npm' | 'verify';
export type CritpathOutcome = 'ok' | 'skipped' | 'dry-run' | 'waiting-approval' | 'staged' | 'fail';
export interface CritpathLedgerEntry { step: CritpathStep; cmd: string; outcome: CritpathOutcome; at: string; sha?: string; detail?: string }
export interface CritpathLedger { version: string; binding?: ApprovalBinding; waiveReason?: string; entries: CritpathLedgerEntry[] }

/** What a human approves: exactly this version, cut commit and notes body. Anything else needs a new card. */
export interface ApprovalBinding { version: string; cutSha: string; notesSha256: string }
export type ApprovalState = { state: 'approved'; id: string } | { state: 'pending'; id: string } | { state: 'unverified'; id: string } | { state: 'declined'; id: string } | { state: 'none' };
/** The slice of a decision-ledger entry the approval check reads (src/decisions/decision-ledger.ts DecisionEntry). */
export interface ApprovalRecord { id: string; refs?: string[]; status: string; choice?: string; decidedBy?: { kind: string } }

export const APPROVE_OPTION = 'a';
/** Distinct from failure (1): the run is healthy and waits for a human publish decision. 75 = EX_TEMPFAIL (sysexits.h). */
export const CRITPATH_WAITING_EXIT = 75;

export function approvalRef(b: ApprovalBinding): string {
  return `release-critpath/${b.version}/${b.cutSha}/${b.notesSha256}`;
}

/** A ledger human marker has no out-of-band proof and cannot authorize an irreversible step. */
export function approvalState(records: readonly ApprovalRecord[], b: ApprovalBinding): ApprovalState {
  const ref = approvalRef(b);
  const entry = records.filter((r) => r.refs?.includes(ref)).at(-1);
  if (!entry) return { state: 'none' };
  if (entry.status === 'open') return { state: 'pending', id: entry.id };
  // The ledger is writable by the same account as a seat. Until an out-of-band
  // trust root exists, even a human marker is a claim, never release authority.
  if (entry.status === 'decided' && entry.choice === APPROVE_OPTION && entry.decidedBy?.kind === 'human')
    return { state: 'unverified', id: entry.id };
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
  requestApproval(b: ApprovalBinding, waiveReason?: string): { id: string };
  now?: () => Date;
  log?: (line: string) => void;
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
  const fail = (step: CritpathStep, cmd: string, detail: string, sha?: string): CritpathResult => {
    record(step, cmd, 'fail', sha, detail);
    const resume = `fix the cause, then rerun from ${step} (done steps are skipped): ${rerun}`;
    log(`⛔ stopped at ${step}\n   command: ${cmd}\n   resume:  ${resume}`);
    return { status: 'failed', exitCode: 1, step, cmd, resume, ledger: o.ledgerPath };
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ').slice(0, 500);

  // ① prepare — the cut is a commit, never a branch name: --branch resolves to the commit origin/release/<v> points to
  // now, so a branch that moved after prepare (recover/append) is never published from the old prepare or old approval.
  let cut = source;
  if (o.branch) {
    const resolveCmd = `git fetch origin ${o.branch} && git rev-parse ${source}`;
    let resolved: string;
    try { resolved = deps.resolveBranch(o.branch).trim().toLowerCase(); }
    catch (e) { return fail('prepare', resolveCmd, message(e)); }
    if (!/^[0-9a-f]{40}$/.test(resolved)) return fail('prepare', resolveCmd, `${source} did not resolve to a 40-hex commit: ${resolved.slice(0, 80)}`);
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
    const approval = approvalState(deps.approvalRecords(), binding);
    const remaining = [rerun, verifyCmd, 'bun website/scripts/deploy-pages.ts --remote <host> --yes   # after the docs PR merges'];
    log(`· approval ${approval.state} for v${o.version} cut ${binding.cutSha} notes sha256 ${binding.notesSha256}`);
    log(`dry run — nothing was published. Remaining:\n${remaining.map((c) => `   ${c}`).join('\n')}`);
    return { status: 'dry-run', exitCode: 0, approval, remaining, ledger: o.ledgerPath };
  }

  // ② approval — only while an irreversible step is still ahead.
  if (!releaseExists || (!npmDone && !npmStaged)) {
    const approvalCmd = `approval record ${approvalRef(binding)}`;
    const approval = approvalState(deps.approvalRecords(), binding);
    if (approval.state === 'declined') return fail('approval', approvalCmd, `publish card ${approval.id} was not approved — a changed cut or notes raises a new card`);
    if (approval.state !== 'approved') {
      const card = approval.state === 'pending' || approval.state === 'unverified' ? { id: approval.id } : deps.requestApproval(binding, waiveReason);
      record('approval', approvalCmd, 'waiting-approval', binding.cutSha, `card ${card.id}${approval.state === 'unverified' ? ' · human proof unverified' : ''}`);
      const resume = approval.state === 'unverified'
        ? `decision ${card.id} claims human approval but has no trusted out-of-band proof; automatic critpath publication remains disabled`
        : `card ${card.id} awaits a trusted out-of-band approval; automatic critpath publication remains disabled`;
      log(`⏸ waiting for publish approval\n   version ${o.version} · cut ${binding.cutSha} · notes sha256 ${binding.notesSha256}${waiveReason ? `\n   waiver: ${waiveReason}` : ''}\n   ${resume}`);
      return { status: 'waiting-approval', exitCode: CRITPATH_WAITING_EXIT, step: 'approval', cmd: approvalCmd, resume, approval: approval.state === 'unverified' ? approval : { state: 'pending', id: card.id }, ledger: o.ledgerPath };
    }
    record('approval', approvalCmd, 'ok', binding.cutSha, `card ${approval.id}`);
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
  return { status: 'done', exitCode: 0, ledger: o.ledgerPath };
}
