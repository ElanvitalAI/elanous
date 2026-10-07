// `elanous release` — 공개 배포 한 판을 «명령»으로 (버전 매뉴얼 내부 문서 `MANUAL-versioning-and-release-2026-09-25` §A).
//
//   elanous release prepare --version <x.y.z[-rc.N]> [--source <ref>] [--out <dir>] [--notes-from <ref>] [--skip-e2e]
//   elanous release publish --dir <prepare 산출> --notes-file <본문> [--yes]
//   elanous release tag --version <x.y.z> --source <commit> [--yes]
//   elanous release verify  [--version <x.y.z>]
//   elanous release notes   --from <ref> [--to <ref>]
//   elanous release run     --version <x.y.z> [--prerelease rc] [--main-cut | --cut-commit <sha>] [--dry-run] [--json] [--if-ready]
//   elanous release resume  --run <runId> --from <node> [--json]   (release/<v> 수리 뒤 새 끝으로 이어 달리기)
//   elanous release auto-start [--window-minutes <n>] [--apply] [--json]
//   elanous release preflight --version <x.y.z> [--publish-at <iso>] [--json]   (컷 30분 전 사전 점검 · 읽기 전용 · ⛔ 있으면 exit 1)
//   elanous release cut-branch --version <x.y.z> --base <sha> --pick <sha>... [--dry-run]
//
// 🩸 계기(2026-09-25 v0.1.0 첫 공개): 손으로 밟은 절차에서 둘을 빠뜨릴 뻔했다 — 공개본 git 커밋(판 커밋이 공개본 커밋이 된다) ·
//    PWA 빌드(빌드 산출은 공개본에 안 실린다 → 빠뜨리면 «웹 화면 없는 판»). 절차를 명령으로 굳힌다.
// ⛔ prepare 는 «네트워크에 아무것도 쓰지 않는다»(공개 저장소를 «읽기»로 clone 만 한다) — 쓰는 것은 publish 뿐이고 `--yes` 가 있어야 한다.
//    공개는 되돌릴 수 없다(그 판은 영구히 공개 라이선스).
// ⛔ 공개본은 «원본 매니페스트»(`release/public-export.yaml`)대로만 만든다 — 매매 실행 코드는 그 매니페스트가 이미 뺀다(🅢 #20529).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { envLiteral } from '../platform/env-literal.js';
import { getUserConfig, userConfigPath } from '../user-config.js';
import { addItem, cellsReferencingDoc, claimItem, decodeClaimHistoryEntry, devVersion, listChecklist, ownerMatches, parseOwner, parityGap, removeItem, renderRefsStatus, seedFromRoadmap, setItem, summarizeChecklist, type ChecklistStatus, type ChecklistDisposition, type ChecklistKind } from '../release-loop/checklist.js';
import * as features from '../release-loop/feature-store.js';
import { evidencePlan, landedButYellow, type MergedChecklistPr } from '../release-loop/landed-but-yellow.js';
import { formatSchedule, getSchedule, listSchedules, setSchedule } from '../release-loop/release-schedule.js';
import { placeCell, rebalance, seatMove, type PlacementPriority } from '../release-loop/placement.js';
import { parseRubric, readRubricItems, rubricGrade, rubricScore } from '../release-loop/rubric.js';
import { writeStdoutJson } from './stdout-json.js';
import { CliUserError } from './cli-user-error.js';
import { hqCliWriteAllowed, type HqDeps } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';
import { runUnattendedRelease, type UnattendedReleaseDeps } from '../../scripts/release-loop/unattended-release.js';
import { cutReleaseBranch } from '../../scripts/release-loop/cut-branch.js';
import { resumeReleaseRun } from '../../scripts/release-loop/resume-release.js';
import type { PrereleaseKind } from '../../scripts/release-loop/release-version.js';
import { releaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { runReleaseIfReady } from './release-run-if-ready.js';
import { formatPreflight, releasePreflight } from '../../scripts/release-loop/preflight.js';
import { autoStartScheduledRelease, type AutoStartDeferral } from '../release-loop/auto-start.js';
import { landingFreezeMessage, LandingFrozenError, readLandingFreeze } from '../release-loop/landing-freeze.js';

export const DEFAULT_PUBLIC_REPO = 'ElanvitalAI/elanous';
const SEMVER = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;

export interface RunResult { status: number | null; stdout: string; stderr: string }
export type Runner = (command: string, args: readonly string[], cwd: string, opts?: { env?: NodeJS.ProcessEnv; input?: string }) => RunResult;

export const defaultRunner: Runner = (command, args, cwd, opts = {}) => {
  const r = spawnSync(command, [...args], { cwd, encoding: 'utf8', env: opts.env ?? process.env, input: opts.input, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : (r.stderr ?? '') };
};

export function isReleaseVersion(version: string): boolean { return SEMVER.test(version); }
export function isPrerelease(version: string): boolean { return version.includes('-'); }

export interface ReleaseManifest {
  version: string;
  tag: string;
  prerelease: boolean;
  publicRepo: string;
  sourceRef: string;
  sourceCommit: string;
  publicCommit: string;
  publicDir: string;
  distDir: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  webUi: boolean;
  e2e: { ran: boolean; ok?: boolean; versionLine?: string };
  notesDraft?: string;
  preparedAt: string;
}

function must(r: RunResult, what: string): string {
  if (r.status !== 0) throw new Error(`${what} 실패 rc=${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** SHA256SUMS 의 모든 줄을 파일과 다시 대조한다 — 하나라도 다르면 이름을 댄다. */
export function verifyChecksums(dist: string): string[] {
  const bad: string[] = [];
  for (const line of readFileSync(join(dist, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    if (!existsSync(join(dist, m[2]!)) || sha256(join(dist, m[2]!)) !== m[1]) bad.push(m[2]!);
  }
  return bad;
}

export interface PrepareOptions {
  version: string;
  source?: string;
  out?: string;
  notesFrom?: string;
  skipE2e?: boolean;
  publicRepo?: string;
  repoRoot?: string;
  log?: (line: string) => void;
}

/** 공개 한 판을 «로컬에서만» 만든다 — 산출 폴더에 `public/`(공개 저장소 작업 트리 · 새 커밋 1) · `dist/`(자산 넷) · `release.json`. */
export async function prepareRelease(opts: PrepareOptions, run: Runner = defaultRunner): Promise<ReleaseManifest> {
  const log = opts.log ?? ((l: string) => console.error(l));
  if (!isReleaseVersion(opts.version)) throw new Error(`버전 모양이 아니다: ${opts.version} (예: 0.1.1 · 0.2.0-rc.1)`);
  const repoRoot = resolve(opts.repoRoot ?? join(import.meta.dir, '..', '..'));
  const publicRepo = opts.publicRepo ?? DEFAULT_PUBLIC_REPO;
  const sourceRef = opts.source ?? 'origin/main';
  const out = resolve(opts.out ?? mkdtempSync(join(tmpdir(), `elanous-release-${opts.version}-`)));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`산출 폴더가 비어 있지 않다: ${out}`);
  mkdirSync(out, { recursive: true });
  const tag = `v${opts.version}`;
  // 의존성은 «node_modules 의 실제 자리»에서 — 워크트리의 node_modules 는 대개 본 트리로의 링크라 `apps/pwa/node_modules` 가 거기만 있다.
  const modulesRoot = dirname(realpathSync(join(repoRoot, 'node_modules')));
  const sourceDir = join(out, 'source');
  const publicDir = join(out, 'public');
  const distDir = join(out, 'dist');

  // ① 원본을 «깨끗한» 분리 체크아웃으로 — 작업 트리의 커밋 안 된 변경이 공개본에 새지 않게.
  if (sourceRef.startsWith('origin/')) must(run('git', ['fetch', '-q', 'origin', sourceRef.slice('origin/'.length)], repoRoot), 'git fetch');
  must(run('git', ['worktree', 'add', '-q', '--detach', sourceDir, sourceRef], repoRoot), 'git worktree add');
  try {
    const sourceCommit = must(run('git', ['rev-parse', 'HEAD'], sourceDir), 'git rev-parse');
    const pkgVersion = (JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as { version?: string }).version;
    if (pkgVersion !== opts.version) throw new Error(`package.json 버전 ${pkgVersion} ≠ ${opts.version} — 먼저 버전을 올리는 PR 을 착지하라(원천 = package.json 한 칸)`);
    symlinkSync(join(modulesRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir');
    log(`① 원본 ${sourceRef} = ${sourceCommit.slice(0, 12)} · package.json ${pkgVersion}`);

    // ② 공개본 내보내기(유출 검사 포함 · 유출이 있으면 rc 1 → 멈춘다).
    must(run('bun', ['scripts/public-export.ts', '--out', join(out, 'export')], sourceDir), '공개본 내보내기(유출 검사)');
    log('② 공개본 내보내기 · 유출 0');

    // ③ 공개 저장소 «이력 위에» 새 커밋 — 첫 판이면 새 저장소.
    const clone = run('git', ['clone', '-q', '--depth', '1', `https://github.com/${publicRepo}.git`, join(out, 'public-git')], out);
    renameSync(join(out, 'export'), publicDir);
    if (clone.status === 0 && existsSync(join(out, 'public-git', '.git'))) {
      renameSync(join(out, 'public-git', '.git'), join(publicDir, '.git'));
      rmSync(join(out, 'public-git'), { recursive: true, force: true });
    } else {
      must(run('git', ['init', '-q', '-b', 'main'], publicDir), 'git init');
      must(run('git', ['remote', 'add', 'origin', `https://github.com/${publicRepo}.git`], publicDir), 'git remote add');
      log(`   (공개 저장소를 못 읽었다 — 새 이력으로 시작: ${(clone.stderr || '').trim().slice(0, 120)})`);
    }
    const name = must(run('git', ['config', 'user.name'], repoRoot), 'git config user.name');
    const email = must(run('git', ['config', 'user.email'], repoRoot), 'git config user.email');
    must(run('git', ['add', '-A'], publicDir), 'git add');
    must(run('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', `elanous ${tag}`], publicDir), 'git commit');
    const publicCommit = must(run('git', ['rev-parse', 'HEAD'], publicDir), 'git rev-parse');
    log(`③ 공개 커밋 ${publicCommit.slice(0, 12)} (${publicRepo} main 위${isPrerelease(opts.version) ? ` · 미리보기 — 공개 main 이 아니라 release/${opts.version} 가지 ⊕ 태그로 나간다` : ''})`);

    // ④ PWA 빌드 — ⛔ 빠뜨리면 «웹 화면 없는 판»(빌드 산출은 공개본에 안 실린다).
    symlinkSync(join(modulesRoot, 'node_modules'), join(publicDir, 'node_modules'), 'dir');
    const pwaModules = join(modulesRoot, 'apps', 'pwa', 'node_modules');
    if (existsSync(pwaModules) && existsSync(join(publicDir, 'apps', 'pwa'))) symlinkSync(pwaModules, join(publicDir, 'apps', 'pwa', 'node_modules'), 'dir');
    const pwa = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], publicDir);
    const webUi = pwa.status === 0 && existsSync(join(publicDir, 'apps', 'pwa', 'out', 'index.html'));
    if (!webUi) throw new Error(`PWA 빌드 실패 — 웹 화면 없는 판은 내지 않는다: ${(pwa.stderr || pwa.stdout).trim().slice(-300)}`);
    log('④ PWA 빌드');

    // ⑤ 묶음 ⊕ 태그 대조 ⊕ 체크섬 재대조.
    const built = run('bun', [join(sourceDir, 'scripts', 'release-build.ts'), '--root', publicDir, '--out', distDir, '--tag', tag], out);
    const buildJson = JSON.parse(must(built, 'release-build')) as { files: ReleaseManifest['files'] };
    const bad = verifyChecksums(distDir);
    if (bad.length) throw new Error(`체크섬 불일치: ${bad.join(', ')}`);
    log(`⑤ 묶음 ${buildJson.files.map((f) => `${f.name} ${f.bytes}`).join(' · ')} · 체크섬 OK`);

    // ⑥ 로컬 끝까지 한 번 — 파이프 설치(file:// 릴리스) → --version → 제거.
    let e2e: ReleaseManifest['e2e'] = { ran: false };
    if (!opts.skipE2e) {
      const rel = join(out, 'e2e-release', 'latest');
      mkdirSync(rel, { recursive: true });
      const download = join(rel, 'download');
      mkdirSync(download);
      for (const f of readdirSync(distDir)) writeFileSync(join(download, f), readFileSync(join(distDir, f)));
      const home = join(out, 'e2e-home');
      const prefix = join(out, 'e2e-prefix');
      mkdirSync(home);
      const env = { ...process.env, HOME: home, ELANOUS_INSTALL_PREFIX: prefix, ELANOUS_RELEASE_BASE: `file://${join(out, 'e2e-release')}`, ELANOUS_INSTALL_SOURCE: '', ELANOUS_VERSION: '', SHELL: '/bin/zsh' };
      const install = run('bash', ['-s', '--', '--no-modify-path'], home, { env, input: readFileSync(join(distDir, 'install.sh'), 'utf8') });
      const version = run(join(prefix, 'bin', 'elanous'), ['--version'], home, { env });
      const versionLine = version.stdout.trim();
      const ok = install.status === 0 && versionLine.startsWith(`${opts.version} ${publicCommit}`);
      run('bash', [join(publicDir, 'scripts', 'uninstall.sh')], home, { env });
      e2e = { ran: true, ok, versionLine };
      if (!ok) throw new Error(`로컬 끝까지 실패 — 설치 rc=${install.status} · --version «${versionLine}» (기대 ${opts.version} ${publicCommit.slice(0, 12)}…)`);
      log(`⑥ 로컬 끝까지: ${versionLine}`);
    }

    let notesDraft: string | undefined;
    if (opts.notesFrom) {
      const notes = run('bun', ['scripts/release-notes.ts', '--from', opts.notesFrom, '--to', sourceCommit], sourceDir);
      if (notes.status === 0) { notesDraft = join(out, 'notes-draft.md'); writeFileSync(notesDraft, notes.stdout); }
    }
    const manifest: ReleaseManifest = {
      version: opts.version, tag, prerelease: isPrerelease(opts.version), publicRepo, sourceRef, sourceCommit, publicCommit,
      publicDir, distDir, files: buildJson.files, webUi, e2e, ...(notesDraft ? { notesDraft } : {}), preparedAt: new Date().toISOString(),
    };
    writeFileSync(join(out, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`✅ 준비 끝 — ${out}/release.json · 공개는 \`elanous release publish --dir ${out} --notes-file <본문> --yes\``);
    return manifest;
  } finally {
    run('git', ['worktree', 'remove', '--force', sourceDir], repoRoot);
  }
}

