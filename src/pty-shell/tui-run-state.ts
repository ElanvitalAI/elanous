// ── TUI 실행 상태 — 턴(busy/idle) ⊕ 기동 판 ⊕ stale 판정 ──
//
// 바깥 제어자(`elanous pty state <ref>`)가 «지금 턴 중인가»와 «이 프로세스가 어느 판 코드로 도는가»를
// 화면 글자 grep 없이 알게 한다(대표 TUI OP 도그푸드 결함 #13).
//
// ⛔ 화면 하단 `⌥ HEAD@<sha>` 는 «세션 cwd 트리»의 HEAD 다 — 프로세스가 실은 코드가 아니다.
//    10-14 실측: 15:19 에 뜬 TUI 가 15:4x 설치 갱신(5c0f98f) 뒤에도 새 판처럼 보였다.
//    ⇒ 기동 판은 «기동 때 한 번» 잡아 manifest 행에 적고, 비교 대상(설치본 · 체크아웃 HEAD)은 «읽을 때» 잰다.
//
// 기록(TUI 쪽): 행 등록 직후 `startTuiRunStateRecorder` 가 판 ⊕ idle 을 적고, 대시보드가 턴 시작·끝에
//   `reportTuiTurn` 을 부른다. 기록 실패는 `debug.log('pty.tui-state', …)` — 조용히 삼키지 않는다.
// 판독(CLI 쪽): `describePtyRunState` 가 행 ⊕ 설치본 기록 ⊕ (체크아웃이면) 그 뿌리의 HEAD 로 판정한다.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import { codeRevision, packageVersion, readInstallMetadataCommit } from '../version/code-revision.js';
import { versionedDashboardInstallDir } from '../dashboard/stale-install-check.js';
import {
  updatePtyManifestBuild, updatePtyManifestTurn,
  type PtyBuildIdentity, type PtyManifestRow, type PtyTurnState,
} from './pty-manifest.js';

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 기동 판 ──

export interface RunningBuildDeps {
  readonly codeRoot?: string;
  readonly installRoot?: string;
  readonly versionDirOf?: (codeRoot: string, installRoot?: string) => string | undefined;
  readonly readInstallCommit?: (metadataPath: string) => string | undefined;
  /** 체크아웃 HEAD(설치본 판 폴더가 아닐 때만). */
  readonly revision?: () => string | undefined;
  readonly version?: () => string;
}

/** 이 프로세스가 실은 코드의 판. 설치본 판 폴더면 그 폴더의 install.json, 아니면 코드 뿌리의 git HEAD. */
export function resolveRunningBuild(deps: RunningBuildDeps = {}): PtyBuildIdentity {
  const codeRoot = deps.codeRoot ?? CODE_ROOT;
  const version = (deps.version ?? packageVersion)();
  const versionDir = (deps.versionDirOf ?? versionedDashboardInstallDir)(codeRoot, deps.installRoot);
  if (versionDir) {
    // 판 폴더의 install.json 만이 «실은 판»의 증거다 — 못 읽으면 다른 출처로 메우지 않고 모른다로 둔다.
    const sha = (deps.readInstallCommit ?? readInstallMetadataCommit)(join(versionDir, 'install.json')) ?? '';
    return { version, sha, source: sha ? 'installed' : 'unknown', codeRoot };
  }
  const sha = (deps.revision ?? codeRevision)() ?? '';
  return { version, sha, source: sha ? 'checkout' : 'unknown', codeRoot };
}

let bootBuild: PtyBuildIdentity | undefined;
/** 기동 판 — 처음 부른 순간 한 번 잡고 그대로 둔다(뒤에 트리 HEAD 가 움직여도 «실은 코드»는 그대로다). */
export function runningBuild(): PtyBuildIdentity {
  bootBuild ??= resolveRunningBuild();
  return bootBuild;
}

// ── 설치본 기록 ──

export interface InstalledRecord {
  readonly sha?: string;
  /** install.json `installedAt`(epoch ms) — 못 읽으면 undefined. */
  readonly installedAt?: number;
}

export function defaultInstallRoot(): string {
  return join(homedir(), '.local', 'share', 'elanous');
}

