// ── `elanous drive` — LLM 제어 루프로 임의 명령 또는 격리 elanous TUI를 자율 구동 ──

import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { StreamLLMFn } from '../autopilot/llm-control-brain.js';
import { establishElanousTuiIsolation, elanousTuiSpawnOptions, type ElanousTuiIsolation } from '../self-implement/elanous-tui-spawn.js';
import { resolveObserveOnlyDecision } from '../self-implement/observe-only.js';
import { getUserConfig } from '../user-config.js';
import { verdictForFinalPtyScreen } from './pty-drive-verdict.js';
import { debug } from '../debug/log.js';
import { writeHarnessScreen } from '../harness/harness-screen.js';
import { resolveControlInboxDir } from '../harness/control-inbox.js';
import { getHarnessSpace, getHarnessRunId, normalizeSpaceId } from '../harness/harness-space.js';
import type { Command } from 'commander';
import { getPty, listPty, type PtyHandle } from '../pty-shell/registry.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { resolvePtyRef } from '../pty-shell/pty-ref.js';
import { parsePtyWriteActor } from '../pty-shell/pty-write-arbiter.js';
import { controlDepsForHandle, controlDepsForRemoteRef, runPtyControlLoop } from '../autopilot/pty-control-loop.js';
import { createLlmControlBrain } from '../autopilot/llm-control-brain.js';
import { withDriveJail } from './drive-input-jail.js';

/** `pty list` 한 줄의 상태 컬럼 위치 — `<id>\t<kind>\t<nickname>\t<scope>\t<state>\t<extra…>`.
 *  ⚠️⛔ **회귀 테스트의 fixture 는 실측 형식의 *스냅샷*이지 형식 변경 감지기가 아니다**(리뷰 지적 · 과장 정정) —
 *  `pty list` 가 컬럼 순서를 바꾸면 이 테스트는 **여전히 통과**한다. 형식을 바꿀 때 함께 갱신해야 한다.
 *  ⇒ 자동 감지가 필요하면 `pty list` 에 구조화 출력(`--json`)을 더하는 것이 근본이다(별건). */
const STATUS_COLUMN = 4;

/** `pty list` 출력에서 그 id 가 `alive` 로 서 있는지 — **탭 필드 기준**.
 *
 *  ⛔⭐ 줄 끝 매칭(`endsWith('\talive')`)으로 하지 마라. `pty list` 가 컬럼을 하나 더 붙이는 순간
 *  **조용히 영영 거짓**이 된다. 실측(2026-08-01): 출력이 `<id>\t<kind>\t-\tremote\talive\t?` 라
 *  마지막 필드가 `?` 이고, 종전 판정은 **한 번도 참이 될 수 없었다** ⇒ `--hold` 가 항상 30초
 *  타임아웃하고 그 끝에서 owner 를 kill 해, 밖에서 보면 *"owner 가 죽었다"* 로 보였다.
 *  ⇒ 두 증상(ready 실패 · owner 조기 종료)이 **한 원인**이었다. */
export function ptyListReportsAlive(stdout: string, id: string): boolean {
  return stdout.split('\n').some((line) => {
    const cols = line.split('\t');
    // ⛔ 상태 **컬럼**만 본다 — `includes` 로 하면 닉네임이 `alive` 인 PTY 를 준비 완료로 오판한다
    //    (무인 리뷰 must-fix · 2026-08-01). 형식은 아래 회귀 테스트가 고정한다.
    return cols[0] === id && cols[STATUS_COLUMN] === 'alive';
  });
}

export interface TuiWorkdirDecision {
  readonly isolated: boolean;
  readonly workdirProvided: boolean;
  readonly rejected: boolean;
  readonly message?: string;
}

/** Reject the unsafe combination before a TUI child can inherit the caller's tree. */
export function decideTuiWorkdir(isolated: boolean, cwd: string | undefined): TuiWorkdirDecision {
  const workdirProvided = Boolean(cwd?.trim());
  const rejected = isolated && !workdirProvided;
  return {
    isolated,
    workdirProvided,
    rejected,
    // ⛔⭐ 거부 문면은 **무엇을 주면 되는지**까지 말한다(교차 세션 제안 · 2026-08-02).
    //    상대가 헤맨 이유가 *"어디에 config 를 쓰나"* 였다 — 실효 자리를 확인하는 한 줄을 함께 준다.
    ...(rejected
      ? { message: '격리 우주에서는 작업 디렉토리를 명시해야 한다 — `--cwd <worktree-path>` 를 주십시오. '
          + '(안 주면 명령을 친 트리가 자식의 쓰기 허용 구역이 됩니다.) '
          + '지금 어느 우주인지는 `elanous where` 로 확인할 수 있습니다.' }
      : {}),
  };
}

/** argv 에서 **우주를 정하는 결정자**를 걷어낸다 — `--test` · `--test=<dir>` · `--config-dir <dir>`.
 *
 * ⛔⭐ 자식에게 argv 를 물려줄 때 이것을 남겨 두면 **1층(명시 플래그)이 우리가 얹은 스탬프를 이긴다.**
 *   해석은 부모가 한 번만 하고(`effectiveInstanceRoot`), 자식에겐 그 **결과 하나**만 준다. */
export function stripScopeArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // ⛔⭐ `--` 뒤는 **passthrough** 다 — 자식 명령의 인자이지 우리 플래그가 아니다.
    //    여기서 걷어내면 남의 명령을 훼손한다(무인 리뷰 must-fix).
    if (a === '--') { out.push(...argv.slice(i)); break; }
    if (a === '--test' || a.startsWith('--test=')) continue;
    if (a === '--config-dir') { i++; continue; }          // 값 토큰까지 함께 버린다
    if (a.startsWith('--config-dir=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * ⛔⭐⭐⭐ **부모가 «이미 수행한» 인자를 owner argv 에서 걷는다** (2026-08-05 · `[S]` 제보).
 *
 * 기전: hold owner 는 부모 argv 를 그대로 물려받는다. 그런데 `--worktree` 는 부모가 «이미»
 * 워크트리를 만들면서 소비한 인자다. owner 가 그것을 다시 보면:
 *   ⑴ 런 신원(`ELANOUS_RUN_ID`)은 «상속»되므로 owner 가 계산하는 이름이 부모와 «똑같고»
 *   ⑵ `addHarnessWorktree` 가 「이미 있는 브랜치」로 실패하며(사람 경로는 fail-closed)
 *   ⑶ ***owner 가 PTY 를 등록하기 «전에» 죽는다.***
 * ⇒ 밖에서는 「30초 기다렸는데 PTY 가 없다」로만 보였다 — 원인이 한 겹 아래 있었다.
 *
 * 📏 실측(기전 재현): 같은 runId 로 두 번 부르면
 *   `git worktree add failed — branch dev/<runId> is already used by worktree at …`
 *
 * ⛔ `--` 뒤는 건드리지 않는다(passthrough) — 스코프 인자와 같은 규율이다.
 */
export function stripParentAppliedArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { out.push(...argv.slice(i)); break; }
    // `-w` 는 `--worktree` 의 짧은 형태다(index.ts 의 `-w, --worktree`).
    if (a === '--worktree' || a === '-w') continue;
    out.push(a);
  }
  return out;
}

/**
 * ⛔⭐⭐ owner argv 에 **작업 디렉토리를 명시로** 넣는다(이미 있으면 그대로 둔다).
 *
 * 왜: `--worktree` 를 걷으면 owner 는 작업 디렉토리를 «아예 잃는다». 격리 우주는 그것을 거부한다
 * (라이브 실측 2026-08-05 — *"격리 우주에서는 작업 디렉토리를 명시해야 한다"*).
 * ⛔ 사람이 이미 준 `--cwd` 는 «덮지 않는다» — 명시가 이긴다.
 * ⛔ `--` 뒤는 건드리지 않는다.
 */
