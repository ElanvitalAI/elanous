// `elanous release` — 공개 배포 한 판을 «명령»으로 (버전 매뉴얼 내부 문서 `MANUAL-versioning-and-release-2026-09-25` §A).
//
//   elanous release prepare --version <x.y.z[-rc.N]> [--source <ref>] [--out <dir>] [--notes-from <ref>] [--skip-e2e]
//   elanous release publish --dir <prepare 산출> --notes-file <본문> [--yes]
//   elanous release tag --version <x.y.z> --source <commit> [--yes]
//   elanous release verify  [--version <x.y.z>]
//   elanous release notes   --from <ref> [--to <ref>]
//   elanous release run     --version <x.y.z> [--dry-run] [--json] [--if-ready]
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
import { userConfigPath } from '../user-config.js';
import { addItem, devVersion, listChecklist, removeItem, seedFromRoadmap, setItem, summarizeChecklist, type ChecklistStatus, type ChecklistDisposition } from '../release-loop/checklist.js';
import { writeStdoutJson } from './stdout-json.js';
import { runUnattendedRelease, type UnattendedReleaseDeps } from '../../scripts/release-loop/unattended-release.js';
import { releaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { runReleaseIfReady } from './release-run-if-ready.js';

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
    log(`③ 공개 커밋 ${publicCommit.slice(0, 12)} (${publicRepo} main 위)`);

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
    { what: `공개 저장소 ${m.publicRepo} main 푸시(${m.publicCommit.slice(0, 12)})`, command: 'git', args: ['push', 'origin', 'HEAD:main'], cwd: m.publicDir },
    {
      what: `릴리스 ${m.tag}${m.prerelease ? ' (prerelease)' : ''} 생성 ⊕ 자산 ${assets.length}(${assets.join(' · ')})`,
      command: 'gh',
      args: ['release', 'create', m.tag, ...assets.map((name) => join(m.distDir, name)), '--repo', m.publicRepo, '--target', m.publicCommit,
        '--title', `elanous ${m.tag}`, '--notes-file', notesFile, ...(m.prerelease ? ['--prerelease'] : [])],
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
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
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
  if (!isReleaseVersion(resolved)) throw new Error(`체크리스트 판 또는 별칭이 아니다: ${v}`);
  return resolved;
}

async function checklistOutput(v: string, codenames: Record<string, string>, mode: 'list' | 'status', json?: boolean): Promise<void> {
  const data = listChecklist(v);
  const summary = summarizeChecklist(data);
  const result = { ...data, codename: codenames[v] ?? '', ...summary };
  if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
  console.log(`${v}${result.codename ? ` (${result.codename})` : ''} · 공개 ${data.released || '없음'} · 개발 ${data.dev}`);
  if (mode === 'list') {
    for (const item of data.items) console.log(`${({ green: '🟢', yellow: '🟡', red: '🔴', done: '✅' } as const)[item.status]} ${item.id} ${item.title}${item.owner ? ` · ${item.owner}` : ''}`);
  } else {
    console.log(`🟢 ${summary.green} · 🟡 ${summary.yellow} · 🔴 ${summary.red} · ✅ ${summary.done}`);
    console.log(`🔴 칸: ${summary.blocked.join(', ') || '없음'}`);
    console.log(`담당별: ${Object.entries(summary.byOwner).map(([owner, count]) => `${owner} ${count}`).join(' · ') || '없음'}`);
  }
}

export function registerReleaseCommands(program: Command, releaseRunDeps: UnattendedReleaseDeps = {}): void {
  const release = program.command('release').description('공개 배포 한 판 — prepare(로컬) → publish(--yes) → verify (docs/manual/MANUAL-versioning-and-release-2026-09-25.md)');
  const checklist = release.command('checklist').description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON');
  const context = (cmd: Command) => {
    const opts = { ...(cmd.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.opts() as { version?: string; json?: boolean }) };
    const codenames = checklistCodenames();
    return { version: checklistVersion(opts.version, codenames), codenames, json: opts.json };
  };
  const withContext = (cmd: Command) => cmd.option('--version <v>', '판 또는 별칭').option('--json', '결과 JSON');
  withContext(checklist.command('list').description('모든 칸')).action(async (_opts: unknown, cmd: Command) => {
    const { version, codenames, json } = context(cmd);
    await checklistOutput(version, codenames, 'list', json);
  });
  withContext(checklist.command('status').description('상태 요약')).action(async (_opts: unknown, cmd: Command) => {
    const { version, codenames, json } = context(cmd);
    await checklistOutput(version, codenames, 'status', json);
  });
  withContext(checklist.command('add <id> <title>').description('칸 추가')).option('--owner <owner>', '담당').action((id: string, title: string, opts: { owner?: string }, cmd: Command) => {
    const { version, json } = context(cmd);
    const data = addItem(version, { id, title, ...(opts.owner !== undefined ? { owner: opts.owner } : {}) });
    if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 추가`);
  });
  withContext(checklist.command('set <id>').description('칸 상태·근거·담당·처분 갱신'))
    .option('--status <status>', 'green|yellow|red|done').option('--evidence <evidence>', '근거').option('--owner <owner>', '담당')
    .option('--disposition <disposition>', 'move|known-issue|block')
    .action((id: string, opts: { status?: string; evidence?: string; owner?: string; disposition?: string }, cmd: Command) => {
      const { version, json } = context(cmd);
      if (opts.status !== undefined && !['green', 'yellow', 'red', 'done'].includes(opts.status)) throw new Error(`잘못된 상태: ${opts.status}`);
      if (opts.disposition !== undefined && !['move', 'known-issue', 'block'].includes(opts.disposition)) throw new Error(`잘못된 처분: ${opts.disposition}`);
      if (opts.status === undefined && opts.evidence === undefined && opts.owner === undefined && opts.disposition === undefined) throw new Error('갱신할 칸을 지정하라');
      const data = setItem(version, id, { ...(opts.status !== undefined ? { status: opts.status as ChecklistStatus } : {}), ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}), ...(opts.owner !== undefined ? { owner: opts.owner } : {}), ...(opts.disposition !== undefined ? { disposition: opts.disposition as ChecklistDisposition } : {}) }, process.env.ELANOUS_TRACK || 'cli');
      if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 갱신`);
    });
  withContext(checklist.command('rm <id>').description('칸 삭제')).action((id: string, _opts: unknown, cmd: Command) => {
    const { version, json } = context(cmd);
    const data = removeItem(version, id, process.env.ELANOUS_TRACK || 'cli');
    if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${id} 삭제`);
  });
  withContext(checklist.command('seed').description('마크다운 로드맵에서 빈 칸 들이기')).requiredOption('--from <file>', '로드맵 파일')
    .action((opts: { from: string }, cmd: Command) => {
      const { version, json } = context(cmd);
      const data = seedFromRoadmap(version, readFileSync(opts.from, 'utf8'));
      if (json) console.log(JSON.stringify(data)); else console.log(`✅ ${version} ${data.items.length}칸`);
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
  release.command('run')
    .description('릴리스 루프 실행 — 원장 직전 판과 release.loop 설정으로 그래프 입력 구성 · --dry-run 은 입력만 출력')
    .requiredOption('--version <v>', '공개할 판(x.y.z)')
    .option('--dry-run', '체크리스트·그래프 실행 없이 전체 입력 보기')
    .option('--if-ready', '준비되지 않았으면 사유를 출력하고 성공으로 건너뛴다')
    .option('--json', '결과 한 줄 JSON(stdout) · 사람 줄은 stderr')
    .action(async (o: { version: string; dryRun?: boolean; ifReady?: boolean; json?: boolean }) => {
      if (o.ifReady && !o.dryRun) {
        try {
          const outcome = await runReleaseIfReady(o.version, {
            ledgerRoot: releaseRunDeps.ledgerRoot,
            readiness: (version, options) => releaseReadiness(version, { ledgerRoot: releaseRunDeps.ledgerRoot, checklist: releaseRunDeps.checklist, ...options }),
            run: () => runUnattendedRelease({ version: o.version }, releaseRunDeps),
          });
          if (outcome.skipped) {
            if (o.json) await writeStdoutJson(`${JSON.stringify(outcome)}\n`);
            else console.log(`· 준비 안 됨 ${o.version} · ${outcome.reason} · ${outcome.detail}`);
            return;
          }
          const result = outcome.result;
          const ok = result.dryRun || result.state?.status === 'done' || result.state?.status === 'awaiting-approval';
          (o.json ? console.error : console.log)(`${result.dryRun ? '· 드라이런' : '▶ 릴리스 루프'} ${result.input.version} · 입력 ${JSON.stringify(result.input)}`);
          if (o.json) await writeStdoutJson(`${JSON.stringify({ ok, ...result })}\n`);
          if (!ok && !process.exitCode) process.exitCode = 1;
        } catch (e) {
          if (o.json) await writeStdoutJson(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
          else console.error(`⛔ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      await jsonAction(o.json, async (log) => {
        const result = await runUnattendedRelease({ version: o.version, dryRun: o.dryRun }, releaseRunDeps);
        log(`${result.dryRun ? '· 드라이런' : '▶ 릴리스 루프'} ${result.input.version} · 입력 ${JSON.stringify(result.input)}`);
        return result;
      }, (r) => r.dryRun || r.state?.status === 'done' || r.state?.status === 'awaiting-approval');
    });
}
