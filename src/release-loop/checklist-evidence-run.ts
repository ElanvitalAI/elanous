// CHECKLIST-E4-RUN-RECEIPT — the execution half of `release checklist evidence run <칸>`.
// HQ(임대 보유·좌석) 호스트는 bun test 를 돌리지 않는다. 시험은 넥서스 호스트 원장(#39165)에 등록된 시험 호스트로 ssh 로 보내고
// (gate-remote runOnRemote: HQ 와 같은 커밋 · 셸 없는 argv · 격리 우주), 그 호스트의 운영 logs.db 에 checklist.evidence.run 을 남긴다.
// 원장 쓰기(근거 한 줄)는 HQ 에 남는다 — 이 모듈은 실행·영수만 다룬다(OP #112782).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gateRemoteHostCap, realGateRemoteRunner, resolveGateRemoteSettings, runOnRemote, type GateRemoteRunner, type GateRemoteSettings } from '../self-implement/gate-remote.js';

// JUD #39237 ⓒ1: 칸 제목은 여러 자리가 쓰는 원장 텍스트다 — 셸로 돌리지 않는다. 허용 꼴은 «bun test <저장소 안 상대 경로…>» 하나뿐.
const EVIDENCE_PATH_ARG = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u;
export function parseEvidenceRunCommand(command: string): { argv: string[] } | { refused: string } {
  if (/[^A-Za-z0-9._/\- ]/u.test(command)) return { refused: '허용 밖 문자(셸 메타문자·따옴표·변수 등)가 있다' };
  const [binary, sub, ...paths] = command.trim().split(/ +/u);
  if (binary !== 'bun' || sub !== 'test') return { refused: '허용 명령은 «bun test <저장소 안 상대 경로…>» 뿐이다' };
  if (!paths.length) return { refused: '시험 경로가 하나 이상 있어야 한다' };
  for (const path of paths) {
    if (!EVIDENCE_PATH_ARG.test(path)) return { refused: `저장소 안 상대 경로가 아니다(절대 경로·옵션 불가): ${path}` };
    if (path.split('/').includes('..')) return { refused: `«..» 경로는 허용하지 않는다: ${path}` };
  }
  return { argv: ['bun', 'test', ...paths] };
}

// ── workspace package: run a package's tests from that package directory ─────────────────────────
// 0.3.31 PWA-INTAKE-N1-N5A-N6A: apps/pwa 시험은 저장소 루트에서 돌리면 그 패키지의 의존성(apps/pwa/node_modules)을 못 찾는다.
// 경로 판정은 구조로 한다(OP #113166 ①: package.json 존재 · 문자열 정규식 0) — 경로에서 위로 올라가 루트 아래에서 처음 만나는 package.json 디렉터리.
export interface EvidencePackageFs { isFile: (path: string) => boolean; exists: (path: string) => boolean; realpath: (path: string) => string }
const nodePackageFs: EvidencePackageFs = {
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
};
/** The package's own lockfiles (bun text and binary forms): a package with one is installed on its own — the root has no workspaces. */
const PACKAGE_LOCKFILES = ['bun.lock', 'bun.lockb'] as const;
/** Install argv for a package whose dependencies are absent on the test host checkout (no shell · lockfile only). */
export const EVIDENCE_PACKAGE_INSTALL_ARGV = ['bun', 'install', '--frozen-lockfile'] as const;

/** Repo-relative directory of the nearest package.json at or above `path`, below the repo root (the root package.json never counts); null = root. */
export function owningPackageDir(root: string, path: string, fs: EvidencePackageFs = nodePackageFs): string | null {
  const top = resolve(root);
  for (let dir = resolve(top, path); dir !== top && dir.startsWith(`${top}${sep}`); dir = dirname(dir)) {
    if (fs.isFile(join(dir, 'package.json'))) return relative(top, dir);
  }
  return null;
}

export type EvidenceRunPlan = { packageDir: string | null; argv: string[]; install: boolean } | { refused: string };