export function withOwnerCwdArg(argv: readonly string[], cwd: string): string[] {
  const cut = argv.indexOf('--');
  const head = cut >= 0 ? argv.slice(0, cut) : [...argv];
  if (head.some((a) => a === '--cwd' || a.startsWith('--cwd='))) return [...argv];
  const tail = cut >= 0 ? argv.slice(cut) : [];
  return [...head, '--cwd', cwd, ...tail];
}

/** 해석된 스코프를 argv 에 **끼워 넣는다** — ⛔ 끝에 붙이면 `--` 뒤로 밀려 파싱되지 않는다. */
export function withScopeArgs(argv: readonly string[], scopeRoot: string): string[] {
  const stripped = stripScopeArgs(argv);
  const cut = stripped.indexOf('--');
  const at = cut >= 0 ? cut : stripped.length;
  return [...stripped.slice(0, at), '--config-dir', scopeRoot, ...stripped.slice(at)];
}

export interface PtyDriveOpts {
  /** 자식으로 실행할 셸 명령(bash -c). elanous target에서는 사용하지 않는다. */
  readonly command?: string;
  /** LLM 제어 brain이 child TUI에 제출할 목표(hold에서는 지정 불가). */
  readonly goal?: string;
  /** bare elanous TUI를 brain 없이 띄워 외부 `elanous pty` 제어면에 넘긴다. */
  readonly hold?: boolean;
  /** hold 결과를 사람이 읽는 줄 대신 한 줄 JSON으로 출력한다. */
  readonly json?: boolean;
  /** handoff owner가 재사용할 canonical PTY ref(내부 전달용). */
  readonly ptyId?: string;
  /** hold: detached owner 프로세스를 띄울지. 기본 true(CLI 경로) · 테스트가 명시로 끈다.
   *  ⛔ 종전엔 `out`/`writeScreen` 주입 여부로 판별해 테스트가 production 분기를 우회했다. */
  readonly spawnOwner?: boolean;
  /** hold: owner ready 대기 상한(ms). 기본 30초(CLI 경로) · ⭐ 테스트가 **실패 경로**를 재려고 줄인다
   *  — 이 seam 이 없으면 실패 메시지 회귀를 고정하는 데 매번 30초가 든다. */
  readonly readyTimeoutMs?: number;
  /** hold: 최초 등록 뒤 생존을 다시 확인할 정착 구간(ms). */
  readonly settlementMs?: number;
  /** ⭐⭐ 자식 PTY 의 화면 크기. **가상 PTY 라 사람 터미널에 매이지 않는다** —
   *  ⛔ 종전엔 `120x30` 이 여기 하드코딩돼 있어, 그보다 큰 렌더 블록을 **맥락과 함께 관측할 수
   *     없었다**(2026-08-02 실측: 툴 결과 블록이 `blockMaxLines=20` 만큼 차지하는 순간을
   *     ChatLog 가시 24행 안에서 못 쟀다). 대표 지적 — *"가상 PTY 면 높이를 더 높게 잡아도 되지 않나"*.
   *  ⇒ 옵션으로 열고 기본은 **160x40**(대표 지시) — 레시피(`elanousTuiSpawnOptions`)와 같은 축이다. */
  readonly cols?: number;
  readonly rows?: number;
  readonly maxSteps?: number;
  readonly pollMs?: number;
  readonly model?: string;
  /** DRIVE-JAIL: brain inputs naming paths outside this directory are not sent to the PTY. */
  readonly jailHome?: string;
  /** Enable the child SelfImplement observation-only override at boot. */
  readonly observeOnly?: boolean;
  readonly cwd?: string;
  /** bare elanous TUI를 격리 자식으로 선택한다. */
  readonly elanous?: boolean;
  /** 테스트 및 embedding seam: elanous binary가 있는 레포 루트. */
  readonly repoRoot?: string;
  /** elanous child의 명시적 격리 루트(호출자 소유이며 자동 삭제하지 않는다). */
  readonly isolatedRoot?: string;
  /** TUI boot wait (기본 8초). */
  readonly bootMs?: number;
  /** 테스트용 boot/submit wait seam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** stdout 싱크(기본 process.stdout.write) — 테스트 주입. */
  readonly out?: (s: string) => void;
  /** LLM 스트림 주입(테스트 — 미주입 시 실제 streamLLM). */
  readonly stream?: StreamLLMFn;
  /** 부모 harness 저장소에 프레임을 쓰는 seam. */
  readonly writeScreen?: (screenKey: string, frame: string, env?: NodeJS.ProcessEnv) => void;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface PtyAttachDriveDeps {
  listPty(): readonly PtyHandle[];
  getPty(id: string): PtyHandle | undefined;
  runControlLoop: typeof import('../autopilot/pty-control-loop.js').runPtyControlLoop;
  controlDepsForHandle: typeof import('../autopilot/pty-control-loop.js').controlDepsForHandle;
  listPtyManifestRows?: typeof listPtyManifestRows;
  controlDepsForRemoteRef?: typeof import('../autopilot/pty-control-loop.js').controlDepsForRemoteRef;
  createBrain: typeof import('../autopilot/llm-control-brain.js').createLlmControlBrain;
  log(event: string, data: Record<string, unknown>): void;
}

const liveAttachDriveDeps: PtyAttachDriveDeps = {
  listPty,
  getPty,
  runControlLoop: runPtyControlLoop,
  controlDepsForHandle,
  listPtyManifestRows,
  controlDepsForRemoteRef,
  createBrain: createLlmControlBrain,
  log(event, data) { debug.log('pty.drive', event, data); },
};

export interface PtyAttachDriveOpts {
  readonly goal: string;
  /** DRIVE-JAIL: brain inputs naming paths outside this directory are not sent to the PTY. */
  readonly jailHome?: string;
  readonly maxSteps?: number;
  readonly pollMs?: number;
  readonly model?: string;
  readonly out?: (text: string) => void;
  readonly stream?: StreamLLMFn;
  readonly actor?: 'human' | 'agent';
}

export interface PtyAttachDriveResult {
  readonly exitCode: number;
  readonly message: string;
}

export async function runPtyAttachDrive(ref: string, opts: PtyAttachDriveOpts, deps: PtyAttachDriveDeps = liveAttachDriveDeps): Promise<PtyAttachDriveResult> {
  if (!ref.trim()) return { exitCode: 2, message: 'pty auto: <ref> is required' };
  if (!opts.goal.trim()) return { exitCode: 2, message: 'pty auto: --goal is required' };
  const local = resolvePtyRef(ref, deps.listPty().filter((handle) => handle.isAlive()).map((handle) => ({ id: handle.id, kind: handle.kind, nickname: handle.nickname })));
  if (local.reason === 'ambiguous') return { exitCode: 1, message: `pty auto: ambiguous ref ${ref}; candidates: ${local.candidates.map((item) => item.id).join(', ')}` };
  const handle = local.match ? deps.getPty(local.match.id) : undefined;
  if (local.match && (!handle || !handle.isAlive())) return { exitCode: 1, message: `pty auto: ${local.match.id} was not found` };
  if (handle && handle.accessMode !== 'auto') return { exitCode: 1, message: `pty auto: ${handle.id} is not agent-owned (access mode: ${handle.accessMode}); refusing to take ownership` };
  const remote = !handle ? resolvePtyRef(ref, (deps.listPtyManifestRows?.() ?? []).filter((row) => row.alive).map((row) => ({ id: row.id, kind: row.kind, nickname: row.nickname }))) : undefined;
  if (remote?.reason === 'ambiguous') return { exitCode: 1, message: `pty auto: ambiguous ref ${ref}; candidates: ${remote.candidates.map((item) => item.id).join(', ')}` };
  const id = handle?.id ?? remote?.match?.id;
  if (!id) return { exitCode: 1, message: `pty auto: ${ref} was not found` };
  const isRemote = !handle;
  const actor = opts.actor ?? 'human';

  const out = opts.out ?? ((text: string) => process.stdout.write(text));
  deps.log('attach-start', { id, ref, goal: opts.goal, ...(isRemote ? { remote: true, actor } : {}) });
  out(`⛭ auto ${id}${isRemote ? ' · remote' : ''} · goal="${opts.goal}"\n`);
  const brain = deps.createBrain({
    goal: opts.goal,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.stream ? { stream: opts.stream } : {}),
    onDecision: (decision) => out(decision.action === 'input' ? `  → input (${decision.text.length} chars)\n` : decision.action === 'done' ? `  → done (${decision.reason})\n` : '  · wait\n'),
  });
  const controlDeps = withDriveJail(handle ? deps.controlDepsForHandle(handle) : deps.controlDepsForRemoteRef?.(id, { actor }) ?? (() => { throw new Error('pty auto: remote control dependencies unavailable'); })(), opts.jailHome, (event, data) => deps.log(event, data));
  const inputHistory: string[] = [];
  const result = await deps.runControlLoop(brain, {
    ...controlDeps,
    inject: (text: string) => { inputHistory.push(text); return controlDeps.inject(text); },
    subjectPtyId: id,
    canReceiveInput: true,
  }, {
    maxSteps: opts.maxSteps ?? 30,
    pollMs: opts.pollMs ?? 800,
  });
  deps.log('attach-finish', { id, termination: result.termination.kind, steps: result.steps });
  out(`\n▸ ${result.termination.kind} (${result.steps} steps)\n`);
  if (result.termination.kind !== 'success') return { exitCode: 1, message: `pty auto: ${id} ${result.termination.kind}` };
  // DRIVE-OK: «done» from the brain still has to show on the final screen.
  let screen = '';
  try { screen = String(await controlDeps.observe()); } catch { /* unreadable → unverified */ }
  const verdict = verdictForFinalPtyScreen({ screen, inputHistory, exitCode: null });
  out(`▸ verdict: ${verdict.kind} — ${verdict.reason}\n`);
  deps.log('attach-verdict', { id, kind: verdict.kind, reason: verdict.reason.slice(0, 200) });
  return { exitCode: verdict.kind === 'success' ? 0 : 1, message: `pty auto: ${id} ${verdict.kind}` };
}

