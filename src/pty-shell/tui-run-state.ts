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

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { debug } from '../debug/log.js';
import { createHerdrAgentReporter, guardHerdrReleaseOnSignal, type HerdrAgentReporterLike, type HerdrSignalTarget } from './herdr-agent-report.js';
import { runGitCommand } from '../git-fs/runner.js';
import { codeRevision, packageVersion, readInstallMetadataCommit } from '../version/code-revision.js';
import {
  buildStaleInstallRelaunchCommand,
  formatStaleInstallNotice,
  versionedDashboardInstallDir,
} from './stale-install-check.js';
import {
  updatePtyManifestAbortRequested, updatePtyManifestBuild, updatePtyManifestProgress, updatePtyManifestTurn,
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

// ── 매 턴 자기 건강 한 줄(TUI-SELF-HEALTH-LINE · 0.2.34) ──
//
// 대시보드 턴 프리앰블에 매 턴 실리는 자기 관측 한 줄: «실행 판 vs 설치본» 낡음 판정
// (judgeBuildStaleness ⊕ readCurrentInstallRecord — 이미 있는 실물)에 «직전 30분 자기 오류»
// ·«크레딧 사용» 재료를 얹는다. 낡은 판이면 재기동 필요를 말하되 안내 문면·재기동 명령은
// stale-install-check 의 기존 재료(formatStaleInstallNotice · buildStaleInstallRelaunchCommand)를
// 그대로 쓴다 — 문면을 두벌로 만들지 않는다.
//
// ⚠️ 미결(이 모듈이 정하지 않는다): ① 직전 30분 창에서 «어떤 이벤트를 자기 오류로 세는지» —
//   호출자가 집계해 count·sample 로 넘긴다. ② 크레딧 사용 재료를 무엇으로 잴지 — 호출자가 만든
//   값을 넘긴다. 두 축은 계약이 정해지는 즉시 호출부에서 주입하면 된다.

export interface SelfHealthErrors {
  /** 직전 30분 창의 자기 오류 건수. 0 = 오류 없음. */
  readonly count: number;
  /** 오류를 대표하는 한 줄(첫 오류 요약 등). 없으면 개수만 말한다. */
  readonly sample?: string;
}

export interface SelfHealthLineDeps {
  /** 기동 판 — 기본 runningBuild(기동 때 한 번 잡힌 값). */
  readonly build?: () => PtyBuildIdentity;
  /** 지금 current 설치본 기록 — 기본 readCurrentInstallRecord. */
  readonly readInstalled?: () => InstalledRecord;
  /** 체크아웃 HEAD 재독기 — 기동 판이 checkout 일 때만 불린다. 기본 readCheckoutHead. */
  readonly readCheckoutHead?: (codeRoot: string) => string | undefined;
  /** 재기동 명령에 얹을 대화 id — 없으면 안내 문면만. */
  readonly sessionId?: string;
  /** 새 판 안내 회차(formatStaleInstallNotice notifiedCount) — 기본 1. */
  readonly notifiedCount?: number;
  /** 크레딧 사용 재료(호출자가 만든 값) — 없으면 그 축은 생략된다. */
  readonly creditUsage?: string;
}

/** 매 턴 자기 건강 한 줄. 판 축 재료가 깨져도 오류·크레딧 축은 살리고, 말할 것이 없으면 null —
 *  줄이 턴을 막지 않는다(fail-soft). */
export function buildSelfHealthLine(
  errors: SelfHealthErrors | null | undefined,
  deps: SelfHealthLineDeps = {},
): string | null {
  const segments: string[] = [];
  try {
    const build = (deps.build ?? runningBuild)();
    const installed = (deps.readInstalled ?? readCurrentInstallRecord)();
    let checkoutHead: string | undefined;
    if (build.source === 'checkout' && build.codeRoot) {
      checkoutHead = (deps.readCheckoutHead ?? readCheckoutHead)(build.codeRoot);
    }
    const staleness = judgeBuildStaleness({ build, installed, ...(checkoutHead ? { checkoutHead } : {}) });
    segments.push(`실행 판 ${build.version}@${shortSha(build.sha)}(${build.source})`);
    if (staleness.stale === true) {
      const relaunch = deps.sessionId
        ? ` · 다시 띄우기: ${buildStaleInstallRelaunchCommand(deps.sessionId)}`
        : '';
      if (staleness.reason === 'installed-moved' && build.sha && installed.sha) {
        segments.push(`낡은 판 — 재기동 필요: ${formatStaleInstallNotice(
          { state: 'changed', bootCommit: build.sha, installedCommit: installed.sha },
          deps.notifiedCount ?? 1,
        )}${relaunch}`);
      } else {
        segments.push(`낡은 판(${staleness.reason}) — 재기동 필요${relaunch}`);
      }
    } else if (staleness.stale === false) {
      segments.push(`판 최신(${staleness.reason})`);
    } else {
      // stale=null 은 «안 낡았다»가 아니다 — 못 잼을 못 잼으로 말한다.
      segments.push(`판 낡음 모름(${staleness.reason})`);
    }
  } catch {
    // 판 축 재료가 깨져도 오류·크레딧 축은 살린다 — 관측이 턴을 막지 않는다.
  }
  if (errors) {
    segments.push(errors.count > 0
      ? `직전 30분 자기 오류 ${errors.count}건${errors.sample ? ` — 대표: ${errors.sample}` : ''}`
      : '직전 30분 자기 오류 0건');
  }
  if (deps.creditUsage) segments.push(`크레딧 사용 ${deps.creditUsage}`);
  return segments.length > 0 ? `[자기 건강] ${segments.join(' · ')}` : null;
}

// ── 판독(CLI) ──

export type PtyTurnView = PtyTurnState | 'unknown';

export interface PtyRunStateView {
  readonly turn: PtyTurnView;
  readonly turnAt?: number;
  /** 마지막 진전 시각(SURVIVAL-PROGRESS-CLOCK) — 기록 없는 행·옛 판은 undefined. */
  readonly progressAt?: number;
  /** Esc 로 턴 중단을 청한 시각 — 이 뒤로 busy 가 지속되면 abort-ignored 판정 재료. */
  readonly abortRequestedAt?: number;
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
  row: Pick<PtyManifestRow, 'alive' | 'startedAt' | 'kind' | 'turnState' | 'turnAt' | 'progressAt' | 'abortRequestedAt' | 'build'> | null,
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
  const turnView = ptyTurnViewOfRow(row);
  return {
    ...turnView,
    ...(row?.alive && row.progressAt !== undefined ? { progressAt: row.progressAt } : {}),
    ...(row?.alive && row.abortRequestedAt !== undefined ? { abortRequestedAt: row.abortRequestedAt } : {}),
    build: build ?? null,
    installed: installed.sha ?? null,
    stale: staleness.stale,
    staleReason: staleness.reason,
  };
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '-';
}

/** 행의 자기보고 턴만 — 설치본·git 판독과 «무관»하다(판독이 실패해도 기록된 턴은 그대로 읽힌다). 죽은 행·기록 없음 = unknown. */
export function ptyTurnViewOfRow(row: Pick<PtyManifestRow, 'alive' | 'turnState' | 'turnAt'> | null | undefined): Pick<PtyRunStateView, 'turn' | 'turnAt'> {
  const turn: PtyTurnView = row?.alive && row.turnState ? row.turnState : 'unknown';
  return { turn, ...(turn !== 'unknown' && row?.turnAt ? { turnAt: row.turnAt } : {}) };
}

// ── 턴 칸(H10 · `pty list` 가 화면 긁기 없이 «지금 턴 중인가·얼마나 됐나»를 낸다) ──

export interface PtyTurnCell {
  readonly state: PtyTurnView;
  /** 지금 턴 상태로 바뀐 시각(epoch ms) — 모르면 null. */
  readonly at: number | null;
  /** 지금 턴 상태에 머문 초(busy 면 «이 턴 경과»). ⛔ 모르면 null — 「0초」와 「못 잼」은 다른 값이다. */
  readonly sinceSec: number | null;
}

export const UNKNOWN_TURN_CELL: PtyTurnCell = { state: 'unknown', at: null, sinceSec: null };

/** `turnAt` 은 턴 값이 «바뀔 때만» 적힌다(`reportTuiTurn` 이 같은 값을 거른다) ⇒ now−turnAt = 그 상태의 경과. */
export function describeTurnCell(view: Pick<PtyRunStateView, 'turn' | 'turnAt'>, now: number): PtyTurnCell {
  if (view.turn === 'unknown' || view.turnAt === undefined || !Number.isFinite(view.turnAt) || view.turnAt <= 0) {
    return { state: view.turn, at: null, sinceSec: null };
  }
  return { state: view.turn, at: view.turnAt, sinceSec: Math.max(0, Math.floor((now - view.turnAt) / 1000)) };
}

/** 표 한 칸 값: `busy,42s` · `idle,300s` · 시각 모름 `busy,?s` · 턴 모름 `?`. */
export function formatTurnCell(cell: PtyTurnCell): string {
  if (cell.state === 'unknown') return '?';
  return `${cell.state},${cell.sinceSec === null ? '?' : cell.sinceSec}s`;
}

// ── H9 자기 재기동 — «재기동 필요» ∧ 유휴 ∧ 사람 입력 없음 ⇒ 스스로 재기동 ──
//
// 정본: seat-state/OPC/TUI-HOMEOSTASIS-SLICES-2026-10-16.md (TUI-H9-IDLE-SELF-RESTART).
// 판정(`decideSelfRestart`)은 순수 함수 — 실제 «새 세션 ⊕ 자리 맥락 재주입» 은 주입된 수행자(`restart`)가 한다.
// 낡음 판정은 기존 `BuildStaleness` 를 그대로 재사용한다(판정·문면을 두벌로 만들지 않는다).
// 사람 입력 대기 신호는 입력 축(대시보드)이 준다 — 이 모듈은 입력 큐를 소유하지 않는다.

/** 유휴 유예: 이만큼 조용했을 때만 재기동한다 — 턴 사이 «쉼»에서 세션을 새로 띄우지 않는다. */
export const DEFAULT_SELF_RESTART_IDLE_MS = 90_000;

export type SelfRestartReason =
  | 'stale-idle-no-input'
  | 'not-stale'
  | 'staleness-unknown'
  | 'turn-busy'
  | 'turn-unknown'
  | 'still-warm'
  | 'human-input-pending';

export interface SelfRestartDecisionDeps {
  /** 재기동 필요인가 — 미지(null)면 재기동하지 않는다. */
  readonly stale: boolean | null;
  readonly staleReason?: BuildStaleReason;
  readonly turn: PtyTurnView;
  /** 지금 턴 상태에 머문 시간(ms) — 모르면 null. */
  readonly idleMs: number | null;
  readonly humanInputPending: boolean;
  readonly minIdleMs?: number;
}

export interface SelfRestartDecision {
  readonly restart: boolean;
  readonly reason: SelfRestartReason;
}

/** 판정선: 세 조건(재기동 필요 · 유휴 · 사람 입력 없음)이 모두 참일 때만 참. 거짓인 첫 조건을 이유로 낸다. */
export function decideSelfRestart(deps: SelfRestartDecisionDeps): SelfRestartDecision {
  if (deps.stale === null) return { restart: false, reason: 'staleness-unknown' };
  if (!deps.stale) return { restart: false, reason: 'not-stale' };
  if (deps.turn === 'busy') return { restart: false, reason: 'turn-busy' };
  if (deps.turn === 'unknown') return { restart: false, reason: 'turn-unknown' };
  const minIdleMs = deps.minIdleMs ?? DEFAULT_SELF_RESTART_IDLE_MS;
  if (deps.idleMs === null || deps.idleMs < minIdleMs) return { restart: false, reason: 'still-warm' };
  if (deps.humanInputPending) return { restart: false, reason: 'human-input-pending' };
  return { restart: true, reason: 'stale-idle-no-input' };
}

/** 재기동 계획 — 새 세션 ⊕ 자리 맥락 재주입 명령까지. 세션 id 를 모르면 명령은 null(판정 근거는 남긴다). */
export interface TuiSelfRestartPlan {
  readonly surfaceId: string;
  readonly staleReason: BuildStaleReason;
  readonly idleMs: number;
  readonly relaunchCommand: string | null;
}

export interface TuiSelfRestartDeps {
  /** 낡음 판정 재료 — 생략하면 이 프로세스의 기동 판 ⊕ 설치본 ⊕ 체크아웃 HEAD 로 잰다. */
  readonly staleness?: () => BuildStaleness;
  /** 사람이 지금 입력 중인가 — 생략하면 «모름» 으로 보고 재기동하지 않는다(조용한 세션을 뺏지 않는다). */
  readonly humanInputPending?: () => boolean;
  readonly sessionId?: string;
  /**
   * 지금 이 TUI 가 «소유한» 세션 — 틱마다 다시 읽어 `sessionId` 보다 우선한다.
   * 대화가 갈아 끼워지는 TUI 는 기동 시점 값을 고정할 수 없어 이 칸을 쓴다(읽기 실패 → null → 재기동 안 함).
   */
  readonly readSessionId?: () => string | null;
  readonly minIdleMs?: number;
  readonly intervalMs?: number;
  /** 실제 재기동 수행자(새 세션 ⊕ 자리 맥락 재주입). 생략 시 설치본 `elanous --resume <세션>`. */
  readonly restart?: (plan: TuiSelfRestartPlan) => void;
  /**
   * 낡은 TUI 가 좌석을 «놓는» 동작 — 새 세션을 띄우기 직전에 부른다.
   * 생략해도 이 녹음기는 그 좌석 행 쓰기를 스스로 놓는다(두 TUI 가 한 좌석을 겹쳐 쓰지 않게).
   */
  readonly yieldSeat?: (plan: TuiSelfRestartPlan) => void;
  /** 유휴 감시 등록 — 틱을 받아 해제 함수를 준다. 생략 시 unref 된 setInterval. */
  readonly watch?: (tick: () => void) => () => void;
}

const stalenessFromRunningBuild = (): BuildStaleness => {
  const build = runningBuild();
  const installed = readCurrentInstallRecord();
  let checkoutHead: string | undefined;
  if (build.source === 'checkout' && build.codeRoot) checkoutHead = readCheckoutHead(build.codeRoot);
  return judgeBuildStaleness({ build, installed, ...(checkoutHead ? { checkoutHead } : {}) });
};

const defaultWatch = (tick: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(tick, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => { clearInterval(timer); };
};

/** 재기동 인자: 새 세션은 `--resume <세션>` 으로 그 좌석의 자리 맥락을 다시 받는다. */
export const TUI_RELAUNCH_FLAG = '--resume';

export interface TuiRelaunchChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  unref(): void;
}

/** 프로세스 띄우기 seam — 무대는 여기만 가짜로 바꿔 «생산 argv·옵션» 을 그대로 지난다. */
export type TuiRelaunchSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore' },
) => TuiRelaunchChild;

