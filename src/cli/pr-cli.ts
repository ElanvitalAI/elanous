import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import {
  createTerminalConfirmChannel,
  requestConfirmation,
  type ConfirmChannel,
  type ConfirmOpts,
  type ConfirmResult,
} from '../hitl/confirm.js';
import { runGate as runChangedTypecheckGate } from '../../scripts/ci-typecheck-changed.js';
import { runIsolationHardcodeGate } from '../../scripts/ci-isolation-hardcode-gate.js';
import { androidFilesIn, runAndroidUnitTestGate } from '../../scripts/ci-android-unit-tests.js';
import { iosFilesIn, runIosUnitTestGate } from '../../scripts/ci-ios-unit-tests.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { runModelHardcodeGate } from '../../scripts/ci-model-hardcode-gate.js';
import { runDaemonPortGate } from '../../scripts/ci-daemon-port-gate.js';
import { runPublicLeakGate } from '../../scripts/ci-public-leak-gate.js';
import { checkCommands, extractElanousCommands, type Finding as DocsCliFinding } from '../../scripts/docs-cli-check.js';
import { runTestInterferenceGate } from '../../scripts/ci-test-interference-gate.js';
import { isGoalDocumentFileName } from '../self-implement/goal-document.js';
import { queryFederatedUnfinishedRunLedgers, type FederatedUnfinishedRunLedgerEntry, type FederatedUnfinishedRunLedgerQuery } from '../self-implement/run-ledger.js';
import { queryRunningRuns, type RunningRunsResult } from '../self-implement/running-runs.js';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import {
  defaultCmdRunner,
  makePrManager,
  resolveDeliverableBase,
  type CmdRunner,
  type PrManager,
} from '../autopilot/pr-manager.js';
import {
  collectBaseLandingCommits,
  computeGranularityStats,
  computeLineageStats,
  computeSourceSplit,
  extractPrNumberFromSubject,
  formatLineageReport,
  countRecentLandings,
  DEFAULT_GRANULARITY_SINCE,
  formatGranularityReport,
  formatOverlapAdvisory,
  formatRecentLandingRateAdvisory,
  formatSourceSplitReport,
  overlapWithCurrentChanges,
  parseNameOnlyList,
  previousLandingSummary,
  unionPaths,
} from './pr-granularity.js';
import { branchLineageSlug, findSiblingPrs } from './pr-lineage.js';

export { branchLineageSlug, findSiblingPrs };

export interface PrLandOpts {
  base?: string;
  cwd?: string;
  dryRun?: boolean;
  hold?: boolean;
  title?: string;
  titleFile?: string;
  body?: string;
  bodyFile?: string;
  commitMessage?: string;
  commitMessageFile?: string;
  includeActiveRunFiles?: boolean;
  excludeActiveRunFiles?: boolean;
  excludeActiveRunSources?: boolean;
  landReason?: string;
}

export interface PrGranularityOpts {
  since?: string;
  cwd?: string;
  base?: string;
  withSource?: boolean;
}

/** `GIT-S14` 재시도 횟수·간격. 표본의 재시도는 «즉시»에도 성공했다 — 짧게 둔다. */
export const PR_LAND_MERGEABLE_UNKNOWN_RETRIES = 3;
export const PR_LAND_MERGEABLE_UNKNOWN_WAIT_MS = 5_000;

export interface PrLandDeps {
  manager?: PrManager;
  /** 병합 재시도 사이 대기(시험 주입용 · 기본 실제 대기). */
  sleep?: (ms: number) => Promise<void>;
  run?: CmdRunner;
  resolveBase?: (run: CmdRunner, cwd: string, explicit?: string) => string | undefined;
  currentBranch?: (cwd: string) => string | undefined;
  readFile?: (path: string) => string;
  listUnfinishedRuns?: () => FederatedUnfinishedRunLedgerQuery | readonly FederatedUnfinishedRunLedgerEntry[];
  queryRunningRuns?: () => RunningRunsResult;
  listOpenPrs?: () => readonly { number: number; headRefName: string }[] | null;
  out?: { log: (message: string) => void; error: (message: string) => void };
  setExitCode?: (code: number) => void;
  runTypecheckGate?: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean;
  runIsolationGate?: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean;
  runMockModuleRestoreGate?: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean;
  runModelHardcodeGate?: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean;
  runDaemonPortGate?: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean;
  /** 공개 유출 래칫(경고 전용) — 반환 0 통과 · 1 늘었다 · 2 못 쟀다. */
  runPublicLeakGate?: (changedFiles: readonly string[], out: { log: (message: string) => void; error: (message: string) => void }) => number;
  /** 공개 문서의 `elanous …` 호출 ↔ 실제 `--help` 대조(경고 전용) — 바뀐 공개 문서 경로를 받아 어긋남 목록을 돌려준다. */
  runDocsCliCheck?: (docFiles: readonly string[]) => DocsCliFinding[];
  /** 변경 시험 파일 간 간섭 검사 심(시험 주입용). */
  runTestInterferenceGate?: (out: { log: (message: string) => void; error: (message: string) => void }, changedFiles: readonly string[]) => Promise<number>;
  /** 안드로이드 단위 시험 게이트 심(시험 주입용). */
  runAndroidGate?: (out: { log: (message: string) => void; error: (message: string) => void }, changedFiles: readonly string[]) => boolean;
  /** iOS 시험 게이트 심(시험 주입용). */
  runIosGate?: (out: { log: (message: string) => void; error: (message: string) => void }, changedFiles: readonly string[]) => boolean;
  isInteractive?: () => boolean;
  requestConfirmation?: (opts: ConfirmOpts) => Promise<ConfirmResult>;
  overlapConfirmChannels?: ConfirmChannel[];
  overlapConfirmTimeoutMs?: number;
  decideOverlapLanding?: () => OverlapLandingDecision | Promise<OverlapLandingDecision>;
}

export const OVERLAP_DECISION_PROMPT = '겹친 파일이 있습니다. 이번 착지를 그대로 병합할까요?';

export type OverlapLandingDecisionOutcome = 'user-merge' | 'user-hold' | 'unavailable';

export interface OverlapLandingDecision {
  outcome: OverlapLandingDecisionOutcome;
  channel: ConfirmResult['channel'];
  interactive: boolean;
}

function defaultIsInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createOverlapConfirmChannel(io: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): ConfirmChannel {
  let rl: ReturnType<typeof createInterface> | undefined;
  let settle: ((answer: boolean | null) => void) | undefined;
  let settled = false;

  const finish = (answer: boolean | null): void => {
    const current = rl;
    rl = undefined;
    if (settled) {
      current?.close();
      return;
    }
    settled = true;
    const resolvePending = settle;
    settle = undefined;
    current?.close();
    resolvePending?.(answer);
  };

  return createTerminalConfirmChannel({
    show(req) {
      const yes = req.yesLabel ?? 'Yes';
      const no = req.noLabel ?? 'No';
      (io.output ?? process.stdout).write(`${req.prompt} [${yes} / ${no}]\n`);
    },
    clear() {
      finish(null);
    },
    awaitAnswer() {
      return new Promise((resolve) => {
        if (settled) {
          resolve(null);
          return;
        }
        settle = resolve;
        rl = createInterface({
          input: io.input ?? process.stdin,
          output: io.output ?? process.stdout,
        });
        if (settled) {
          finish(null);
          return;
        }
        rl.question('> ', (answer) => {
          const text = answer.trim().toLowerCase();
          if (text === 'n' || text === 'no' || text === 'hold' || text === '쌓아 두기') {
            finish(false);
            return;
          }
          finish(true);
        });
      });
    },
  });
}

/** Map a HITL confirm result to an overlap landing choice. all-failed/timeout stay unavailable even when the fallback answer is true. */
export function overlapDecisionFromConfirm(result: ConfirmResult): Pick<OverlapLandingDecision, 'outcome' | 'channel'> {
  if (result.channel === 'all-failed' || result.channel === 'timeout') {
    return { outcome: 'unavailable', channel: result.channel };
  }
  return { outcome: result.answer ? 'user-merge' : 'user-hold', channel: result.channel };
}

