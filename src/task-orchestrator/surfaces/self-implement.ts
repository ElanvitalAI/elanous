/**
 * `surface.kind === 'self-implement'` adapter — parallel self-dev.
 *
 * Each task = one `elanous self implement <feature>` **subprocess**. Why a
 * subprocess and not an in-process `runSelfImplement` call: the child
 * goal-loop derives its harness-space from `process.env`
 * (`ELANOUS_HARNESS_SPACE_ID`), so N in-process jobs would clobber each
 * other's space marker. A subprocess gets its own env → its own space →
 * its own screen/log buffer, letting the dispatcher fan out safely.
 * The full worktree→gate→review→merge pipeline runs inside the child
 * (existing CLI · zero changes to self-implement internals).
 *
 * Pattern mirrors src/task-orchestrator/surfaces/acx-session.ts —
 * an injected `SelfImplementJobSpawn` owns the actual process launch;
 * the adapter handles dispatcher concerns (AbortSignal → cancelled,
 * TaskExecution shape, exit-code → status mapping). Tests inject a fake
 * spawn so no real subprocess/worktree/PR side effects occur.
 *
 * Cf. PLAN-parallel-self-dev-orchestrator-2026-07-21.
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { oldDoorInternalEnv } from '../../self-dev/old-door.js';
import { selfDevRunsDir } from '../../self-dev/run-store.js';
import { debug } from '../../debug/log.js';
import { join, resolve } from 'node:path';
import { findGitDir } from '../../git-fs/locate.js';
import { isAbandonedClassification, type AbandonedClassificationResult } from '../../self-implement/abandoned-classification.js';
import { createExecution, type Task, type TaskExecution } from '../types.js';
import type { DispatchContext, DispatchResult } from '../surface-registry.js';

/** Result of one self-implement subprocess. */
export interface SelfImplementJobDone {
  /** Process exit code (null when killed by signal). 0 = clean. */
  exitCode: number | null;
  /** Tail of stdout+stderr (kept small for the execution record). */
  output: string;
  /** Structured error for non-zero exits / spawn failure. */
  error?: { code: string; message: string };
  /** S3 — real pipeline disposition parsed from `--json`
   *  (`{stage, ok, worktreePath, branch, prUrl, prNumber, merged}`).
   *  Distinguishes merged / pr-opened / gate-failed / pr-declined,
   *  which the coarse exit code alone cannot. Absent when `--json`
   *  wasn't emitted (fake spawns in tests). */
  disposition?: SelfImplementDisposition;
}

/** Parsed `elanous self implement --json` result (subset consumed here). */
export interface SelfImplementDisposition {
  stage?: string;
  ok?: boolean;
  worktreePath?: string;
  branch?: string;
  harvestable?: true;
  prUrl?: string;
  prNumber?: number;
  /** Head SHA checked by the Pod before host regate. */
  checkedHeadCommit?: string;
  /** Review verdict only when the child bound a real pass to a clean, unchanged worktree head. */
  selfReview?: { verdict: 'pass'; head: string };
  hostRegate?: { passed: boolean; failures: Array<{ step: string; detail: string }>; os: string };
  merged?: boolean;
  detail?: string;
  /** Terminal error emitted by a failed child `--json` result. */
  error?: string;
  // ⭐⭐⭐ `A1`(2026-08-19 · 대표 지시 *"R3 가 서브 프로세스여도 잘 도는 안"*) — ***판정 3종***.
  //
  // 🚨 왜(실측): 이 셋이 ***트리아지의 입력 전부***인데 종전엔 «한 칸도» 안 건너왔다.
  //   📏 자식은 `--json` 으로 `r.result` 를 ***통째로*** 내보낸다(`src/index.ts:5519`) —
  //     즉 값은 «전선에 실려 있었고», ***아래 파서가 「모르는 칸」이라 버렸다***.
  //   ⇒ 📌 「전달 결손」의 정확한 자리는 «자식»도 «전선»도 아니고 ***파서***였다.
  /** auto-merge 를 «왜» 건너뛰었나(`review-diff-truncated` 등) — 「도구 한계」를 가르는 근거. */
  mergeReason?: string;
  /** 런이 «왜» 멈췄나. 없으면 「부모가 잘랐다」다(`MANUAL-time-and-windows` §⑦-a). */
  stopReason?: string;
  /** 자식이 스스로 낸 완료 성격(수렴·미수렴·경계 등). */
  completionDisposition?: string;
  /** Abandoned-run classification from the child. Independent of completionDisposition. */
  failureClassification?: AbandonedClassificationResult['classification'];
  /** Structured provider failure evidence from the child result. */
  providerErrors?: { count: number; provider: string; category: 'quota' | 'credential' | 'request' | 'other' };
  /** Stable self-implement run identity for ledger-backed consumers. */
  runId?: string;
  /** Pod child run identity, distinct from the host parent run attached to logs. */
  childRunId?: string;
  /** E4(2026-09-25 · 벤치 비교 칸) — 자식 `--json` 의 `gate.passed`. 없으면 «못 쟀다»(false 가 아니다). */
  gatePassed?: boolean;
  /** 자식 `--json` 의 `review.verdict`(마지막 리뷰). `review.reviewed=false` 면 싣지 않는다 — 리뷰 안 한 판을 pass 로 읽지 않게. */
  reviewVerdict?: 'pass' | 'warn' | 'fail';
  /** 마지막 리뷰의 must-fix 수(`review.mustFix.length`). 같은 조건. */
  reviewMustFixCount?: number;
  mustFix?: string[];
}