const defaultRelaunchSpawn: TuiRelaunchSpawn = (command, args, options) =>
  spawn(command, args, options) as unknown as TuiRelaunchChild;

let relaunchSpawn: TuiRelaunchSpawn = defaultRelaunchSpawn;

/** 무대용 spawn 교체 — 인자 없이 부르면 생산 기본값(spawn)으로 되돌린다. */
export function setTuiRelaunchSpawnForTesting(next?: TuiRelaunchSpawn): void {
  relaunchSpawn = next ?? defaultRelaunchSpawn;
}

/** 기본 재기동 수행자: 설치본 `elanous --resume <세션>` — 새 세션이 그 좌석의 자리 맥락으로 다시 뜬다. */
export const spawnTuiRelaunch = (sessionId: string): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const child = relaunchSpawn(process.env.ELANOUS_BIN || 'elanous', [TUI_RELAUNCH_FLAG, sessionId], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
};

// ── SURVIVAL-PROGRESS-CLOCK — «마지막 진전 시각»로 느림·정체·Esc 무시를 가른다 ──
//
// `turnAt` 은 턴 값이 «바뀔 때만» 적히므로 busy 경과만으로는 «일하는 중»인지 «죽었다»인지를 못 가른다.
// 진전 신호(스트림 텍스트·도구 시작/끝·상태 줄)가 `progress_at` 를 계속 올리면 긴 턴도 «느리지만 가는 중»이
// 되고, 진전이 끊기면 «정체», Esc 청구 뒤에도 busy 가 지속되면 «Esc 무시»로 판정한다.