export async function decideOverlapLanding(input: {
  isInteractive?: () => boolean;
  requestConfirmation?: (opts: ConfirmOpts) => Promise<ConfirmResult>;
  channels?: ConfirmChannel[];
  timeoutMs?: number;
} = {}): Promise<OverlapLandingDecision> {
  const interactive = (input.isInteractive ?? defaultIsInteractive)();
  const confirm = input.requestConfirmation ?? requestConfirmation;
  const channels = interactive ? (input.channels ?? [createOverlapConfirmChannel()]) : [];
  const result = await confirm({
    prompt: OVERLAP_DECISION_PROMPT,
    yesLabel: '그대로 병합',
    noLabel: '쌓아 두기',
    channels,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return { ...overlapDecisionFromConfirm(result), interactive };
}

const liveOut = { log: (message: string) => console.log(message), error: (message: string) => console.error(message) };

function runPrLandTypecheckGate(out: { log: (message: string) => void; error: (message: string) => void }): boolean {
  let failed = false;
  const exit = ((code: number): never => {
    failed = code !== 0;
    throw new Error(`ci-typecheck-changed exited ${code}`);
  });
  try {
    runChangedTypecheckGate({ log: out.log, warn: out.error, error: out.error, exit });
  } catch (error) {
    if (!failed) throw error;
  }
  return !failed;
}

// ⛔⭐⭐ `args: []` 가 «필수»다 — 기본값이 `process.argv.slice(2)` 라, 그냥 부르면
//   이 게이트가 ***`elanous pr land` 의 인자를 자기 인자로 읽는다***.
//   🚨 그 자리에 `--update` 가 있으면 게이트가 «막는 대신 baseline 을 다시 쓴다»
//      (= 위반을 정당한 잔류로 삼키고 조용히 통과). 그래서 인자를 «끊어» 넘긴다.
// ⭐ 몽키패치가 «없다» — 이 스크립트는 형제(ci-typecheck-changed)와 같은 관례로
//   `runIsolationHardcodeGate(io): number` 를 이미 export 하고 있고, process.exit 는
//   `import.meta.main` 뒤에만 있다. 그래서 여기선 «반환값»만 읽으면 된다.
// ⛔⭐⭐⭐ 「막는다」와 「못 쟀다」를 «같은 값으로 접지 않는다» (🅢 132차 지적 · 2026-08-26).
//   ⓐ 위반을 «찾았다»            → 막는다(return false). 그게 이 게이트의 일이다
//   ⓑ 게이트 «자신»이 못 돌았다   → ***막지 않는다***. 대신 「못 쟀다」를 «이름으로» 낸다
//   🚨 왜 ⓑ 가 fail-open 인가 — 이 게이트는 세 창이 «다 쓰는» 착지 경로에 붙는다.
//      fail-closed 면 게이트가 깨지는 순간 전 트랙의 착지가 멈추고, 그 멈춤이
//      ***「내 변경이 나쁘다」로 «보인다»*** — 원인이 게이트인 줄 아무도 모른다.
//   ⛔ 그리고 침묵으로 통과시키지 «않는다». 조용한 fail-open 은 「검사했다」로 읽히고,
//      그러면 이 게이트는 «있어도 없는» 것이 된다.
/**
 * 격리 하드코딩 게이트를 «착지하는 트리»에서 돌린다.
 * 🩸 2026-09-25: 종전엔 `cwd` 없이 불러 게이트가 «자기 스크립트가 있는 트리»(= `bun <pilot>/bin/elanous.mjs pr land` 면 pilot)를
 *   검사했다 — 워크트리에서 착지하는 PR 은 «PR 이 아니라 pilot» 이 판정됐다. #20413 의 새 하드코딩이 통과했고,
 *   그 뒤 pilot 이 그것을 받자 «고치는» PR(#20417)까지 막혔다.
 */
export function runPrLandIsolationGate(
  out: { log: (message: string) => void; error: (message: string) => void },
  cwd: string = process.cwd(),
  gate: typeof runIsolationHardcodeGate = runIsolationHardcodeGate,
): boolean {
  const top = runGitCommand(cwd, ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
  const root = top.status === 0 && String(top.stdout ?? '').trim() ? String(top.stdout).trim() : cwd;
  return gate({ args: [], cwd: root, log: out.log, error: out.error }) === 0;
}

/** ⭐ 2026-09-24 — 공개 유출 래칫은 «경고만» 낸다(착지를 막지 않는다 · 막는 것은 공개 결정 뒤 · 채널 합의).
 *  계기: 기준선 뒤 3시간 만에 🅢 착지분에서 유출 증가 다섯을 이 게이트가 잡았다 — 착지 순간에 보여야 그 자리에서 고친다. */
function runPrLandPublicLeakGate(changedFiles: readonly string[], out: { log: (message: string) => void; error: (message: string) => void }): number {
  return runPublicLeakGate({ args: ['--changed-files', ...changedFiles], log: out.log, error: out.log });
}

export function publicLeakWarning(
  changedFiles: readonly string[] | undefined,
  gate: (changedFiles: readonly string[], out: { log: (message: string) => void; error: (message: string) => void }) => number,
  out: { log: (message: string) => void; error: (message: string) => void },
): void {
  if (!changedFiles || changedFiles.length === 0) return;
  const captured: string[] = [];
  const sink = { log: (m: string) => captured.push(m), error: (m: string) => captured.push(m) };
  let rc: number;
  try { rc = gate(changedFiles, sink); } catch (error) {
    out.log(`⚠ public-leak-gate(경고 전용): 못 쟀다 — ${error instanceof Error ? error.message : String(error)}`);
    record('public-leak-gate', true, { warnOnly: true, measured: false });
    return;
  }
  record('public-leak-gate', true, { warnOnly: true, measured: rc !== 2, grew: rc === 1 });
  if (rc === 0) { out.log('✓ public-leak-gate(경고 전용): 공개 유출이 늘지 않았다.'); return; }
  if (rc === 1) {
    out.log('⚠ public-leak-gate(경고 전용 · 착지는 막지 않는다): 공개 유출이 늘었다 —');
    for (const line of captured.filter((l) => /→/.test(l))) out.log(`   ${line.trim()}`);
    out.log('   확인: bun scripts/public-export.ts --leak-check --path <파일> --all');
    return;
  }
  out.log('⚠ public-leak-gate(경고 전용): 못 쟀다(기준선 없음 등).');
}

/** 공개 문서(`release/public/내부 문서 `**`` ⊕ `README.md`) 중 이번 착지가 바꾼 것만 — 지워진 파일은 뺀다. */
export function publicDocPaths(changedFiles: readonly string[] | undefined, exists: (path: string) => boolean): string[] {
  return [...new Set(changedFiles ?? [])].filter((f) => (f === 'README.md' || /^release\/public\/docs\/.+\.md$/.test(f)) && exists(f));
}

/** ⭐ 2026-09-26 — 공개 문서의 `elanous …` 호출이 실제 CLI(`--help`)에 있나를 «경고만» 낸다(착지는 막지 않는다).
 *  계기: 09-25 README·install.md 가 거짓이 된 원인이 전부 «CLI 가 바뀌었는데 문서가 모름»이었다(RFC 공개 매뉴얼 M3).
 *  ⛔ 범위는 «바뀐 공개 문서»뿐 — 전 문서 대조는 38초라 착지마다 돌리지 않는다(문서 배포 때 `bun scripts/docs-cli-check.ts` 전수). */
export function docsCliWarning(
  docFiles: readonly string[],
  check: (docFiles: readonly string[]) => DocsCliFinding[],
  out: { log: (message: string) => void },
): void {
  if (docFiles.length === 0) return;
  let findings: DocsCliFinding[];
  try { findings = check(docFiles); } catch (error) {
    out.log(`⚠ docs-cli-check(경고 전용): 못 쟀다 — ${error instanceof Error ? error.message : String(error)}`);
    record('docs-cli-check', true, { warnOnly: true, measured: false, files: docFiles.length });
    return;
  }
  const mismatches = findings.filter((f) => f.kind !== 'unmeasured');
  const unmeasured = findings.length - mismatches.length;
  record('docs-cli-check', true, { warnOnly: true, measured: true, files: docFiles.length, mismatches: mismatches.length, unmeasured });
  if (findings.length === 0) { out.log(`✓ docs-cli-check(경고 전용): 바뀐 공개 문서 ${docFiles.length}개의 elanous 호출이 실제 CLI 와 맞는다.`); return; }
  out.log(`⚠ docs-cli-check(경고 전용 · 착지는 막지 않는다): 바뀐 공개 문서 ${docFiles.length}개 — 어긋남 ${mismatches.length} · 못 잰 것 ${unmeasured}`);
  for (const f of findings) out.log(`   ${f.kind}  ${f.ref.file}:${f.ref.line}  ${f.detail}`);
  out.log('   확인: bun scripts/docs-cli-check.ts <파일>');
}

function runPrLandDocsCliCheck(root: string): (docFiles: readonly string[]) => DocsCliFinding[] {
  return (docFiles) => checkCommands(docFiles.flatMap((f) => extractElanousCommands(f, readFileSync(join(root, f), 'utf8'))));
}

function runPrLandMockModuleRestoreGate(out: { log: (message: string) => void; error: (message: string) => void }): boolean {
  return runMockModuleRestoreGate({ args: [], log: out.log, error: out.error }) === 0;
}

// 🚨 안드로이드 축 — `bun test` 우주 «밖»이라 다른 게이트가 원리상 못 본다.
//    ⭐ 두 층으로 나눈다:
//      ⑴ «깨우기»는 변경 파일로 — 안드로이드를 안 만진 PR 은 Gradle 을 «부르지도» 않는다.
//         ⛔ 인자 없이 부르면 문서 한 줄 PR 도 매번 Gradle 을 돌려 착지가 수십 초씩 늦고,
//            그렇게 느린 게이트는 결국 «꺼진다» — 있어도 없는 게이트가 된다.
//      ⑵ 깨어난 «뒤»에는 변경 범위가 아니라 ***안드로이드 시험 전부***를 돌린다.
//         2026-09-07 실측: 내가 안 만진 파일이 이미 깨져 있었고, 변경 범위만 봤다면 못 봤다.
function runPrLandAndroidGate(
  out: { log: (message: string) => void; error: (message: string) => void },
  changedFiles: readonly string[] = [],
): boolean {
  return runAndroidUnitTestGate({ args: ['--changed-files', ...changedFiles], log: out.log, error: out.error }) === 0;
}

/** ⛔ 보호는 «호출부»에 둔다 — 주입된 게이트가 던져도 같은 계약이 서야 한다.
 *  runner 안에 두면 DI 경로가 그 보호를 «비껴간다»(첫 판이 그랬고 시험이 잡았다). */
// ⛔⭐ `label` 을 «받는다» — 이 함수는 isolation 하나가 아니라 «여러 게이트»가 쓴다.
//   📏 실측(2026-09-05): mock-module-restore 게이트가 던져도 경고가 「isolation-gate」라고 말했다.
//     `.github/workflows` 가 없어 `pr land` 가 «유일한» 강제점이므로, 여기서 이름을 틀리게 대면
//     읽는 사람이 «멀쩡한 게이트»를 고치러 간다.
async function testInterferenceGateVerdict(
  gate: (out: { log: (message: string) => void; error: (message: string) => void }, changedFiles: readonly string[]) => Promise<number>,
  changedFiles: readonly string[],
  out: { log: (message: string) => void; error: (message: string) => void },
): Promise<{ measured: boolean }> {
  try {
    await gate(out, changedFiles);
    return { measured: true };
  } catch (error) {
    out.error(`⚠ test-interference-gate: 게이트가 «못 쟀다» — ${error instanceof Error ? error.message : String(error)}`);
    out.error('⚠ test-interference-gate: 「간섭 없음」이 아니라 「검사 못 함」이다. 이 착지는 통과시키되 게이트를 고쳐라.');
    return { measured: false };
  }
}

function gateVerdict(
  label: string,
  gate: (out: { log: (message: string) => void; error: (message: string) => void }) => boolean,
  out: { log: (message: string) => void; error: (message: string) => void },
): { ok: boolean; measured: boolean } {
  try {
    return { ok: gate(out), measured: true };
  } catch (error) {
    out.error(`⚠ ${label}: 게이트가 «못 쟀다» — ${error instanceof Error ? error.message : String(error)}`);
    out.error(`⚠ ${label}: 「위반 없음」이 아니라 「검사 못 함」이다. 이 착지는 통과시키되 게이트를 고쳐라.`);
    return { ok: true, measured: false };
  }
}

function liveCurrentBranch(cwd: string): string | undefined {
  const result = runGitCommand(cwd, ['branch', '--show-current'], { encoding: 'utf-8' });
  const branch = result.status === 0 ? result.stdout.trim() : '';
  return branch || undefined;
}

function record(step: string, ok: boolean, extra: Record<string, unknown> = {}): void {
  debug.log('pr.land', 'step', { step, ok, ...extra });
}

type PrRemoteCapability = 'github' | 'local-path' | 'no-remote' | 'other';

function isLocalRemote(raw: string): boolean {
  if (/^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(raw)) return true;
  if (!raw.includes('://') && !raw.includes(':') && !/\s/.test(raw) && raw.length > 0) return true;
  try {
    return new URL(raw).protocol === 'file:';
  } catch {
    return false;
  }
}

/** GitHub is recognized only from the parsed URL/SCP host, never from its path. */
function isGitHubRemote(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'ssh:') && url.hostname.toLowerCase() === 'github.com';
  } catch {
    const scp = /^(?:[^@/]+@)?([^/:]+):[^/]+\/.+$/.exec(raw);
    return scp?.[1]?.toLowerCase() === 'github.com';
  }
}

interface RemoteBranchRef {
  remote: string;
  branch: string;
}

function resolveRemoteBranchRef(run: CmdRunner, cwd: string, base: string): RemoteBranchRef {
  const remoteResult = run('git', ['remote'], { cwd });
  const remotes = remoteResult.ok
    ? remoteResult.out.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean)
    : [];
  const remote = remotes
    .filter((name) => base.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (remote) return { remote, branch: base.slice(remote.length + 1) };
  return { remote: 'origin', branch: base };
}

function remoteBaseTarget(run: CmdRunner, cwd: string, base: string): { remote: string; branch: string; url: string } | undefined {
  const ref = resolveRemoteBranchRef(run, cwd, base);
  const remoteUrl = run('git', ['remote', 'get-url', ref.remote], { cwd });
  return remoteUrl.ok ? { ...ref, url: remoteUrl.out.trim() } : undefined;
}

function remoteCapability(run: CmdRunner, cwd: string, base: string, target = remoteBaseTarget(run, cwd, base)): PrRemoteCapability {
  if (target) {
    if (isLocalRemote(target.url)) return 'local-path';
    return isGitHubRemote(target.url) ? 'github' : 'other';
  }
  const remotes = run('git', ['remote'], { cwd });
  return remotes.ok && remotes.out.trim() === '' ? 'no-remote' : 'other';
}

function baseLine(base: string, capability: PrRemoteCapability): { text: string; ok: boolean } {
  if (capability === 'github') return { text: `✓ base: ${base}`, ok: true };
  const reason = capability === 'local-path'
    ? '로컬 경로 원격'
    : capability === 'no-remote'
      ? '원격 없음'
      : '그 외 원격';
  return { text: `⚠ base: ${base} (PR 생성 불가: ${reason})`, ok: false };
}

export interface PorcelainStatusRecord {
  xy: string;
  path: string;
  originalPath?: string;
}

export function parsePorcelainStatus(output: string): PorcelainStatusRecord[] {
  const records: PorcelainStatusRecord[] = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    const originalPath = xy.includes('R') || xy.includes('C') ? fields[++index] : undefined;
    records.push({ xy, path: field.slice(3), ...(originalPath ? { originalPath } : {}) });
  }
  return records;
}