/**
 * Launch seam. Production wires a `bun bin/elanous.mjs self implement`
 * subprocess (see `defaultSelfImplementSpawn`); tests inject a fake.
 * Returns immediately with an `address` + a `done` promise that
 * resolves when the child exits.
 */
export interface SelfImplementJobSpawn {
  (input: {
    feature: string;
    /** Predecessor goal ID or PR number; Pod admission waits until it is merged. */
    after?: string | number;
    base?: string;
    autoMerge?: boolean;
    /** G8 — attach `auto-review` opt-in label → `--auto-review`. */
    autoReview?: boolean;
    /** S3 — open a draft PR through self-implement's own merge-decision
     *  node (HITL gate). Promotion flows through the review node so the
     *  disposition is recorded internally — no external hand-merge. */
    openPr?: boolean;
    draft?: boolean;
    /** Distinct-per-job harness-space id → own screen/log buffer. */
    spaceId: string;
    signal?: AbortSignal;
  }): {
    /** `self-impl:<spaceId>` — keyed so `elanous logs --space` / metrics
     *  can attribute without re-parsing. */
    address: string;
    done: Promise<SelfImplementJobDone>;
  };
}

export interface SelfImplementAdapterOptions {
  spawn: SelfImplementJobSpawn;
  now?: () => number;
}

/** Output tail cap — matches the other surface adapters. */
const OUTPUT_TAIL_BYTES = 4096;

export type SpawnElanousBinSource = 'cwd-repository' | 'source-tree-fallback';

export interface SpawnElanousBin {
  bin: string;
  source: SpawnElanousBinSource;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a runnable elanous entrypoint without treating every git repository as elanous. */
export function resolveSpawnElanousBin(cwd = process.cwd(), sourceRoot = resolve(import.meta.dir, '../../..')): SpawnElanousBin {
  const repositoryRoot = findGitDir(cwd)?.root;
  const repositoryBin = repositoryRoot ? join(repositoryRoot, 'bin', 'elanous.mjs') : undefined;
  if (repositoryBin && isRegularFile(repositoryBin)) {
    return { bin: repositoryBin, source: 'cwd-repository' };
  }

  const sourceBin = join(sourceRoot, 'bin', 'elanous.mjs');
  if (isRegularFile(sourceBin)) {
    return { bin: sourceBin, source: 'source-tree-fallback' };
  }

  throw new Error(`Unable to locate runnable elanous entrypoint; tried ${repositoryBin ?? 'no git repository'} and ${sourceBin}`);
}

/** Keep the final UTF-8 bytes without splitting a Unicode code point. */
function tailOutput(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= OUTPUT_TAIL_BYTES) return output;

