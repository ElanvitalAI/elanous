// 산출물 기동기 — 골 문서의 기동 선언을 읽어 «켜고», 준비될 때까지 기다리고, 반드시 «끈다».
//
// ⛔ 이 층이 하지 않는 것: 명령을 «해석»하지 않는다. `resolveArtifactLaunchCommand` 가
//   저장소의 실재하는 선언(package.json scripts · Makefile · Procfile · elanous 하위명령)에서
//   읽은 명령이 «정확히 하나»일 때만 켠다. 후보가 0이거나 둘 이상이면 켜지 않고 사유를 값으로 낸다.
//
// ⭐ 프로세스 수명주기가 이 모듈의 «본체»다. 앞선 시도가 리뷰 must-fix 다섯으로 기각됐고
//   그 다섯이 전부 이 축이었다. 그래서 각각을 설계로 못 박는다:
//   ① 셸이 죽어도 그 «자식 그룹»이 남는다      → detached 로 띄우고 «그룹»에 신호를 보낸다
//   ② 그룹 신호가 안 통하는 플랫폼이 있다        → 그때는 자식 자신에게 SIGKILL 폴백
//   ③ spawn 실패는 «비동기 error 이벤트»로 온다  → 그 이벤트를 구독해 값으로 바꾼다
//   ④ 포트 검사는 TOCTOU 다                     → 띄우기 «전»에 이미 열려 있으면 귀속 불가로 거부하고,
//                                              폴링마다 «자식이 아직 사나»를 같이 본다
//   ⑤ 정리는 «모든» 경로에서 난다               → 성공·실패·예외 어디서든 stop 을 부르고 stop 은 멱등이다

import { terminateTree, TERMINATE_TREE_KILL_WAIT_MS } from '../shell-primitive/terminate-tree.js';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { parseArtifactLaunchDeclaration } from '../self-implement/goal-author.js';
import { resolveArtifactLaunchCommand } from './artifact-launch-command.js';
import { debug } from '../debug/log.js';

/** 켤 수 없었던 이유. ⛔ 「못 켰다」의 갈래를 하나로 접지 않는다. */
export type ArtifactLaunchFailureReason =
  | 'no-launch-declaration'
  | 'invalid-launch-declaration'
  | 'no-port-declaration'
  | 'no-command-source'
  | 'ambiguous-command-source'
  | 'port-already-in-use'
  | 'spawn-failed'
  | 'early-exit'
  | 'port-timeout'
  /** ⛔ 포트에 응답하는 것이 «우리 자식이 아니다»가 확인됐다. */
  | 'port-not-owned'
  /** ⛔ 골 문서를 «못 읽었다» — 「선언이 없다」와 다른 값이다. */
  | 'goal-read-failed'
  /** ⛔ 띄우기 «전» 포트 상태를 «못 쟀다» — 「이미 점유됐다」와 다른 값이다. */
  | 'port-state-unknown'
  /** ⛔ 해석기가 사유를 «안 줬다» — 「후보가 없다」와 다른 값이다. 못 쟀음을 못 쟀음으로 남긴다. */
  | 'unknown-command-resolution';

/** 포트 응답을 우리 자식에게 «귀속»시킬 수 있었나. ⛔ 「못 쟀음」을 「확인됨」으로 접지 않는다. */
export type ArtifactPortAttribution = 'confirmed' | 'unverified';

export interface ArtifactLaunchHandle {
  /** 관측 대상 주소. 포트가 응답한 «뒤»에만 존재한다. */
  readonly url: string;
  /**
   * ⭐ 선검사·자식 생존·프로브 직후 재확인만으로는 preflight 뒤 제3자가 포트를 잡는 경쟁을 못 막는다.
   *   소유 PID 를 물어 «확인»되면 confirmed, 못 물으면 unverified 로 «남긴다»(리뷰 must-fix 7차).
   */
  readonly attribution: ArtifactPortAttribution;
  /** 몇 번 불러도 같다. 그룹 → 자식 순으로 끄고, 끝나면 다시 불러도 아무 일도 없다. */
  stop(): Promise<void>;
}