export const DEFAULT_TURN_STALL_MS = 12 * 60 * 1000;
export const DEFAULT_SLOW_TURN_MS = 20 * 60 * 1000;
export const DEFAULT_ABORT_IGNORE_MS = 30 * 1000;

export type TurnProgressJudgment = 'progressing' | 'slow' | 'stalled' | 'abort-ignored' | 'unknown';

export interface TurnProgressInput {
  readonly turn: PtyTurnView;
  readonly turnAt?: number;
  readonly progressAt?: number;
  readonly abortRequestedAt?: number;
  readonly now: number;
  /** 정체 임계 — 진전이 이만큼 끊기면 stalled. 기본 12분. */
  readonly stallMs?: number;
  /** 느린 턴 임계 — 턴 경과가 이만큼이면 slow. 기본 20분. */
  readonly slowTurnMs?: number;
  /** Esc 무시 임계 — 청구 뒤 이만큼 busy 면 abort-ignored. 기본 30초. */
  readonly abortIgnoreMs?: number;
}

/** 순수 판정: busy 턴의 진전·정체·Esc 무시를 임계로 가른다. 재료가 없으면 unknown(«괜찮다»가 아니다). */
export function judgeTurnProgress(input: TurnProgressInput): TurnProgressJudgment {
  const { turn, turnAt, progressAt, abortRequestedAt, now } = input;
  if (turn !== 'busy') return 'unknown';
  if (!Number.isFinite(now)) return 'unknown';
  // Esc 청구 뒤에도 busy 가 지속되면 무시 — 정체보다 구체적이므로 먼저 가른다.
  if (abortRequestedAt !== undefined && Number.isFinite(abortRequestedAt)) {
    if (now - abortRequestedAt >= (input.abortIgnoreMs ?? DEFAULT_ABORT_IGNORE_MS)) return 'abort-ignored';
  }
  // 진전 시각이 없으면 턴 시작(turnAt)이 진전의 0초다.
  const since = progressAt !== undefined && Number.isFinite(progressAt) ? progressAt : turnAt;
  if (since === undefined || !Number.isFinite(since)) return 'unknown';
  const elapsed = Math.max(0, now - since);
  if (elapsed >= (input.stallMs ?? DEFAULT_TURN_STALL_MS)) return 'stalled';
  if (turnAt !== undefined && Number.isFinite(turnAt) && now - turnAt >= (input.slowTurnMs ?? DEFAULT_SLOW_TURN_MS)) return 'slow';
  return 'progressing';
}