function stagedPaths(run: CmdRunner, cwd: string): PorcelainStatusRecord[] | null {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
  return status.ok ? parsePorcelainStatus(status.out) : null;
}

interface NumstatRecord {
  readonly added: number;
  readonly deleted: number;
  readonly path: string;
}

/** `git diff --numstat` lines: added, deleted, path, tab-separated. Binary rows (`-`) are skipped. */
export function parseNumstat(output: string): NumstatRecord[] {
  const records: NumstatRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = firstTab >= 0 ? line.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const added = Number(line.slice(0, firstTab));
    const deleted = Number(line.slice(firstTab + 1, secondTab));
    const path = line.slice(secondTab + 1);
    if (!Number.isFinite(added) || !Number.isFinite(deleted) || !path) continue;
    records.push({ added, deleted, path });
  }
  return records;
}

/**
 * Body phrases a goalless plan document uses to describe itself.
 *
 * 🚨 실측 정정(2026-09-07): 초판 표식은 `'골/grounding 없이 만들어졌다'` 였는데
 *    ***그 문장은 실물에 «0건»이었다*** — 저자가 문서를 안 읽고 문면을 지어냈다.
 *    📏 워크트리의 오염 문서 72개 중 «0 히트». 오탐은 0인데 ***미탐이 100%*** 였다.
 * ⇒ ✅ 실물 문면으로 바꾼다:
 *    "요청된 골은 `write a plan`이지만, … historian 조사 재료가 «제공되지 않았다»"
 *
 * ⛔ 그리고 «둘이 같은 문장 단위 안에서 순서대로» 나와야 참이다 —
 *    한쪽만으로는 그 낱말을 «인용»한 정당한 문서를 문다.
 */
const UNGROUNDED_PLAN_ARTIFACT_MARKERS = ['`write a plan`', '제공되지 않았다'] as const;

/** 문장/문단 단위로 쪼갠다 — 두 표식이 «같은 단위»에 있어야 근거가 된다. */
function planArtifactStructuralUnits(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/(?<=[.!?。．]|다\.)\s+/))
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
}

/**
 * Classify from document body only. A PLAN-/RFC-like name is not evidence —
 * callers read the file and pass `{ body }` alone.
 */
export function planArtifactBodyDeclaresCreatedWithoutGoalOrGrounding(input: {
  body: string;
}): boolean {
  const [askMarker, missingMarker] = UNGROUNDED_PLAN_ARTIFACT_MARKERS;
  return planArtifactStructuralUnits(input.body).some((unit) => {
    const askAt = unit.indexOf(askMarker);
    const missingAt = unit.indexOf(missingMarker);
    return askAt >= 0 && missingAt >= 0 && askAt < missingAt;
  });
}

function deletionDominantFiles(run: CmdRunner, cwd: string): NumstatRecord[] | null {
  // HEAD, not the index: `git checkout <ref> -- <file>` writes both index and worktree,
  // which is the 2026-08-24 revert that landing would commit via `git add -A`.
  const diff = run('git', ['diff', '--numstat', 'HEAD'], { cwd });
  if (!diff.ok) return null;
  return parseNumstat(diff.out).filter(({ added, deleted }) => deleted > added);
}

function repoRelativePath(cwd: string, path: string): string | null {
  const normalized = relative(resolve(cwd), resolve(cwd, path)).replaceAll('\\', '/');
  return normalized && !normalized.startsWith('../') && normalized !== '..' ? normalized : null;
}

function activeRunFileConflicts(cwd: string, staged: readonly string[], runs: readonly FederatedUnfinishedRunLedgerEntry[]): Array<{ path: string; runIds: string[] }> {
  const stagedSet = new Set(staged.map((path) => repoRelativePath(cwd, path)).filter((path): path is string => path !== null));
  const conflicts = new Map<string, Set<string>>();
  for (const run of runs) {
    const runPaths = [...run.plannedPaths, ...(run.goalDocumentPath ? [run.goalDocumentPath] : [])];
    for (const path of runPaths) {
      const normalized = repoRelativePath(cwd, path);
      if (!normalized || !stagedSet.has(normalized)) continue;
      const runIds = conflicts.get(normalized) ?? new Set<string>();
      runIds.add(run.runId);
      conflicts.set(normalized, runIds);
    }
  }
  return [...conflicts.entries()].map(([path, runIds]) => ({ path, runIds: [...runIds].sort() })).sort((left, right) => left.path.localeCompare(right.path));
}

function unfinishedRunLookupFailures(query: FederatedUnfinishedRunLedgerQuery): Record<string, number> {
  return {
    unreadableLedgerDirectoryCount: query.unreadableLedgerDirectoryCount,
    missingLedgerDirectoryCount: query.missingLedgerDirectoryCount,
    unreadableLedgerDirectoryAccessCount: query.unreadableLedgerDirectoryAccessCount,
    indeterminateLedgerDirectoryCount: query.indeterminateLedgerDirectoryCount,
    unreadableLedgerCount: query.unreadableLedgerCount,
  };
}

function hasUnfinishedRunLookupFailures(query: FederatedUnfinishedRunLedgerQuery): boolean {
  return query.unreadableLedgerDirectoryAccessCount > 0
    || query.indeterminateLedgerDirectoryCount > 0
    || query.unreadableLedgerCount > 0;
}

function isFederatedUnfinishedRunLedgerQuery(value: FederatedUnfinishedRunLedgerQuery | readonly FederatedUnfinishedRunLedgerEntry[]): value is FederatedUnfinishedRunLedgerQuery {
  return !Array.isArray(value);
}

function unfinishedRunQuery(value: FederatedUnfinishedRunLedgerQuery | readonly FederatedUnfinishedRunLedgerEntry[]): FederatedUnfinishedRunLedgerQuery {
  if (isFederatedUnfinishedRunLedgerQuery(value)) return value;
  return {
    entries: value,
    ledgerDirectories: [],
    goalsDirectory: '',
    unreadableLedgerCount: 0,
    unreadableLedgerDirectoryCount: 0,
    missingLedgerDirectoryCount: 0,
    unreadableLedgerDirectoryAccessCount: 0,
    indeterminateLedgerDirectoryCount: 0,
    reconciledTerminatedElsewhereCount: 0,
    scope: 'self-implement-run-ledger-federated',
    note: 'Injected test seam without a federated lookup result.',
  };
}

function runningRunObservation(result: RunningRunsResult, unfinishedRunCount: number): Record<string, unknown> {
  const statusByRunId = new Map(result.entries.map((entry) => [entry.runId, entry]));
  const runningRunCount = result.countedStatuses.reduce((count, status) => count + result.counts[status], 0);
  return {
    unfinishedRunCount,
    runningRunCount,
    runningRunTotal: result.total,
    countedStatuses: result.countedStatuses,
    runningRunCounts: result.counts,
    runningRunUnreadableLedgerCount: result.ledger.unreadableLedgerCount,
    runningRunUnreadableLedgerDirectoryCount: result.ledger.unreadableLedgerDirectoryCount,
    runningRunMissingLedgerDirectoryCount: result.ledger.missingLedgerDirectoryCount,
    runningRunUnreadableLedgerDirectoryAccessCount: result.ledger.unreadableLedgerDirectoryAccessCount,
    runningRunIndeterminateLedgerDirectoryCount: result.ledger.indeterminateLedgerDirectoryCount,
    runningRunUnreadablePtyRoots: result.pty.unreadable,
    runningRunObservationIncomplete: result.ledger.unreadableLedgerCount > 0
      || result.ledger.unreadableLedgerDirectoryAccessCount > 0
      || result.ledger.indeterminateLedgerDirectoryCount > 0
      || result.pty.unreadable.length > 0,
    statusFor: (runId: string) => statusByRunId.get(runId)?.status ?? 'unassessed',
  };
}

function conflictRunStatuses(conflicts: readonly { path: string; runIds: readonly string[] }[], statusFor: (runId: string) => string): Array<{ path: string; runIds: Array<{ runId: string; status: string }> }> {
  return conflicts.map(({ path, runIds }) => ({ path, runIds: runIds.map((runId) => ({ runId, status: statusFor(runId) })) }));
}

function renderConflictRunIds(runIds: readonly { runId: string; status: string }[]): string {
  return runIds.map(({ runId, status }) => `${runId}) status=${status}`).join(', ');
}