export type ArtifactLaunchResult =
  | { readonly ok: true; readonly handle: ArtifactLaunchHandle; readonly command: string }
  | {
    readonly ok: false;
    readonly reason: ArtifactLaunchFailureReason;
    /** `ambiguous-command-source` 일 때만 — 겹친 후보를 이름으로 남긴다. */
    readonly candidates?: readonly string[];
    readonly detail?: string;
  };

/** 명령 해석의 산출 — `resolveArtifactLaunchCommand` 의 반환에서 이 층이 «쓰는 것»만 좁혀 받는다. */
export interface ArtifactLaunchCommandResolution {
  readonly command?: string;
  readonly reason?: string;
  readonly candidates?: readonly unknown[];
}

export interface ArtifactLaunchDeps {
  /**
   * ⭐ 저장소 뿌리를 «인자»로 받는다. ⛔ 이 모듈은 `process.cwd()` 를 읽지 않는다 —
   *   실행 맥락은 한 번 정해지고 아래로는 인자로만 내려간다는 계약(MANUAL-execution-context) 때문이다.
   */
  repositoryRoot: string;
  /** 이름 → 명령 해석(테스트 심). 기본은 저장소의 `resolveArtifactLaunchCommand`. */
  resolveCommand?: (input: { entrypoint?: string; targetPath: string; repositoryRoot: string }) => Promise<ArtifactLaunchCommandResolution>;
  readGoal?: (path: string) => Promise<string>;
  /** 명령 문자열을 셸로 띄운다(테스트 심). detached 로 띄우는 책임은 구현이 진다. */
  spawn?: (command: string) => ChildProcess;
  /** 포트가 응답하나. true 면 열려 있다. */
  probePort?: (port: number) => Promise<boolean>;
  /**
   * ⭐ 그 포트를 «듣고 있는» 프로세스의 pid. 모르면 undefined.
   * ⛔ undefined 를 「우리 것」으로도 「남의 것」으로도 접지 않는다 — unverified 로 남긴다.
   */
  portOwnerPid?: (port: number) => number | undefined;
  /** 프로세스 «그룹»에 신호를 보낸다. 보낼 수 없으면 false. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  /**
   * ⭐ 그룹에 «아직 누가 있나». true=있다 · false=비었다 · undefined=못 쟀다.
   * ⛔ 리더(셸)의 exit 는 그룹이 비었음을 «증명하지 못한다» — 손자가 남을 수 있다(리뷰 must-fix 5차).
   */
  groupAlive?: (pid: number) => boolean | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 포트를 기다리는 상한(기본 30초). ⛔ 상한이 없으면 「못 켰다」가 「영원히 기다린다」가 된다. */
  readyTimeoutMs?: number;
  /** 폴링 간격(기본 250ms). */
  pollIntervalMs?: number;
  /** SIGTERM 뒤 SIGKILL 까지 기다리는 시간(기본 2초). */
  killGraceMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_KILL_GRACE_MS = 2_000;

const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('harness.artifact-launcher', event, data); } catch { /* fail-soft */ }
};