/**
 * Where an allow-listed `bun test <paths…>` runs: every path under one workspace package → cwd = that package directory and the paths
 * rewritten relative to it (argv stays `bun test <paths>`); every path at the root → unchanged. Mixed packages, or root mixed with a
 * package, are refused (nothing run). The package directory must resolve (realpath) inside the repo — a symlink out of it is refused.
 * `install` = the package carries its own lockfile and its node_modules is absent.
 */
export function evidenceRunPlan(root: string, argv: readonly string[], fs: EvidencePackageFs = nodePackageFs): EvidenceRunPlan {
  const [binary, sub, ...paths] = argv;
  const owners = [...new Set(paths.map((path) => owningPackageDir(root, path, fs)))];
  const [packageDir, ...others] = owners;
  if (others.length) return { refused: `시험 경로가 서로 다른 패키지에 걸쳐 있다(${owners.map((owner) => owner ?? '저장소 루트').join(' · ')}) — 한 명령은 한 패키지(또는 루트)의 시험만 담는다` };
  if (packageDir === undefined || packageDir === null) return { packageDir: null, argv: [...argv], install: false };
  const top = resolve(root);
  const packagePath = join(top, packageDir);
  let realTop: string, realPackage: string;
  try { realTop = fs.realpath(top); realPackage = fs.realpath(packagePath); } catch { return { refused: `패키지 디렉터리의 실제 경로를 읽지 못했다: ${packageDir}` }; }
  if (!realPackage.startsWith(`${realTop}${sep}`)) return { refused: `패키지 디렉터리가 저장소 밖을 가리킨다(심볼릭 링크): ${packageDir} → ${realPackage}` };
  const rewritten = paths.map((path) => {
    const inside = relative(packagePath, resolve(top, path));
    if (!inside) return './';
    return path.endsWith('/') ? `${inside}/` : inside;
  });
  const install = PACKAGE_LOCKFILES.some((name) => fs.isFile(join(packagePath, name))) && !fs.exists(join(packagePath, 'node_modules'));
  return { packageDir, argv: [binary!, sub!, ...rewritten], install };
}

/** Child env: allow-listed keys only — no credential, token or API-key variable reaches the evidence command. */
const EVIDENCE_ENV_PASSTHROUGH = ['PATH', 'LANG'] as const;
export function evidenceRunEnv(parent: NodeJS.ProcessEnv, universe: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of EVIDENCE_ENV_PASSTHROUGH) { const value = parent[key]; if (value !== undefined) env[key] = value; }
  return { ...env, HOME: join(universe, 'home'), TMPDIR: join(universe, 'tmp'), NODE_ENV: 'test', ELANOUS_STATE_DIR: universe, ELANOUS_STATE_DIR_SOURCE: 'explicit' };
}

export type EvidenceSpawn = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { status: number | null; error?: Error };
const evidenceSpawn: EvidenceSpawn = (command, args, options) => spawnSync(command, args, { ...options, shell: false, stdio: ['ignore', 2, 2] });

export function runInIsolatedUniverse(argv: readonly string[], cwd: string, parentEnv: NodeJS.ProcessEnv = process.env, spawn: EvidenceSpawn = evidenceSpawn): { status: number | null; error?: string } {
  const universe = mkdtempSync(join(tmpdir(), 'elanous-evidence-run-'));
  try {
    mkdirSync(join(universe, 'home')); mkdirSync(join(universe, 'tmp'));
    // 셸 없이 argv 그대로 · 자식 출력은 stderr 로(영수 stdout 과 섞이지 않는다).
    const result = spawn(argv[0]!, argv.slice(1), { cwd, env: evidenceRunEnv(parentEnv, universe) });
    return { status: result.status, ...(result.error ? { error: result.error.message } : {}) };
  } finally { rmSync(universe, { recursive: true, force: true }); }
}

// ── registry: which hosts may run the test ─────────────────────────────────────────────────────
/** One nexus host registry entry as this module reads it: its key and the names it answers to. */
export interface RegistryHostEntry { key: string; host: string; aliases?: readonly string[] }