export interface PublishStep { what: string; command: string; args: string[]; cwd: string }

/** publish 가 «할 일»을 명령 목록으로 — `--yes` 없으면 이것만 보여 준다. */
export function planPublish(m: ReleaseManifest, notesFile: string): PublishStep[] {
  // ⛔ 설치기는 `SHA256SUMS` 로 받은 묶음을 확인한다 — 빠지면 그 판의 설치가 «전부» 실패한다.
  //    🩸 2026-09-25 v0.1.1 드라이런: release-build 의 `files` 에는 SHA256SUMS 가 없어(체크섬 대상 목록이라) «자산 4» 로 올릴 뻔했다.
  const assets = [...new Set([...m.files.map((f) => f.name), 'SHA256SUMS'])];
  return [
    // RELEASE-REHEARSAL-RC: a prerelease never moves public main — its export goes to release/<v> plus its tag (one atomic push).
    m.prerelease
      ? { what: `공개 저장소 ${m.publicRepo} release/${m.version} 가지 ⊕ 태그 ${m.tag} 푸시(${m.publicCommit.slice(0, 12)} · main 무접촉)`, command: 'git',
        args: ['push', '--atomic', 'origin', `${m.publicCommit}:refs/heads/release/${m.version}`, `${m.publicCommit}:refs/tags/${m.tag}`], cwd: m.publicDir }
      : { what: `공개 저장소 ${m.publicRepo} main 푸시(${m.publicCommit.slice(0, 12)})`, command: 'git', args: ['push', 'origin', 'HEAD:main'], cwd: m.publicDir },
    {
      what: `릴리스 ${m.tag}${m.prerelease ? ' (prerelease)' : ''} 생성 ⊕ 자산 ${assets.length}(${assets.join(' · ')})`,
      command: 'gh',
      args: ['release', 'create', m.tag, ...assets.map((name) => join(m.distDir, name)), '--repo', m.publicRepo, '--target', m.publicCommit,
        // RELEASE-REHEARSAL-RC: a prerelease is never Latest — the one-line installer keeps serving the last stable release.
        '--title', `elanous ${m.tag}${m.prerelease ? ' (pre-release)' : ''}`, '--notes-file', notesFile, ...(m.prerelease ? ['--prerelease', '--latest=false', '--verify-tag'] : [])],
      cwd: m.publicDir,
    },
  ];
}

export function readManifest(dir: string): ReleaseManifest {
  return JSON.parse(readFileSync(join(resolve(dir), 'release.json'), 'utf8')) as ReleaseManifest;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export interface TagOptions { version: string; source: string; yes?: boolean; repoRoot?: string; log?: (line: string) => void }

/** 로컬과 origin 의 태그를 모두 대조한다. 주석 태그는 반드시 peel 해서 원본 커밋을 비교한다. */
function checkSourceTag(version: string, source: string, repoRoot: string, run: Runner): { tag: string; commit: string; local: boolean; remote: boolean } {
  if (!isReleaseVersion(version)) throw new Error(`버전 모양이 아니다: ${version}`);
  if (!COMMIT_SHA.test(source)) throw new Error(`원본 커밋 SHA가 아니다: ${source}`);
  const tag = `v${version}`;
  const commit = must(run('git', ['rev-parse', '--verify', `${source}^{commit}`], repoRoot), '원본 커밋 확인');
  if (commit !== source.toLowerCase()) throw new Error(`원본 커밋 불일치: ${source} ≠ ${commit}`);
  const localRef = `refs/tags/${tag}`;
  // `--quiet` 없이 없는 ref 를 물으면 git 은 1 이 아니라 128 을 낸다(📏 2026-09-27 · 0.2.2 소급 태깅이 여기서 멈췄다).
  const local = run('git', ['show-ref', '--verify', '--quiet', localRef], repoRoot);
  if (local.status !== 0 && local.status !== 1) must(local, `로컬 태그 ${tag} 조회`);
  if (local.status === 0) {
    const target = must(run('git', ['rev-parse', '--verify', `${localRef}^{commit}`], repoRoot), `로컬 태그 ${tag} 확인`);
    if (target !== commit) throw new Error(`태그 충돌: ${tag} 로컬 ${target} ≠ 원본 ${commit} — 덮지 않는다`);
  }
  const remote = must(run('git', ['ls-remote', '--tags', 'origin', localRef, `${localRef}^{}`], repoRoot), `origin 태그 ${tag} 조회`);
  const refs = new Map(remote.split('\n').filter(Boolean).map((line) => {
    const [hash, ref] = line.split(/\s+/);
    return [ref, hash];
  }));
  const target = refs.get(`${localRef}^{}`) ?? refs.get(localRef);
  if (target && target !== commit) throw new Error(`태그 충돌: ${tag} origin ${target} ≠ 원본 ${commit} — 덮지 않는다`);
  return { tag, commit, local: local.status === 0, remote: Boolean(target) };
}

function applySourceTag(version: string, source: string, repoRoot: string, run: Runner): void {
  const state = checkSourceTag(version, source, repoRoot, run);
  if (!state.local) must(run('git', ['tag', '-a', state.tag, state.commit, '-m', `elanous ${state.tag}`], repoRoot), `내부 태그 ${state.tag} 생성`);
  if (!state.remote) must(run('git', ['push', 'origin', `refs/tags/${state.tag}:refs/tags/${state.tag}`], repoRoot), `내부 태그 ${state.tag} push`);
  debug.log('release.publish', 'tagged', { version, commit: state.commit });
}

/** 이미 발행한 판의 내부 기준점을 소급 태깅한다. --yes 없으면 저장소를 읽거나 쓰지 않는다. */
export async function tagRelease(opts: TagOptions, run: Runner = defaultRunner): Promise<{ tagged: boolean }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!isReleaseVersion(opts.version)) throw new Error(`버전 모양이 아니다: ${opts.version}`);
  if (!COMMIT_SHA.test(opts.source)) throw new Error(`원본 커밋 SHA가 아니다: ${opts.source}`);
  log(`${opts.yes ? '▶' : '·'} 내부 태그 v${opts.version} → ${opts.source} (origin push${opts.yes ? '' : ' 예정'})`);
  if (!opts.yes) return { tagged: false };
  applySourceTag(opts.version, opts.source, resolve(opts.repoRoot ?? join(import.meta.dir, '..', '..')), run);
  return { tagged: true };
}