function currentChangePaths(
  run: CmdRunner,
  cwd: string,
  staged: PorcelainStatusRecord[] | null,
  base: string,
  out: { log: (message: string) => void },
): string[] {
  const fromStatus = staged
    ? staged.flatMap(({ path, originalPath }) => (originalPath ? [path, originalPath] : [path]))
    : [];
  const localBase = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  const remoteDisplayBase = `origin/${localBase}`;
  const remoteBase = `refs/remotes/${remoteDisplayBase}`;
  const remoteExists = run('git', ['rev-parse', '--verify', '--quiet', remoteBase], { cwd }).ok;
  const comparisonBase = remoteExists ? remoteBase : localBase;

  if (!remoteExists) {
    out.log(`⚠ changed-files: 원격 추적 ref ${remoteDisplayBase} 없음 — 로컬 ${localBase} 기준으로 계산합니다.`);
  } else {
    const divergence = run('git', ['rev-list', '--left-right', '--count', `${localBase}...${remoteBase}`], { cwd });
    const counts = divergence.ok ? divergence.out.trim().match(/^(\d+)\s+(\d+)$/) : null;
    const localAheadCount = counts ? Number(counts[1]) : null;
    const localBehindCount = counts ? Number(counts[2]) : null;
    if (localAheadCount === null || localBehindCount === null || localAheadCount > 0 || localBehindCount > 0) {
      out.log(`⚠ changed-files: 로컬 ${localBase}와 원격 ${remoteDisplayBase}가 갈립니다 (로컬 뒤처짐=${localBehindCount ?? 'unknown'}커밋) — ${remoteDisplayBase}...HEAD 기준으로 계산합니다.`);
    }
  }

  const diff = run('git', ['diff', '--name-only', '--no-renames', `${comparisonBase}...HEAD`], { cwd });
  const fromDiff = diff.ok ? parseNameOnlyList(diff.out) : [];
  return unionPaths(fromStatus, fromDiff);
}

function collectResolvedBaseLandings(
  run: CmdRunner,
  cwd: string,
  since: string,
  baseRef: string,
) {
  return collectBaseLandingCommits(run, cwd, { since, baseRef });
}

const RECENT_LANDING_WINDOW_MINUTES = 30;

function currentAuthorEmail(run: CmdRunner, cwd: string): string | undefined {
  const result = run('git', ['config', 'user.email'], { cwd });
  if (!result.ok) return undefined;
  const email = result.out.trim();
  return email || undefined;
}

export function formatCommitMessageFallbackNotice(input: {
  branch: string;
  hasTitle: boolean;
}): string | null {
  if (!input.hasTitle) return null;
  return `⚠ commit-message: --title 은 PR 제목에만 쓰입니다. 커밋 메시지는 "chore: land ${input.branch}" 가 됩니다 — 같은 문면을 남기려면 --commit-message 를 함께 주십시오.`;
}

const LAND_REASON_MAX_LENGTH = 160;
const LAND_REASON_TRUNCATE_LENGTH = 157;

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

function formatSiblingPrAdvisory(siblings: readonly { number: number; headRefName: string }[]): string | null {
  if (siblings.length === 0) return null;
  const named = siblings.map((pr) => `#${pr.number} ${pr.headRefName}`).join(', ');
  return `⚠ sibling-prs: ${named} — 같은 골에서 나온 열린 PR입니다. 이어 붙일지 이것을 살릴지 고르십시오.`;
}

function lookupOpenPrs(run: CmdRunner, cwd: string): { number: number; headRefName: string }[] | null {
  const listed = run(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', String(SOURCE_SPLIT_PR_LIST_LIMIT), '--json', 'number,headRefName'],
    { cwd },
  );
  if (!listed.ok) return null;
  try {
    const parsed: unknown = JSON.parse(listed.out);
    if (!Array.isArray(parsed)) return null;
    const prs: { number: number; headRefName: string }[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') return null;
      const number = (entry as { number?: unknown }).number;
      const headRefName = (entry as { headRefName?: unknown }).headRefName;
      if (typeof number !== 'number' || !Number.isInteger(number) || typeof headRefName !== 'string') return null;
      prs.push({ number, headRefName });
    }
    return prs;
  } catch {
    return null;
  }
}

function emitSiblingPrAdvisory(
  branch: string,
  listOpenPrs: () => readonly { number: number; headRefName: string }[] | null,
  out: { log: (message: string) => void },
): boolean {
  if (branchLineageSlug(branch) === null) return false;
  let openPrs: readonly { number: number; headRefName: string }[] | null;
  try {
    openPrs = listOpenPrs();
  } catch (error) {
    record('sibling-prs', false, {
      outcome: 'lookup-failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!openPrs) {
    record('sibling-prs', false, { outcome: 'lookup-failed' });
    return false;
  }
  const siblings = findSiblingPrs(branch, openPrs);
  const line = formatSiblingPrAdvisory(siblings);
  if (!line) {
    record('sibling-prs', true, { outcome: 'none' });
    return false;
  }
  out.log(line);
  record('sibling-prs', true, {
    outcome: 'found',
    count: siblings.length,
    numbers: siblings.map((pr) => pr.number),
  });
  return true;
}

export function formatLandReasonNotice(input: {
  reason?: string;
  advisoryShown: boolean;
}): string | null {
  if (!input.advisoryShown) return null;
  if (!input.reason) {
    return '⚠ land-reason: 권고가 떴는데 이유가 없습니다 — 지금 내야 한다면 --land-reason 으로 한 줄 남기십시오.';
  }
  const points = Array.from(input.reason);
  const displayed = points.length > LAND_REASON_MAX_LENGTH
    ? `${points.slice(0, LAND_REASON_TRUNCATE_LENGTH).join('')}...`
    : input.reason;
  return `✓ land-reason: ${displayed}`;
}

function emitRecentLandingRateAdvisory(
  run: CmdRunner,
  cwd: string,
  commits: readonly { subject: string; authorEmail: string; committedAtMs: number }[] | null,
  out: { log: (message: string) => void },
): boolean {
  const windowMinutes = RECENT_LANDING_WINDOW_MINUTES;
  const authorEmail = currentAuthorEmail(run, cwd);
  if (!authorEmail || commits === null) {
    const previous = commits === null ? undefined : previousLandingSummary(commits, Date.now());
    record('recent-landing-rate', true, {
      recentCount: 0,
      windowMinutes,
      emitted: false,
      scope: 'repository',
      hasPrevious: previous !== undefined,
    });
    return false;
  }
  const nowMs = Date.now();
  const recentCount = countRecentLandings(commits, {
    authorEmail,
    nowMs,
    windowMinutes,
  });
  const previous = previousLandingSummary(commits, nowMs);
  const line = formatRecentLandingRateAdvisory({
    recentCount,
    windowMinutes,
    ...(previous ? { previous } : {}),
  });
  if (line) out.log(line);
  record('recent-landing-rate', true, {
    recentCount,
    windowMinutes,
    emitted: !!line,
    scope: 'repository',
    hasPrevious: previous !== undefined,
  });
  return !!line;
}

function emitLandingOverlapAdvisory(
  run: CmdRunner,
  cwd: string,
  base: string,
  currentFiles: readonly string[],
  out: { log: (message: string) => void },
): boolean {
  if (currentFiles.length === 0) {
    record('overlap', true, { outcome: 'no-changed-files' });
    return false;
  }
  const commits = collectResolvedBaseLandings(run, cwd, DEFAULT_GRANULARITY_SINCE, base);
  if (commits === null) {
    record('overlap', false, { outcome: 'lookup-failed' });
    return false;
  }
  const overlaps = overlapWithCurrentChanges(commits, currentFiles);
  const line = formatOverlapAdvisory(overlaps);
  if (line) {
    record('overlap', true, {
      outcome: 'found',
      overlappingFileCount: overlaps.length,
      comparedLandingCount: commits.length,
    });
    out.log(line);
    return true;
  }
  record('overlap', true, { outcome: 'none' });
  return false;
}

const SOURCE_SPLIT_PR_LIST_LIMIT = 200;
/**
 * merged 조회의 «폭주 방지» 절대 상한 — ⛔ 창을 덮는 값이 «아니라» 그 위의 천장이다.
 * ⚠️ `SOURCE_SPLIT_PR_LIST_LIMIT`(열린 PR 축)과 «같은 상수를 쓰면 안 된다» —
 *    그러면 천장이 창(하루 약 300 착지)보다 작아 `mergedPrLookupLimit` 이 항상 그 값으로 눌린다
 *    (2026-08-28 실측: 그 상태에서 `조회 창 밖 99` 가 남았다).
 */
const MERGED_PR_LOOKUP_RUNAWAY_CAP = 1000;
const SOURCE_LOOKUP_FAILED_LINE = '⚠ source: 브랜치 조회에 실패해 갈래를 내지 못했습니다.';

type MergedPrHeadRefsLookup = {
  map: Map<number, string>;
  count: number;
  limit: number;
  truncated: boolean;
};

function countPrNumberedLandings(commits: readonly { subject: string }[]): number {
  let count = 0;
  for (const commit of commits) {
    if (extractPrNumberFromSubject(commit.subject) !== null) count += 1;
  }
  return count;
}

/** Cover the window's PR-numbered landings; never exceed the runaway cap. */
function mergedPrLookupLimit(prNumberedLandingCount: number): number {
  return Math.min(MERGED_PR_LOOKUP_RUNAWAY_CAP, Math.max(prNumberedLandingCount, 1));
}

function lookupMergedPrHeadRefs(run: CmdRunner, cwd: string, limit: number): MergedPrHeadRefsLookup | null {
  const listed = run(
    'gh',
    ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,headRefName'],
    { cwd },
  );
  if (!listed.ok) return null;
  try {
    const parsed: unknown = JSON.parse(listed.out);
    if (!Array.isArray(parsed)) return null;
    const map = new Map<number, string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') return null;
      const number = (entry as { number?: unknown }).number;
      const headRefName = (entry as { headRefName?: unknown }).headRefName;
      if (typeof number !== 'number' || !Number.isInteger(number) || typeof headRefName !== 'string') return null;
      map.set(number, headRefName);
    }
    const count = parsed.length;
    return {
      map,
      count,
      limit,
      // 상한에 «닿았다»는 «날 사실»이다 — 그것이 무언가를 설명하는지는 아래 인쇄 조건이 가른다.
      truncated: count === limit,
    };
  } catch {
    return null;
  }
}

export function runPrGranularity(opts: PrGranularityOpts = {}, deps: PrLandDeps = {}): number {
  const out = deps.out ?? liveOut;
  const cwd = opts.cwd ?? process.cwd();
  const run = deps.run ?? defaultCmdRunner;
  const since = opts.since?.trim() || DEFAULT_GRANULARITY_SINCE;
  const resolveBase = deps.resolveBase ?? resolveDeliverableBase;
  const base = resolveBase(run, cwd, opts.base);
  if (!base) {
    out.error('✗ granularity: 비교 base를 해석하지 못했습니다.');
    return 1;
  }
  const commits = collectResolvedBaseLandings(run, cwd, since, base);
  if (commits === null) {
    out.error('✗ granularity: 로컬 git log 를 읽지 못했습니다.');
    return 1;
  }
  let sourceLookup: MergedPrHeadRefsLookup | null | undefined;
  if (opts.withSource) {
    sourceLookup = lookupMergedPrHeadRefs(run, cwd, mergedPrLookupLimit(countPrNumberedLandings(commits)));
  }
  for (const line of formatGranularityReport(computeGranularityStats(commits, sourceLookup?.map), since)) out.log(line);
  if (opts.withSource) {
    const lookup = sourceLookup ?? null;
    if (lookup === null) {
      out.log(SOURCE_LOOKUP_FAILED_LINE);
    } else {
      const headRefByPrNumber = lookup.map;
      for (const line of formatSourceSplitReport(computeSourceSplit(commits, headRefByPrNumber))) out.log(line);
      // ⭐ 계보 절도 «같은 조회»로 낸다 — lookupMergedPrHeadRefs 를 두 번 부르지 않는다.
      //   무리·미상 원인이 모두 0이면 formatLineageReport 가 빈 배열을 내 이 루프는 조용하다.
      const lineage = computeLineageStats(commits, headRefByPrNumber, lookup.truncated);
      for (const line of formatLineageReport(lineage)) out.log(line);
      // ⭐ 상한에 닿았더라도 «그것이 아무것도 설명하지 못하면» 이 줄을 내지 않는다 —
      //   상한을 창에서 유도한 뒤로는 「닿았다」가 흔해졌고, 그 줄만 보면 읽는 사람이
      //   ⛔ 「분모가 빠졌다」로 오독한다. 실제로 «못 본 착지»가 있을 때만 말한다.
      if (lookup.truncated && lineage.outsideLookupWindow > 0) {
        out.log(`MAYBE_TRUNCATED limit=${lookup.limit} count=${lookup.count}`);
      }
    }
  }
  return 0;
}

/** Execute the human PR landing sequence. Every failure is terminal. */
/** GitHub GraphQL `MergeableState` · `MergeStateStatus` 열거값. */
const GITHUB_MERGEABLE = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const GITHUB_MERGE_STATE = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);