// ── 기록(TUI) ──

export interface TuiRunStateRecorderDeps {
  readonly now?: () => number;
  readonly build?: () => PtyBuildIdentity;
  readonly writeBuild?: (id: string, build: PtyBuildIdentity) => boolean;
  readonly writeTurn?: (id: string, turn: PtyTurnState, at: number) => boolean;
  /** 진전 시각 기록 — 생략하면 `updatePtyManifestProgress`(같은 행 5초 스로틀). */
  readonly writeProgress?: (id: string, at: number) => boolean;
  /** Esc 청구 시각 기록 — 생략하면 `updatePtyManifestAbortRequested`. */
  readonly writeAbortRequested?: (id: string, at: number) => boolean;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * herdr pane 신고기. 생략 시: `writeTurn` 을 주입하지 않은 기본 녹음기만
   * `createHerdrAgentReporter` 를 만든다(시험이 실 herdr 를 안 건드리게).
   * `null` 이면 신고하지 않는다.
   */
  readonly herdr?: HerdrAgentReporterLike | null;
  /**
   * SIGINT·SIGTERM 기본 죽음에도 herdr 를 반납하는 신호 지킴이의 대상(TUI-HERDR-EXIT-RACE).
   * 생략 시: 기본 신고기(herdr 미주입)일 때만 실 `process` · 주입 herdr 는 지킴이 0. `null` 이면 안 건다.
   */
  readonly signals?: HerdrSignalTarget | null;
  /**
   * H9 자기 재기동(낡은 판 ∧ 유휴 ∧ 사람 입력 없음 ⇒ 새 세션 ⊕ 자리 맥락 재주입).
   * 생략하면 감시를 안 건다 — 이 축을 켜는 것은 호출자(생산 진입점)의 결정이다.
   */
  readonly selfRestart?: TuiSelfRestartDeps;
}