/**
 * The registry key a host name stands for — the key itself, the record's host, or one of its registry aliases
 * (so a self-reported «MacStudioB1» maps to the entry «node-b» when that entry lists it). Null when unregistered.
 * The mapping is the registry's own data, not a hardcoded table (OP #112782).
 */
export function registryHostName(name: string, registry: readonly RegistryHostEntry[]): string | null {
  return registry.find((entry) => entry.key === name || entry.host === name || (entry.aliases ?? []).includes(name))?.key ?? null;
}

/**
 * Test hosts = the nexus host registry's entries in registry order, minus the invoking HQ host and any seat host (matched through the registry).
 * The registry (HostRecord: host · aliases? · seat? · channel · installedSha · heartbeat · state) carries no role/capability field,
 * so every other registered host is a candidate and reachability decides (OP #112782: node-b · mbp · node-c are registered there).
 */
export function evidenceTestHosts(registry: readonly RegistryHostEntry[], excluded: readonly string[]): string[] {
  const skipped = new Set(excluded.map((name) => registryHostName(name, registry) ?? name));
  return registry.map((entry) => entry.key).filter((key) => !skipped.has(key));
}

// ── remote: the test host side ───────────────────────────────────────────────────────────────
/** Repo-relative entry the test host runs at the HQ commit (checkout root is the cwd). */
export const EVIDENCE_REMOTE_ENTRY = 'src/release-loop/checklist-evidence-remote-entry.ts';
/** The one stdout line the remote entry prints: the receipt of what it ran and logged. */
export const EVIDENCE_RECEIPT_MARKER = '__CHECKLIST_EVIDENCE_RECEIPT=';

export interface EvidenceRunRequest { runId: string; cellId: string; version: string; host: string; ledgerHost: string; commit: string; argv: readonly string[] }
export interface EvidenceRunReceipt { runId: string; cellId: string; version: string; host: string; selfReportedHost: string; ledgerHost: string; commit: string; command: string; rc: number; durationMs: number; at: string;
  /** Repo-relative package directory the test ran from (absent = repo root). */
  cwd?: string }

/** Remote argv (no shell): bun + the entry + positional request fields + the allow-listed test argv. */
export function evidenceRemoteArgv(request: EvidenceRunRequest): string[] {
  return ['bun', EVIDENCE_REMOTE_ENTRY, request.runId, request.cellId, request.version, request.host, request.ledgerHost, request.commit, ...request.argv];
}

export interface EvidenceReceiptDeps {
  execute: (argv: readonly string[], cwd: string) => { status: number | null; error?: string };
  log: (data: Record<string, unknown>) => void;
  selfReportedHost: () => string;
  now: () => Date;
  cwd: string;
  print: (line: string) => void;
  packageFs?: EvidencePackageFs;
}