export type PtyAttachDriveRunner = (start: () => Promise<{ readonly exitCode: number; readonly message: string }>) => Promise<void>;

/** Register under the control-axis result runner; this function never owns process output or exit state. */
export function registerPtyAttachDriveCommand(pty: Command, run: PtyAttachDriveRunner, deps: PtyAttachDriveDeps = liveAttachDriveDeps): void {
  pty.command('auto <ref>')
    .requiredOption('--goal <goal>', 'goal for the existing PTY')
    .option('--max-steps <count>', 'maximum control-loop steps', '30')
    .option('--poll-ms <ms>', 'screen polling interval in milliseconds', '800')
    .option('--model <model>', 'LLM model override')
    .option('--actor <who>', 'remote input actor (human or agent)', 'human')
    .option('--jail-home <dir>', 'DRIVE-JAIL: do not send inputs naming paths outside this directory')
    .description('Drive an existing agent-owned PTY without spawning a terminal')
    .action((ref: string, opts: { goal: string; maxSteps: string; pollMs: string; model?: string; actor?: string; jailHome?: string }) => run(async () => {
      const maxSteps = Number(opts.maxSteps);
      const pollMs = Number(opts.pollMs);
      const actor = parsePtyWriteActor(opts.actor);
      if (!actor) return { exitCode: 2, message: 'pty auto: --actor must be human or agent' };
      return Number.isInteger(maxSteps) && maxSteps >= 1 && Number.isInteger(pollMs) && pollMs >= 0
        ? runPtyAttachDrive(ref, { goal: opts.goal, maxSteps, pollMs, actor, ...(opts.model ? { model: opts.model } : {}), ...(opts.jailHome ? { jailHome: opts.jailHome } : {}) }, deps)
        : { exitCode: 2, message: 'pty auto: --max-steps must be an integer >= 1 and --poll-ms must be an integer >= 0' };
    }));
}

/** Spawn-only drive flags. Named and refused when `--attach` is set — never accepted then ignored. */
export const DRIVE_SPAWN_ONLY_OPTIONS = ['cwd', 'worktree', 'json'] as const;
export type DriveSpawnOnlyOption = (typeof DRIVE_SPAWN_ONLY_OPTIONS)[number];

export interface DriveCliOpts {
  goal: string;
  maxSteps?: string;
  pollMs?: string;
  model?: string;
  cwd?: string;
  worktree?: boolean;
  json?: boolean;
  /** Existing PTY ref. Absent = spawn a new shell PTY (the default). */
  attach?: string;
  /** DRIVE-JAIL boundary directory. */
  jailHome?: string;
}

export interface DriveCliDeps {
  runPtyDrive?: typeof runPtyDrive;
  runPtyAttachDrive?: typeof runPtyAttachDrive;
  exit?: (code: number) => never;
  writeError?: (message: string) => void;
}

function toDriveCliFlag(attributeName: string): string {
  return `--${attributeName.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Named refusal of spawn-only flags on the attach path. Callers must not swallow this. */
export function assertDriveAttachOptions(opts: Pick<DriveCliOpts, DriveSpawnOnlyOption>): void {
  const named = DRIVE_SPAWN_ONLY_OPTIONS.filter((name) => opts[name] !== undefined && opts[name] !== false);
  if (named.length === 0) return;
  throw new Error(`drive: --attach 는 띄우는 쪽 전용 옵션과 같이 쓸 수 없음: ${named.map(toDriveCliFlag).join(', ')}`);
}

/** Commander drive action: one verb, two PTY sources.
 * No `--attach` → spawn a shell (legacy `elanous drive '<cmd>'`).
 * `--attach <ref>` → drive that existing PTY (same loop as `elanous pty auto`).
 * The TUI target deliberately belongs to `elanous dev --elanous`; this action remains shell-only. */
export async function runDriveCliCommand(command: string | undefined, opts: DriveCliOpts, deps: DriveCliDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const writeError = deps.writeError ?? ((message: string) => process.stderr.write(message));
  const finiteInt = (raw: string, name: string, min: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      writeError(`drive: --${name} 는 ${min} 이상의 정수여야 함(받음: ${raw})\n`);
      exit(2);
      throw new Error('unreachable after drive CLI exit');
    }
    return n;
  };
  const maxSteps = finiteInt(opts.maxSteps ?? '30', 'max-steps', 1);
  const pollMs = finiteInt(opts.pollMs ?? '800', 'poll-ms', 0);
  const attach = opts.attach?.trim();
  if (attach) {
    try {
      assertDriveAttachOptions(opts);
    } catch (err) {
      writeError(`${err instanceof Error ? err.message : String(err)}\n`);
      exit(2);
      return;
    }
    if (command) {
      writeError('drive: --attach 는 셸 명령을 받지 않음 — 이미 있는 PTY 를 몬다\n');
      exit(2);
      return;
    }
    const runAttach = deps.runPtyAttachDrive ?? runPtyAttachDrive;
    let attached: PtyAttachDriveResult;
    try {
      attached = await runAttach(attach, {
        goal: opts.goal, maxSteps, pollMs,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.jailHome ? { jailHome: opts.jailHome } : {}),
      });
    } catch (err) {
      writeError(`drive: ${err instanceof Error ? err.message : String(err)}\n`);
      exit(1);
      return;
    }
    if (attached.message) writeError(`${attached.message}\n`);
    exit(attached.exitCode);
    return;
  }
  if (!command) {
    writeError('drive: shell target requires <command>\n');
    exit(2);
    return;
  }
  const run = deps.runPtyDrive ?? runPtyDrive;
  let exitCode: number | null;
  try {
    ({ exitCode } = await run({
      command, goal: opts.goal, maxSteps, pollMs,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.jailHome ? { jailHome: opts.jailHome } : {}),
    }));
  } catch (err) {
    writeError(`drive: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
    return;
  }
  if (exitCode === null) {
    writeError('drive: child exited without an exit code; reporting failure (exit 1)\n');
    exit(1);
    return;
  }
  exit(exitCode);
}