interface ActiveRecorder {
  readonly surfaceId: string;
  readonly now: () => number;
  readonly writeTurn: (id: string, turn: PtyTurnState, at: number) => boolean;
  readonly writeProgress: (id: string, at: number) => boolean;
  readonly writeAbortRequested: (id: string, at: number) => boolean;
  readonly log: (event: string, data: Record<string, unknown>) => void;
  readonly herdr: HerdrAgentReporterLike | null;
  /** manifest 에 실제로 적힌 마지막 턴. 실패면 안 바뀐다(재시도). */
  last?: PtyTurnState;
  /** idle 로 «바뀐» 시각 — 유휴 경과의 0초. busy 로 가면 다시 모른다. */
  idleSince?: number;
  /** herdr 에 마지막으로 알린 턴. manifest 성패와 따로 둔다. */
  herdrLast?: PtyTurnState;
}

let active: ActiveRecorder | null = null;

const defaultLog = (event: string, data: Record<string, unknown>): void => { debug.log('pty.tui-state', event, data); };

/** TUI 행 등록 직후 부른다 — 판을 적고 턴을 idle 로 연다. 이후 `reportTuiTurn` 이 이 행에 적는다. */
export function startTuiRunStateRecorder(surfaceId: string, deps: TuiRunStateRecorderDeps = {}): () => void {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const writeTurn = deps.writeTurn ?? updatePtyManifestTurn;
  const writeProgress = deps.writeProgress ?? updatePtyManifestProgress;
  const writeAbortRequested = deps.writeAbortRequested ?? updatePtyManifestAbortRequested;
  // 기본 신고기는 기본 manifest 쓰기와 짝일 때만. writeTurn 주입(시험)은 herdr 를 안 만든다.
  const herdr = deps.herdr !== undefined
    ? deps.herdr
    : (deps.writeTurn ? null : createHerdrAgentReporter({ sessionId: surfaceId }));
  let build: PtyBuildIdentity | undefined;
  try { build = (deps.build ?? runningBuild)(); } catch (error) {
    log('build-resolve-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
  }
  if (build) {
    const ok = (() => { try { return (deps.writeBuild ?? updatePtyManifestBuild)(surfaceId, build); } catch { return false; } })();
    log(ok ? 'build-recorded' : 'build-write-failed', { ptyId: surfaceId, sha: build.sha, version: build.version, source: build.source });
  }
  // 기동 순서: 판 → manifest 초기 idle → herdr 신고. herdr start 가 idle 을 신고하므로 초기 idle 을 turn 으로 다시 안 보낸다.
  const recorder: ActiveRecorder = { surfaceId, now, writeTurn, writeProgress, writeAbortRequested, log, herdr, herdrLast: herdr ? 'idle' : undefined };
  active = recorder;
  writeTurnState(recorder, 'idle');
  if (herdr) { try { herdr.start(); } catch { /* 신고 실패가 녹음기를 깨지 않는다 */ } }
  // H9 유휴 감시: 판·턴·사람 입력을 매 틱 다시 재고, 재기동 성공 뒤에만 좌석을 양도한다.
  const selfRestart = deps.selfRestart;
  let unwatch: () => void = () => {};
  if (selfRestart) {
    const minIdleMs = selfRestart.minIdleMs ?? DEFAULT_SELF_RESTART_IDLE_MS;
    const restartedFor = new Set<BuildStaleReason>();
    let restartInFlight = false;
    const tick = (): void => {
      if (active !== recorder) return;
      let staleness: BuildStaleness;
      try { staleness = (selfRestart.staleness ?? stalenessFromRunningBuild)(); } catch (error) {
        log('self-restart-staleness-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // 사람 입력 신호가 없거나 읽을 수 없으면 모름으로 닫는다 — 명시적 false만 «사람 입력 없음»이다.
      let humanInputPending = true;
      if (selfRestart.humanInputPending) {
        try { humanInputPending = selfRestart.humanInputPending() !== false; } catch { humanInputPending = true; }
      }
      // 재기동은 «지금 이 TUI 가 보여 주는 대화» 로만 잇는다 — 읽기 실패는 null(대체 세션을 지어내지 않는다).
      let sessionId: string | null = selfRestart.sessionId ?? null;
      if (selfRestart.readSessionId) {
        try { sessionId = selfRestart.readSessionId(); } catch { sessionId = null; }
      }
      const idleMs = recorder.idleSince === undefined ? null : Math.max(0, now() - recorder.idleSince);
      const decision = decideSelfRestart({
        stale: staleness.stale,
        staleReason: staleness.reason,
        turn: recorder.last ?? 'unknown',
        idleMs,
        humanInputPending,
        minIdleMs,
      });
      if (!decision.restart || restartedFor.has(staleness.reason) || restartInFlight) return;
      if (!sessionId) {
        log('self-restart-no-session', { ptyId: surfaceId, staleReason: staleness.reason });
        return;
      }
      const plan: TuiSelfRestartPlan = {
        surfaceId,
        staleReason: staleness.reason,
        idleMs: idleMs ?? 0,
        relaunchCommand: sessionId ? buildStaleInstallRelaunchCommand(sessionId) : null,
      };
      log('self-restart', { ptyId: surfaceId, reason: decision.reason, staleReason: plan.staleReason, idleMs: plan.idleMs, relaunchCommand: plan.relaunchCommand });
      restartInFlight = true;
      const handoff = (): void => {
        // 새 세션이 실제로 생성된 뒤에만 낡은 TUI 가 좌석 행 쓰기를 놓는다.
        if (selfRestart.yieldSeat) {
          try {
            selfRestart.yieldSeat(plan);
          } catch (error) {
            log('self-restart-yield-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (active === recorder) active = null;
        restartedFor.add(staleness.reason);
        restartInFlight = false;
        log('self-restart-handover', { ptyId: surfaceId, staleReason: plan.staleReason, relaunchCommand: plan.relaunchCommand });
      };
      const failed = (error: unknown): void => {
        restartInFlight = false;
        log('self-restart-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
      };
      try {
        if (selfRestart.restart) {
          selfRestart.restart(plan);
          handoff();
        } else {
          void spawnTuiRelaunch(sessionId).then(handoff, failed);
        }
      } catch (error) {
        failed(error);
      }
    };
    try {
      const watch = selfRestart.watch ?? ((fn: () => void) => defaultWatch(fn, selfRestart.intervalMs ?? Math.max(5_000, Math.round(minIdleMs / 3))));
      unwatch = watch(tick);
    } catch (error) {
      log('self-restart-watch-failed', { ptyId: surfaceId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // raw 모드 전 ctrl+c(SIGINT 기본 죽음)는 'exit' 훅을 안 돌린다 — 신호에서도 반납한다.
  const signals = deps.signals !== undefined ? deps.signals : (deps.herdr === undefined ? process : null);
  let unguard: () => void = () => {};
  if (herdr && signals) {
    try { unguard = guardHerdrReleaseOnSignal(() => herdr.release(), signals); } catch { /* 지킴이 실패가 녹음기를 깨지 않는다 */ }
  }
  return () => {
    try { unwatch(); } catch { /* 종료 경로를 깨지 않는다 */ }
    try { unguard(); } catch { /* 종료 경로를 깨지 않는다 */ }
    if (herdr) { try { herdr.release(); } catch { /* 종료 경로를 깨지 않는다 */ } }
    if (active === recorder) active = null;
  };
}

/** 대시보드가 턴 시작(busy)·끝(idle)에 부른다. 녹음기가 없으면(자기보고 꺼짐) 아무것도 안 한다. */
export function reportTuiTurn(turn: PtyTurnState): void {
  if (!active || active.last === turn) return;
  writeTurnState(active, turn);
}

/** 진전 신호(스트림 텍스트·도구 시작/끝·상태 줄)에서 부른다 — 마지막 진전 시각을 올린다. 녹음기가 없으면 아무것도 안 한다. */
export function reportTuiProgress(): void {
  if (!active) return;
  const at = active.now();
  let ok = false;
  try { ok = active.writeProgress(active.surfaceId, at); } catch { ok = false; }
  // 실패(0행·예외)는 관측으로만 남긴다 — 진전 기록이 턴을 막지 않는다. 스로틀 생략(false 아님 실패만)은 조용히 지나간다.
  if (!ok) active.log('progress-write-failed', { ptyId: active.surfaceId, at });
}

/** Esc 게이트가 턴 중단을 청할 때 부른다 — 청구 시각을 남긴다(busy 가 지속되면 abort-ignored 판정 재료). */
export function reportTuiAbortRequested(): void {
  if (!active) return;
  const at = active.now();
  let ok = false;
  try { ok = active.writeAbortRequested(active.surfaceId, at); } catch { ok = false; }
  if (!ok) active.log('abort-requested-write-failed', { ptyId: active.surfaceId, at });
}

function writeTurnState(recorder: ActiveRecorder, turn: PtyTurnState): void {
  const at = recorder.now();
  let ok = false;
  try { ok = recorder.writeTurn(recorder.surfaceId, turn, at); } catch { ok = false; }
  if (ok) {
    recorder.last = turn;
    // 유휴 경과의 0초는 «idle 로 바뀐 시각» — busy 로 가면 다시 모른다.
    if (turn === 'idle') recorder.idleSince = at;
    else recorder.idleSince = undefined;
  }
  // 실패는 관측으로 남긴다 — 바깥 제어자는 그 사이 «unknown/낡은 값»을 본다. 성공은 남기지 않는다(턴마다 두 줄은 소음).
  else recorder.log('turn-write-failed', { ptyId: recorder.surfaceId, turn, at });
  // herdr 는 manifest 쓰기 성패와 무관하게, 값이 바뀔 때 알린다(같은 값 재시도는 한 번만).
  if (recorder.herdr && recorder.herdrLast !== turn) {
    // 신고가 동기로 던지면 «보낸 상태» 로 적지 않는다 — herdr 가 아는 값(herdrLast)과 다음 전이를 비교해 다시 보낸다(r4 리뷰 sf).
    try {
      recorder.herdr.turn(turn);
      recorder.herdrLast = turn;
    } catch (error) {
      recorder.log('herdr-turn-threw', { turn, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function resetTuiRunStateForTesting(): void {
  active = null;
  bootBuild = undefined;
}