/** Test host side: re-validate the argv, run it once in an isolated universe, log the event to this host's logs.db, print the receipt. */
export function runEvidenceReceipt(args: readonly string[], deps: EvidenceReceiptDeps): number {
  const [runId, cellId, version, host, ledgerHost, commit, ...argv] = args;
  if (!runId || !cellId || !version || !host || !ledgerHost || !commit || !argv.length) throw new Error('evidence receipt: runId cellId version host ledgerHost commit argv… required');
  const command = argv.join(' ');
  const parsed = parseEvidenceRunCommand(command);
  if ('refused' in parsed || parsed.argv.join(' ') !== command) throw new Error(`evidence receipt: argv is not the allow-listed form: ${command}`);
  const plan = evidenceRunPlan(deps.cwd, parsed.argv, deps.packageFs);
  if ('refused' in plan) throw new Error(`evidence receipt: ${plan.refused}: ${command}`);
  const cwd = plan.packageDir === null ? deps.cwd : join(deps.cwd, plan.packageDir);
  const started = deps.now();
  // 패키지 자체 잠금 파일이 있고 node_modules 가 없으면(루트 설치는 워크스페이스를 덮지 않는다) 그 디렉터리에서 잠금 그대로 설치한다.
  const install = plan.install ? deps.execute(EVIDENCE_PACKAGE_INSTALL_ARGV, cwd) : null;
  const installRc = install ? install.status ?? 1 : null; // Source: a signal-killed install (null status) is a failure, like the test rc below (NUMGUARD)
  const outcome = install && installRc !== 0
    ? { status: installRc, error: `${EVIDENCE_PACKAGE_INSTALL_ARGV.join(' ')} rc ${installRc}${install.error ? `: ${install.error}` : ''}` }
    : deps.execute(plan.argv, cwd);
  const durationMs = deps.now().getTime() - started.getTime();
  const rc = outcome.status ?? 1;
  const receipt: EvidenceRunReceipt = { runId, cellId, version, host, selfReportedHost: deps.selfReportedHost(), ledgerHost, commit, command, rc, durationMs, at: started.toISOString(),
    ...(plan.packageDir === null ? {} : { cwd: plan.packageDir }) };
  deps.log({ ...receipt, layer: 'test', synthetic: true, executedOn: host, ...(plan.packageDir === null ? {} : { argv: plan.argv }), ...(installRc === null ? {} : { installRc }),
    ...(outcome.error ? { error: outcome.error } : {}) });
  deps.print(`${EVIDENCE_RECEIPT_MARKER}${JSON.stringify(receipt)}`);
  return rc;
}

export function parseEvidenceReceipt(stdout: string): EvidenceRunReceipt | null {
  const line = stdout.split(/\r?\n/u).reverse().find((row) => row.startsWith(EVIDENCE_RECEIPT_MARKER));
  if (!line) return null;
  try {
    const receipt = JSON.parse(line.slice(EVIDENCE_RECEIPT_MARKER.length)) as Partial<EvidenceRunReceipt>;
    return typeof receipt.runId === 'string' && typeof receipt.cellId === 'string' && typeof receipt.rc === 'number' && typeof receipt.at === 'string'
      ? receipt as EvidenceRunReceipt : null;
  } catch { return null; }
}

// ── HQ side: dispatch over ssh at the HQ commit ──────────────────────────────────────────────
/** Lines of remote test output kept for the result (출처: 시험 실패 요약이 한 화면에 들어오는 꼬리 — bun test 실패 블록·요약 줄). */
export const EVIDENCE_OUTPUT_TAIL_LINES = 40;
export function outputTail(text: string, lines = EVIDENCE_OUTPUT_TAIL_LINES): string {
  return text.trimEnd().split(/\r?\n/u).slice(-lines).join('\n');
}

export type EvidenceDispatchOutcome =
  | { kind: 'ran'; rc: number; receipt: EvidenceRunReceipt | null; outputTail: string }
  | { kind: 'unreachable'; reason: string };

/** Reuses gate-remote runOnRemote: pushes the exact HQ commit to the host's mirror, checks it out detached in a scratch dir, runs argv quoted (no shell interpolation). */
export function dispatchEvidenceRun(request: EvidenceRunRequest, repo: string, deps: { settings?: GateRemoteSettings; runner?: GateRemoteRunner } = {}): EvidenceDispatchOutcome {
  const settings = deps.settings ?? resolveGateRemoteSettings(undefined);
  const outcome = runOnRemote({ repo, host: request.host, mirror: settings.mirror, commit: request.commit, argv: evidenceRemoteArgv(request), hostCap: gateRemoteHostCap(settings, request.host) },
    deps.runner ?? realGateRemoteRunner);
  if (outcome.kind === 'busy') return { kind: 'unreachable', reason: `busy${outcome.occupied !== undefined ? ` (${outcome.occupied} slots)` : ''}` };
  if (outcome.kind === 'infra') return { kind: 'unreachable', reason: outcome.reason };
  return { kind: 'ran', rc: outcome.rc, receipt: parseEvidenceReceipt(outcome.stdout.toString('utf8')), outputTail: outputTail(outcome.stderr.toString('utf8')) };
}