export async function runPrLand(opts: PrLandOpts = {}, deps: PrLandDeps = {}): Promise<number> {
  const out = deps.out ?? liveOut;
  if (opts.title !== undefined && opts.titleFile !== undefined) {
    out.error('✗ title: --title과 --title-file은 함께 사용할 수 없습니다.');
    return 1;
  }
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    out.error('✗ body: --body와 --body-file은 함께 사용할 수 없습니다.');
    return 1;
  }
  if (opts.includeActiveRunFiles && opts.excludeActiveRunFiles) {
    out.error('✗ active-run-files: --include-active-run-files와 --exclude-active-run-files는 함께 사용할 수 없습니다.');
    return 1;
  }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let title = opts.title;
  let body = opts.body;
  let commitMessage = opts.commitMessage;
  if (opts.titleFile) {
    try { title = readFile(opts.titleFile); }
    catch (error) {
      out.error(`✗ title: --title-file 읽기 실패 (${opts.titleFile}): ${String((error as { message?: string })?.message ?? error)}`);
      return 1;
    }
  }
  if (opts.bodyFile) {
    try { body = readFile(opts.bodyFile); }
    catch (error) {
      out.error(`✗ body: --body-file 읽기 실패 (${opts.bodyFile}): ${String((error as { message?: string })?.message ?? error)}`);
      return 1;
    }
  }
  if (opts.commitMessageFile) {
    try { commitMessage = readFile(opts.commitMessageFile); }
    catch (error) {
      out.error(`✗ commit-message: --commit-message-file 읽기 실패 (${opts.commitMessageFile}): ${String((error as { message?: string })?.message ?? error)}`);
      return 1;
    }
  }

  const cwd = opts.cwd ?? process.cwd();
  const run = deps.run ?? defaultCmdRunner;
  const resolveBase = deps.resolveBase ?? resolveDeliverableBase;
  const branch = (deps.currentBranch ?? liveCurrentBranch)(cwd);
  if (!branch) {
    const detail = '현재 브랜치를 해석하지 못했습니다.';
    record('branch', false);
    out.error(`✗ branch: ${detail}`);
    return 1;
  }
  record('branch', true);
  out.log(`✓ branch: ${branch}`);

  const base = resolveBase(run, cwd, opts.base);
  if (!base) {
    const detail = '비교 base를 선택하지 못했습니다.';
    record('base', false);
    out.error(`✗ base: ${detail}`);
    return 1;
  }
  const baseTarget = remoteBaseTarget(run, cwd, base);
  const capability = remoteCapability(run, cwd, base, baseTarget);
  const baseOutput = baseLine(base, capability);
  record('base', baseOutput.ok, { capability });
  (baseOutput.ok ? out.log : out.error)(baseOutput.text);
  const hadTitle = opts.title !== undefined;
  const hasExplicitCommitMessage = opts.commitMessage !== undefined || opts.commitMessageFile !== undefined;
  const fallbackNotice = hasExplicitCommitMessage
    ? null
    : formatCommitMessageFallbackNotice({ branch, hasTitle: hadTitle });
  if (fallbackNotice) out.log(fallbackNotice);
  record('commit-message-fallback', true, { branch, hadTitle, emitted: fallbackNotice !== null });
  const recentAdvisoryShown = emitRecentLandingRateAdvisory(
    run,
    cwd,
    collectResolvedBaseLandings(run, cwd, DEFAULT_GRANULARITY_SINCE, base),
    out,
  );

  // ⛔ local-path / no-remote 는 gh 가 원리상 못 한다. 이미 아는 자리에서 멈춘다.
  //    `other` 는 GitHub Enterprise 가 떨어지므로 막지 않는다 — gh 가 시도하게 둔다.
  if (capability === 'local-path' || capability === 'no-remote') return 1;

  // ⛔⭐⭐ 「현재 브랜치 == base」면 ***커밋 «전»에*** 멈춘다.
  //   📏 2026-08-12 실측(내가 밟았다): 브랜치 생성이 `index.lock` 으로 실패해 main 에 선 채로 이것을 쳤다.
  //     ⇒ `upsertPr` 이 «PR 을 못 만든다»고 거부했지만 그때는 ***이미 `add --all` + commit 이 main 에 얹힌 뒤***였고,
  //       그대로 push 돼 `chore: land main` 이라는 무의미한 커밋이 ***PR 흐름을 건너뛰고*** 들어갔다.
  //   🎯 ⇒ 📌 ***거부는 「할 수 없다」를 아는 «가장 이른» 자리에서 해야 한다*** — 부작용 뒤가 아니라.
  //   ⛔ base 는 `origin/main` 처럼 remote 표기일 수 있으므로 «접미»로 비교한다.
  const baseBranchName = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  if (branch === base || branch === baseBranchName) {
    record('same-branch', false);
    out.error(`✗ same-branch: 현재 브랜치가 base 와 같다(${branch}) — 작업 브랜치로 옮긴 뒤 다시 치십시오. ⛔ 아무것도 커밋하지 않았습니다.`);
    return 1;
  }
  record('same-branch', true);

  // `upsertPr()` performs `git add -A`; observe every path it would stage before that write.
  let activeRunConflicts: Array<{ path: string; runIds: string[] }> = [];
  const staged = stagedPaths(run, cwd);
  if (staged === null) {
    record('active-run-files', false, { status: 'staging-paths-unreadable' });
    out.error('✗ active-run-files: 전체 스테이징 대상 조회 실패. 도는 런 파일 위험 검사를 수행하지 못한 채 계속합니다.');
  } else {
    const stagedPaths = [...new Set(staged.flatMap(({ path, originalPath }) => originalPath ? [path, originalPath] : [path]))];
    const untrackedPaths = [...new Set(staged.filter(({ xy }) => xy === '??').map(({ path }) => path))];
    if (untrackedPaths.length > 0) {
      record('untracked-files', true, { count: untrackedPaths.length, paths: untrackedPaths });
      out.error(`⚠ untracked-files: 전체 스테이징에 추적되지 않던 파일 ${untrackedPaths.length}개가 포함됩니다 — ${untrackedPaths.join('; ')}.`);

      // ⛔⭐ 그 경고는 「담아야 할 새 파일」과 「담으면 안 되는 남의 산출물」을 «같은 값»으로 낸다.
      //   🩸 실측(2026-09-07): 자식의 계획 문서(`내부 문서 `RFC-write-plan-*``)가 «남의 PR»에 딸려 온 일이
      //      하루 «여섯» 번 났고(#15874 #15875 #15878 #15879 #15883 #15901),
      //      어제 것은 ***main 에 이미 착지했다***(#15735 — 그 PR 제목과 완전히 무관하다).
      //   ⇒ 그 부분집합을 «따로» 세어 이름을 댄다. ⛔ 막지는 «않는다» — 위 경고와 같은 성질이다
      //     (정당한 경우가 있다: 그 문서를 «고치는» PR).
      const ungroundedPlanArtifacts = untrackedPaths.filter((path) => {
        try {
          // ⛔⭐ `git status` 는 `{ cwd }` 로 돌아 «그 워크트리 기준 상대 경로»를 낸다.
          //   ⇒ `readFile(path)` 는 «프로세스 CWD» 에서 읽으므로 `--cwd` 를 쓰면 ***조용히 못 읽고***
          //     이 검사가 «없는 것처럼» 통과한다(무인 리뷰가 잡았다). 대상 트리에 결박한다.
          return planArtifactBodyDeclaresCreatedWithoutGoalOrGrounding({ body: readFile(resolve(cwd, path)) });
        } catch {
          return false; // 못 읽으면 «아니다»로 접지 않고 조용히 넘긴다 — 이 검사가 착지를 막지 않는다
        }
      });
      if (ungroundedPlanArtifacts.length > 0) {
        // ⛔⭐ 문면은 ***자가 «실제로 본 것»만*** 말한다 — 무인 리뷰 2차가 잡았다.
        //   🩸 앞 판은 「골이 `write a plan` 뿐이었고 조사 재료가 제공되지 않았다」고 «단언»했는데,
        //     이 자는 그것을 «증명하지 못한다». 리뷰가 준 반례를 눌러 확인했다:
        //     "`write a plan` 외 구현도 요청됐지만 historian 재료는 제공되지 않았다" → ***매치된다***.
        //   ⇒ 자를 더 좁히면 실물 변형(여섯 종)을 놓친다 ⇒ ***출력을 근거 수준으로 낮춘다.***
        record('ungrounded-plan-artifacts', true, {
          count: ungroundedPlanArtifacts.length,
          paths: ungroundedPlanArtifacts,
          evidence: 'body has `write a plan` followed by 제공되지 않았다 in one sentence unit (heuristic; not proof of goallessness)',
        });
        out.error(
          `⚠ ungrounded-plan-artifacts: 그중 ${ungroundedPlanArtifacts.length}개의 본문에 `
            + '「`write a plan`」 과 「제공되지 않았다」가 ***한 문장 안에 그 순서로*** 있습니다 — '
            + `${ungroundedPlanArtifacts.join('; ')}. `
            + '⛔ 자식의 계획 산출물이 딸려 온 형태일 수 있습니다 — 이 골의 것이 맞는지 «읽어» 확인하십시오'
            + '(휴리스틱이라 단정하지 않고, 막지도 않습니다).',
        );
      }
    }
    try {
      const query = unfinishedRunQuery((deps.listUnfinishedRuns ?? (() => queryFederatedUnfinishedRunLedgers({ includeTest: true })))());
      const failures = unfinishedRunLookupFailures(query);
      const lookupComplete = !hasUnfinishedRunLookupFailures(query);
      const conflicts = activeRunFileConflicts(cwd, stagedPaths, query.entries);
      let observation: Record<string, unknown>;
      let runningRunObservationComplete: boolean;
      let conflictStatuses: Array<{ path: string; runIds: Array<{ runId: string; status: string }> }>;
      try {
        const running = (deps.queryRunningRuns ?? (() => queryRunningRuns({ includeTest: true, caller: 'pr-land' })))();
        const summary = runningRunObservation(running, query.entries.length);
        const statusFor = summary.statusFor as (runId: string) => string;
        observation = { ...summary };
        delete observation.statusFor;
        runningRunObservationComplete = !observation.runningRunObservationIncomplete;
        conflictStatuses = conflictRunStatuses(conflicts, statusFor);
        if (!runningRunObservationComplete) {
          out.error(`⚠ active-run-files: 실제 도는 런 관측이 불완전합니다 (unreadableLedgers=${observation.runningRunUnreadableLedgerCount}, unreadableLedgerDirectoryAccesses=${observation.runningRunUnreadableLedgerDirectoryAccessCount}, indeterminateLedgerDirectories=${observation.runningRunIndeterminateLedgerDirectoryCount}, unreadablePtyRoots=${(observation.runningRunUnreadablePtyRoots as readonly string[]).join(',') || 'none'}). 관측된 도는 런 수와 완전히 측정된 0건을 구분해 미완 런 겹침 검사를 유지합니다.`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        observation = { unfinishedRunCount: query.entries.length, runningRunObservation: 'unavailable', runningRunObservationDetail: detail };
        runningRunObservationComplete = false;
        conflictStatuses = conflictRunStatuses(conflicts, () => 'unassessed');
        out.error(`⚠ active-run-files: 실제 도는 런 관측 실패 (${detail}). 도는 런 0건과 구분해 미완 런 겹침 경고를 유지합니다.`);
      }
      const activeRunLookupComplete = lookupComplete && runningRunObservationComplete;
      const observationStatus = activeRunLookupComplete
        ? 'complete'
        : !lookupComplete && !runningRunObservationComplete
          ? 'unfinished-runs-and-running-observation-partial'
          : !lookupComplete
            ? 'unfinished-runs-partial'
            : observation.runningRunObservation === 'unavailable'
              ? 'running-runs-unavailable'
              : 'running-runs-partial';
      record('active-run-files', activeRunLookupComplete, {
        status: observationStatus,
        unfinishedRunLookupComplete: lookupComplete,
        runningRunObservationComplete,
        stagedPathCount: stagedPaths.length,
        untrackedPathCount: untrackedPaths.length,
        untrackedPaths,
        conflictCount: conflicts.length,
        conflicts,
        conflictStatuses,
        ...observation,
        ...failures,
      });
      if (!lookupComplete) {
        out.error(`⚠ active-run-files: 도는 런 조회가 불완전합니다 (unreadableLedgerDirectories=${failures.unreadableLedgerDirectoryCount}, missingDirectories=${failures.missingLedgerDirectoryCount}, unreadableDirectories=${failures.unreadableLedgerDirectoryAccessCount}, indeterminateDirectories=${failures.indeterminateLedgerDirectoryCount}, unreadableLedgers=${failures.unreadableLedgerCount}). 도는 런 없음과 구분해 계속합니다.`);
      }
      if (conflicts.length > 0) {
        activeRunConflicts = conflicts;
        const observed = observation.runningRunObservation === 'unavailable'
          ? '실제 도는 런은 측정하지 못했습니다'
          : runningRunObservationComplete
            ? `미완 런 ${observation.unfinishedRunCount}건 중 실제 도는 런 ${observation.runningRunCount}건 (countedStatuses=${(observation.countedStatuses as readonly string[]).join(',')})`
            : `미완 런 ${observation.unfinishedRunCount}건 중 관측된 실제 도는 런 ${observation.runningRunCount}건 (조회 불완전; countedStatuses=${(observation.countedStatuses as readonly string[]).join(',')})`;
        const conflictDetail = conflicts.map(({ path, runIds }) => `${path} (runId=${runIds.join(',')})`).join('; ');
        const statusDetail = conflictStatuses.map(({ path, runIds }) => `${path} (${renderConflictRunIds(runIds)}`).join('; ');
        out.error(`⚠ active-run-files: 전체 스테이징에 미완 런 겹침 파일 ${conflicts.length}개가 포함됩니다 — ${observed}; ${conflictDetail}; statuses=${statusDetail}.`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record('active-run-files', false, { status: 'unfinished-runs-unreadable', detail });
      out.error(`✗ active-run-files: 도는 런 조회 실패 (${detail}). 도는 런 없음과 구분해 계속합니다.`);
    }
  }

  const deletionDominant = deletionDominantFiles(run, cwd);
  if (deletionDominant && deletionDominant.length > 0) {
    const detail = deletionDominant.map(({ path, added, deleted }) => `${path} (+${added}/-${deleted})`).join('; ');
    record('deletion-dominant-files', true, {
      count: deletionDominant.length,
      files: deletionDominant,
    });
    out.error(`⚠ deletion-dominant-files: 삭제가 추가보다 많은 파일 ${deletionDominant.length}개 — ${detail}.`);
  }

  // ⛔⭐ 제목 기본값은 «이 브랜치가 «더한» 마지막 커밋»에서만 온다.
  //   📏 2026-08-11 실측(내가 만든 결함): `git log -1` 만 쓰면 브랜치에 «자기 커밋이 없을 때»
  //     base 의 마지막 커밋 제목을 집어 ***전혀 다른 PR 의 제목***이 붙는다.
  //     실물 `#8300` — 하니스 재점화 PR 에 `[S] docs: FINDING §6d …(#8297)` 이 붙었다.
  //     (그 창에서 `git commit` 이 `index.lock` 으로 실패했고, `pr land` 가 그것을 흡수해 커밋했다.)
  //   ⇒ 📌 `<base>..HEAD` 로 범위를 좁히고, 비면 ***지어내지 않고*** `Land <branch>` 로 되돌아간다.
  //     ⛔ 「없음」을 「남의 제목」으로 채우지 않는다.
  if (opts.title === undefined && opts.titleFile === undefined) {
    const commitTitle = run('git', ['log', '-1', '--format=%s', `${base}..HEAD`], { cwd });
    if (commitTitle.ok && commitTitle.out.trim()) title = commitTitle.out.trim();
    // ⛔⭐⭐⭐⭐ **아직 커밋이 «없을» 때 — `--commit-message` 가 바로 그 제목이다**(2026-08-19 · 대표 지적).
    //
    // 🚨 실측한 결함: 위 조회는 커밋을 만들기 ***«전»***에 돈다. 그런데 가장 흔한 사용 형태는
    //   ***「미커밋 변경 ⊕ `--commit-message`」***다(작업 트리에서 바로 착지). 그 경로에서는
    //   `<base>..HEAD` 가 ***언제나 비어*** 있어 제목이 ***원리상 절대 안 잡히고*** `Land <branch>` 로 떨어졌다.
    //   📏 그 결과: 2026-08-17 18:46 부터 이틀간 ***156건***이 `Land <브랜치>` 제목 ⊕ 34자 플레이스홀더 본문으로
    //     들어갔다(두 세션 «모두» 밟았다). 같은 시각 하니스가 연 PR 은 본문이 22,741자였다.
    // ⭐ 이것은 ***「지어내기」가 아니다*** — `--commit-message` 는 ***곧 그 커밋의 제목이 될 문자열***이다.
    //   위 주석이 금지한 것은 「«남의» 커밋 제목을 집는 것」이고, 이건 «이 착지 자신의» 문면이다.
    //
    // 🚨🆕 **그리고 커밋이 «이미 있어도» 명시된 `--commit-message` 가 이긴다**(2026-08-28 실측).
    //   위 `git log -1` 이 «먼저» 돌아 브랜치의 마지막 커밋 제목을 집는다. 그런데 워크트리에서
    //   자식 뼈대를 이어받아 마감할 때는 «작업 커밋»(예: `wip`)이 이미 있고,
    //   그 경로에서 `--commit-message` 가 ***통째로 무시***됐다.
    //   📏 그래서 `wip (#13841)` 이 main 에 들어갔다 — 소스 3파일을 바꾼 착지인데 제목이 `wip` 이다.
    //   ⭐ 명시된 `--commit-message` 는 ***이 착지에 대한 사람의 «선언»***이므로 이전 작업 커밋보다 세다.
    //   ⛔ 명시가 «없을» 때는 지금처럼 커밋 제목을 쓴다 — 그건 「남의 문면」이 아니라 이 브랜치의 것이다.
    if (commitMessage?.trim()) {
      title = commitMessage.trim().split('\n', 1)[0]!.trim();
    }
  }

  const typecheckOk = (deps.runTypecheckGate ?? runPrLandTypecheckGate)(out);
  record('typecheck', typecheckOk);
  if (!typecheckOk) {
    // ⛔⭐ 「왜 막혔나」를 «단정하지 않는다» — 이 게이트는 불리언만 돌려주므로 여기서는 이유를 모른다.
    //   📏 실측(2026-09-05): 깨진 base 로 막혔을 때 이 줄이 「타입 에러 때문」이라고 «틀리게» 말했다.
    //     실제 이유는 `[tsc-gate] ⛔ 변경 파일 수집 실패` 였고 그것은 «바로 위에» 이미 찍혀 있었다.
    //   ⛔ 「위 출력을 보라」고도 «말하지 않는다** — `deps.runTypecheckGate` 는 불리언만 계약하므로
    //     주입된 게이트가 «아무것도 안 찍을» 수 있다(무인 리뷰 지적). 약속할 수 없는 것을 약속하지 않는다.
    //   ⇒ 이 줄이 말하는 것은 «무엇이 막았나» 하나뿐이다.
    //   ⚠️ `.github/workflows` 가 없어 `pr land` 가 «유일한» 강제점이다 — 여기서 이유를 틀리게 대면
    //     읽는 사람이 없는 타입 에러를 찾는다.
    out.error('✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.');
    return 1;
  }
  out.log('✓ typecheck: scripts/ci-typecheck-changed.ts PASS — changed files have no new type errors.');

  const isolation = gateVerdict('isolation-gate', deps.runIsolationGate ?? ((o) => runPrLandIsolationGate(o, cwd)), out);
  // ⭐ 관측에 «잰 것»과 «못 잰 것»을 다른 값으로 남긴다 — 둘이 같은 모양이면 그 자는 거짓을 낸다.
  record('isolation-gate', isolation.ok, { measured: isolation.measured });
  if (!isolation.ok) {
    out.error('✗ isolation-gate: scripts/ci-isolation-hardcode-gate.ts blocked pr land because changed files introduce new homedir+.elanous hardcoding.');
    return 1;
  }
  if (isolation.measured) {
    out.log('✓ isolation-gate: scripts/ci-isolation-hardcode-gate.ts PASS — no new homedir+.elanous hardcoding.');
  }

  const mockModuleRestore = gateVerdict('mock-module-restore-gate', deps.runMockModuleRestoreGate ?? runPrLandMockModuleRestoreGate, out);
  record('mock-module-restore-gate', mockModuleRestore.ok, { measured: mockModuleRestore.measured });
  if (!mockModuleRestore.ok) {
    out.error('✗ mock-module-restore-gate: scripts/ci-mock-module-restore-gate.ts blocked pr land because changed tests introduce mock.module without R-TST23 restoration.');
    return 1;
  }
  if (mockModuleRestore.measured) {
    out.log('✓ mock-module-restore-gate: scripts/ci-mock-module-restore-gate.ts PASS — no new un-restored mock.module.');
  }

  // ⛔⭐⭐ 모델 «이름» 하드코딩 — 🩸 2026-09-25 · 대표 이 «두 번» 같은 정정을 했다.
  //   근본은 훈계가 아니라 ***분포***였다: 스크립트에 박힌 이름 중 «가장 흔한» 것이 ***낡은 것***이라
  //   옆 파일을 베끼면 낡은 이름을 물려받는다. ⇒ 이 자가 «신규»만 막는다(ratchet).
  //   ⚠️ `.github/workflows` 가 없어 `pr land` 가 «유일한» 강제점이다.
  const modelHardcode = gateVerdict('model-hardcode-gate', deps.runModelHardcodeGate ?? ((o) => runModelHardcodeGate({ log: o.log, error: o.error, args: [] }) === 0), out);
  record('model-hardcode-gate', modelHardcode.ok, { measured: modelHardcode.measured });
  if (!modelHardcode.ok) {
    out.error('✗ model-hardcode-gate: scripts/ci-model-hardcode-gate.ts blocked pr land because changed files hardcode a model id — derive it from tierModel()/config instead.');
    return 1;
  }
  if (modelHardcode.measured) {
    out.log('✓ model-hardcode-gate: scripts/ci-model-hardcode-gate.ts PASS — no new hardcoded model id.');
  }
  const daemonPort = gateVerdict('daemon-port-gate', deps.runDaemonPortGate ?? ((o) => runDaemonPortGate({ log: o.log, error: o.error, cwd, args: [] }) === 0), out);
  record('daemon-port-gate', daemonPort.ok, { measured: daemonPort.measured });
  if (!daemonPort.ok) {
    out.error('✗ daemon-port-gate: scripts/ci-daemon-port-gate.ts blocked pr land because source hardcodes the daemon port — resolve it with resolveDaemonEndpoint (src/nexus/daemon-endpoint.ts).');
    return 1;
  }
  if (daemonPort.measured) {
    out.log('✓ daemon-port-gate: scripts/ci-daemon-port-gate.ts PASS — no new daemon port literals.');
  }

  const changedPaths = currentChangePaths(run, cwd, staged, base, out);
  publicLeakWarning(changedPaths, deps.runPublicLeakGate ?? runPrLandPublicLeakGate, out);
  if (publicDocPaths(changedPaths, () => true).length > 0) {
    const top = run('git', ['rev-parse', '--show-toplevel'], { cwd });
    const docsRoot = top.ok && top.out.trim() ? top.out.trim() : cwd;
    docsCliWarning(publicDocPaths(changedPaths, (f) => existsSync(join(docsRoot, f))), deps.runDocsCliCheck ?? runPrLandDocsCliCheck(docsRoot), out);
  }
  const testInterference = await testInterferenceGateVerdict(
    deps.runTestInterferenceGate ?? ((o, files) => runTestInterferenceGate({ args: ['--changed-files', ...files], log: o.log })),
    changedPaths,
    out,
  );
  record('test-interference-gate', true, { measured: testInterference.measured });

  const androidGate = gateVerdict(
    'android-gate',
    deps.runAndroidGate
      ? (o) => deps.runAndroidGate!(o, changedPaths)
      : (o) => runPrLandAndroidGate(o, changedPaths),
    out,
  );
  record('android-gate', androidGate.ok, { measured: androidGate.measured });
  if (!androidGate.ok) {
    out.error('✗ android-gate: scripts/ci-android-unit-tests.ts blocked pr land — 안드로이드 단위 시험이 «돌지 않았거나» 실패했다.');
    return 1;
  }
  // ⛔ 「안 돌았다」를 「돌았다」로 «말하지 않는다» — 이 게이트가 고치려는 병이 정확히 그것이다.
  //    안드로이드를 안 만진 PR 이면 게이트가 스스로 「해당 없음」을 냈으니 여기서 또 말하지 않는다.
  if (androidGate.measured && androidFilesIn(changedPaths).length > 0) {
    out.log('✓ android-gate: scripts/ci-android-unit-tests.ts PASS — 안드로이드 단위 시험이 «실제로 돌았고» 실패 0.');
  }

  const iosGate = gateVerdict(
    'ios-gate',
    deps.runIosGate
      ? (o) => deps.runIosGate!(o, changedPaths)
      : (o) => runIosUnitTestGate({ args: ['--changed-files', ...changedPaths], log: o.log, error: o.error }) === 0,
    out,
  );
  record('ios-gate', iosGate.ok, { measured: iosGate.measured });
  if (!iosGate.ok) {
    out.error('✗ ios-gate: scripts/ci-ios-unit-tests.ts blocked pr land — iOS 순수-로직 시험이 «돌지 않았거나» 실패했다.');
    return 1;
  }
  if (iosGate.measured && iosFilesIn(changedPaths).length > 0) {
    out.log('✓ ios-gate: scripts/ci-ios-unit-tests.ts PASS — iOS 순수-로직 시험이 «실제로 돌았고» 실패 0.');
  }


  const overlapFound = emitLandingOverlapAdvisory(run, cwd, base, changedPaths, out);
  const siblingFound = emitSiblingPrAdvisory(
    branch,
    deps.listOpenPrs ?? (() => lookupOpenPrs(run, cwd)),
    out,
  );
  const advisoryShown = recentAdvisoryShown || overlapFound || siblingFound;
  const reason = opts.landReason;
  const landReasonNotice = formatLandReasonNotice({ reason, advisoryShown });
  if (landReasonNotice) out.log(landReasonNotice);
  record('land-reason', true, {
    advisoryShown,
    hasReason: !!reason,
    reasonLength: reason ? codePointLength(reason) : 0,
    reasonLengthUnit: 'codepoint',
  });
  let overlapDecision: OverlapLandingDecision | undefined;
  if (overlapFound && !opts.hold && !opts.dryRun) {
    overlapDecision = await (deps.decideOverlapLanding ?? (() => decideOverlapLanding({
      isInteractive: deps.isInteractive,
      requestConfirmation: deps.requestConfirmation,
      channels: deps.overlapConfirmChannels,
      timeoutMs: deps.overlapConfirmTimeoutMs,
    })))();
    record('overlap-decision', true, {
      outcome: overlapDecision.outcome,
      channel: overlapDecision.channel,
      interactive: overlapDecision.interactive,
    });
  }
  const hold = !!opts.hold || overlapDecision?.outcome === 'user-hold';

  const manager = deps.manager ?? makePrManager(run);
  const existing = manager.findPrForBranchOutcome(branch, cwd);
  const lookupOk = existing.status !== 'FAILED';
  record('find', lookupOk, { found: !!existing.url, status: existing.status });
  out.log(existing.url
    ? `✓ find: ${existing.url} (${existing.status})`
    : `${lookupOk ? '✓' : '✗'} find: ${existing.status}`);

  const excludePaths = activeRunConflicts.map(({ path }) => path);
  const excludingActiveRunFiles = opts.excludeActiveRunFiles && excludePaths.length > 0;
  const otherFiles = excludingActiveRunFiles
    ? activeRunConflicts.filter(({ path }) => !isGoalDocumentFileName(basename(path)))
    : [];
  const abortSources = otherFiles.length > 0 && !opts.excludeActiveRunSources;

  if (excludingActiveRunFiles) {
    record('active-run-files-excluded', !abortSources, {
      conflicts: activeRunConflicts,
      excludePaths,
      policy: 'explicit-exclude',
      otherFileCount: otherFiles.length,
      aborted: abortSources,
    });
  }

  if (abortSources) {
    const omitted = otherFiles
      .map(({ path, runIds }) => `${path} (runId=${runIds.join(',')})`)
      .join('; ');
    const prefix = opts.dryRun ? '[dry-run] ' : '';
    out.error(
      `${prefix}✗ active-run-files: --exclude-active-run-files 가 골 문서가 아닌 파일을 이번 착지에서 빼므로 멈춥니다. ⛔ 아무것도 커밋하지 않았고 PR 도 만들지 않았습니다. 빠지는 파일: ${omitted}. 다시 치려면 --exclude-active-run-files 를 빼십시오. 소스를 빼고 강행하려면 위험한 선택 --exclude-active-run-sources 를 같이 주십시오.`,
    );
    return 1;
  }

  if (opts.dryRun) {
    if (excludePaths.length === 0) {
      out.log(`[dry-run] active-run-files: 겹침 파일이 없습니다${opts.excludeActiveRunFiles ? '; --exclude-active-run-files로 제외할 파일이 없습니다' : ''}.`);
    } else if (excludingActiveRunFiles) {
      out.log(`[dry-run] active-run-files: --exclude-active-run-files 명시로 이번 착지에서 제외합니다 — ${excludePaths.join(', ')}.`);
    } else {
      out.log(`[dry-run] active-run-files: 이번 착지에 포함됩니다 — ${excludePaths.join(', ')}.`);
    }
    if (commitMessage !== undefined) {
      out.log(`[dry-run] commit-message: ${commitMessage}`);
    }
    if (!lookupOk) {
      record('plan', false, { reason: 'find-failed', status: existing.status });
      out.log(`[dry-run] 기존 PR 조회가 실패했습니다 (${existing.status}). PR 생성·병합 계획을 진행할 수 없습니다.`);
      return 1;
    }
    record('plan', true);
    if (opts.hold) {
      out.log(`[dry-run] ${existing.url ? '기존 PR을 갱신' : 'PR을 생성'}하고 --hold 로 병합하지 않고 멈춥니다.`);
    } else {
      out.log(`[dry-run] ${existing.url ? '기존 PR을 갱신하고 ready 상태를 보장' : 'PR을 생성하고 ready 상태를 보장'}한 뒤 squash merge 합니다.`);
    }
    return 0;
  }

  if (activeRunConflicts.length > 0 && excludingActiveRunFiles) {
    const detail = activeRunConflicts.map(({ path, runIds }) => `${path} (runId=${runIds.join(',')})`).join('; ');
    out.error(`⚠ active-run-files: --exclude-active-run-files 명시로 이번 착지에서 제외합니다 — ${detail}.`);
    if (otherFiles.length > 0) {
      const otherDetail = otherFiles.map(({ path, runIds }) => `${path} (runId=${runIds.join(',')})`).join('; ');
      out.error(`⚠ active-run-files: 골 문서가 아닌 파일 ${otherFiles.length}개가 이번 변경에서 빠집니다 — ${otherDetail}.`);
    }
  }

  const upsert = manager.upsertPr({
    branch,
    worktreePath: cwd,
    base,
    draft: hold,
    title: title ?? `Land ${branch}`,
    // ⛔⭐ 본문 기본값도 «내용이 있는» 쪽으로 — 종전 34자 플레이스홀더는 ***아무에게도 쓸모가 없었고***
    //   그래서 두 세션이 이틀간 「본문 없는 PR」을 156건 냈다. `--commit-message` 가 있으면 그것을 싣는다.
    //   ⚠️ 그래도 ***서사는 `--body`/`--body-file` 로 주는 것이 옳다*** — 이 기본값은 «바닥»이지 «목표»가 아니다.
    body: body ?? (commitMessage?.trim()
      ? `${commitMessage.trim()}\n\n---\n⚠️ 이 본문은 \`--commit-message\` 에서 자동 생성됐다. 서사는 \`--body-file\` 로 주는 것이 옳다.`
      : 'Human-requested atomic PR landing.'),
    commitMessage: commitMessage ?? `chore: land ${branch}`,
    ...(excludingActiveRunFiles ? { excludePaths } : {}),
  });
  if (!upsert.ok) {
    if (upsert.reason === 'noop' && excludingActiveRunFiles) {
      record('upsert-ready-noop', true, { excludePaths, detail: upsert.detail });
      out.log(`✓ upsert-ready: 제외 후 올릴 것이 없습니다 — ${upsert.detail}`);
      return 0;
    }
    record('upsert-ready', false);
    out.error(`✗ upsert-ready: ${upsert.reason}: ${upsert.detail}`);
    return 1;
  }
  record('upsert-ready', true);
  out.log(`✓ upsert-ready: ${upsert.url}${upsert.reused ? ' (기존 PR)' : ' (새 PR)'}`);

  if (hold) {
    record('hold', true, { url: upsert.url, reused: upsert.reused });
    out.log(`✓ hold: ${upsert.url} — 병합하지 않고 쌓아 둡니다. 같은 브랜치에서 다시 pr land --hold 하면 이 PR에 커밋이 더 쌓입니다.`);
    return 0;
  }

  let merged = manager.mergePrOutcome(upsert.url);
  // `GIT-S14` — 병합이 «미완료(OPEN)»로 끝났고 GitHub 가 아직 `mergeable=UNKNOWN`(병합 가능 여부 계산 중)이면
  //   짧게 기다렸다 다시 병합한다. 표본 셋(08-25 · 09-24 🅢 #20233 등)이 모두 «같은 명령 재시도에 병합»이었다.
  //   ⛔ UNKNOWN 일 때만 재시도한다 — CONFLICTING 등 다른 값은 기다려도 안 풀린다(그대로 실패를 낸다).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; !merged.ok && merged.kind === 'not-merged' && merged.state === 'OPEN' && attempt <= PR_LAND_MERGEABLE_UNKNOWN_RETRIES; attempt += 1) {
    const mergeable = run('gh', ['pr', 'view', upsert.url, '--json', 'mergeable', '--jq', '.mergeable'], { cwd });
    const value = mergeable.ok ? mergeable.out.trim() : '';
    if (value !== 'UNKNOWN') break;
    record('merge-retry', true, { attempt, mergeable: value, waitMs: PR_LAND_MERGEABLE_UNKNOWN_WAIT_MS });
    out.log(`⏳ merge: mergeable=UNKNOWN — GitHub 가 병합 가능 여부를 아직 계산 중입니다 · ${PR_LAND_MERGEABLE_UNKNOWN_WAIT_MS / 1000}초 뒤 다시 병합 (${attempt}/${PR_LAND_MERGEABLE_UNKNOWN_RETRIES})`);
    await sleep(PR_LAND_MERGEABLE_UNKNOWN_WAIT_MS);
    merged = manager.mergePrOutcome(upsert.url);
  }
  if (!merged.ok) {
    // `GIT-S76` — 「미완료(OPEN)」만으로는 «충돌»과 «아직 계산 중»이 안 갈린다. GitHub 의 병합 가능 상태를 같이 싣는다.
    //   되읽기에 실패하면 종전 문면 그대로다(못 읽은 것을 「충돌 아님」으로 적지 않는다).
    const mergeState = merged.kind === 'not-merged' && merged.state === 'OPEN'
      ? run('gh', ['pr', 'view', upsert.url, '--json', 'mergeable,mergeStateStatus', '--jq', '[.mergeable, .mergeStateStatus] | map(select(. != null)) | join(" ")'], { cwd })
      : undefined;
    const [rawMergeable, rawMergeState] = mergeState?.ok ? mergeState.out.trim().split(/\s+/) : [];
    // GitHub 가 정한 값만 싣는다 — 모르는 값을 «상태»로 옮겨 적지 않는다.
    const mergeable = rawMergeable && GITHUB_MERGEABLE.has(rawMergeable) ? rawMergeable : undefined;
    const mergeStateStatus = rawMergeState && GITHUB_MERGE_STATE.has(rawMergeState) ? rawMergeState : undefined;
    const stateNote = [mergeable ? `mergeable=${mergeable}` : '', mergeStateStatus ? `mergeState=${mergeStateStatus}` : ''].filter(Boolean).join(' · ');
    const detail = merged.kind === 'not-merged'
      ? `squash merge 미완료 (state: ${merged.state}${stateNote ? ` · ${stateNote}` : ''})`
      : merged.kind === 'unknown'
        ? 'squash merge 결과를 모름 (상태 미확정)'
        : 'squash merge 상태 되읽기 실패';
    record('merge', false, {
      result: merged.kind,
      ...(merged.kind === 'not-merged' ? { state: merged.state } : {}),
      ...(mergeable ? { mergeable } : {}),
      ...(mergeStateStatus ? { mergeStateStatus } : {}),
    });
    out.error(`✗ merge: ${detail}`);
    if (mergeable === 'CONFLICTING') {
      out.error('  ↳ 충돌 — 이 브랜치가 기준 브랜치의 최근 착지와 같은 줄을 고쳤다. `bun bin/elanous.mjs git fetch origin` → `bun bin/elanous.mjs git rebase origin/<기준>` 로 풀고 다시 pr land.');
    }
    return 1;
  }
  record('merge', true, { result: merged.kind, ...(merged.remoteBranchDeletion ? { remoteBranchDeletion: merged.remoteBranchDeletion.detail } : {}) });
  if (merged.remoteBranchDeletion) {
    out.log(`⚠ remote branch deletion: ${merged.remoteBranchDeletion.detail}`);
  }
  const baseRef = upsert.reused
    ? run('gh', ['pr', 'view', upsert.url, '--json', 'baseRefName', '--jq', '.baseRefName'], { cwd })
    : undefined;
  const landingBase = baseRef
    ? (baseRef.ok && baseRef.out.trim() ? baseRef.out.trim() : '<base unavailable>')
    : base;
  out.log(`✓ merge: squash ${upsert.url} → ${landingBase}`);
  if (landingBase === '<base unavailable>') {
    out.log('⚠ local HEAD does not contain the landed result; the landed base is unavailable, so no branch command can be provided.');
  } else {
    const remoteRef = resolveRemoteBranchRef(run, cwd, landingBase);
    out.log(`⚠ local HEAD does not contain the landed result; create a new branch directly from remote ${remoteRef.remote} with: git branch <new-branch> ${remoteRef.remote}/${remoteRef.branch}`);
  }
  return 0;
}

export function registerPrCommands(program: Command, deps: PrLandDeps = {}): void {
  const pr = program.command('pr').description('PR landing commands');
  pr.command('land')
    .description('현재 브랜치 PR을 생성 또는 갱신해 ready 상태로 만들고 squash merge')
    .option('--base <branch>', 'PR base branch')
    .option('--cwd <path>', '작업 트리 경로')
    .option('--dry-run', '변경 없이 landing 계획만 출력')
    .option('--hold', 'PR을 생성 또는 갱신한 뒤 병합하지 않고 쌓아 둔다')
    .option('--title <title>', 'PR title')
    .option('--title-file <path>', 'PR title file')
    .option('--body <body>', 'PR body')
    .option('--body-file <path>', 'PR body file')
    .option('--commit-message <message>', 'upsert commit message')
    .option('--commit-message-file <path>', 'upsert commit message file (takes precedence over --commit-message)')
    .option('--include-active-run-files', '도는 런 파일을 이번 착지에 포함 (기본 동작)')
    .option('--exclude-active-run-files', '도는 런과 겹친 파일을 이번 착지에서 제외')
    .option('--exclude-active-run-sources', '⚠ 위험: --exclude-active-run-files 가 골 문서가 아닌 파일(소스)을 빼도 착지를 강행')
    .option('--land-reason <text>', '권고를 보고도 지금 내는 이유(예: 남이 기다리는 차단 해제)')
    .action(async (opts: PrLandOpts) => {
      // ⛔⭐⭐⭐ **관측 sink 를 먼저 건다** — 라이브 도그푸드가 잡은 결함(2026-08-03).
      //   단위 테스트는 `debug.log` 가 **불렸다**를 단언하지만, standalone CLI 는 sink 를 등록하지
      //   않으면 그 로그가 **`logs.db` 에 안 닿는다** ⇒ `elanous logs --category pr.land` 가 0건이었다.
      //   ⇒ 수용기준 「단계별 관측」이 테스트는 통과하고 실물에서는 성립하지 않았다.
      //   ***호출을 재는 것과 도착을 재는 것은 다른 축이다*** (`#6701`·`I-T8` 과 같은 계열).
      //   fail-open — 관측 배선 실패가 착지를 막지 않는다.
      try {
        const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
        await registerStandaloneLogSink('pr-land');
      } catch { /* fail-open */ }
      const code = await runPrLand(opts, deps);
      if (code !== 0) (deps.setExitCode ?? ((exitCode: number) => { process.exitCode = exitCode; }))(code);
    });
  pr.command('granularity')
    .description('로컬 git log 로 최근 착지 단위(파일 중복·단일 파일 비율)를 센다')
    .option('--since <window>', 'git log --since 창', DEFAULT_GRANULARITY_SINCE)
    .option('--cwd <path>', '작업 트리 경로')
    .option('--base <branch>', '착지 집계에 쓸 base 브랜치')
    .option('--with-source', 'PR 번호로 브랜치를 조회해 하니스↔사람 갈래를 함께 낸다 (gh 필요)')
    .action((opts: PrGranularityOpts) => {
      const code = runPrGranularity(opts, deps);
      if (code !== 0) (deps.setExitCode ?? ((exitCode: number) => { process.exitCode = exitCode; }))(code);
    });
}
