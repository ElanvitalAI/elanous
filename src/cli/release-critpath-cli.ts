// `elanous release critpath` — wires the existing release commands into scripts/release-loop/critpath.ts.
// Nothing here reimplements publish or npm: prepare/publish/verify are release-cli's functions, npm is npm-publish-node.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { APPROVE_OPTION, approvalRef, type ApprovalBinding, type CritpathDeps, type PreparedRelease } from '../../scripts/release-loop/critpath.js';
import type { RaiseInput } from '../decisions/decision-ledger.js';

function sha1File(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

/** The OP publish card (decision ledger · category publish). Its ref binds version · cut · notes sha256. */
export function critpathApprovalCard(b: ApprovalBinding, waiveReason?: string): RaiseInput {
  return {
    title: `Publish elanous v${b.version} via the manual critical path`,
    category: 'publish',
    scqa: {
      s: `v${b.version} is prepared from cut ${b.cutSha.slice(0, 12)} with notes sha256 ${b.notesSha256.slice(0, 12)}; publishing it cannot be undone.`,
      c: (waiveReason ? `Waiver: ${waiveReason}` : 'Publishing pushes the public repo, creates the GitHub release and publishes npm.').slice(0, 240),
    },
    options: [
      { key: APPROVE_OPTION, label: `Publish v${b.version}`, consequence: 'release critpath continues with publish, npm and verify on its next run.' },
      { key: 'b', label: 'Hold', consequence: 'Nothing is published; a changed cut or notes raises a new card.' },
    ],
    recommendation: { skipped: true, reason: 'Irreversible publication needs a human decision; it cannot be undone.' },
    raisedBy: { agent: 'release-critpath' },
    refs: [approvalRef(b)],
  };
}

export async function defaultCritpathDeps(log: (line: string) => void): Promise<CritpathDeps> {
  const cli = await import('./release-cli.js');
  const { fetchNpmRegistry, runNpmPublish } = await import('../../scripts/release-loop/npm-publish-node.js');
  const { prereleaseKind } = await import('../../scripts/release-loop/release-version.js');
  const { DecisionLedger } = await import('../decisions/decision-ledger.js');
  const readPrepared = (dir: string): PreparedRelease | null => {
    if (!existsSync(join(dir, 'release.json'))) return null;
    const m = cli.readManifest(dir);
    const tgz = join(m.distDir, 'elanous.tgz');
    const checksumsOk = existsSync(tgz) && cli.verifyChecksums(m.distDir).length === 0;
    return { dir, version: m.version, tag: m.tag, publicRepo: m.publicRepo, sourceRef: m.sourceRef, sourceCommit: m.sourceCommit,
      publicCommit: m.publicCommit, tgz, tgzSha1: existsSync(tgz) ? sha1File(tgz) : '', e2eOk: m.e2e.ran && m.e2e.ok === true, checksumsOk };
  };
  // The repo the release commands run from (same default as prepareRelease's repoRoot).
  const repoRoot = resolve(join(import.meta.dir, '..', '..'));
  return {
    readPrepared,
    resolveBranch: (branch) => {
      // Explicit refspec: the remote-tracking ref itself moves, so prepare's `origin/<branch>` checkout sees the same commit.
      const fetched = cli.defaultRunner('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], repoRoot);
      if (fetched.status !== 0) throw new Error(`git fetch origin ${branch} failed: ${(fetched.stderr || fetched.stdout).trim().slice(-300)}`);
      const parsed = cli.defaultRunner('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], repoRoot);
      if (parsed.status !== 0) throw new Error(`git rev-parse origin/${branch} failed: ${(parsed.stderr || parsed.stdout).trim().slice(-300)}`);
      return parsed.stdout.trim();
    },
    prepare: async ({ version, source, out }) => {
      await cli.prepareRelease({ version, source, out, log });
      const prepared = readPrepared(out);
      if (!prepared) throw new Error(`prepare finished without ${out}/release.json`);
      return prepared;
    },
    githubReleaseExists: (tag, repo) => cli.defaultRunner('gh', ['release', 'view', tag, '--repo', repo], process.cwd()).status === 0,
    publish: async ({ dir, notesFile, yes }) => { await cli.publishRelease({ dir, notesFile, yes, log }); },
    npmRegistry: async (version) => {
      const r = await fetchNpmRegistry(`https://registry.npmjs.org/elanous/${version}`);
      if (r.status === 404) return { visible: false };
      if (r.status !== 200) throw new Error(`npm registry returned ${r.status}`);
      const dist = (r.body as { dist?: { shasum?: string } } | null)?.dist;
      return { visible: true, shasum: dist?.shasum };
    },
    npmDryRun: (tgz, version) => {
      // An empty per-run npmrc: no token, and the user's/global npm config is never read or written.
      const dir = mkdtempSync(join(tmpdir(), 'critpath-npmrc-'));
      try {
        const npmrc = join(dir, 'npmrc');
        writeFileSync(npmrc, '', { mode: 0o600 });
        const tag = prereleaseKind(version) === null ? 'latest' : 'next';
        const r = cli.defaultRunner('npm', ['publish', tgz, '--dry-run', '--ignore-scripts', '--tag', tag, '--access', 'public', '--loglevel', 'warn'], dir,
          { env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } });
        return { ok: r.status === 0, detail: `npm publish --dry-run rc=${r.status} ${(r.stderr || r.stdout).trim().slice(-300)}` };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    npmPublish: async ({ version, tgz }) => {
      const r = await runNpmPublish({ input: { version, previousVersion: '' }, outputs: { publish: { outcome: 'ok' }, prepare: { candidate: tgz } } });
      return { ok: r.outcome === 'ok', npm: r.npm, summary: r.summary };
    },
    verify: async (version, repo) => {
      const r = await cli.verifyRelease({ version, publicRepo: repo, log });
      return { ok: r.ok, summary: `verify ${r.ok ? 'ok' : 'fail'} · ${r.versionLine || '-'} · notesPage ${r.notesPage ?? '-'}${r.error ? ` · ${r.error}` : ''}` };
    },
    approvalRecords: () => new DecisionLedger().list({ status: 'all' }),
    requestApproval: (b: ApprovalBinding, waiveReason?: string) => {
      const ref = approvalRef(b);
      const entry = new DecisionLedger().raiseOnce(critpathApprovalCard(b, waiveReason), ref);
      return { id: entry.id };
    },
    log,
  };
}

export function registerReleaseCritpathCommand(release: Command, depsFactory: (log: (line: string) => void) => Promise<CritpathDeps> = defaultCritpathDeps): void {
  release.command('critpath')
    .description('수동 크리티컬 패스 한 명령 — prepare → (docs-node 생략) → OP 승인 기록 → publish → npm → verify. 승인 카드 없으면 publish 직전에 멈춘다(rc 75). 끝난 단계는 건너뛴다')
    .requiredOption('--version <x.y.z>', '릴리스 판')
    .requiredOption('--notes-file <md>', '공개 릴리스 본문(승인은 이 파일의 sha256 에 묶인다)')
    .option('--cut-commit <sha>', '컷 커밋(40자) — --branch 와 둘 중 하나')
    .option('--branch <release/v>', 'release/<v> 가지(origin)')
    .option('--waive-reason <text>', '공개 면제 사유 — known-issues 공개 문구 규칙을 통과해야 한다')
    .option('--dry-run', 'prepare + publish 미리보기 + npm --dry-run 만 · 아무것도 공개하지 않고 승인 카드도 올리지 않는다')
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version: string; notesFile: string; cutCommit?: string; branch?: string; waiveReason?: string; dryRun?: boolean; json?: boolean }) => {
      const log = o.json ? (l: string) => console.error(l) : (l: string) => console.log(l);
      const { runCritpath } = await import('../../scripts/release-loop/critpath.js');
      const dir = join(effectiveInstanceRoot(), 'release', o.version);
      try {
        const deps = await depsFactory(log);
        const r = await runCritpath({ version: o.version, notesFile: resolve(o.notesFile), cutCommit: o.cutCommit, branch: o.branch, waiveReason: o.waiveReason,
          dryRun: o.dryRun, out: join(dir, 'critpath-prepared'), ledgerPath: join(dir, 'critpath.json') }, deps);
        if (o.json) process.stdout.write(`${JSON.stringify({ ok: r.status === 'done' || r.status === 'dry-run', ...r })}\n`);
        process.exitCode = r.exitCode;
      } catch (e) {
        if (o.json) process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
        else console.error(`⛔ ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