  let start = bytes.length - OUTPUT_TAIL_BYTES;
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start++;
  const tail = bytes.subarray(start).toString('utf8');
  return `[output truncated to at most ${OUTPUT_TAIL_BYTES} UTF-8 bytes]\n${tail}`;
}

/** Normalise a task id into a filesystem/env-safe space id fragment.
 *  Exported so the orchestrator can map spaceId → task for disposition
 *  capture + per-job screen/log addressing. */
export function spaceIdForTask(task: Task): string {
  return task.id.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'self-impl';
}

/**
 * Dispatcher adapter factory. Returns a SurfaceAdapter for
 * `kind === 'self-implement'`.
 */
export function createSelfImplementAdapter(opts: SelfImplementAdapterOptions) {
  const now = opts.now ?? Date.now;

  return async function dispatchSelfImplement(
    task: Task,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (task.surface.kind !== 'self-implement') {
      throw new Error(`self-implement adapter received wrong kind: ${task.surface.kind}`);
    }
    const surface = task.surface;
    const exec = createExecution(task, { now: now() });
    const spaceId = spaceIdForTask(task);

    let address: string | undefined;
    let donePromise: Promise<SelfImplementJobDone> | null = null;
    let spawnError: unknown = null;

    try {
      const res = opts.spawn({
        feature: surface.feature,
        ...(surface.after !== undefined ? { after: surface.after } : {}),
        ...(surface.base !== undefined ? { base: surface.base } : {}),
        ...(surface.autoMerge !== undefined ? { autoMerge: surface.autoMerge } : {}),
        ...(surface.autoReview !== undefined ? { autoReview: surface.autoReview } : {}),
        ...(surface.openPr !== undefined ? { openPr: surface.openPr } : {}),
        ...(surface.draft !== undefined ? { draft: surface.draft } : {}),
        spaceId,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      address = res.address;
      donePromise = res.done;
    } catch (err) {
      spawnError = err;
    }

    const promise = (async (): Promise<TaskExecution> => {
      if (spawnError) {
        const end = now();
        const aborted = ctx.signal?.aborted;
        return {
          ...exec,
          endedAt: end,
          durationMs: end - exec.startedAt,
          status: aborted ? 'cancelled' : 'failed',
          error: aborted
            ? { code: 'ABORTED', message: 'cancelled by caller' }
            : {
                code: 'SELF_IMPL_SPAWN_FAILED',
                message: spawnError instanceof Error ? spawnError.message : String(spawnError),
              },
          ...(address !== undefined ? { surfaceAddress: address } : {}),
        };
      }
      try {
        const r = await donePromise!;
        const end = now();
        const tailedOutput = tailOutput(r.output);
        // Abort wins over exit code — caller asked us to stop.
        if (ctx.signal?.aborted) {
          return {
            ...exec,
            endedAt: end,
            durationMs: end - exec.startedAt,
            status: 'cancelled',
            error: { code: 'ABORTED', message: 'cancelled by caller' },
            output: tailedOutput,
            ...(address !== undefined ? { surfaceAddress: address } : {}),
          };
        }
        if (r.exitCode === 0) {
          return {
            ...exec,
            endedAt: end,
            durationMs: end - exec.startedAt,
            status: 'completed',
            output: tailedOutput,
            ...(address !== undefined ? { surfaceAddress: address } : {}),
          };
        }
        const exitMessage = `self implement exited with code ${r.exitCode ?? 'null'}`;
        const childDiagnostic = r.disposition?.error?.trim();
        const fallbackMessage = childDiagnostic
          ? `${childDiagnostic} (${exitMessage})`
          : r.output.length === 0
            ? `${exitMessage} (child produced no output)`
            : r.disposition
              ? `${exitMessage} (child stage=${r.disposition.stage ?? 'unknown'}; ${r.disposition.detail ?? `mustFix=${JSON.stringify(r.disposition.mustFix ?? 'unknown')}`})`
              : `${exitMessage} (child output did not contain a parseable terminal JSON diagnostic)`;
        return {
          ...exec,
          endedAt: end,
          durationMs: end - exec.startedAt,
          status: 'failed',
          error: r.error ?? { code: 'SELF_IMPL_FAILED', message: fallbackMessage },
          output: tailedOutput,
          ...(address !== undefined ? { surfaceAddress: address } : {}),
        };
      } catch (err) {
        const end = now();
        const aborted = ctx.signal?.aborted;
        return {
          ...exec,
          endedAt: end,
          durationMs: end - exec.startedAt,
          status: aborted ? 'cancelled' : 'failed',
          error: aborted
            ? { code: 'ABORTED', message: 'cancelled by caller' }
            : {
                code: 'SELF_IMPL_JOB_FAILED',
                message: err instanceof Error ? err.message : String(err),
              },
          ...(address !== undefined ? { surfaceAddress: address } : {}),
        };
      }
    })();

    return {
      executionId: exec.id,
      ...(address !== undefined ? { surfaceAddress: address } : {}),
      promise,
    };
  };
}

/**
 * Production launch seam — spawns `bun bin/elanous.mjs self implement`.
 * Each child gets its own `ELANOUS_HARNESS_SPACE_ID` (distinct space →
 * own screen/log buffer) plus `childNestEnv()` (fork-bomb depth guard).
 * Kept out of the adapter so tests never touch a real subprocess.
 */
export function defaultSelfImplementSpawn(): SelfImplementJobSpawn {
  return (input) => {
    // Lazy requires — heavy node/elanous deps only loaded in production.
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const { harnessSpaceEnv, executorRoleEnv } = require('../../harness/harness-space.js') as typeof import('../../harness/harness-space.js');
    const { childNestEnv, getNestDepth, getMaxNestDepth } = require('../../agent/nest-depth.js') as typeof import('../../agent/nest-depth.js');
    const { debug } = require('../../debug/log.js') as typeof import('../../debug/log.js');

    const { bin, source: binSource } = resolveSpawnElanousBin();
    // `--json` so the child prints its SelfImplementResult on the last
    // line → we parse the real disposition (stage / prUrl / merged).
    const runsDir = selfDevRunsDir();
    mkdirSync(runsDir, { recursive: true });
    const featureDir = mkdtempSync(join(runsDir, 'feature-'));
    const featureFile = join(featureDir, 'feature.txt');
    try { writeFileSync(featureFile, input.feature, { mode: 0o600 }); }
    catch (error) { rmSync(featureDir, { recursive: true, force: true }); throw error; }
    const args = [bin, 'self', 'implement', '--feature-file', featureFile, '--json'];
    if (input.base) args.push('--base', input.base);
    if (input.autoMerge) args.push('--auto-merge');
    if (input.autoReview) args.push('--auto-review');
    if (input.openPr) args.push('--open-pr');
    if (input.draft === false) args.push('--no-draft');

    const address = `self-impl:${input.spaceId}`;
    // ⭐ 환경 주입 관측(2026-07-21 대표·"docker run -e 가시성") — 조율자(coordinator)가 executor 세포를
    // 스폰하는 순간의 env 분화(role/space/nest)를 남긴다. 자식이 왜 그 역할·공간·깊이인지 재현 없이 추적.
    debug.log('self-dev.spawn', 'launch', {
      spaceId: input.spaceId, address, role: 'executor',
      nestDepth: getNestDepth() + 1, maxNest: getMaxNestDepth(),
      autoMerge: !!input.autoMerge, openPr: !!input.openPr,
      bin, binSource, feature: input.feature.slice(0, 80),
    });
    const done = new Promise<SelfImplementJobDone>((resolve) => {
      let child: import('node:child_process').ChildProcess;
      try {
        child = spawn('bun', args, {
          cwd: process.cwd(),
          // Distinct harness-space per job (own screen/log) + nest guard.
          // The CLI honours a pre-set ELANOUS_HARNESS_SPACE_ID (index.ts).
          env: {
            ...process.env,
            ...childNestEnv(),
            ...harnessSpaceEnv('self-implement', input.spaceId),
            ...executorRoleEnv(),   // ⭐ 세포 role 분화 — 자식은 executor(실행자)로 자기인지.
            ...oldDoorInternalEnv('self-implement'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        rmSync(featureDir, { recursive: true, force: true });
        resolve({
          exitCode: null,
          output: '',
          error: { code: 'SELF_IMPL_SPAWN_FAILED', message: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      let out = '';
      const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* fail-soft */ } };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e: Error) => {
        rmSync(featureDir, { recursive: true, force: true });
        input.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: null, output: out, error: { code: 'SELF_IMPL_SPAWN_FAILED', message: String(e?.message ?? e) } });
      });
      child.on('exit', (code: number | null) => {
        rmSync(featureDir, { recursive: true, force: true });
        input.signal?.removeEventListener('abort', onAbort);
        const disposition = parseSelfImplementJson(out);
        resolve({ exitCode: code, output: out, ...(disposition ? { disposition } : {}) });
      });
    });
    return { address, done };
  };
}

/**
 * ★ `A2`(2026-08-19) — ***파서가 「버린 칸」을 «말하게» 한다.***
 *
 * 🚨 왜 — 종전 파서는 «모르는 키를 조용히» 버렸다. 그래서 `mergeReason` 이 전선에 «실려 있는데도»
 *   부모가 못 받는 상태를 ***오늘까지 아무도 몰랐다***(2026-08-19 · 조율 채널 Q2).
 * ⇒ 📌 경계가 스스로 「내가 뭘 버렸는지」를 말하면 ***안 이어진 배선이 «값»으로 드러난다.***
 *   이 저장소가 하루에 «열 번» 만난 형태(부품은 있고 부르는 자가 없다)의 «예방책»이다.
 *
 * ⛔ 관측만 한다 — 버리는 «행동»은 안 바꾼다(모르는 칸을 통과시키면 타입 계약이 무너진다).
 * ⚠️ 값은 싣지 않고 «키 이름»만 — 자식 산출에 비밀이 섞일 수 있다.
 */
/** E4 — 자식 결과의 `gate`·`review` 에서 벤치가 쓰는 세 칸만 옮긴다. ⛔ 모양이 어긋나면 «안 싣는다»(추측 금지). */
export function reviewGateFields(o: Record<string, unknown>): Pick<SelfImplementDisposition, 'gatePassed' | 'reviewVerdict' | 'reviewMustFixCount'> {
  const gate = o.gate && typeof o.gate === 'object' && !Array.isArray(o.gate) ? o.gate as Record<string, unknown> : undefined;
  const review = o.review && typeof o.review === 'object' && !Array.isArray(o.review) ? o.review as Record<string, unknown> : undefined;
  const reviewed = review?.reviewed === true;
  const verdict = review?.verdict;
  return {
    ...(typeof gate?.passed === 'boolean' ? { gatePassed: gate.passed } : {}),
    ...(reviewed && (verdict === 'pass' || verdict === 'warn' || verdict === 'fail') ? { reviewVerdict: verdict } : {}),
    ...(reviewed && Array.isArray(review?.mustFix) ? { reviewMustFixCount: (review!.mustFix as unknown[]).length } : {}),
  };
}

export function reportUnmappedDispositionFields(
  raw: Record<string, unknown>,
  mapped: SelfImplementDisposition,
): readonly string[] {
  const known = new Set(Object.keys(mapped));
  const unmapped = Object.keys(raw).filter((key) => !known.has(key) && raw[key] !== undefined);
  if (unmapped.length > 0) {
    try {
      debug.log('self-implement.json', 'unmapped-fields', {
        count: unmapped.length,
        keys: unmapped.slice(0, 12),
        ...(unmapped.length > 12 ? { more: unmapped.length - 12 } : {}),
      }, { level: 'info' });
    } catch { /* 관측 실패가 파싱을 막지 않는다 */ }
  }
  return unmapped;
}

function failureClassificationFromJson(o: Record<string, unknown>): AbandonedClassificationResult['classification'] | undefined {
  if (typeof o.failureClassification === 'string' && isAbandonedClassification(o.failureClassification)) {
    return o.failureClassification;
  }
  const nested = o.abandonedClassification;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const classification = (nested as { classification?: unknown }).classification;
    if (typeof classification === 'string' && isAbandonedClassification(classification)) return classification;
  }
  return undefined;
}

/** Parse the last JSON object line of `elanous self implement --json`
 *  stdout into a disposition. Tolerant — returns null if no JSON found
 *  (e.g. the child crashed before printing). Pure. */
export function parseSelfImplementJson(stdout: string): SelfImplementDisposition | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.stage !== 'string' && typeof o.ok !== 'boolean') continue;
      const failureClassification = failureClassificationFromJson(o);
      const mapped: SelfImplementDisposition = {
        ...(typeof o.stage === 'string' ? { stage: o.stage } : {}),
        ...(typeof o.ok === 'boolean' ? { ok: o.ok } : {}),
        ...(typeof o.worktreePath === 'string' ? { worktreePath: o.worktreePath } : {}),
        ...(typeof o.branch === 'string' ? { branch: o.branch } : {}),
        ...(o.harvestable === true && typeof o.branch === 'string' && o.branch.trim() ? { harvestable: true } : {}),
        ...(typeof o.prUrl === 'string' ? { prUrl: o.prUrl } : {}),
        ...(typeof o.prNumber === 'number' ? { prNumber: o.prNumber } : {}),
        ...(typeof o.checkedHeadCommit === 'string' ? { checkedHeadCommit: o.checkedHeadCommit } : {}),
        ...(o.reviewedHeadCommit && typeof o.reviewedHeadCommit === 'string' && /^[0-9a-f]{40}$/i.test(o.reviewedHeadCommit)
          && o.review && typeof o.review === 'object' && !Array.isArray(o.review)
          && (o.review as { reviewed?: unknown; verdict?: unknown }).reviewed === true
          && (o.review as { verdict?: unknown }).verdict === 'pass'
          ? { selfReview: { verdict: 'pass' as const, head: o.reviewedHeadCommit } } : {}),
        ...(typeof o.hostRegate === 'object' && o.hostRegate !== null ? { hostRegate: o.hostRegate as SelfImplementDisposition['hostRegate'] } : {}),
        ...(typeof o.merged === 'boolean' ? { merged: o.merged } : {}),
        ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
        ...(typeof o.error === 'string' && o.error.trim() ? { error: o.error } : {}),
        // ⭐ `A1` — 판정 3종. 이 셋이 트리아지의 입력이다.
        ...(typeof o.mergeReason === 'string' && o.mergeReason.trim() ? { mergeReason: o.mergeReason } : {}),
        ...(typeof o.stopReason === 'string' && o.stopReason.trim() ? { stopReason: o.stopReason } : {}),
        ...(typeof o.completionDisposition === 'string' && o.completionDisposition.trim()
          ? { completionDisposition: o.completionDisposition } : {}),
        ...(failureClassification ? { failureClassification } : {}),
        ...(o.providerErrors && typeof o.providerErrors === 'object' && !Array.isArray(o.providerErrors)
          && typeof (o.providerErrors as Record<string, unknown>).count === 'number'
          && Number.isFinite((o.providerErrors as Record<string, unknown>).count)
          && (o.providerErrors as { count: number }).count > 0
          && typeof (o.providerErrors as Record<string, unknown>).provider === 'string'
          && ['quota', 'credential', 'request', 'other'].includes(String((o.providerErrors as Record<string, unknown>).category))
          ? { providerErrors: o.providerErrors as SelfImplementDisposition['providerErrors'] } : {}),
        ...(typeof o.runId === 'string' && o.runId.trim() ? { runId: o.runId, childRunId: o.runId } : {}),
        ...reviewGateFields(o),
        ...(Array.isArray(o.mustFix) && o.mustFix.every((item) => typeof item === 'string') ? { mustFix: o.mustFix as string[] } : {}),
      };
      reportUnmappedDispositionFields(o, mapped);
      return mapped;
    } catch { /* not this line */ }
  }
  return null;
}