export async function publishRelease(opts: { dir: string; notesFile: string; yes?: boolean; repoRoot?: string; instanceRoot?: string; ledgerRoot?: string; log?: (l: string) => void }, run: Runner = defaultRunner): Promise<{ published: boolean; steps: PublishStep[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const m = readManifest(opts.dir);
  if (!existsSync(opts.notesFile)) throw new Error(`릴리스 본문 파일이 없다: ${opts.notesFile} (초안: ${m.notesDraft ?? 'release notes --from <ref>'})`);
  if (m.e2e.ran && !m.e2e.ok) throw new Error('prepare 의 로컬 끝까지가 실패한 판이다 — 공개하지 않는다');
  const bad = verifyChecksums(m.distDir);
  if (bad.length) throw new Error(`준비 뒤 자산이 바뀌었다: ${bad.join(', ')}`);
  const existing = run('gh', ['release', 'view', m.tag, '--repo', m.publicRepo], m.publicDir);
  if (existing.status === 0) throw new Error(`이미 있는 릴리스다: ${m.tag} — 버전을 올려 다시 prepare 하라(같은 태그를 덮지 않는다)`);
  const steps = planPublish(m, resolve(opts.notesFile));
  for (const s of steps) log(`${opts.yes ? '▶' : '·'} ${s.what}\n    ${s.command} ${s.args.join(' ')}`);
  if (!opts.yes) { log('⛔ 보기만 했다 — 공개는 되돌릴 수 없다. 실행하려면 --yes'); return { published: false, steps }; }
  const repoRoot = resolve(opts.repoRoot ?? join(import.meta.dir, '..', '..'));
  checkSourceTag(m.version, m.sourceCommit, repoRoot, run);
  for (const s of steps) must(run(s.command, s.args, s.cwd), s.what);
  applySourceTag(m.version, m.sourceCommit, repoRoot, run);
  // 판 기록은 이 우주 ⊕ 기계 단위 릴리스 원장(`releaseLedgerRoot()` · 다음 판 gate 가 기준선으로 읽는 자리) 두 곳에 남긴다.
  // 공개는 이미 끝났으니 한 자리가 실패해도 다른 자리는 쓰고, 실패는 숨기지 않고 알린다(되돌릴 수 없는 단계 뒤라 던지지 않는다).
  const body = `${JSON.stringify({ ...m, publishedAt: new Date().toISOString() }, null, 2)}\n`;
  // 설정 디렉터리를 명시로 바꿔 끼운 경우(시험·`--config-dir`)는 그 우주만 — 다른 원장으로 넘지 않는다(gate 의 `releaseLedgerRoot` 와 같은 규칙).
  const roots = getElanousConfigDirOverride() ? [effectiveInstanceRoot()]
    : [...new Set([opts.instanceRoot ?? effectiveInstanceRoot(), opts.ledgerRoot ?? releaseLedgerRoot()])];
  for (const root of roots) {
    const record = join(root, 'release', m.version, 'release.json');
    try {
      mkdirSync(dirname(record), { recursive: true });
      const temp = `${record}.${process.pid}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, record);
    } catch (error) {
      log(`⚠ 판 기록을 못 남겼다: ${record} — ${error instanceof Error ? error.message : String(error)} (공개는 끝났다 · 다음 판 gate 는 기준선을 다시 스윕한다)`);
    }
  }
  log(`✅ 공개: https://github.com/${m.publicRepo}/releases/tag/${m.tag} — 이어서 \`elanous release verify --version ${m.version}\``);
  return { published: true, steps };
}

// ── yank(릴리스 내리기 · 대표 09-26 승인 · 로드맵 #2) ─────────────────────────────────────────
// 지우지 않고 «내린다»: 대상 판을 pre-release 로 강등 ⊕ Latest 해제 ⊕ 제목에 (yanked) → 직전 안정 판에 Latest.
// 그러면 `latest/download/install.sh` 가 직전 판을 준다. 자산은 남는다 — 판을 고정한 사용자(`ELANOUS_VERSION=`)도
// 받을 수 있고 `--undo` 로 되돌린다. (gemini-cli 의 `release-rollback` 과 같은 자리 · 참조 04 `~/source/ref`)

export interface ReleaseInfo { tagName: string; isPrerelease: boolean; isDraft: boolean; isLatest: boolean; publishedAt: string }

export function listReleases(repo: string, run: Runner, cwd: string): ReleaseInfo[] {
  return JSON.parse(must(run('gh', ['release', 'list', '--repo', repo, '--limit', '50', '--json', 'tagName,isPrerelease,isDraft,isLatest,publishedAt'], cwd), `릴리스 목록 ${repo}`)) as ReleaseInfo[];
}

export function planYank(releases: readonly ReleaseInfo[], tag: string, repo: string, undo = false): PublishStep[] {
  const target = releases.find((r) => r.tagName === tag);
  if (!target) throw new Error(`없는 릴리스다: ${tag}`);
  const version = tag.replace(/^v/, '');
  if (undo) {
    return [{ what: `${tag} 되돌리기 — 정식 판 ⊕ Latest ⊕ 제목 원래대로`, command: 'gh', args: ['release', 'edit', tag, '--repo', repo, '--prerelease=false', '--latest', '--title', `elanous ${tag}`], cwd: '.' }];
  }
  if (target.isPrerelease) throw new Error(`이미 pre-release 다(yank 됐거나 미리보기): ${tag} — 되돌리려면 --undo`);
  const previous = releases
    .filter((r) => r.tagName !== tag && !r.isPrerelease && !r.isDraft)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  if (!previous) throw new Error(`${tag} 말고 정식 판이 없다 — 내리면 Latest 가 비어 한 줄 설치가 전부 실패한다. 내리지 않는다`);
  return [
    { what: `${tag} 내리기 — pre-release 로 강등 ⊕ Latest 해제 ⊕ 제목 (yanked) · 자산은 남긴다`, command: 'gh', args: ['release', 'edit', tag, '--repo', repo, '--prerelease', '--latest=false', '--title', `elanous ${tag} (yanked)`], cwd: '.' },
    { what: `${previous.tagName} 을 Latest 로 — latest/download/install.sh 가 이 판을 준다(v${version} 을 고정한 사용자는 ELANOUS_VERSION=${version} 로 여전히 받는다)`, command: 'gh', args: ['release', 'edit', previous.tagName, '--repo', repo, '--latest'], cwd: '.' },
  ];
}

/** `latest/download/install.sh` 가 지금 어느 판으로 가나(리다이렉트 Location) — 못 읽으면 null. */
export function latestInstallerTag(repo: string, run: Runner, cwd: string): string | null {
  const r = run('curl', ['-sI', `https://github.com/${repo}/releases/latest/download/install.sh`], cwd);
  return /\/releases\/download\/(v[^/\s]+)\//i.exec(r.stdout)?.[1] ?? null;
}

/** 📏 09-26 실측: API 의 Latest 는 즉시 · 다운로드 리다이렉트(`latest/download/…`)는 약 100~120초 늦게 따라온다(CDN).
 *  그래서 실행 뒤 «설치기가 실제로 주는 판»이 기대한 판이 될 때까지 잰다 — API 만 보고 ✅ 를 내면 거짓이다(첫 실물에서 그랬다). */
export const YANK_PROPAGATION_TIMEOUT_MS = 240_000;
export const YANK_PROPAGATION_POLL_MS = 10_000;

export async function yankRelease(opts: { version: string; publicRepo?: string; yes?: boolean; undo?: boolean; log?: (l: string) => void; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number }, run: Runner = defaultRunner): Promise<{ applied: boolean; latestNow: string | null; propagated?: boolean; waitedMs?: number }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  if (!isReleaseVersion(opts.version)) throw new Error(`버전 모양이 아니다: ${opts.version}`);
  const repo = opts.publicRepo ?? DEFAULT_PUBLIC_REPO;
  const tag = `v${opts.version}`;
  const cwd = tmpdir();
  const steps = planYank(listReleases(repo, run, cwd), tag, repo, opts.undo);
  for (const s of steps) log(`${opts.yes ? '▶' : '·'} ${s.what}
    ${s.command} ${s.args.join(' ')}`);
  if (!opts.yes) { log(`⛔ 보기만 했다 — 실행하려면 --yes (되돌리기: elanous release yank --version ${opts.version} --undo --yes)`); return { applied: false, latestNow: null }; }
  for (const s of steps) must(run(s.command, s.args, cwd), s.what);
  // 기대 = 되돌림이면 그 판 · 내림이면 Latest 를 받은 직전 판(두 번째 단계의 대상).
  const expected = opts.undo ? tag : steps[1]!.args[2]!;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? YANK_PROPAGATION_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? YANK_PROPAGATION_POLL_MS;
  let waited = 0;
  let latestNow = latestInstallerTag(repo, run, cwd);
  while (latestNow !== expected && waited < timeoutMs) {
    await sleep(pollMs);
    waited += pollMs;
    latestNow = latestInstallerTag(repo, run, cwd);
  }
  const propagated = latestNow === expected;
  debug.log('release.yank', opts.undo ? 'undone' : 'yanked', { tag, repo, expected, latestNow, propagated, waitedMs: waited });
  if (propagated) log(`✅ ${opts.undo ? '되돌림' : '내림'}: ${tag} · latest/download/install.sh → ${latestNow} (${Math.round(waited / 1000)}초 뒤 반영)`);
  else { log(`⚠️ ${opts.undo ? '되돌림' : '내림'}은 적용했지만 설치기가 아직 ${latestNow ?? '못 읽음'} 을 준다(기대 ${expected} · ${Math.round(waited / 1000)}초 기다림 · CDN 캐시) — 잠시 뒤 다시 확인: curl -sI https://github.com/${repo}/releases/latest/download/install.sh`); process.exitCode = 2; }
  return { applied: true, latestNow, propagated, waitedMs: waited };
}

/** 공개 주소로 끝까지 — 깨끗한 임시 홈에서 설치 → --version → self-update → 제거. */
/** 상태 왕복 — 설치본이 «쓰고 다른 프로세스에서 다시 읽나»(자격 불요). `--version` 은 일을 하는 증거가 아니다.
 *  ① 기억: `memory add`(stdin 본문에 nonce) → 새 프로세스 `memory search <nonce>` 가 찾는가.
 *  ② 로그(sqlite): `setup --non-interactive` 가 남기는 행 — 검증 시작 «뒤»의 행이 `logs --json` 으로 읽히는가(카테고리에 기대지 않는다).
 *  📏 09-25: 기억은 베어 ubuntu:24.04 ⊕ 이 맥 빈 HOME 둘 다 ok. 로그는 «데몬이 한 번 떠야» 스토어가 생긴다 — 빈 HOME 에선
 *  스토어가 없어(`registeredStores:0`) 원리상 못 잰다 ⇒ `no-store`(실패도 통과도 아님 · 판정에서 뺀다). 데몬은 LLM 자격이
 *  없으면 기동을 거부하므로, 로그·세션·미션 스토어 왕복은 자격을 넣는 베어 컨테이너 검증의 몫(버전 매뉴얼).
 *  미션 스토어·세션 기록은 LLM 이 있어야 생겨 여기서 «안 잰다». */
export type LogRoundTrip = 'ok' | 'fail' | 'no-store';

export function stateRoundTrip(elanous: string, home: string, env: NodeJS.ProcessEnv, run: Runner, startedAtMs: number, nonce = `verify${startedAtMs}`): { memory: boolean; logs: LogRoundTrip } {
  const add = run(elanous, ['memory', 'add', 'reference', `release-verify-${nonce}`, 'release verify probe'], home, { env, input: `release verify nonce ${nonce}\n` });
  const search = run(elanous, ['memory', 'search', nonce], home, { env });
  const memory = add.status === 0 && search.status === 0 && search.stdout.includes(nonce);
  run(elanous, ['setup', '--non-interactive'], home, { env });
  const read = run(elanous, ['logs', '--limit', '20', '--json'], home, { env });
  const rows = read.stdout.split('\n').flatMap((line) => {
    try { const row = JSON.parse(line) as { ts_ms?: unknown }; return typeof row.ts_ms === 'number' ? [row.ts_ms] : []; } catch { return []; }
  });
  if (rows.some((ts) => ts >= startedAtMs)) return { memory, logs: 'ok' };
  return { memory, logs: /"registeredStores":0\b/.test(`${read.stdout}${read.stderr}`) ? 'no-store' : 'fail' };
}

/** 공개 판의 노트가 문서 사이트에 있나 — 🅕 제보(09-27): 0.2.2 노트가 GitHub 릴리스에만 있고 docs 에 없었다(#21137 이 뒤에 옮김).
 *  `publish` 는 아무 경로의 본문 파일을 받으므로 원본(`release/public/내부 문서 `<판>``)·사이트 배포를 빼먹어도 모른다 ⇒ verify 가 사이트를 잰다.
 *  정식 판만(`-rc.N` 같은 선행 판은 노트 페이지를 두지 않는다). */
export const DOCS_SITE = 'https://docs.elanous.ai';
export function releaseNotesPageUrl(version: string): string | null {
  if (version.includes('-')) return null;
  return `${DOCS_SITE}/releases/${version.replace(/\./g, '-')}/`;
}
export type NotesPage = 'ok' | 'missing' | 'not-required';
export function checkReleaseNotesPage(version: string | undefined, run: Runner, cwd: string): { notesPage: NotesPage; url: string | null } {
  const url = version ? releaseNotesPageUrl(version) : null;
  if (!url) return { notesPage: 'not-required', url };
  const r = run('curl', ['-sL', '-o', '/dev/null', '-w', '%{http_code}', url], cwd);
  return { notesPage: r.status === 0 && r.stdout.trim() === '200' ? 'ok' : 'missing', url };
}

export async function verifyRelease(opts: { version?: string; publicRepo?: string; log?: (l: string) => void }, run: Runner = defaultRunner): Promise<{ ok: boolean; versionLine: string; installerUrl: string; steps?: { install: number | null; selfUpdate: number | null; uninstall: number | null }; state?: { memory: boolean; logs: LogRoundTrip }; notesPage?: NotesPage }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  if (opts.version !== undefined && !isReleaseVersion(opts.version)) throw new Error(`버전 모양이 아니다: ${opts.version}`);
  const repo = opts.publicRepo ?? DEFAULT_PUBLIC_REPO;
  const installerUrl = `https://github.com/${repo}/releases/${opts.version ? `download/v${opts.version}` : 'latest/download'}/install.sh`;
  const root = mkdtempSync(join(tmpdir(), 'elanous-release-verify-'));
  const startedAtMs = Date.now();
  try {
    const home = join(root, 'home');
    const prefix = join(root, 'prefix');
    mkdirSync(home);
    // 검증은 «빈 HOME» 에서만 쓴다 — 물려받은 ELANOUS_*(STATE_DIR 등)·XDG_* 가 있으면 상태 왕복이 운영 저장소에 쓴다.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ELANOUS_') && !key.startsWith('XDG_')));
    const env = envLiteral({ ...inherited, HOME: home, ELANOUS_INSTALL_PREFIX: prefix, ELANOUS_INSTALL_SOURCE: '', ELANOUS_VERSION: opts.version ?? '', SHELL: '/bin/zsh' });
    const script = must(run('curl', ['-fsSL', installerUrl], home), `설치기 받기 ${installerUrl}`);
    const install = run('bash', ['-s', '--', '--no-modify-path'], home, { env, input: script });
    const versionLine = run(join(prefix, 'bin', 'elanous'), ['--version'], home, { env }).stdout.trim();
    const state = stateRoundTrip(join(prefix, 'bin', 'elanous'), home, env, run, startedAtMs);
    const update = run(join(prefix, 'bin', 'elanous'), ['self-update', '--json'], home, { env });
    const uninstall = existsSync(join(prefix, 'current', 'node_modules', 'elanous', 'scripts', 'uninstall.sh'))
      ? run('bash', [join(prefix, 'current', 'node_modules', 'elanous', 'scripts', 'uninstall.sh')], home, { env })
      : { status: null, stdout: '', stderr: 'uninstall.sh 없음' };
    const notes = checkReleaseNotesPage(opts.version, run, home);
    const ok = install.status === 0 && (opts.version ? versionLine.startsWith(`${opts.version} `) : versionLine.length > 0) && update.status === 0 && state.memory && state.logs !== 'fail' && notes.notesPage !== 'missing';
    log(`${ok ? '✅' : '⛔'} ${installerUrl}\n  설치 rc=${install.status} · --version «${versionLine}» · 기억 왕복 ${state.memory ? 'ok' : 'FAIL'} · 로그 왕복 ${state.logs === 'ok' ? 'ok' : state.logs === 'fail' ? 'FAIL' : '안 잼(스토어 없음 — 데몬이 한 번 떠야 생긴다)'} · self-update rc=${update.status} · 제거 rc=${uninstall.status} · 노트 페이지 ${notes.notesPage === 'ok' ? 'ok' : notes.notesPage === 'missing' ? `없음 — release/public/docs/releases/${opts.version}.md ⊕ website/pages.json ⊕ \`bun website/scripts/deploy-pages.ts\` (${notes.url})` : '해당 없음'}`);
    return { ok, versionLine, installerUrl, steps: { install: install.status, selfUpdate: update.status, uninstall: uninstall.status }, state, notesPage: notes.notesPage };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `--json` — 사람 줄은 stderr, stdout 엔 결과 한 줄(그래프 간선이 파이프로 읽는다 · 🅣 T-R 요청). */
async function jsonAction<T>(json: boolean | undefined, body: (log: (l: string) => void) => Promise<T>, ok: (r: T) => boolean): Promise<void> {
  const log = json ? (l: string) => console.error(l) : (l: string) => console.log(l);
  try {
    const r = await body(log);
    if (json) process.stdout.write(`${JSON.stringify({ ok: ok(r), ...(r as object) })}\n`);
    if (!ok(r) && !process.exitCode) process.exitCode = 1;
  } catch (e) {
    const frozen = e instanceof LandingFrozenError ? { reason: 'frozen' as const } : {};
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, ...frozen, error: (e as Error).message })}\n`);
    else console.error(`⛔ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function checklistCodenames(): Record<string, string> {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { codenames?: Record<string, string> } };
  return raw.release?.codenames ?? {};
}

function checklistVersion(input: string | undefined, codenames: Record<string, string>): string {
  const v = input ?? devVersion().replace(/-dev\.\d+$/, '');
  const resolved = isReleaseVersion(v) ? v : Object.entries(codenames).find(([, name]) => name === v)?.[0] ?? v;
  if (!isReleaseVersion(resolved)) throw new CliUserError(`체크리스트 판 또는 별칭이 아니다: ${v}`);
  return resolved;
}

async function checklistOutput(v: string, codenames: Record<string, string>, mode: 'list' | 'status', json?: boolean, owner?: string): Promise<void> {
  if (owner !== undefined) parseOwner(owner);
  const snapshot = listChecklist(v);
  const data = owner === undefined ? snapshot : { ...snapshot, items: snapshot.items.filter((item) => ownerMatches(item.owner, owner)) };
  const summary = summarizeChecklist(data);
  const parity = data.items.flatMap((item) => {
    const why = item.kind === 'screen' ? parityGap(item.evidence) : null;
    return why ? [{ id: item.id, why }] : [];
  });
  const result = { ...data, codename: codenames[v] ?? '', ...summary, parity };
  for (const { id, why } of parity) debug.log('release.checklist', 'parity-warning', { version: v, id, why });
  if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
  console.log(`⚠ 짝 경고 ${parity.length}: ${parity.map(({ id }) => id).join(', ') || '없음'}`);
  console.log(`${v}${result.codename ? ` (${result.codename})` : ''} · 공개 ${data.released || '없음'} · 개발 ${data.dev}`);
  if (mode === 'list') {
    for (const item of data.items) console.log(`${({ green: '🟢', yellow: '🟡', red: '🔴', done: '✅' } as const)[item.status]} ${item.id} ${item.title}${item.owner ? ` · ${item.owner}` : ''}${item.ceoMinutes !== undefined ? ` · 대표 손 ${item.ceoMinutes}분${item.ceoDate ? ` (${item.ceoDate})` : ''}` : ''}`);
  } else {
    console.log(`🟢 ${summary.green} · 🟡 ${summary.yellow} · 🔴 ${summary.red} · ✅ ${summary.done}`);
    console.log(`🔴 칸: ${summary.blocked.join(', ') || '없음'}`);
    console.log(`담당별: ${Object.entries(summary.byOwner).map(([owner, count]) => `${owner} ${count}`).join(' · ') || '없음'}`);
  }
}

export interface LandedButYellowDeps {
  run?: Runner;
  checklist?: typeof listChecklist;
  now?: () => Date;
  evidenceAdd?: typeof features.evidenceAdd;
  schedules?: typeof features.readSchedules;
  released?: typeof features.releasedVersion;
}

const MERGED_PR_LIMIT = 400;

function mergedChecklistPrs(since: string, now: Date, run: Runner): { prs: MergedChecklistPr[]; truncated: boolean } {
  const cwd = process.cwd();
  const fetch = (lower: string, upper?: string, limit = MERGED_PR_LIMIT): MergedChecklistPr[] => {
    const search = `merged:>=${lower}${upper ? ` merged:<${upper}` : ''}`;
    const raw = must(run('gh', ['pr', 'list', '--state', 'merged', '--search', search, '--limit', String(limit), '--json', 'number,title,body,mergedAt'], cwd), '병합 PR 조회(gh)');
    const page = JSON.parse(raw) as MergedChecklistPr[];
    if (!Array.isArray(page)) throw new Error('병합 PR 조회(gh): 배열이 아니다');
    return page;
  };
  const unique = new Map<number, MergedChecklistPr>();
  let truncated = false;
  const collect = (page: MergedChecklistPr[]) => {
    for (const pr of page) if (!unique.has(pr.number)) unique.set(pr.number, pr);
  };
  const first = fetch(since);
  if (first.length < MERGED_PR_LIMIT) return { prs: first, truncated: false };
  const lower = Date.parse(`${since}T00:00:00Z`);
  const upper = Math.max(lower + 1000, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const visit = (start: number, end: number): void => {
    const from = new Date(start).toISOString();
    const to = new Date(end).toISOString();
    const page = fetch(from, to);
    if (page.length < MERGED_PR_LIMIT) { collect(page); return; }
    if (end - start <= 1000) {
      // The second-precision search cannot be subdivided; probe one extra row to distinguish exactly 400 from a real truncation.
      const probe = fetch(from, to, MERGED_PR_LIMIT + 1);
      collect(probe.slice(0, MERGED_PR_LIMIT));
      if (probe.length > MERGED_PR_LIMIT) truncated = true;
      return;
    }
    const middle = start + Math.floor((end - start) / 2000) * 1000;
    visit(start, middle);
    visit(middle, end);
  };
  visit(lower, upper);
  return { prs: [...unique.values()], truncated };
}

function printLandedRows(rows: ReturnType<typeof landedButYellow>, items: ReturnType<typeof listChecklist>['items']): void {
  const updatedAtById = new Map(items.map((item) => [item.id, item.updatedAt]));
  const date = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
    return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  };
  for (const row of rows) {
    const icon = row.status === 'yellow' ? '🟡' : '🔴';
    console.log(`${row.id} ${row.owner ?? '-'} ${icon} ← ${row.prs.map((pr, i) => `#${pr.number} «${pr.title}» (${date(pr.mergedAt)} · 근거에 ${row.alreadyInEvidence[i] ? '있음' : '없음'}${pr.mergedAt > (updatedAtById.get(row.id) ?? '') ? ' · 칸보다 새것' : ''})`).join(' · ')}`);
  }
  console.log(`${rows.length}칸 · 그중 근거에 없는 PR 이 있는 칸 ${rows.filter((row) => row.alreadyInEvidence.includes(false)).length}`);
}

function compareReleaseVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core, pre] = version.split('-');
    const [major, minor, patch] = core!.split('.').map(Number);
    const [stage, sequence] = pre?.split('.') ?? [];
    return [major!, minor!, patch!, stage === undefined ? 3 : ({ alpha: 0, beta: 1, rc: 2 } as Record<string, number>)[stage]!, Number(sequence ?? 0)];
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

export function registerReleaseCommands(program: Command, releaseRunDeps: UnattendedReleaseDeps = {}, landedDeps: LandedButYellowDeps = {}, hqDeps: HqDeps = {}): void {
  const release = program.command('release').description('공개 배포 한 판 — prepare(로컬) → publish(--yes) → verify (docs/manual/MANUAL-versioning-and-release-2026-09-25.md)');
  const schedule = release.command('schedule').description('판별 컷·착지 마감 조회·갱신');
  const scheduleLedgerRoot = () => releaseRunDeps.ledgerRoot ?? releaseLedgerRoot();
  const ledgerFenceDeps = (): HqDeps => getElanousConfigDirOverride() && !hqDeps.store && !getUserConfig().hq?.arbiter
    ? { ...hqDeps, store: fileLeaseStore(join(effectiveInstanceRoot(), 'hq', 'lease.json')), seenPath: join(effectiveInstanceRoot(), 'hq', 'seen-generation'), localPath: join(effectiveInstanceRoot(), 'hq', 'local.json') }
    : hqDeps;
  const mayWriteLedger = (command: string, override: boolean, ledgerRoot: string) => {
    if (isIsolatedLedgerWriteRoot(ledgerRoot)) {
      try { debug.log('hq.fence', 'skipped-isolated', { root: ledgerRoot, command }); } catch { /* observation is fail-soft */ }
      return true;
    }
    return hqCliWriteAllowed(command, override, ledgerFenceDeps());
  };
  schedule.command('list').option('--json', '결과 JSON').action((o: { json?: boolean }) => {
    const rows = listSchedules(scheduleLedgerRoot());
    if (o.json) console.log(JSON.stringify(rows));
    else for (const row of rows) console.log(formatSchedule(row));
  });
  schedule.command('show').requiredOption('--version <v>', '조회할 판').option('--json', '결과 JSON')
    .action((o: { version: string; json?: boolean }) => {
      const row = getSchedule(o.version, scheduleLedgerRoot());
      if (!row) throw new CliUserError(`없는 판 일정: ${o.version}`, '판 일정 등록: elanous release schedule set --version <v> --cut-at <iso> --land-by <iso>');
      if (o.json) console.log(JSON.stringify(row)); else console.log(formatSchedule(row));
    });
  schedule.command('set').requiredOption('--version <v>', '갱신할 판')
    .option('--cut-at <iso>', '오프셋 포함 컷 시각').option('--land-by <iso>', '오프셋 포함 착지 마감')
    .option('--freeze-from <iso>', '동결 시작').option('--freeze-until <iso>', '동결 종료').option('--json', '결과 JSON').option('--hq-override')
    .action((o: { version: string; cutAt?: string; landBy?: string; freezeFrom?: string; freezeUntil?: string; json?: boolean; hqOverride?: boolean }) => {
      if (o.cutAt === undefined && o.landBy === undefined && o.freezeFrom === undefined && o.freezeUntil === undefined) throw new CliUserError('갱신할 시각을 지정하라', '--cut-at <iso> 또는 --land-by <iso>');
      if (!mayWriteLedger('release schedule set', Boolean(o.hqOverride), scheduleLedgerRoot())) return;
      const row = setSchedule(o.version, { cutAt: o.cutAt, landBy: o.landBy, freezeFrom: o.freezeFrom, freezeUntil: o.freezeUntil }, process.env.ELANOUS_TRACK || 'cli', scheduleLedgerRoot());
      if (o.json) console.log(JSON.stringify(row)); else console.log(formatSchedule(row));
    });
  release.command('place <id>').description('칸의 우선순위·마감·용량으로 판 배치')
    .option('--priority <priority>', 'P0|P1|P2').option('--dry-run', '이동 없이 배치 보기')
    .action((id: string, opts: { priority?: string; dryRun?: boolean }) => {
      const rows = listSchedules(scheduleLedgerRoot());
      const found = rows.flatMap(({ version }) => listChecklist(version).items.filter((item) => item.id === id));
      if (found.length !== 1) throw new CliUserError(found.length ? `여러 판의 같은 칸: ${id}` : `없는 칸: ${id}`, 'release checklist add 로 칸을 먼저 만든다');
      const item = found[0]!;
      if (!item.owner) throw new CliUserError(`담당 없는 칸: ${id}`);
      const who = process.env.ELANOUS_TRACK;
      if (who && who !== 'OP' && !ownerMatches(item.owner, parseOwner(who).seat)) throw new CliUserError('남의 칸 당기기 거부 — COO 에 요청');
      if (!opts.dryRun && who !== 'OP') throw new CliUserError('판 배치는 COO 에 요청 — 자리는 이유와 함께 release checklist move 로 다음 판에만 이월');
      if (!opts.dryRun && !mayWriteLedger('release place', false, scheduleLedgerRoot())) return;
      const priority = opts.priority ?? item.priority;
      if (!priority) throw new CliUserError(`우선순위가 없는 칸: ${id} — --priority P0|P1|P2 를 지정하라`);
      const result = placeCell({ id, title: item.title, owner: item.owner, priority: priority as PlacementPriority, predecessors: item.predecessors ?? [], deadlineVersion: item.deadlineVersion, ceoMinutes: item.ceoMinutes, ceoDate: item.ceoDate, ...(item.accelerator === true ? { accelerator: true } : {}) }, { schedules: rows, dryRun: opts.dryRun, by: who ?? 'cli' });
      console.log(`${opts.dryRun ? '· 드라이런' : '✅'} ${id} ${result.from ?? '-'} → ${result.version} · ${result.reason}${result.displaced.length ? ` · P2 이월 ${result.displaced.map((row) => row.id).join(', ')}` : ''}`);
    });
  release.command('rebalance').description('마감 2시간 전 미시작 칸을 다음 판으로')
    .requiredOption('--version <v>', '대상 판').option('--dry-run', '이동 없이 보기')
    .action((opts: { version: string; dryRun?: boolean }) => {
      if (process.env.ELANOUS_TRACK !== 'OP' && !opts.dryRun) throw new CliUserError('판 이월은 COO 에 요청');
      if (!opts.dryRun && !mayWriteLedger('release rebalance', false, scheduleLedgerRoot())) return;
      const { decisions, blocked } = rebalance(opts.version, { schedules: listSchedules(scheduleLedgerRoot()), dryRun: opts.dryRun });
      for (const row of decisions) console.log(`${opts.dryRun ? '· 드라이런' : '✅'} ${row.id} ${row.from} → ${row.version} · ${row.reason}`);
      for (const row of blocked) console.log(`⛔ ${row.id} ${row.from} → ${row.to} 이월 거부 · ${row.reason}`);
      if (!decisions.length && !blocked.length) console.log('이월할 미시작 칸 없음');
    });
  const ceoMinutes = (value: string): number => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliUserError('대표 손 분량은 0 이상의 정수 분이어야 한다');
    return Number(value);
  };
  const checklist = release.command('checklist').description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  const mayWrite = (cmd: Command) => mayWriteLedger(`release checklist ${cmd.name()}`, Boolean(cmd.optsWithGlobals().hqOverride), releaseLedgerRoot());
  const context = (cmd: Command) => {
    const opts = { ...(cmd.parent?.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.opts() as { version?: string; json?: boolean }) };
    const codenames = checklistCodenames();
    return { version: checklistVersion(opts.version, codenames), codenames, json: opts.json };
  };
  const withContext = (cmd: Command) => cmd.option('--version <v>', '판 또는 별칭').option('--json', '결과 JSON').option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  const actor = () => process.env.ELANOUS_TRACK || 'cli';
  withContext(checklist.command('rubric').description('루브릭 채점(읽기 전용)'))
    .action(async (_opts: unknown, cmd: Command) => {
      if (cmd.opts().version === undefined && cmd.parent?.opts().version === undefined) throw new CliUserError('조회할 판을 지정하라', '--version <v>');
      const { version, json } = context(cmd);
      const items = readRubricItems(version, releaseLedgerRoot());
      const rows = items.flatMap((item) => {
        const rubric = parseRubric(`${item.title}\n${item.evidence ?? ''}`);
        if (!rubric) return [];
        const score = rubricScore(rubric);
        return [{ id: item.id, score, grade: rubricGrade(score), priority: item.priority ?? null }];
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const missing = items.length - rows.length;
      if (json) { await writeStdoutJson(`${JSON.stringify({ version, rows, missing })}\n`); return; }
      console.log('id · 점수 · 등급 · 현재 우선순위');
      for (const row of rows) console.log(`${row.id} · ${row.score} · ${row.grade} · ${row.priority ?? '-'}`);
      console.log(`루브릭 없는 칸 ${missing}`);
    });
  withContext(checklist.command('refs <doc>').description('문서를 인용하는 칸 — 모든 판의 구현 현황(읽기 전용)'))
    .action(async (doc: string, _opts: unknown, cmd: Command) => {
      if (!doc.trim() || doc.trim().startsWith('#')) throw new CliUserError(`잘못된 문서: ${doc}`, '저장소 상대 경로[#절] — 예: docs/RFC-x.md#§3');
      const { json } = context(cmd);
      const ledgerRoot = releaseLedgerRoot();
      const rows = cellsReferencingDoc(doc, features.assignedVersions(ledgerRoot).map((version) => listChecklist(version, ledgerRoot)));
      const byStatus = { green: 0, yellow: 0, red: 0, done: 0 } as Record<ChecklistStatus, number>;
      for (const row of rows) byStatus[row.status] += 1;
      debug.log('release.checklist', 'refs-read', { doc, rows: rows.length });
      if (json) { await writeStdoutJson(`${JSON.stringify({ doc, rows, byStatus })}\n`); return; }
      console.log(renderRefsStatus(rows));
      console.log(`칸 ${rows.length} · 🟢 ${byStatus.green} · 🟡 ${byStatus.yellow} · 🔴 ${byStatus.red} · ✅ ${byStatus.done}`);
    });
  withContext(checklist.command('list').description('모든 칸')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = context(cmd);
    await checklistOutput(version, codenames, 'list', json, opts.owner);
  });
  withContext(checklist.command('status').description('상태 요약')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = context(cmd);
    await checklistOutput(version, codenames, 'status', json, opts.owner);
  });
  withContext(checklist.command('landed-but-yellow').description('병합 PR 이 있지만 노랑·빨강인 칸(기본 읽기 전용)'))
    .option('--owner <owner>', '자리 또는 하위 자리로 거르기')
    .option('--open', '미발행 일정 판 중 칸이 있는 판 전부')
    .option('--apply-evidence', '확실한 PR 짝의 근거를 붙인다(상태는 그대로)')
    .option('--dry-run', '근거 추가 없이 계획만 출력')
    .action(async (opts: { owner?: string; open?: boolean; applyEvidence?: boolean; dryRun?: boolean }, cmd: Command) => {
      try {
        const inherited = cmd.parent?.opts() as { version?: string; json?: boolean } | undefined;
        const local = cmd.opts() as { version?: string; json?: boolean };
        if (opts.open && (local.version !== undefined || inherited?.version !== undefined)) throw new CliUserError('--open 과 --version 을 함께 쓸 수 없다');
        const json = local.json ?? inherited?.json;
        if (opts.owner !== undefined) parseOwner(opts.owner);
        const released = opts.open ? (landedDeps.released ?? features.releasedVersion)() : '';
        const openSnapshots = opts.open
          ? (landedDeps.schedules ?? features.readSchedules)()
            .filter(({ version }) => isReleaseVersion(version) && (!released || compareReleaseVersions(version, released) > 0))
            .sort((a, b) => compareReleaseVersions(a.version, b.version))
            .map(({ version }) => (landedDeps.checklist ?? listChecklist)(version)).filter((snapshot) => snapshot.items.length > 0)
          : [];
        if (opts.open && !openSnapshots.length) {
          if (json) await writeStdoutJson('[]\n'); else console.log('열린 판 없음');
          return;
        }
        if (opts.applyEvidence && !opts.dryRun && !mayWrite(cmd)) return;
        const snapshots = opts.open ? openSnapshots : [(landedDeps.checklist ?? listChecklist)(context(cmd).version)];
        const now = (landedDeps.now ?? (() => new Date()))();
        const updated = snapshots.flatMap(({ items }) => items
          .filter((item) => (item.status === 'yellow' || item.status === 'red') && (opts.owner === undefined || ownerMatches(item.owner, opts.owner)))
          .map((item) => Date.parse(item.updatedAt)).filter((at) => Number.isFinite(at)));
        const since = updated.length ? new Date(updated.reduce((earliest, at) => Math.min(earliest, at))).toISOString().slice(0, 10)
          : new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
        const { prs, truncated } = mergedChecklistPrs(since, now, landedDeps.run ?? defaultRunner);
        const results: Array<{ version: string; rows?: ReturnType<typeof landedButYellow>; plan?: ReturnType<typeof evidencePlan> }> = [];
        let totalAdded = 0, totalSkipped = 0;
        for (const snapshot of snapshots) {
          const { version, items } = snapshot;
          const rows = landedButYellow(items, prs, { owner: opts.owner });
          const skippedMention = new Set(rows.flatMap((row) => row.prs.flatMap((pr) =>
            pr.basis === 'mention' ? [JSON.stringify([row.id, pr.number])] : []))).size;
          if (opts.open) totalSkipped += skippedMention;
          if (opts.open && !json) console.log(`— ${version} —`);
          if (opts.applyEvidence || opts.dryRun) {
            const plan = evidencePlan(rows);
            const log = json ? console.error : console.log;
            for (const { id, ref } of plan) {
              if (!opts.dryRun) (landedDeps.evidenceAdd ?? features.evidenceAdd)(id, version, ref, actor(), snapshot.released, snapshot.dev);
              log(`${opts.dryRun ? '·' : '✅'} ${id} 근거 ${ref}`);
            }
            const added = opts.dryRun ? 0 : plan.length;
            totalAdded += added;
            log(`붙임 ${added} · 건너뜀(언급만) ${skippedMention}`);
            if (!opts.open && !opts.dryRun) debug.log('release.checklist', 'evidence-synced', { added, skippedMention });
            results.push({ version, plan });
          } else {
            if (!json) printLandedRows(rows, items);
            results.push({ version, rows });
          }
        }
        if (opts.open) {
          if (opts.applyEvidence && !opts.dryRun) debug.log('release.checklist', 'evidence-synced', { versions: snapshots.map(({ version }) => version), added: totalAdded, skippedMention: totalSkipped });
          if (!json) console.log(`판 ${snapshots.length} · 붙임 합 ${totalAdded} · 건너뜀(언급만) 합 ${totalSkipped}`);
          else await writeStdoutJson(`${JSON.stringify(results)}\n`);
        } else if (json) await writeStdoutJson(`${JSON.stringify(opts.applyEvidence || opts.dryRun ? results[0]!.plan : results[0]!.rows)}\n`);
        if (truncated) console.error('⚠ 병합 PR 400개 상한: 목록이 잘렸을 수 있다');
      } catch (error) {
        console.error(`⛔ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  withContext(checklist.command('add <id> <title>').description('칸 추가')).option('--owner <owner>', '담당').option('--kind <kind>', 'screen = 다섯 화면 짝 칸 · 근거에 짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 … 한 줄')
    .option('--priority <priority>', 'P0|P1|P2').option('--deadline-version <v>', '마감 판').option('--predecessor <id...>', '선행 칸 id')
    .option('--ceo-minutes <minutes>', '대표 손 분량(분)').option('--ceo-date <date>', '대표 손 날짜 YYYY-MM-DD (없으면 판 착지일 KST)')
    .option('--accelerator', '가속 등급 — 다른 칸의 처리량을 올리는 칸(자율성·효율성·동시성). 생략하면 등급 없음')
    .option('--allow-duplicate-id', '다른 판에 같은 id 가 있어도 경고 후 추가')
    .option('--ref <path...>', '근거 문서 — 저장소 상대 경로[#절] (반복 가능)')
    .action((id: string, title: string, opts: { ref?: string[]; owner?: string; kind?: string; priority?: string; deadlineVersion?: string; predecessor?: string[]; ceoMinutes?: string; ceoDate?: string; accelerator?: boolean; allowDuplicateId?: boolean }, cmd: Command) => {
    const { version, json } = context(cmd);
    if (!mayWrite(cmd)) return;
    const data = addItem(version, { id, title, ...(opts.ref !== undefined ? { refs: opts.ref } : {}), ...(opts.owner !== undefined ? { owner: opts.owner } : {}), ...(opts.kind !== undefined ? { kind: opts.kind as ChecklistKind } : {}), ...(opts.priority !== undefined ? { priority: opts.priority as PlacementPriority } : {}), ...(opts.deadlineVersion !== undefined ? { deadlineVersion: opts.deadlineVersion } : {}), ...(opts.predecessor !== undefined ? { predecessors: opts.predecessor } : {}), ...(opts.ceoMinutes !== undefined ? { ceoMinutes: ceoMinutes(opts.ceoMinutes) } : {}), ...(opts.ceoDate !== undefined ? { ceoDate: opts.ceoDate } : {}), ...(opts.accelerator ? { accelerator: true } : {}) }, { allowDuplicateId: opts.allowDuplicateId });
    if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 추가`);
  });
  withContext(checklist.command('set <id>').description('칸 상태·근거·담당·처분 갱신'))
    .option('--status <status>', 'green|yellow|red|done').option('--evidence <evidence>', '근거').option('--owner <owner>', '담당')
    .option('--disposition <disposition>', 'move|known-issue|block').option('--kind <kind>', 'screen = 다섯 화면 짝 칸 · 근거에 짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 … 한 줄')
    .option('--priority <priority>', 'P0|P1|P2').option('--deadline-version <v>', '마감 판').option('--predecessor <id...>', '선행 칸 id')
    .option('--ceo-minutes <minutes>', '대표 손 분량(분)').option('--ceo-date <date>', '대표 손 날짜 YYYY-MM-DD')
    .option('--accelerator', '가속 등급 부여').option('--no-accelerator', '가속 등급 해제(기본은 없음)')
    .option('--ref <path...>', '근거 문서 더하기 — 저장소 상대 경로[#절] (반복 가능 · 중복 제거)')
    .action((id: string, opts: { ref?: string[]; status?: string; evidence?: string; owner?: string; disposition?: string; kind?: string; priority?: string; deadlineVersion?: string; predecessor?: string[]; ceoMinutes?: string; ceoDate?: string; accelerator?: boolean }, cmd: Command) => {
      const { version, json } = context(cmd);
      if (opts.status !== undefined && !['green', 'yellow', 'red', 'done'].includes(opts.status)) throw new CliUserError(`잘못된 상태: ${opts.status}`, 'green|yellow|red|done');
      if (opts.disposition !== undefined && !['move', 'known-issue', 'block'].includes(opts.disposition)) throw new CliUserError(`잘못된 처분: ${opts.disposition}`, 'move|known-issue|block');
      if (opts.status === undefined && opts.evidence === undefined && opts.owner === undefined && opts.disposition === undefined && opts.kind === undefined && opts.priority === undefined && opts.deadlineVersion === undefined && opts.predecessor === undefined && opts.ceoMinutes === undefined && opts.ceoDate === undefined && opts.accelerator === undefined && opts.ref === undefined) throw new CliUserError('갱신할 칸을 지정하라', '--ref · --status · --evidence · --owner · --disposition · --kind · --priority · --deadline-version · --predecessor · --ceo-minutes · --ceo-date · --accelerator · --no-accelerator 중 하나');
      if (!mayWrite(cmd)) return;
      const data = setItem(version, id, { ...(opts.ref !== undefined ? { refs: opts.ref } : {}), ...(opts.status !== undefined ? { status: opts.status as ChecklistStatus } : {}), ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}), ...(opts.owner !== undefined ? { owner: opts.owner } : {}), ...(opts.disposition !== undefined ? { disposition: opts.disposition as ChecklistDisposition } : {}), ...(opts.kind !== undefined ? { kind: opts.kind as ChecklistKind } : {}), ...(opts.priority !== undefined ? { priority: opts.priority as PlacementPriority } : {}), ...(opts.deadlineVersion !== undefined ? { deadlineVersion: opts.deadlineVersion } : {}), ...(opts.predecessor !== undefined ? { predecessors: opts.predecessor } : {}), ...(opts.ceoMinutes !== undefined ? { ceoMinutes: ceoMinutes(opts.ceoMinutes) } : {}), ...(opts.ceoDate !== undefined ? { ceoDate: opts.ceoDate } : {}), ...(opts.accelerator !== undefined ? { accelerator: opts.accelerator ? true : null } : {}) }, process.env.ELANOUS_TRACK || 'cli');
      const item = data.items.find((entry) => entry.id === id);
      const why = item?.kind === 'screen' && item.status === 'green' ? parityGap(item.evidence) : null;
      if (why) {
        console.error(`⚠ 짝: ${why} — 근거에 «짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 …» 한 줄`);
        debug.log('release.checklist', 'parity-warning', { version, id, why });
      }
      if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 갱신`);
    });
  withContext(checklist.command('claim <id>').description('칸의 단일 주인을 잡는다'))
    .requiredOption('--by <owner>', '잡을 자리 또는 하위 자리').option('--force', '기존 주인에서 강제로 바꾼다')
    .action((id: string, opts: { by: string; force?: boolean }, cmd: Command) => {
      const { version, json } = context(cmd);
      if (!mayWrite(cmd)) return;
      const data = claimItem(version, id, opts.by, { force: opts.force });
      if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 주인 ${opts.by}`);
    });
  withContext(checklist.command('rm <id>').description('칸 삭제')).action((id: string, _opts: unknown, cmd: Command) => {
    const { version, json } = context(cmd);
    if (!mayWrite(cmd)) return;
    const data = removeItem(version, id, process.env.ELANOUS_TRACK || 'cli');
    if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 삭제`);
  });
  withContext(checklist.command('seed').description('마크다운 로드맵에서 빈 칸 들이기')).requiredOption('--from <file>', '로드맵 파일')
    .action((opts: { from: string }, cmd: Command) => {
      const { version, json } = context(cmd);
      if (!mayWrite(cmd)) return;
      const data = seedFromRoadmap(version, readFileSync(opts.from, 'utf8'));
      if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${version} ${data.items.length}칸`);
    });
  withContext(checklist.command('move <id>').description('칸을 한 트랜잭션으로 다른 판에 옮긴다'))
    .requiredOption('--from <v>', '현재 판').requiredOption('--to <v>', '새 판').option('--reason <reason>', '이동 사유')
    .action((id: string, opts: { from: string; to: string; reason?: string }, cmd: Command) => {
      const { codenames, json } = context(cmd);
      const from = checklistVersion(opts.from, codenames), to = checklistVersion(opts.to, codenames);
      if (!opts.reason?.trim()) throw new CliUserError('이동 이유가 필요하다');
      if (!mayWrite(cmd)) return;
      if (actor() === 'cli') {
        // No seat identity (ELANOUS_TRACK unset): keep the plain move so seat sessions without the variable still work, but say so.
        console.error('⚠ 자리 신원 없음(ELANOUS_TRACK 미설정) — 자리 규칙(자기 칸 · 다음 판 · 용량) 검사 없이 옮긴다');
        debug.log('release.placement', 'anonymous-move', { id, from, to });
        features.move(id, from, to, actor(), undefined, undefined, opts.reason);
      } else if (actor() !== 'OP') seatMove(id, from, to, actor(), opts.reason, { schedules: listSchedules(scheduleLedgerRoot()) });
      else features.move(id, from, to, actor(), undefined, undefined, opts.reason);
      if (json) console.log(JSON.stringify(listChecklist(to))); else console.log(`✅ ${id} ${from} → ${to}`);
    });
  withContext(checklist.command('retitle <id> <title>').description('칸 제목 수정')).action((id: string, title: string, _opts: unknown, cmd: Command) => {
    const { version, json } = context(cmd);
    if (!mayWrite(cmd)) return;
    const snapshot = listChecklist(version);
    features.retitle(id, title, actor(), snapshot.released, snapshot.dev);
    if (json) console.log(JSON.stringify(listChecklist(version))); else console.log(`✅ ${id} 제목 수정`);
  });
  const evidence = checklist.command('evidence').description('칸의 PR·커밋 근거');
  withContext(evidence.command('add <id> <ref>').description('근거 참조 추가')).action((id: string, ref: string, _opts: unknown, cmd: Command) => {
      const { version, json } = context(cmd);
      if (!mayWrite(cmd)) return;
      const snapshot = listChecklist(version);
      features.evidenceAdd(id, version, ref, actor(), snapshot.released, snapshot.dev);
    if (json) console.log(JSON.stringify(features.history(id).map(decodeClaimHistoryEntry))); else console.log(`✅ ${id} 근거 ${ref}`);
  });
  withContext(checklist.command('history <id>').description('칸의 판 이동·변경 이력')).action((id: string, _opts: unknown, cmd: Command) => {
    const { json } = context(cmd);
    const rows = features.history(id).map(decodeClaimHistoryEntry);
    if (json) { console.log(JSON.stringify(rows)); return; }
    const info = features.details(id);
    if (info) {
      console.log(`${info.id} · ${info.title} · 담당 ${info.owner ?? '-'} · 종류 ${info.kind ?? '-'} · 처음 ${info.createdAt}`);
      for (const ev of info.evidence) console.log(`  근거 ${ev.version} ${ev.ref} (${ev.at} ${ev.by})`);
    }
    for (const row of rows) console.log(`${row.at} ${row.version} ${row.by} ${row.field}: ${JSON.stringify(row.from)} → ${JSON.stringify(row.to)}`);
  });
  withContext(checklist.command('export').description('SQLite 에서 checklist.json 스냅샷 생성')).action((_opts: unknown, cmd: Command) => {
    const { version, json } = context(cmd);
    if (!mayWrite(cmd)) return;
    const snapshot = listChecklist(version);
    features.exportJson(version, snapshot.released, snapshot.dev);
    if (json) console.log(JSON.stringify(listChecklist(version))); else console.log(`✅ ${version} checklist.json 내보냄`);
  });
  release.command('prepare')
    .description('깨끗한 원본 → 공개본 → 공개 저장소 이력 위 커밋 → PWA → 묶음·체크섬 → 로컬 끝까지 (네트워크 쓰기 없음)')
    .requiredOption('--version <x.y.z>', 'package.json 과 같은 버전(먼저 버전 PR 을 착지)')
    .option('--source <ref>', '원본 ref', 'origin/main')
    .option('--out <dir>', '산출 폴더(비어 있어야 한다 · 기본 임시 폴더)')
    .option('--notes-from <ref>', '변경 기록 초안의 시작 ref(직전 릴리스의 원본 커밋)')
    .option('--skip-e2e', '로컬 끝까지를 건너뛴다(권하지 않음)')
    .option('--public-repo <owner/name>', '공개 저장소', DEFAULT_PUBLIC_REPO)
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version: string; source: string; out?: string; notesFrom?: string; skipE2e?: boolean; publicRepo: string; json?: boolean }) => {
      await jsonAction(o.json, async (log) => ({ manifest: await prepareRelease({ version: o.version, source: o.source, out: o.out, notesFrom: o.notesFrom, skipE2e: o.skipE2e, publicRepo: o.publicRepo, log }) }), (r) => !r.manifest.e2e.ran || r.manifest.e2e.ok === true);
    });
  release.command('yank')
    .description('릴리스 내리기 — pre-release 로 강등 ⊕ Latest 를 직전 정식 판으로(자산은 남김 · --undo 로 되돌림). --yes 없으면 보기만')
    .requiredOption('--version <x.y.z>', '내릴 판')
    .option('--undo', '내린 판을 되돌린다(정식 판 ⊕ Latest)')
    .option('--public-repo <owner/name>', '공개 저장소', DEFAULT_PUBLIC_REPO)
    .option('--yes', '실제로 바꾼다')
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version: string; undo?: boolean; publicRepo: string; yes?: boolean; json?: boolean }) => {
      await jsonAction(o.json, (log) => yankRelease({ version: o.version, undo: o.undo, publicRepo: o.publicRepo, yes: o.yes, log }), (r) => !r.applied || r.propagated !== false);
    });
  release.command('publish')
    .description('⛔ 되돌릴 수 없다 — 공개 저장소 푸시 ⊕ GitHub 릴리스. --yes 없으면 보기만')
    .requiredOption('--dir <dir>', 'prepare 산출 폴더')
    .requiredOption('--notes-file <file>', '공개용 릴리스 본문(내부 PR 번호·트랙 표식 없이)')
    .option('--yes', '실제로 공개한다')
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { dir: string; notesFile: string; yes?: boolean; json?: boolean }) => {
      await jsonAction(o.json, async (log) => {
        const r = await publishRelease({ dir: o.dir, notesFile: o.notesFile, yes: o.yes, log });
        const m = readManifest(o.dir);
        return { ...r, tag: m.tag, publicRepo: m.publicRepo, publicCommit: m.publicCommit, assets: [...new Set([...m.files.map((f) => f.name), 'SHA256SUMS'])].map((name) => join(m.distDir, name)) };
      }, () => true);
    });
  release.command('tag')
    .description('이미 발행된 판의 내부 원본 커밋에 주석 태그를 달고 origin 에 push. --yes 없으면 계획만')
    .requiredOption('--version <x.y.z>', '이미 발행된 판')
    .requiredOption('--source <commit>', '내부 원본 커밋 SHA')
    .option('--yes', '태그를 실제로 만든다')
    .action(async (o: { version: string; source: string; yes?: boolean }) => {
      await jsonAction(undefined, (log) => tagRelease({ ...o, log }), () => true);
    });
  release.command('verify')
    .description('공개 주소로 끝까지 — 깨끗한 임시 홈에서 설치 → --version → self-update → 제거')
    .option('--version <x.y.z>', '고정 버전(없으면 latest)')
    .option('--public-repo <owner/name>', '공개 저장소', DEFAULT_PUBLIC_REPO)
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version?: string; publicRepo: string; json?: boolean }) => {
      await jsonAction(o.json, (log) => verifyRelease({ version: o.version, publicRepo: o.publicRepo, log }), (r) => r.ok);
    });
  release.command('notes')
    .description('두 ref 사이 착지로 변경 기록 초안(공개 전에 다듬는다)')
    .requiredOption('--from <ref>', '시작 ref')
    .option('--to <ref>', '끝 ref', 'HEAD')
    .action(async (o: { from: string; to: string }) => {
      const { draftReleaseNotes, readLandedCommits, renderReleaseNotes } = await import('../../scripts/release-notes.js');
      console.log(renderReleaseNotes(draftReleaseNotes(readLandedCommits(o.from, o.to), o.from, o.to)));
    });
  release.command('cut-branch')
    .description('원래 컷에 main 의 수리 커밋만 얹은 release/<v> 가지를 만들고 push. --append 는 이미 있는 가지에 fast-forward 로만 더 얹는다')
    .requiredOption('--version <v>', '릴리스 판(x.y.z)')
    .requiredOption('--base <sha>', '원래 컷 SHA')
    .requiredOption('--pick <sha...>', '차례로 얹을 main 커밋 SHA')
    .option('--append', '이미 있는 release/<v> 를 출발점으로 fast-forward push(강제 push 없음)')
    .option('--dry-run', '가지·worktree·push 없이 계획만 출력')
    .option('--json', '결과 한 줄 JSON(stdout)')
    .action(async (o: { version: string; base: string; pick: string[]; append?: boolean; dryRun?: boolean; json?: boolean }) => {
      await jsonAction(o.json, async (log) => cutReleaseBranch({ ...o, log }), () => true);
    });
  const runAction = async (o: { version: string; cutCommit?: string; mainCut?: boolean; prerelease?: string; dryRun?: boolean; ifReady?: boolean; forceFreeze?: boolean; json?: boolean }, logRun = console.log): Promise<boolean | AutoStartDeferral | undefined> => {
      // Only the rc rehearsal channel is operated for now (alpha/beta stay valid version shapes, not run options).
      if (o.prerelease !== undefined && o.prerelease !== 'rc') {
        const message = `--prerelease supports rc only: ${o.prerelease}`;
        if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, error: message })}\n`);
        else console.error(`⛔ ${message}`);
        process.exitCode = 1;
        return false;
      }
      const prerelease = o.prerelease as PrereleaseKind | undefined;
      if (!o.dryRun) {
        try {
          const frozen = readLandingFreeze(releaseRunDeps.freezeRoot);
          if (frozen) {
            debug.log('release.run', o.forceFreeze ? 'freeze-forced' : 'frozen', { version: o.version, reason: frozen.reason, until: frozen.until });
            if (!o.forceFreeze) {
              // `--if-ready` (the scheduled path) defers quietly; a direct run fails — the release run is run again after `freeze off`.
              if (o.ifReady) {
                if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: true, skipped: true, reason: 'frozen', detail: landingFreezeMessage(frozen) })}\n`);
                else logRun(`· ${landingFreezeMessage(frozen)} · 릴리스 루프 연기`);
              } else {
                if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, reason: 'frozen', error: landingFreezeMessage(frozen) })}\n`);
                else console.error(`⛔ ${landingFreezeMessage(frozen)} · 릴리스 루프 거부(--force-freeze 로만 강행)`);
                process.exitCode = 1;
              }
              return o.ifReady ? { deferred: true, reason: 'frozen' } : false;
            }
          }
        } catch (e) {
          if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
          else console.error(`⛔ ${(e as Error).message}`);
          process.exitCode = 1;
          return false;
        }
      }
      // A prerelease rehearsal never reads the stable version's readiness (checklist cells): it runs directly.
      if (o.ifReady && !o.dryRun && !prerelease) {
        try {
          const outcome = await runReleaseIfReady(o.version, {
            ledgerRoot: releaseRunDeps.ledgerRoot,
            readiness: (version, options) => releaseReadiness(version, { ledgerRoot: releaseRunDeps.ledgerRoot, checklist: releaseRunDeps.checklist, ...options }),
            run: () => runUnattendedRelease({ version: o.version, cutCommit: o.cutCommit, mainCut: o.mainCut, prerelease, forceFreeze: o.forceFreeze }, releaseRunDeps),
          });
          if (outcome.skipped) {
            if (o.json) await writeStdoutJson(`${JSON.stringify(outcome)}\n`);
            else logRun(`· 준비 안 됨 ${o.version} · ${outcome.reason} · ${outcome.detail}`);
            return { deferred: true, reason: outcome.reason };
          }
          const result = outcome.result;
          const ok = result.dryRun || result.state?.status === 'done' || result.state?.status === 'awaiting-approval';
          (o.json ? console.error : logRun)(`${result.dryRun ? '· 드라이런' : '▶ 릴리스 루프'} ${result.input.version} · 입력 ${JSON.stringify(result.input)}`);
          if (o.json) await writeStdoutJson(`${JSON.stringify({ ok, ...result })}\n`);
          if (!ok && !process.exitCode) process.exitCode = 1;
          return ok;
        } catch (e) {
          if (e instanceof LandingFrozenError) {
            // A freeze switched on after the entry check still defers the scheduled run rather than failing it.
            debug.log('release.run', 'frozen', { version: o.version, reason: e.freeze.reason, until: e.freeze.until, at: 'run-boundary' });
            if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: true, skipped: true, reason: 'frozen', detail: e.message })}\n`);
            else logRun(`· ${e.message} · 릴리스 루프 연기`);
            return { deferred: true, reason: 'frozen' };
          }
          if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
          else console.error(`⛔ ${(e as Error).message}`);
          process.exitCode = 1;
          return false;
        }
      }
      await jsonAction(o.json, async (log) => {
        const result = await runUnattendedRelease({ version: o.version, dryRun: o.dryRun, cutCommit: o.cutCommit, mainCut: o.mainCut, prerelease, forceFreeze: o.forceFreeze }, releaseRunDeps);
        log(`${result.dryRun ? '· 드라이런' : '▶ 릴리스 루프'} ${result.input.version} · 입력 ${JSON.stringify(result.input)}`);
        return result;
      }, (r) => r.dryRun || r.state?.status === 'done' || r.state?.status === 'awaiting-approval');
  };
  release.command('run')
    .description('릴리스 루프 실행 — 원장 직전 판과 release.loop 설정으로 그래프 입력 구성 · --dry-run 은 입력만 출력')
    .requiredOption('--version <v>', '공개할 판(x.y.z)')
    .option('--cut-commit <sha>', 'origin/main HEAD 대신 컷으로 쓸 커밋(이미 자른 release/<v> 끝 — 옛 경로)')
    .option('--main-cut', '옛 경로: 판 올림을 main 에 착지(기본은 release/<v> 가지에만 올린다)')
    .option('--prerelease <kind>', '미리보기 판(rc) — <v>-rc.<다음 빈 번호> · npm next · GitHub pre-release · docs-land/ops-upgrade/dev-bump 건너뜀')
    .option('--dry-run', '체크리스트·그래프 실행 없이 전체 입력 보기')
    .option('--if-ready', '준비되지 않았으면 사유를 출력하고 성공으로 건너뛴다')
    .option('--force-freeze', '동결 중 게이트·발행 강행(관측 기록) — 가지 컷은 동결이 필요 없다 · 동결은 비상 스위치로 남는다')
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version: string; cutCommit?: string; mainCut?: boolean; prerelease?: string; dryRun?: boolean; ifReady?: boolean; forceFreeze?: boolean; json?: boolean }) => { await runAction(o); });
  release.command('preflight')
    .description('컷 30분 전 사전 점검(읽기 전용) — 체크리스트 게이트 모의 · 발행 뒤 칸 · run --dry-run 입력 · 동결 · 일정/게이트 실측. ⛔ 있으면 exit 1')
    .requiredOption('--version <v>', '점검할 판(x.y.z)')
    .option('--publish-at <iso>', '계획 발행 시각(기본: 컷 뒤 첫 07·18시 KST)')
    .option('--json', '결과 한 줄 JSON(stdout)')
    .action(async (o: { version: string; publishAt?: string; json?: boolean }) => {
      try {
        const result = await releasePreflight(o.version, { publishAt: o.publishAt, releaseRunDeps });
        if (o.json) await writeStdoutJson(`${JSON.stringify(result)}\n`);
        else for (const line of formatPreflight(result)) console.log(line);
        if (result.blockers > 0) process.exitCode = 1;
      } catch (e) {
        if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
        else console.error(`⛔ ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
  release.command('resume')
    .description('실패한 릴리스 런을 이어 달린다 — cut-branch --append 로 고친 release/<v> 새 끝을 version-release 기록에 반영(빨리감기만·상태 백업) 뒤 --from 노드부터')
    .requiredOption('--run <runId>', '실패한 release-loop 런 ID')
    .requiredOption('--from <node>', '다시 시작할 노드(예: gate)')
    .option('--json', '결과 한 줄 JSON(stdout)')
    .action(async (o: { run: string; from: string; json?: boolean }) => {
      await jsonAction(o.json, async (log) => {
        const result = await resumeReleaseRun({ runId: o.run, from: o.from });
        log(`${result.tip.changed ? `↻ ${result.tip.branch} ${result.tip.from.slice(0, 12)} → ${result.tip.to.slice(0, 12)} (백업 ${result.tip.backup})` : `· ${result.tip.branch} 끝 그대로 ${result.tip.to.slice(0, 12)}`} · ${o.from} 부터 → ${result.state.status}`);
        return { tip: result.tip, status: result.state.status, runId: result.state.runId };
      }, (r) => r.status === 'done' || r.status === 'awaiting-approval');
    });
  release.command('auto-start')
    .description('판 일정의 컷 창에서 릴리스 시작을 미리 본다 · --apply 로 release run --if-ready 실행')
    .option('--window-minutes <n>', '컷 뒤 선택 창(분)', '15')
    .option('--apply', '선택한 판을 release run --if-ready 로 시작')
    .option('--json', '결과 한 줄 JSON(stdout)')
    .action(async (o: { windowMinutes: string; apply?: boolean; json?: boolean }) => {
      await jsonAction(o.json, async (log) => {
        const result = await autoStartScheduledRelease({
          windowMinutes: Number(o.windowMinutes), apply: o.apply, ledgerRoot: scheduleLedgerRoot(),
          readiness: (version, ledgerRoot, now) => releaseReadiness(version, { ledgerRoot, now: () => now, checklist: releaseRunDeps.checklist }),
          launch: async (version) => {
            const ran = await runAction({ version, ifReady: true, json: false }, log);
            if (ran && typeof ran === 'object' && ran.deferred) return ran;
            if (ran !== true) throw new Error(`release run 미시작 또는 실패: ${version}`);
          },
        });
        if (result.status === 'planned') log(`· 미리 보기 ${result.version} · 컷 ${result.cutAt} · 실행하려면 --apply`);
        else if (result.status === 'started') log(`▶ 릴리스 시작 ${result.version} · 컷 ${result.cutAt}`);
        else if (result.status === 'skipped') log(`· 릴리스 연기 ${result.version} · ${result.reason}`);
        else log('· 선택할 컷 없음');
        return result;
      }, () => true);
    });
}