/** ⭐⭐ drive 스폰 옵션 **조립**을 순수 함수로 뽑는다 — `runPtyDrive` 안에 두면 테스트가 조립을
 *  **베껴 모사**할 수밖에 없고, 베낀 테스트는 배선 회귀를 못 잡는다(무인 리뷰 must-fix · 2026-08-02).
 *  이제 테스트가 **실제로 도는 코드**를 탄다. */
/** ⛔ 화면 크기는 **1 이상**이어야 한다 — `0` 이나 음수는 PTY 로서 뜻이 없다. CLI 는 이미
 *  `parsePositiveInt` 로 거르지만, 이 함수는 공개 표면이라 **여기서도 거부**한다(무인 리뷰 should-fix). */
function requirePositiveSize(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`drive: ${name} must be a positive integer (got ${String(value)})`);
  }
  return value;
}

export function buildDriveSpawnOptions(
  opts: PtyDriveOpts,
  ctx: {
    cwd: string;
    space: Parameters<typeof elanousTuiSpawnOptions>[0]['space'];
    configDir?: string;
    stateDir?: string;
    envPtyId?: string;
  },
): ReturnType<typeof elanousTuiSpawnOptions> {
  const cols = requirePositiveSize(opts.cols, '--cols');
  const rows = requirePositiveSize(opts.rows, '--rows');
  if (opts.elanous) {
    const ptyId = opts.ptyId ?? ctx.envPtyId;
    const observeOnly = opts.observeOnly || resolveObserveOnlyDecision().enabled;
    return elanousTuiSpawnOptions({
      repoRoot: opts.repoRoot ?? resolve(import.meta.dir, '../..'),
      cwd: ctx.cwd,
      configDir: ctx.configDir!,
      stateDir: ctx.stateDir!,
      space: ctx.space,
      controlInboxDir: resolveControlInboxDir(ctx.space.id),
      requireIsolation: true,
      ...(observeOnly ? { observeOnly: true } : {}),
      // ⭐ 미지정이면 레시피 기본(160x40)을 쓴다 — 위 cols/rows 주석 참조.
      // ⚠️ `!== undefined` 로 본다 — `opts.cols ?` 로 보면 0 이 조용히 기본으로 떨어져
      //    셸 경로(`??`)와 동작이 갈린다(무인 리뷰 should-fix).
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
      // ⭐⭐ hold 경로는 id 를 **미리 발급**하므로 자식에게 그대로 넘긴다 —
      //    그래야 자식이 `getCurrentPtyId()` 로 자기를 알고 **PTY 정체성을 관측에 태깅**할 수 있다.
      //    ⚠️ pty↔session 결속은 아니다 — 세션은 데몬 소유다(매뉴얼 §0a ⑶b).
      ...(ptyId ? { ptyId } : {}),
    });
  }
  return {
    cmd: 'bash', args: ['-c', opts.command!], accessMode: 'auto' as const, transitionPolicy: 'open' as const,
    // ⭐ 대표 기본 160×40 — elanous TUI 레시피와 같은 축(위 cols/rows 주석).
    cols: cols ?? 160, rows: rows ?? 40,
    ...(opts.cwd ? { workdir: opts.cwd } : {}),
  };
}

export async function runPtyDrive(opts: PtyDriveOpts): Promise<{ exitCode: number | null }> {
  try {
    return await runPtyDriveInner(opts);
  } catch (error) {
    if (opts.hold && opts.json) {
      const message = error instanceof Error ? error.message : String(error);
      (opts.out ?? ((s: string) => process.stdout.write(s)))(`${JSON.stringify({ held: false, error: message })}\n`);
    }
    throw error;
  }
}