/** 기본 포트 프로브 — 연결이 되면 열린 것으로 본다. ⛔ 무엇이 도는지는 묻지 않는다. */
export function defaultProbePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    const settle = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** 기본 그룹 생존 검사 — 신호 0 은 «보내지 않고» 존재만 묻는다. ESRCH 면 비었고, EPERM 이면 있다. */
export function defaultGroupAlive(pid: number): boolean | undefined {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;   // ⛔ 못 쟀다 — 「비었다」로 접지 않는다
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 골 문서를 읽어 산출물을 켜고, 선언된 포트가 응답할 때까지 기다린 뒤 관측 주소를 내준다.
 *
 * ⛔ 성공하면 호출자가 `handle.stop()` 을 «반드시» 불러야 한다. 실패 경로에서는 이 함수가 이미 껐다.
 */
export async function launchGoalArtifact(goalPath: string, deps: ArtifactLaunchDeps): Promise<ArtifactLaunchResult> {
  const readGoal = deps.readGoal ?? ((path: string) => readFile(path, 'utf8'));
  const resolveCommand = deps.resolveCommand
    ?? ((input: { entrypoint?: string; targetPath: string; repositoryRoot: string }) =>
      resolveArtifactLaunchCommand(input as Parameters<typeof resolveArtifactLaunchCommand>[0]) as Promise<ArtifactLaunchCommandResolution>);
  const probePort = deps.probePort ?? ((port: number) => defaultProbePort(port));
  const killGroup = deps.killGroup;
  const groupAlive = deps.groupAlive ?? defaultGroupAlive;
  const portOwnerPid = deps.portOwnerPid;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // ① ⛔ 상대 경로를 «암묵적 process.cwd()» 로 해석하지 않는다 — 맥락은 인자로만 내려온다(리뷰 must-fix).
  const resolvedGoalPath = isAbsolute(goalPath) ? goalPath : resolvePath(deps.repositoryRoot, goalPath);
  let document: string;
  try {
    document = await readGoal(resolvedGoalPath);
  } catch (error) {
    // ④ ⛔ 못 읽은 것을 「선언이 없다」로 «단정»하지 않는다(리뷰 must-fix 6차).
    return { ok: false, reason: 'goal-read-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const declaration = parseArtifactLaunchDeclaration(document);
  if (declaration === null) return { ok: false, reason: 'no-launch-declaration' };
  if (declaration.errors.length) return { ok: false, reason: 'invalid-launch-declaration', detail: declaration.errors.join('; ') };
  if (declaration.port === undefined) return { ok: false, reason: 'no-port-declaration' };
  const port = declaration.port;

  let resolved: ArtifactLaunchCommandResolution;
  try {
    resolved = await resolveCommand({
      ...(declaration.entrypoint === undefined ? {} : { entrypoint: declaration.entrypoint }),
      targetPath: resolvedGoalPath,
      repositoryRoot: deps.repositoryRoot,
    });
  } catch (error) {
    observe('resolve-threw', { goalPath, error: String(error).slice(0, 120) });
    return { ok: false, reason: 'unknown-command-resolution', detail: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  const command = resolved.command;
  if (command === undefined) {
    const reason = resolved.reason;
    const candidates = resolved.candidates ?? [];
    observe('resolve-failed', { goalPath, reason: reason ?? 'unknown', candidateCount: candidates.length });
    if (reason === 'ambiguous-command-source') return { ok: false, reason: 'ambiguous-command-source', candidates: candidates.map((c) => String(c)) };
    // ② ⛔ «아는» 사유만 그 값으로 낸다. 빈 문자열·모르는 값·부재를 「후보가 없다」로 단정하면
    //   그것이 곧 못 쟀음을 없음으로 말하는 것이다(리뷰 must-fix 3·4차).
    if (reason === 'no-command-source') return { ok: false, reason: 'no-command-source' };
    return {
      ok: false,
      reason: 'unknown-command-resolution',
      detail: reason === undefined || reason === ''
        ? 'resolver returned neither a command nor a reason'
        : `resolver returned an unrecognized reason: ${reason}`,
    };
  }

  // ④ 귀속 — 띄우기 «전»에 이미 열려 있으면 그 포트의 응답을 우리 자식에게 귀속시킬 수 없다.
  try {
    if (await probePort(port)) {
      observe('port-already-in-use', { goalPath, port });
      return { ok: false, reason: 'port-already-in-use', detail: `port ${port} responded before launch` };
    }
  } catch (error) {
    // 선검사가 던지면 「비어 있다」로 넘어가지 않는다 — 귀속을 확인 못 했으므로 켜지 않는다.
    // ③ ⛔ 던졌다는 것은 «못 쟀다»는 뜻이지 「점유됐다」가 아니다(리뷰 must-fix 6차).
    observe('preflight-probe-threw', { goalPath, port, error: String(error).slice(0, 120) });
    return { ok: false, reason: 'port-state-unknown', detail: `pre-launch port probe threw: ${error instanceof Error ? error.message : String(error)}` };
  }

  const spawnFn = deps.spawn ?? ((cmd: string) => nodeSpawn(cmd, { shell: true, detached: true, stdio: 'ignore' }));
  let child: ChildProcess;
  try {
    child = spawnFn(command);
  } catch (error) {
    // 동기 throw 도 값으로 바꾼다. ③ 의 절반.
    observe('spawn-failed', { goalPath, sync: true });
    return { ok: false, reason: 'spawn-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  // ③ spawn 실패는 «비동기 error 이벤트»로도 온다 — 구독하지 않으면 미처리 이벤트가 프로세스를 죽인다.
  let spawnError: string | null = null;
  child.once('error', (error: Error) => { spawnError = error.message; });
  let exited = false;
  child.once('exit', () => { exited = true; });

  // ① ⛔ 멱등은 「두 번째가 «아무것도 안 함»」이 아니라 「두 번째도 «완료를 기다림»」이다(리뷰 must-fix 6차).
  //   진행 중 teardown 을 공유하지 않으면 두 번째 호출이 실제 종료 «전»에 resolve 된다.
  let teardown: Promise<void> | null = null;
  const runStop = async (): Promise<void> => {
    const pid = child.pid;
    // ② pid 를 모르면 «그룹»에는 못 보낸다. 그렇다고 아무것도 안 하면 그것이 곧 고아 경로다(리뷰 must-fix).
    //   자식 핸들은 있으므로 자식 자신에게는 «반드시» 보낸다.
    if (pid === undefined) {
      try { child.kill('SIGTERM'); } catch { /* 이미 죽었다 */ }
      try { child.kill('SIGKILL'); } catch { /* 이미 죽었다 */ }
      observe('stopped', { goalPath, pid: null, escalated: true, groupKilled: false });
      return;
    }
    // ① KILL-TREE-ONE — 신호 순서·유예·SIGKILL 승격·사후 확인은 공용 terminateTree 한 곳이 가진다.
    //   이 모듈은 «주입 가능한 이음매»(killGroup · groupAlive)만 sendSignal 로 건네고, 그룹 신호가
    //   «false 반환 · throw» 로 실패하면 자식 자신에게 폴백한다(리뷰 must-fix ②: 폴백이 건너뛰어지면 고아 경로).
    const signalChild = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* 이미 죽었다 */ }
    };
    const sendSignal = (addr: number, signal: NodeJS.Signals | 0): void => {
      const groupPid = -addr;
      if (signal === 0) {
        // ⛔ 리더(셸)의 exit 는 그룹이 비었음을 증명하지 못한다 — 그룹을 «따로» 묻는다(리뷰 must-fix 5차).
        //   못 쟀으면(undefined) 비었다고 가정하지 않는다: ESRCH 가 아닌 오류로 던져 «있다고 간주 · 승격» 한다.
        let alive: boolean | undefined;
        try { alive = groupAlive(groupPid); } catch { alive = undefined; }
        if (alive === false) throw Object.assign(new Error('group empty'), { code: 'ESRCH' });
        if (alive === undefined) throw Object.assign(new Error('group unmeasured'), { code: 'EUNMEASURED' });
        return;
      }
      // 이음매가 없으면 terminateTree 의 기본 송신(process.kill)과 같은 길을 쓴다 — 실패는 폴백으로 간다.
      let delivered = false;
      try {
        if (killGroup) delivered = killGroup(groupPid, signal);
        else { process.kill(addr, signal); delivered = true; }
      } catch { delivered = false; }
      if (!delivered) signalChild(signal);
    };
    const outcome = await terminateTree(child, {
      group: true,
      graceMs: killGraceMs,
      killWaitMs: Math.min(killGraceMs, TERMINATE_TREE_KILL_WAIT_MS),
      sendSignal,
    });
    if (!outcome.terminated) observe('stop-unconfirmed', { goalPath, pid, errors: outcome.errors.slice(0, 3) });
    observe('stopped', { goalPath, pid, escalated: outcome.escalated, groupConfirmedEmpty: outcome.terminated && !outcome.escalated });
  };
  const stop = (): Promise<void> => (teardown ??= runStop());

  // ① ⭐ 준비 대기의 «어떤» 예외에도 자식이 남지 않게 한다 — probePort·sleep·now 는 주입된 심이라
  //   throw 할 수 있고, 초판은 try 없이 예외가 함수를 빠져나가 자식을 고아로 만들었다(리뷰 must-fix).
  try {
  // ① deadline 계산도 try «안»이다 — now() 가 throw 하면 이미 띄운 자식이 샌다(리뷰 must-fix).
  const deadline = now() + readyTimeoutMs;
  for (;;) {
    if (spawnError !== null) {
      await stop();
      observe('spawn-failed', { goalPath, sync: false });
      return { ok: false, reason: 'spawn-failed', detail: spawnError };
    }
    // ④ 귀속 — 자식이 이미 죽었으면 포트가 열려 있어도 그것은 «우리 것이 아니다».
    if (exited) {
      await stop();
      observe('early-exit', { goalPath, port });
      return { ok: false, reason: 'early-exit', detail: 'child exited before the port responded' };
    }
    if (await probePort(port)) {
      // ④ ⭐ 프로브가 «yield 지점»이다 — 기다리는 동안 자식이 죽었을 수 있다.
      //   포트가 열렸어도 그 응답을 죽은 자식에게 귀속시킬 수 없으므로 여기서 다시 본다.
      if (spawnError !== null) {
        await stop();
        observe('spawn-failed', { goalPath, sync: false, duringProbe: true });
        return { ok: false, reason: 'spawn-failed', detail: spawnError };
      }
      if (exited) {
        await stop();
        observe('early-exit', { goalPath, port, duringProbe: true });
        return { ok: false, reason: 'early-exit', detail: 'child exited while the port was being probed' };
      }
      break;
    }
    if (now() >= deadline) {
      await stop();
      observe('port-timeout', { goalPath, port, readyTimeoutMs });
      return { ok: false, reason: 'port-timeout', detail: `port ${port} did not respond within ${readyTimeoutMs}ms` };
    }
    await sleep(pollIntervalMs);
  }

  } catch (error) {
    await stop();
    observe('readiness-threw', { goalPath, port, error: String(error).slice(0, 160) });
    return { ok: false, reason: 'port-timeout', detail: `readiness probing threw: ${error instanceof Error ? error.message : String(error)}` };
  }

  // ⭐ 귀속 — 소유 PID 를 «물을 수 있으면» 묻는다. 남의 것이면 성공으로 내지 않는다.
  // ③ ⛔ 귀속 확인의 «어떤» 예외도 자식을 남기지 않는다(리뷰 must-fix 8차).
  let attribution: ArtifactPortAttribution = 'unverified';
  let notOurs: number | null = null;
  try {
    if (portOwnerPid !== undefined) {
      const owner = portOwnerPid(port);
      if (owner !== undefined) {
        if (owner === child.pid) {
          attribution = 'confirmed';
        } else if (child.pid !== undefined && groupAlive(child.pid) === false) {
          // ⭐ 우리 그룹이 «비었음이 확인»됐는데 포트를 쥔 자가 있다 ⇒ 우리 것이 아니다.
          notOurs = owner;
        }
        // ⛔ 그 밖: 우리 그룹이 살아 있거나 못 쟀다 ⇒ 그 pid 가 우리 손자일 수 있다.
        //   ***모르는 것을 「남의 것」으로 단정하지 않는다*** — unverified 로 남긴다(리뷰 must-fix 8차 ②).
      }
    }
  } catch (error) {
    // ⛔ 귀속을 «못 쟀다»고 해서 기동 자체를 실패로 접지 않는다 — 산출물은 실제로 떴다.
    //   예외를 삼켜 unverified 로 남기고 핸들을 돌려주므로 호출자가 정리할 수 있다(고아 없음).
    attribution = 'unverified';
    notOurs = null;
    observe('attribution-threw', { goalPath, port, error: String(error).slice(0, 120) });
  }
  if (notOurs !== null) {
    await stop();
    observe('port-not-owned', { goalPath, port, owner: notOurs, childPid: child.pid ?? null });
    return { ok: false, reason: 'port-not-owned', detail: `port ${port} is held by pid ${notOurs} while our process group is confirmed empty` };
  }

  const url = `http://127.0.0.1:${port}`;
  observe('ready', { goalPath, port, attribution, command: command.slice(0, 120) });
  return { ok: true, command, handle: { url, attribution, stop } };
}