/** 지금 `current` 가 가리키는 설치본의 commit ⊕ 설치 시각. */
export function readCurrentInstallRecord(installRoot = defaultInstallRoot()): InstalledRecord {
  const path = join(installRoot, 'current', 'install.json');
  const sha = readInstallMetadataCommit(path);
  let installedAt: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { installedAt?: unknown };
    const t = typeof parsed.installedAt === 'string' ? Date.parse(parsed.installedAt) : NaN;
    if (Number.isFinite(t)) installedAt = t;
  } catch { /* 설치본 없음 */ }
  return { ...(sha ? { sha } : {}), ...(installedAt !== undefined ? { installedAt } : {}) };
}

export function readCheckoutHead(codeRoot: string): string | undefined {
  try {
    const r = runGitCommand(codeRoot, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    const sha = r.status === 0 ? String(r.stdout).trim() : '';
    return sha || undefined;
  } catch {
    return undefined;
  }
}

// ── stale 판정 ──

export type BuildStaleReason =
  /** 설치본 판으로 떴고 지금 설치본과 같다. */
  | 'same-as-installed'
  /** 설치본 판으로 떴는데 그 뒤 설치본이 바뀌었다 — 재기동해야 새 판. */
  | 'installed-moved'
  /** 체크아웃에서 떴고 그 뿌리의 HEAD 가 같다. */
  | 'same-as-checkout'
  /** 체크아웃에서 떴는데 그 뿌리의 HEAD 가 움직였다. */
  | 'checkout-moved'
  /** 판 기록이 없는 옛 행인데 설치본이 그 행보다 늦게 깔렸다(추정 — 설치본으로 떴다면 낡았다). */
  | 'started-before-install'
  /** 비교할 값을 못 얻었다 — «안 낡았다»가 아니다. */
  | 'unknown';

export interface BuildStaleness {
  /** null = 못 쟀다(⛔ false 로 접지 않는다). */
  readonly stale: boolean | null;
  readonly reason: BuildStaleReason;
}

export function judgeBuildStaleness(input: {
  readonly build?: PtyBuildIdentity;
  readonly installed: InstalledRecord;
  readonly checkoutHead?: string;
  readonly startedAt?: number;
}): BuildStaleness {
  const { build, installed } = input;
  if (build?.sha && build.source === 'installed') {
    if (!installed.sha) return { stale: null, reason: 'unknown' };
    return installed.sha === build.sha ? { stale: false, reason: 'same-as-installed' } : { stale: true, reason: 'installed-moved' };
  }
  if (build?.sha && build.source === 'checkout') {
    if (!input.checkoutHead) return { stale: null, reason: 'unknown' };
    return input.checkoutHead === build.sha ? { stale: false, reason: 'same-as-checkout' } : { stale: true, reason: 'checkout-moved' };
  }
  if (!build && input.startedAt !== undefined && installed.installedAt !== undefined && installed.installedAt > input.startedAt) {
    return { stale: true, reason: 'started-before-install' };
  }
  return { stale: null, reason: 'unknown' };
}

// ── 판독(CLI) ──

export type PtyTurnView = PtyTurnState | 'unknown';

export interface PtyRunStateView {
  readonly turn: PtyTurnView;
  readonly turnAt?: number;
  readonly build: PtyBuildIdentity | null;
  readonly installed: string | null;
  readonly stale: boolean | null;
  readonly staleReason: BuildStaleReason;
}

export interface DescribeRunStateDeps {
  readonly readInstalled?: () => InstalledRecord;
  readonly readCheckoutHead?: (codeRoot: string) => string | undefined;
}

/** manifest 행 하나의 턴 ⊕ 판 ⊕ stale. 행이 없거나 죽었으면 턴은 unknown. */
export function describePtyRunState(
  row: Pick<PtyManifestRow, 'alive' | 'startedAt' | 'kind' | 'turnState' | 'turnAt' | 'build'> | null,
  deps: DescribeRunStateDeps = {},
): PtyRunStateView {
  let installed: InstalledRecord = {};
  try { installed = (deps.readInstalled ?? readCurrentInstallRecord)(); } catch { /* unknown */ }
  const build = row?.build;
  let checkoutHead: string | undefined;
  // 판독 예외는 «모른다»(stale=null)로 — 조회 명령 자체를 깨지 않는다.
  try {
    if (build?.source === 'checkout' && build.codeRoot) checkoutHead = (deps.readCheckoutHead ?? readCheckoutHead)(build.codeRoot);
  } catch { checkoutHead = undefined; }
  // 판 기록 없는 옛 행의 «설치 뒤에 떴나» 추정은 elanous TUI 행에만 건다(셸 PTY 는 판과 무관하다).
  const staleness = judgeBuildStaleness({
    ...(build ? { build } : {}),
    installed,
    ...(checkoutHead ? { checkoutHead } : {}),
    ...(row && row.kind === 'tui' ? { startedAt: row.startedAt } : {}),
  });
  const turn: PtyTurnView = row?.alive && row.turnState ? row.turnState : 'unknown';
  return {
    turn,
    ...(turn !== 'unknown' && row?.turnAt ? { turnAt: row.turnAt } : {}),
    build: build ?? null,
    installed: installed.sha ?? null,
    stale: staleness.stale,
    staleReason: staleness.reason,
  };
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '-';
}

// ── 기록(TUI) ──

export interface TuiRunStateRecorderDeps {
  readonly now?: () => number;
  readonly build?: () => PtyBuildIdentity;
  readonly writeBuild?: (id: string, build: PtyBuildIdentity) => boolean;
  readonly writeTurn?: (id: string, turn: PtyTurnState, at: number) => boolean;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

interface ActiveRecorder {
  readonly surfaceId: string;
  readonly now: () => number;
  readonly writeTurn: (id: string, turn: PtyTurnState, at: number) => boolean;
  readonly log: (event: string, data: Record<string, unknown>) => void;
  last?: PtyTurnState;
}

let active: ActiveRecorder | null = null;

const defaultLog = (event: string, data: Record<string, unknown>): void => { debug.log('pty.tui-state', event, data); };

/** TUI 행 등록 직후 부른다 — 판을 적고 턴을 idle 로 연다. 이후 `reportTuiTurn` 이 이 행에 적는다. */
export function startTuiRunStateRecorder(surfaceId: string, deps: TuiRunStateRecorderDeps = {}): () => void {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const writeTurn = deps.writeTurn ?? updatePtyManifestTurn;
  let build: PtyBuildIdentity | undefined;
  try { build = (deps.build ?? runningBuild)(); } catch (error) {
    log('build-resolve-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
  }
  if (build) {
    const ok = (() => { try { return (deps.writeBuild ?? updatePtyManifestBuild)(surfaceId, build); } catch { return false; } })();
    log(ok ? 'build-recorded' : 'build-write-failed', { ptyId: surfaceId, sha: build.sha, version: build.version, source: build.source });
  }
  const recorder: ActiveRecorder = { surfaceId, now, writeTurn, log };
  active = recorder;
  writeTurnState(recorder, 'idle');
  return () => { if (active === recorder) active = null; };
}

/** 대시보드가 턴 시작(busy)·끝(idle)에 부른다. 녹음기가 없으면(자기보고 꺼짐) 아무것도 안 한다. */
export function reportTuiTurn(turn: PtyTurnState): void {
  if (!active || active.last === turn) return;
  writeTurnState(active, turn);
}

function writeTurnState(recorder: ActiveRecorder, turn: PtyTurnState): void {
  const at = recorder.now();
  let ok = false;
  try { ok = recorder.writeTurn(recorder.surfaceId, turn, at); } catch { ok = false; }
  if (ok) recorder.last = turn;
  // 실패는 관측으로 남긴다 — 바깥 제어자는 그 사이 «unknown/낡은 값»을 본다. 성공은 남기지 않는다(턴마다 두 줄은 소음).
  else recorder.log('turn-write-failed', { ptyId: recorder.surfaceId, turn, at });
}

export function resetTuiRunStateForTesting(): void {
  active = null;
  bootBuild = undefined;
}