async function runPtyDriveInner(opts: PtyDriveOpts): Promise<{ exitCode: number | null }> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const holdResult = (ptyId: string, spaceId?: string, workdir?: string): void => {
    if (opts.json) out(`${JSON.stringify({ held: true, ptyId, ...(spaceId ? { spaceId } : {}), ...(workdir ? { workdir } : {}) })}\n`);
    else out(`⛭ held ${ptyId}\n`);
  };
  // ⛔⭐⭐⭐ **판정은 옵션이 아니라 우주에 기반한다**(무인 리뷰 must-fix · 2026-08-02).
  //    초판은 `opts.elanous` 일 때만 해석해서, **비-elanous 경로**도 격리 우주에서 `--cwd` 없이 돌았다.
  //
  // ⭐⭐ 다만 **「격리」가 다 같지 않다**(인수 시 실측). 이 저장소는 비-리더 트리에서 **3층
  //    (트리 파생)** 이 기본 ON 이라, 단순 부등호로 재면 **모든 호출**이 거부된다(기존 검사 3건이
  //    즉시 죽어 그것을 드러냈다). 두 사고는 **둘 다 명시 격리**였다 —
  //    `--isolated-root`(교차 세션) · `--test`(나). ⇒ **명시했을 때만** 요구한다.
  const { resolveCurrentInstance } = await import('../instance/current.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const scopeRoot = effectiveInstanceRoot();
  const resolution = resolveCurrentInstance();
  const explicitlyIsolated = (resolution.kind === 'test' && resolution.layer === 'explicit-flag')
    || Boolean(opts.isolatedRoot);
  const workdirDecision = decideTuiWorkdir(explicitlyIsolated, opts.cwd);
  debug.log('pty.drive', 'tui-workdir-decision', workdirDecision);
  if (workdirDecision.rejected) throw new Error(workdirDecision.message);
  const cwd = opts.cwd ?? process.cwd();
  const holdSpaceId = opts.hold
    ? (process.env.ELANOUS_HOLD_SPACE_ID ?? getHarnessSpace()?.id ?? normalizeSpaceId(basename(cwd)))
    : undefined;
  // ⛔⭐ 거부는 **detached owner 를 띄우기 전에** 한다(리뷰 must-fix · 2026-07-30).
  //    초판은 이 셋이 owner spawn **뒤**에 있어서, 실제 호출 형태의 `hold+비-elanous` / `hold+goal` 이
  //    즉시 거부되지 않고 **자식을 띄운 다음 30초 timeout** 으로 실패했다.
  // ⛔ `goal` 은 **존재 자체**를 거부한다 — `trim()` 기준이면 `--goal ''`/공백이 통과해 조용히 무시된다
  //    (레포 불변식 "수락 후 무시 금지").
  if (opts.hold && !opts.elanous) throw new Error('hold requires elanous target');
  if (opts.hold && opts.goal !== undefined) throw new Error('hold cannot be combined with goal');
  // ⛔ brain 전용 옵션은 hold 와 함께 오면 **거부**한다(리뷰 must-fix · 2026-07-30) —
  //    hold 분기는 brain 을 만들기 전에 반환하므로 이 셋은 **조용히 무시**됐다("수락 후 무시" 금지).
  //    ⚠️ `isolatedRoot`·`cwd` 는 스폰 옵션이라 hold 에서도 유효하다(거부 대상 아님).
  if (opts.hold) {
    const brainOnly = (['maxSteps', 'pollMs', 'model'] as const).filter((k) => opts[k] !== undefined);
    if (brainOnly.length) throw new Error(`hold cannot be combined with brain-only options: ${brainOnly.join(', ')}`);
  }
  if (!opts.hold && !opts.goal?.trim()) throw new Error('drive requires a non-empty goal');
  if (!opts.elanous && !opts.command) throw new Error('shell drive requires a command');
  // ⛔⭐ owner 생성 여부를 **주입 여부로 판별하지 않는다**(리뷰 must-fix · 2026-07-30) —
  //    종전엔 `!opts.out && !opts.writeScreen` 이 조건이라 **테스트가 주입만 하면 production 분기를
  //    우회**했고, 반대로 정상 API 호출자가 out 을 넘기면 owner 없이 `held` 로 성공했다.
  //    ⇒ 판별을 명시 필드(`spawnOwner`)로 옮긴다. 기본값은 `true`(CLI 경로)이고 테스트가 명시로 끈다.
  if (opts.hold && opts.spawnOwner !== false && process.env.ELANOUS_HOLD_OWNER !== '1') {
    // ⚠️ 4바이트(8 hex)는 **registry 의 canonical 형식이 정한 것**이다 — 리뷰 should-fix
    //    ("UUID 등 충분한 식별자")를 그대로 따르면 깨진다:
    //      registry.ts:803  new RegExp(`^${kind}_[0-9a-f]{8}$`).test(id)   ← **정확히 8 hex**
    //      registry.ts:277  invalid preallocated PTY id … expected ${kind}_<8 lowercase hex>
    //    ⇒ 폭을 늘리려면 **registry 계약**(그 정규식·에러 문구·기존 id 전부)을 함께 바꿔야 하고
    //      그것은 이 PR 스코프 밖이다. ⏭️ 결손으로 등록한다(충돌 확률 = 8 hex 이므로 생일문제로
    //      동시 alive 8개 상한에서는 무시할 수준이지만, 매니페스트 누적에서는 다르다).
    const id = `pty_${randomBytes(4).toString('hex')}`;
    // ⛔⭐⭐⭐ **우주를 한 번 해석하고, 그 값으로 owner 와 checker 를 함께 못 박는다.**
    //
    //   종전엔 owner 는 **argv 상속**(`process.argv.slice(1)`)으로, checker 는 **argv 스니핑**
    //   (`includes('--test')`)으로 각자 우주를 정했다. 출처가 둘이라 갈렸다:
    //     · `[S]` 실측(pilot · #5730) — owner 는 `⟨test⟩` 에 등록하고 checker 는 `prod` 를 조회했다.
    //     · 반대 방향도 있다 — `--config-dir` 이 **process-local override** 로만 서면
    //       (파서가 세우고 argv 엔 없는 경로) **owner 가 그것을 못 물려받는다**.
    //       ⚠️ 이건 4우주 회귀 테스트가 잡았다. 나는 "owner 계약은 안 바꾼다"를 불변식으로 적었는데
    //          **그 불변식이 틀렸다** — owner 도 명시로 못 박아야 넷 다 성립한다.
    //
    // ⇒ ⭐ `effectiveInstanceRoot()`(해석 4층 SSOT)를 **한 번** 부르고, 그 값을
    //   **양쪽 다 명시 `--config-dir`(1층)** 으로 준다(owner 는 env 스탬프로 한 번 더 보강한다 —
    //   1층이 이기지만 두 축이 어긋난 채로 두지 않는다).
    //   지도 = 내부 문서 `MAP-isolation-scope-four-universes-2026-08-01`
    // ⭐ 위에서 **이미 한 번** 해석했다 — 여기서 다시 부르면 두 출처가 된다(이 파일이 고치려던 형태).
    const resolvedScopeRoot = scopeRoot;
    const ownerEnv = {
      ...process.env,
      ELANOUS_HOLD_OWNER: '1',
      ELANOUS_HOLD_PTY_ID: id,
      ELANOUS_HOLD_SPACE_ID: holdSpaceId!,
      ELANOUS_STATE_DIR: resolvedScopeRoot,
      // ⛔⭐ **뿌리를 «그대로» 물려줄 때만 출처도 물려준다**(`OBS-T121`).
      //   🚨 출처가 빠지면 owner 가 「파생」을 「사람이 말한 격리」로 읽는다 —
      //     그러면 바깥 계정의 상태(쿼터 신호)를 갱신 안 되는 우주에서 읽는다.
      //   ⛔ 뿌리를 «바꿨으면» 딱지를 안 붙인다 — 그 값의 출처를 «모르기» 때문이다.
      //     (모르면 종전 동작 = 「명시」로 남는다. 아는 척하지 않는다.)
      ...(process.env.ELANOUS_STATE_DIR === resolvedScopeRoot && process.env.ELANOUS_STATE_DIR_SOURCE
        ? { ELANOUS_STATE_DIR_SOURCE: process.env.ELANOUS_STATE_DIR_SOURCE }
        : {}),
    };
    // ⛔⭐⭐⭐ **owner argv 에서 스코프 결정자를 걷어내고 해석된 값 하나만 남긴다.**
    //    env 스탬프(2층)만 얹으면 **원본 argv 의 `--test`/`--config-dir`(1층)이 그것을 이긴다**
    //    — 그러면 owner 는 `cwd` 에서 우주를 **다시 해석**해 `scopeRoot` 와 또 갈릴 수 있다
    //    (무인 리뷰 must-fix · 2026-08-01). ⇒ checker 와 **완전히 같은 방식**으로 1층에 못 박는다.
    // ⛔⭐ 스코프 인자 ⊕ «부모가 이미 소비한» 인자를 함께 걷는다 — 후자를 남기면 owner 가
    //   같은 이름의 워크트리를 다시 만들려다 «등록 전에» 죽는다(위 stripParentAppliedArgs 참조).
    // ⛔⭐⭐⭐ 그리고 «걷은 자리를 메운다» — `--worktree` 를 걷기만 하면 owner 는 작업 디렉토리를
    //   «아예 잃는다». 격리 우주는 그것을 거부한다(라이브 실측 2026-08-05:
    //   「격리 우주에서는 작업 디렉토리를 명시해야 한다 — --cwd <worktree-path>」).
    //   ⇒ 부모가 «이미 만든» 그 경로를 명시로 넘긴다. 그래야 `--worktree` 가 두 단계
    //     (`harness worktree add` → `--cwd`)와 «같은 일»을 한 번에 하는 것이 된다.
    //   ⚠️ 사람이 이미 `--cwd` 를 줬으면 «덮지 않는다» — 명시가 이긴다.
    const ownerArgs = withOwnerCwdArg(
      withScopeArgs(stripParentAppliedArgs(process.argv.slice(1)), resolvedScopeRoot),
      cwd,
    );
    // ⛔⭐⭐⭐ owner 의 **사망 사유를 버리지 않는다**(`[S]` 제보 ③ — 「실패가 조용하다」).
    //   종전 `stderr:'ignore'` 는 owner 가 «왜» 죽었는지를 통째로 버렸고, 밖에서는
    //   checker 의 「없다」만 보였다 ⇒ 원인이 한 겹 아래인데 그 겹이 안 보였다.
    //   ⚠️ detached 프로세스라 스트림을 붙들지 않는다 — «파일»로 받아 실패할 때만 꼬리를 읽는다.
    const ownerLogPath = join(tmpdir(), `elanous-hold-owner-${id}.log`);
    // ⛔ 공유 tmpdir 이고 명령 산출이 담길 수 있다 ⇒ 권한을 «명시»한다(리뷰 should-fix).
    const ownerLog = openSync(ownerLogPath, 'w', 0o600);
    // ⛔⭐ `Bun.spawn` 이 던져도 fd 를 닫는다(리뷰 must-fix) — 종전엔 spawn 성공 경로에서만 닫았다.
    let owner: ReturnType<typeof Bun.spawn>;
    try {
      owner = Bun.spawn({
        cmd: [process.execPath, ...ownerArgs],
        cwd,
        detached: true,
        env: ownerEnv,
        stdout: ownerLog,
        stderr: ownerLog,
      });
    } finally {
      // ⛔⭐ 부모는 «즉시» 닫는다 — 자식은 spawn 시점에 이미 상속했으므로 그 쓰기는 계속된다.
      //   `finally` 라 spawn 이 던진 경우에도 닫힌다.
      try { closeSync(ownerLog); } catch { /* best-effort */ }
    }
    owner.unref();
    const cliScript = process.argv[1];
    // ⛔⭐⭐⭐ **checker 의 우주를 argv 스니핑으로 추측하지 않는다** — 해석 SSOT 를 쓴다.
    //
    //   종전: `process.argv.includes('--test') ? ['--test'] : []`
    //   ⇒ owner 는 **부모 argv 전체**(`process.argv.slice(1)`)를 물려받아 부모 우주에 등록하는데,
    //     checker 는 명령을 **재구성**하면서 `--config-dir` 같은 **다른 층의 결정자를 떨궜다**.
    //     부모 argv 에 `--test` 가 없고 `--config-dir` 로 격리된 하위 단계(예: dev-pipeline 이
    //     띄운 프로세스)에서는 **owner 는 test 에 등록하고 checker 는 prod 를 조회**한다.
    //   ⭐ 실측(`[S]` · pilot · 2026-08-01 · 조율 채널 #5730):
    //     `checker = … pty list`(--test 없음) · `checkerExit=0` · `"pty list: no PTYs found"`
    //     인데 같은 시각 `elanous --test pty list` 에는 owner 가 **보였다**.
    //
    // ⇒ ⭐ `effectiveInstanceRoot()` 는 **4층(명시 플래그 ▸ 부모 스탬프 ▸ 트리 파생 ▸ 기본)** 을
    //   거친 **실효 뿌리**다. 그것을 **명시 `--config-dir`** 로 넘기면 checker 는 1층에서 확정되고,
    //   부모가 어느 층으로 결정됐든 **owner 와 같은 우주**를 본다(4우주 전부).
    //   지도 = 내부 문서 `MAP-isolation-scope-four-universes-2026-08-01`
    const scopeArgs = ['--config-dir', resolvedScopeRoot];
    // ⛔ **실제로 쓴 값**을 남긴다(무인 리뷰 must-fix) — 선계산 변수를 찍으면 경로에 따라 undefined 로 퇴행한다.
    debug.log('pty.drive', 'hold-scope-pinned', { scopeRoot: resolvedScopeRoot, ownerArgs, checkerScope: scopeArgs });
    // ⛔⭐⭐⭐ **기다린 것을 남긴다** — 종전엔 `id` 를 만들고(:157) 실패하면 그냥 throw 했다(로그 0).
    //    그래서 밖에서는 **«판정이 틀렸다»** 와 **«id 가 갈렸다»** 와 **«checker 가 아예 못 돌았다»** 가
    //    **구별되지 않았다**. `[S]` 가 pilot 에서 이 실패로 막혔을 때 그것을 밖에서 좁힐 수단이 없었다
    //    (조율 채널 #5730 · 2026-08-01). ⇒ 기다리는 대상과 checker 계약을 먼저 찍는다.
    const checkerCmd = [process.execPath, cliScript, ...scopeArgs, 'pty', 'list'];
    const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
    debug.log('pty.drive', 'hold-wait-start', {
      awaitingId: id,
      checker: checkerCmd.join(' '),
      // ⭐ argv 경계가 공백 있는 경로에서 모호해지지 않게 배열도 남긴다(리뷰 should-fix · #6498).
      checkerArgv: checkerCmd,
      // ⛔⭐ **서브커맨드를 짧은 전용 필드로 뽑는다**(2026-08-02). `checker` 는 전체 문자열이라
      //    경로가 길어지면 로거의 문자열 상한에 걸려 **끝이 잘린다** — 그런데 잘리는 끝이 하필
      //    `pty list` 의 `list`, 즉 *"무엇을 조회했나"* 다. 관측이 자기 핵심을 지우는 셈이라
      //    짧은 필드로 따로 남긴다(같은 형태를 `seams.ts` 의 `subcommand` 에서도 썼다).
      checkerSubcommand: checkerCmd.slice(-2).join(' '),
      cwd,
      stateDir: process.env.ELANOUS_STATE_DIR ?? null,
      // ⭐ **owner 와 checker 가 같은 뿌리를 보는지**가 이 실패의 핵심이라 둘을 나란히 찍는다.
      scopeRoot: scopeArgs[1],
      readyTimeoutMs,
    });
    const settlementMs = opts.settlementMs ?? 250;
    const ownerExitObserveMs = 100;
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + readyTimeoutMs;
    // ⚠️ 마지막 폴의 실물을 들고 나간다 — 실패 메시지가 **무엇을 봤는지** 말해야 한다.
    let lastExit: number | null = null;
    let lastStdout = '';
    let lastStderr = '';
    // ⛔⭐ **최소 한 번은 검사한다** — `while (now < deadline)` 만 쓰면 `readyTimeoutMs` 가
    //    폴 간격보다 작을 때 checker 를 **한 번도 안 돌리고** `checker exit=null` 로 보고했다
    //    (무인 리뷰 should-fix). 「안 돌렸다」를 「돌렸는데 없었다」로 내보내면 안 된다.
    let polled = false;
    /** owner 가 «이미 죽었나» — 죽었으면 30초를 기다릴 이유가 없다. */
    let ownerExited: number | null = null;
    while (!polled || Date.now() < deadline) {
      polled = true;
      // ⛔⭐ owner 사망을 본다 — checker 의 「없다」보다 이쪽이 원인에 가깝다.
      // ⛔⭐ `!== null` 로 쓰면 «모른다»(undefined — 스폰 구현이 그 필드를 안 주는 경우)를
      //   「죽었다」로 읽는다. 실제로 «수»를 들고 있을 때만 사망으로 판정한다.
      // ⛔⭐⭐ 그리고 «사망을 봤다고 곧장 실패로 접지 않는다»(리뷰 must-fix) — PTY 를 «등록한 뒤»
      //   owner 가 끝나는 경합이 있다. 그 경우 답은 「죽었다」가 아니라 「떴다」다.
      //   ⇒ 사망을 보면 checker 를 «한 번 더» 돌려 등록 여부를 먼저 확정한다.
      if (typeof owner.exitCode === 'number') { ownerExited = owner.exitCode; }
      // ⛔⭐ `stderr` 를 버리지 않는다 — 종전 `stderr:'ignore'` 는 **checker 가 죽어도 조용**했다.
      //    checker 가 못 도는 것과 PTY 가 안 뜨는 것은 다른 결함인데 같은 타임아웃으로 나왔다.
      const listed = Bun.spawnSync({ cmd: checkerCmd, cwd, env: ownerEnv, stdout: 'pipe', stderr: 'pipe' });
      lastExit = listed.exitCode;
      lastStdout = new TextDecoder().decode(listed.stdout);
      lastStderr = new TextDecoder().decode(listed.stderr);
      // ⛔⭐ `exitCode === 0` 일 때만 판정한다 — checker 가 죽으면서도 stdout 에 뭔가 남기면
      //    (부분 출력·경고) 종전엔 그것을 **정상 목록으로 읽어** ready 로 오판하거나
      //    실패 문면을 `checker listed …` 로 **오분류**했다(무인 리뷰 must-fix · 2026-08-01).
      if (lastExit === 0 && ptyListReportsAlive(lastStdout, id)) {
        await sleep(settlementMs);
        const settled = Bun.spawnSync({ cmd: checkerCmd, cwd, env: ownerEnv, stdout: 'pipe', stderr: 'pipe' });
        lastExit = settled.exitCode;
        lastStdout = new TextDecoder().decode(settled.stdout);
        lastStderr = new TextDecoder().decode(settled.stderr);
        if (lastExit === 0 && ptyListReportsAlive(lastStdout, id)) {
          debug.log('pty.drive', 'hold-wait-ready', { awaitingId: id, waitedMs: Date.now() - waitStartedAt, settlementMs });
          holdResult(id, holdSpaceId, cwd);
          return { exitCode: 0 };
        }
        if (typeof owner.exitCode === 'number') ownerExited = owner.exitCode;
        if (ownerExited === null) {
          const observed = await Promise.race([
            owner.exited.then((code) => typeof code === 'number' ? code : null),
            sleep(ownerExitObserveMs).then(() => null),
          ]);
          if (observed !== null) ownerExited = observed;
        }
        debug.log('pty.drive', 'hold-wait-settlement-failed', {
          awaitingId: id, waitedMs: Date.now() - waitStartedAt, settlementMs, checkerExit: lastExit, ownerExit: ownerExited,
        });
        try { owner.kill(); } catch { /* noop */ }
        throw new Error(`held elanous TUI registered then died during ${settlementMs}ms settlement — awaited ${id}; last exit=${ownerExited ?? 'unknown'}`);
      }
      // ⛔⭐⭐ 이번 폴에서 «등록이 확인되지 않았고» owner 가 이미 죽었으면 더 기다릴 이유가 없다.
      //   ⇒ 등록 판정을 «먼저» 하고(위 return), 그 뒤에 끊는다 — 경합에서 「떴다」를 잃지 않는다.
      if (ownerExited !== null) break;
      // ⭐ 남은 시간만큼만 잔다 — 무조건 100ms 자면 deadline 을 넘긴 뒤에도 반환이 늦어져
      //    `readyTimeoutMs` 의 뜻이 흐려진다(리뷰 should-fix).
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    // ⛔⭐⭐⭐ 루프의 «마지막 checker 실행 도중» owner 가 죽으면 종전엔 그 사망을 못 봤다
    //   (exitCode 를 다시 안 읽어 일반 timeout 으로 오판했다 · 리뷰 must-fix).
    //   ⇒ 나온 뒤 한 번 더 본다. 그리고 죽었으면 «등록 여부를 다시» 확인한다 —
    //     「죽었다」와 「떴다」는 같은 순간에 참일 수 있고, 답은 후자다.
    if (ownerExited === null && typeof owner.exitCode === 'number') {
      ownerExited = owner.exitCode;
      const recheck = Bun.spawnSync({ cmd: checkerCmd, cwd, env: ownerEnv, stdout: 'pipe', stderr: 'pipe' });
      if (recheck.exitCode === 0 && ptyListReportsAlive(new TextDecoder().decode(recheck.stdout), id)) {
        debug.log('pty.drive', 'hold-wait-ready', { awaitingId: id, waitedMs: Date.now() - waitStartedAt, ownerExited });
        holdResult(id, holdSpaceId, cwd);
        return { exitCode: 0 };
      }
    }
    try { owner.kill(); } catch { /* noop */ }
    debug.log('pty.drive', 'hold-wait-timeout', {
      awaitingId: id,
      checker: checkerCmd.join(' '),
      checkerExit: lastExit,
      // ⚠️ 로그도 무제한이 아니다 — 메시지보다 **훨씬 넉넉하되** 상한은 있다.
      //    ⛔ 그래서 "전문" 이라 부르지 않는다(리뷰 must-fix: 문서가 코드보다 넓게 말했다).
      checkerStdout: lastStdout.slice(0, 8000),
      checkerStderr: lastStderr.slice(0, 4000),
      checkerStdoutTruncated: lastStdout.length > 8000,
      checkerStderrTruncated: lastStderr.length > 4000,
    });
    // ⭐ 사람이 로그를 안 켜도 **한 줄로 세 후보가 갈리게** 실물을 메시지에 싣는다.
    // ⛔ **exit 를 최우선으로 분기**한다 — checker 사망은 «못 봤다» 가 아니라 «못 돌았다» 이고,
    //    그 둘을 같은 문면으로 내면 `[S]` 가 겪은 «세 후보가 안 갈린다» 가 그대로 재발한다.
    // ⚠️ 비정상 출력으로 **오류 문면이 무제한 커지지 않게** 상한을 둔다(리뷰 should-fix) —
    //    실패 메시지는 사람이 한 줄로 읽는 것이지 로그 덤프가 아니다(전문은 `hold-wait-timeout`).
    const listed = () => {
      const ids = lastStdout.trim().split('\n').map((l) => l.split('\t')[0]).filter(Boolean);
      return ids.length > 8 ? [...ids.slice(0, 8), `…+${ids.length - 8}`] : ids;
    };
    // ⛔⭐⭐ owner 가 죽었으면 그것이 «원인»이다 — checker 의 「없다」는 그 결과일 뿐이다.
    //   ⇒ 사유를 먼저 말하고, 로그 꼬리를 «값으로» 싣는다(사람이 로그를 안 켜도 한 줄로 갈린다).
    const ownerTail = (): string => {
      // ⛔ 「꼬리」만 필요한데 전체를 읽지 않는다 — owner 가 대량 출력을 남겼을 수 있다.
      try {
        const size = statSync(ownerLogPath).size;
        const want = 4096;
        const start = size > want ? size - want : 0;
        const fd = openSync(ownerLogPath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(want, size));
          readSync(fd, buf, 0, buf.length, start);
          const text = buf.toString('utf8').trim();
          if (!text) return '(owner 산출 없음)';
          const lines = text.split('\n');
          return lines[lines.length - 1]!.slice(0, 300);
        } finally { closeSync(fd); }
      } catch { return '(owner 로그를 못 읽음)'; }
    };
    if (ownerExited !== null) {
      debug.log('pty.drive', 'hold-owner-died', { awaitingId: id, ownerExit: ownerExited, ownerLogPath });
      throw new Error(
        `held elanous TUI owner exited before registering a PTY (exit=${ownerExited}) — awaited ${id}; `
        + `owner said: ${ownerTail()} (전문: ${ownerLogPath})`,
      );
    }
    const seen = lastExit !== 0
      ? `checker exit=${lastExit}${lastStderr.trim() ? `: ${lastStderr.trim().split('\n')[0].slice(0, 200)}` : ''}${lastStdout.trim() ? ` (stdout listed [${listed().join(', ')}])` : ''}`
      : lastStdout.trim().length === 0
        ? 'checker printed nothing'
        : `checker listed [${listed().join(', ')}]`;
    throw new Error(
      `held elanous TUI owner did not become ready within ${readyTimeoutMs >= 1000 ? `${Math.round(readyTimeoutMs / 1000)} seconds` : `${readyTimeoutMs}ms`} — awaited ${id}; ${seen}`,
    );
  }
  // ⚠️ 거부 셋은 위(owner spawn 전)로 옮겼다 — 여기 중복을 두지 않는다(옮기며 지우는 것을 놓쳤던 자리).
  const { startPty, unregisterPty } = await import('../pty-shell/registry.js');
  const isolation: ElanousTuiIsolation | undefined = opts.elanous
    ? establishElanousTuiIsolation({ root: opts.isolatedRoot, callerStateDir: process.env.ELANOUS_STATE_DIR })
    : undefined;
  const writeScreen = opts.writeScreen ?? writeHarnessScreen;
  const inheritedSpace = getHarnessSpace();
  const space = opts.hold && holdSpaceId
    ? (inheritedSpace ? { ...inheritedSpace, id: holdSpaceId } : { inHarness: true as const, kind: 'dev-hold' as const, id: holdSpaceId, runId: getHarnessRunId() })
    : inheritedSpace
      ?? { inHarness: true as const, kind: 'dev-hold' as const, id: normalizeSpaceId(basename(cwd)), runId: getHarnessRunId() };
  const screenKey = space.id || basename(cwd);
  let h: ReturnType<typeof startPty> | undefined;
  // ⭐ hold 가 **성공적으로 넘긴** 경우에만 true. finally 는 이 플래그로만 정리를 생략한다.
  let handedOff = false;
  try {
    const spawnOptions = buildDriveSpawnOptions(opts, {
      cwd,
      space,
      ...(isolation ? { configDir: isolation.configDir, stateDir: isolation.stateDir } : {}),
      ...(process.env.ELANOUS_HOLD_PTY_ID ? { envPtyId: process.env.ELANOUS_HOLD_PTY_ID } : {}),
    });
    h = startPty({
      ...spawnOptions,
      ...(opts.hold ? { detach: true, ...(opts.ptyId ?? process.env.ELANOUS_HOLD_PTY_ID ? { id: opts.ptyId ?? process.env.ELANOUS_HOLD_PTY_ID } : {}) } : {}),
    });
    if (opts.hold) {
      // `detach` is a registry lifetime contract, not a spawn-recipe concern.
      // The held child must remain discoverable after this CLI process returns.
      h.setAccessMode('write');
      const screen = await h.renderScreen();
      writeScreen(screenKey, screen, process.env);
      debug.log('pty.drive', 'held', { id: h.id, screenKey });
      holdResult(h.id, space.id, cwd);
      // ⛔⭐ **여기까지 왔을 때만** 정리를 생략한다(리뷰 must-fix · 2026-07-30) —
      //    종전엔 finally 가 `opts.hold` 만 봐서, 위 setAccessMode·renderScreen·writeScreen 중
      //    하나라도 던지면 **detached PTY 와 isolation 이 유출**됐다(아무도 거두지 않는다).
      handedOff = true;
      return { exitCode: 0 };
    }
    const { runPtyControlLoop, controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    const { createLlmControlBrain } = await import('../autopilot/llm-control-brain.js');
    out(`⛭ drive ${h.id} · goal="${opts.goal}"\n`);
    const brain = createLlmControlBrain({
      goal: opts.goal!,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.stream ? { stream: opts.stream } : {}),
      onDecision: (d) => out(
        d.action === 'input' ? `  → input (${d.text.length} chars)\n`
        : d.action === 'done' ? `  → done (${d.reason})\n`
        : '  · wait\n',
      ),
    });
    let delivered = !opts.elanous;
    const settle = opts.elanous ? async () => {
      if (delivered) return;
      const wait = opts.sleep ?? sleep;
      await wait(opts.bootMs ?? 8_000);
      h!.write(opts.goal!, 'agent');
      await wait(300);
      h!.write('\r', 'agent');
      writeScreen(screenKey, await h!.renderScreen(), process.env);
      delivered = true;
    } : undefined;
    const rawDeps = withDriveJail(controlDepsForHandle(h), opts.jailHome, (event, data) => debug.log('pty.drive', event, data));
    // DRIVE-OK: keep what we typed so the final verdict can tell child output from echoed input.
    const inputHistory: string[] = [];
    const deps = { ...rawDeps, inject: (text: string) => { inputHistory.push(text); return rawDeps.inject(text); } };
    const autoAssist = opts.elanous ? getUserConfig().tools.selfImplement.autoAssist : undefined;
    const observe = opts.elanous ? async () => {
      const frame = await deps.observe();
      writeScreen(screenKey, frame, process.env);
      return frame;
    } : deps.observe;
    const result = await runPtyControlLoop(brain, {
      ...deps,
      observe,
      ...(settle ? { settle } : {}),
      subjectPtyId: h.id,
      ...(opts.elanous ? { canReceiveInput: true, autoAssist } : {}),
    }, {
      maxSteps: opts.maxSteps ?? 30,
      pollMs: opts.pollMs ?? 800,
    });
    let screen = '';
    try { screen = await h.renderScreen(); } catch { /* noop */ }
    if (opts.elanous) writeScreen(screenKey, screen, process.env);
    out(`\n▸ ${result.termination.kind} (${result.steps} steps)\n`);
    if (screen.trim()) out(`▸ 최종 화면:\n${screen}\n`);
    const childExit = h.exitCode;
    const alive = h.isAlive();
    // DRIVE-OK (10-03 X1: every step failed yet drive said ok): the brain's «done» is not proof —
    // judge the final screen. Plain drives take the verdict as the exit; elanous-TUI drives only observe it.
    const verdict = result.termination.kind === 'success' ? verdictForFinalPtyScreen({ screen, inputHistory, exitCode: childExit }) : null;
    if (verdict) {
      out(`▸ verdict: ${verdict.kind} — ${verdict.reason}\n`);
      debug.log('pty.drive', 'verdict', { kind: verdict.kind, reason: verdict.reason.slice(0, 200), enforced: !opts.elanous });
    }
    const verdictFails = !!verdict && !opts.elanous && verdict.kind !== 'success';
    const baseExit = childExit !== null
      ? childExit
      : alive
        ? result.termination.kind === 'success' ? 0 : 1
        : null;
    // The verdict only withholds a success: nonzero and unknown (null) exits keep their meaning.
    const exitCode = baseExit === 0 && verdictFails ? 1 : baseExit;
    debug.log('pty.drive', 'exit-resolve', { alive, childExit, exitCode, termination: result.termination.kind, ...(verdict ? { verdict: verdict.kind } : {}) });
    if (exitCode === null) out('▸ child exited without an exit code; reporting failure at the process boundary (exit 1)\n');
    return { exitCode };
  } finally {
    // ⛔ `opts.hold` 가 아니라 **handedOff**(성공 handoff)로 판정한다 — hold 경로가 중간에서
    //    던지면 정리해야 한다(그러지 않으면 detached PTY·isolation 유출).
    if (!handedOff && h) {
      try { h.kill(); } catch { /* noop */ }
      try { unregisterPty(h.id); } catch { /* noop */ }
    }
    if (!handedOff) {
      try { isolation?.dispose(); } catch { /* noop */ }
    }
  }
}
