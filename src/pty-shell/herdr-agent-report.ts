// herdr pane 안의 elanous TUI 가 스스로 에이전트로 신고한다.
// 전경 프로세스 이름(bun …/elanous.mjs)은 herdr 내장 감지 목록 밖이라
// `herdr agent list` 에 안 잡힌다 — pane CLI 로 생애·세션을 직접 알린다.
//
// 활성은 HERDR_ENV=1 ⊕ HERDR_PANE_ID ⊕ 킬스위치가 아닐 때뿐.
// 실패(rc≠0·spawn·ENOENT·오류 봉투)는 던지지 않고 한 번 로그한 뒤 그 신고기를 끈다.
// 단 turn 신고의 timeout 은 끄지 않는다(TUI-HERDR-STATUS-STALE · 10-22 n8n): herdr 가 바쁜 한 번의 2s 초과로
// 신고기가 꺼져 턴 끝 idle 이 영영 안 나가 herdr 가 1.9h 동안 working 을 보였다. timeout 은 «결과 모름»이라
// 마지막 턴 상태를 잠시 뒤 다시 신고하고(새 seq · 더 새 턴이 오면 그만) 이후 턴 신고도 그대로 보낸다.
//
// herdr 는 같은 pane·source 에서 «직전보다 큰 seq» 만 받는다(작으면 rc0 인데 무시).
// 같은 pane 에서 TUI 를 다시 띄워도 신고가 살도록 seq 는 max(직전+1 · 시각 · 예약 high-watermark+1) 이다.
// pane 기록 = 예약한 seq 범위의 high-watermark(기본 tmpdir 파일) — 정상·비정상 재기동에서 뒤 범위를 쓴다.
// ⛔ 턴 경로는 보통 파일을 안 만진다: 범위가 소진되면 next()가 새 범위를 파일에 예약한다.
// 기록을 못 읽고 못 쓰면(관측 `seq-store-failed` 한 번) 시각·직전+1 로만 간다.
//
// 실패로 꺼지는 것은 «이후 turn» 뿐이다. release(권한 반납)는 start 실패가 «확인»됐을 때만 건너뛴다.
// start 의 비동기 신고가 아직 안 끝났으면(결과 모름) 반납을 미루지 않고 바로 동기로 시도한다(관측 `release-start-pending`) —
// 종료 경로에서 미루면 exit 뒤 반납이 영영 안 나간다. 반납 실패(rc≠0 등)는 `release-failed` 로 늘 남긴다.
// 그때 반납 직전에 더 큰 seq 로 동기 재등록한다(TUI-HERDR-EXIT-RACE) — 미등록 반납은 seq 를 안 남겨
// 늦게 닿은 비동기 등록이 유령이 되던 경합을 «동기 재등록 → 동기 반납» 순서로 닫는다.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debug } from '../debug/log.js';
import { pruneStaleHerdrAgent } from './herdr-prune-stale.js';
import { HerdrSequenceLease, type HerdrSeqStore } from './herdr-sequence-lease.js';
export type { HerdrSeqStore } from './herdr-sequence-lease.js';

/** 턴 값 — tui-run-state 의 PtyTurnState 와 같은 낱말이지만 순환 import 를 피하려 여기 둔다. */
export type HerdrTurn = 'busy' | 'idle';

export interface HerdrRunResult {
  readonly ok: boolean;
  readonly stderr?: string;
  /** 시간 안에 답을 못 받았다 — herdr 가 이미 적용했을 수도 있는 «결과 모름»(TUI-HERDR-STATUS-STALE). */
  readonly timedOut?: boolean;
}

export interface HerdrRunOpts {
  readonly sync: boolean;
  readonly timeoutMs: number;
}

export type HerdrRunner = (
  argv: string[],
  opts: HerdrRunOpts,
) => HerdrRunResult | Promise<HerdrRunResult>;

export interface HerdrAgentReporterDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: HerdrRunner;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  readonly sessionId?: string;
  /** seq 시작값의 시계(ms). 기본 Date.now. */
  readonly now?: () => number;
  /** pane 별 예약 범위 끝 기록. 기본 = tmpdir 파일(`createFileSeqStore`). */
  readonly seqStore?: HerdrSeqStore;
  /** 재신고 타이머 — 기본 setTimeout(unref). 시험이 가짜 시계를 준다. */
  readonly schedule?: (fn: () => void, ms: number) => void;
  /** Injected runners skip production startup cleanup unless explicitly enabled. */
  readonly pruneStaleOnStart?: boolean;
}

const defaultSchedule = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
};

export function defaultHerdrSeqDir(): string {
  return join(tmpdir(), 'elanous-herdr-seq');
}

/** pane 하나의 seq 기록 파일. 파일 이름은 pane id 의 안전 문자만. */
export function createFileSeqStore(paneId: string, dir: string = defaultHerdrSeqDir()): HerdrSeqStore {
  const path = join(dir, `${paneId.replace(/[^A-Za-z0-9._-]/g, '_')}.seq`);
  return {
    read() {
      let text: string;
      try { text = readFileSync(path, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
        throw error;
      }
      const n = Number(text.trim());
      return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    },
    write(seq) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, String(seq), 'utf8');
    },
  };
}

export interface HerdrAgentReporterLike {
  start(): void;
  turn(t: HerdrTurn): void;
  release(): void;
}

const ASYNC_TIMEOUT_MS = 2000;
/** turn 신고가 timeout 이면 이만큼 뒤에 마지막 상태를 다시 신고한다. */
export const HERDR_TURN_RETRY_DELAY_MS = 3000;
/** 같은 턴 상태의 재신고 상한 — 넘으면 `report-gave-up` 을 남기고 다음 턴 신고를 기다린다(신고기는 켜 둔다). */
export const HERDR_TURN_RETRY_MAX = 3;
const SYNC_TIMEOUT_MS = 300;
const STDERR_HEAD = 240;
const STDOUT_CAP = 4096;
/** herdr «Integrate your own agent» — 내장 감지가 아닌 자기 신고는 custom: 접두. */
const HERDR_SOURCE = 'custom:elanous';
const HERDR_AGENT = 'elanous';

const defaultLog = (event: string, data: Record<string, unknown>): void => {
  debug.log('pty.herdr', event, data);
};

function stderrHead(stderr: string | undefined): string {
  if (!stderr) return '';
  return stderr.length <= STDERR_HEAD ? stderr : stderr.slice(0, STDERR_HEAD);
}

/**
 * herdr pane CLI 는 실패를 stdout JSON `{"error":{"code","message"}}` 로 낸다(10-18 실측 · pane_not_found 는 rc1).
 * rc 가 0 이어도 이 봉투가 있으면 실패다(r4 리뷰 mf) — 오류 문면을 돌려준다. 봉투가 없으면 undefined.
 */
export function herdrJsonError(stdout: string | undefined): string | undefined {
  const text = stdout?.trim();
  // herdr 0.9.1 실측: 성공은 rc0 + 빈 stdout, 오류는 stdout JSON 봉투(10-18 live README).
  // 비어 있지 않은 응답은 전체가 JSON 이어야 한다 — 아니면 깨진 응답(#29077 리뷰 mf).
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.error === undefined || parsed.error === null) return undefined;
    const e = parsed.error as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : '';
    const message = typeof e.message === 'string' ? e.message : (typeof parsed.error === 'string' ? parsed.error : '');
    return [code, message].filter((s) => s.length > 0).join(': ') || 'herdr error';
  } catch {
    // JSON 이 아니다 = 잘렸거나 깨진 응답 — 봉투인지 모르니 성공으로 읽지 않는다(r8·#29077 리뷰 mf).
    return 'unparseable-json';
  }
}

/** rc·stdout·stderr 로 결과를 정한다 — JSON error 봉투·깨진 JSON·상한 넘침은 rc 와 무관하게 실패, 오류 문면은 봉투 → stderr 순. */
function judgeHerdr(code: number | null, stdout: string, stderr: string, stdoutOverflow = false): HerdrRunResult {
  // 상한을 넘었다 = 응답을 끝까지 못 봤다 — 봉투 판정을 보장할 수 없으니 «측정 불가» 로 실패(r8 리뷰 mf).
  if (stdoutOverflow) return { ok: false, stderr: 'stdout-overflow-unmeasured' };
  const jsonError = herdrJsonError(stdout);
  if (code === 0 && jsonError === undefined) return { ok: true };
  return { ok: false, stderr: jsonError ?? (stderr || (code === null ? 'killed' : `rc=${code}`)) };
}

function binOf(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HERDR_BIN_PATH?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'herdr';
}

/** 기본 러너 — 비동기 ≤2000ms, 동기(release) ≤300ms. ENOENT·timeout·rc≠0·stdout JSON error 는 ok:false(오류 문면은 stderr 칸). */
export function defaultHerdrRunner(env: NodeJS.ProcessEnv): HerdrRunner {
  const bin = binOf(env);
  return (argv, opts) => {
    const cap = opts.sync ? Math.min(opts.timeoutMs, SYNC_TIMEOUT_MS) : Math.min(opts.timeoutMs, ASYNC_TIMEOUT_MS);
    if (opts.sync) {
      try {
        const r = spawnSync(bin, argv, { timeout: cap, encoding: 'utf8', windowsHide: true });
        if (r.error) {
          const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
          return { ok: false, stderr: r.error.message, ...(timedOut ? { timedOut: true } : {}) };
        }
        const out = typeof r.stdout === 'string' ? r.stdout : '';
        const overflow = Buffer.byteLength(out, 'utf8') > STDOUT_CAP;
        return judgeHerdr(r.status, overflow ? '' : out, typeof r.stderr === 'string' ? r.stderr : '', overflow);
      } catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
      }
    }
    return new Promise<HerdrRunResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        resolve({ ok: false, stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      let stderr = '';
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutOverflow = false;
      let settled = false;
      const finish = (result: HerdrRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, stderr: stderr || 'timeout', timedOut: true });
      }, cap);
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderr.length < STDERR_HEAD) stderr += String(chunk);
      });
      // 오류 봉투는 stdout 으로 온다 — 응답은 짧다(한 줄 JSON). 폭주 방어로 4KB 까지만.
      // 상한은 «바이트» 로 잰다(UTF-8 · #29077 리뷰 mf) — 넘치면 더 모으지 않고 넘침만 적는다.
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (stdoutOverflow) return;
        if (stdoutBytes + buf.length > STDOUT_CAP) { stdoutOverflow = true; return; }
        stdoutBytes += buf.length;
        stdoutChunks.push(buf);
      });
      child.on('error', (error) => finish({ ok: false, stderr: error.message }));
      child.on('close', (code) => {
        const stdout = stdoutOverflow ? '' : Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
        finish(judgeHerdr(code, stdout, stderr, stdoutOverflow));
      });
    });
  };
}

/** 신호 지킴이가 쓰는 process 의 좁은 면 — 시험이 가짜를 준다. */
export interface HerdrSignalTarget {
  readonly pid: number;
  on(sig: NodeJS.Signals, fn: (sig: NodeJS.Signals) => void): unknown;
  removeListener(sig: NodeJS.Signals, fn: (sig: NodeJS.Signals) => void): unknown;
  listenerCount(sig: NodeJS.Signals): number;
  kill(pid: number, sig?: string | number): unknown;
}

const RELEASE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * SIGINT·SIGTERM 기본 죽음에도 반납한다(TUI-HERDR-EXIT-RACE).
 * 대시보드가 raw 모드에 들기 «전»의 ctrl+c 는 SIGINT 기본 동작으로 프로세스를 죽여(rc130) 'exit' 훅이 안 돈다 —
 * 10-22 격리 세션 실측: 반납 0 · `agent list` 에 elanous idle 이 남았다.
 * 신호가 오면 반납(동기) → 자기 리스너를 걷고, 이제 아무도 안 들으면 같은 신호를 다시 올려 기본 죽음을 지킨다.
 * 다른 리스너가 있으면 그쪽이 같은 신호를 이미 받았다 — 다시 올리지 않는다.
 * @returns 해제(정상 종료 경로에서 부른다).
 */
export function guardHerdrReleaseOnSignal(release: () => void, proc: HerdrSignalTarget = process): () => void {
  let off = false;
  const remove = (): void => {
    if (off) return;
    off = true;
    for (const sig of RELEASE_SIGNALS) { try { proc.removeListener(sig, onSignal); } catch { /* 종료 경로를 깨지 않는다 */ } }
  };
  function onSignal(sig: NodeJS.Signals): void {
    try { release(); } catch { /* 신호 경로를 깨지 않는다 */ }
    remove();
    let alone = true;
    try { alone = proc.listenerCount(sig) === 0; } catch { alone = true; }
    if (alone) { try { proc.kill(proc.pid, sig); } catch { /* 이미 끝나는 중 */ } }
  }
  for (const sig of RELEASE_SIGNALS) proc.on(sig, onSignal);
  return remove;
}

/**
 * herdr pane 안에서만 신고기. 비활성이면 null (skipped 로그 한 번).
 * 반환 메서드는 실패해도 던지지 않는다.
 */
export function createHerdrAgentReporter(deps: HerdrAgentReporterDeps = {}): HerdrAgentReporterLike | null {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  if (env.ELANOUS_HERDR_REPORT === '0') {
    log('skipped', { reason: 'kill-switch' });
    return null;
  }
  const paneId = env.HERDR_PANE_ID?.trim() ?? '';
  if (env.HERDR_ENV !== '1' || paneId.length === 0) {
    log('skipped', { reason: 'no-herdr-env' });
    return null;
  }
  const run = deps.run ?? defaultHerdrRunner(env);
  const sessionId = deps.sessionId ?? '';
  return new Reporter(
    paneId, sessionId, run, log, deps.now ?? Date.now,
    deps.seqStore ?? createFileSeqStore(paneId), deps.schedule ?? defaultSchedule,
    deps.pruneStaleOnStart ?? deps.run === undefined,
  );
}

type IssueResult = boolean | Promise<boolean>;

class Reporter implements HerdrAgentReporterLike {
  private readonly sequence: HerdrSequenceLease;
  private disabled = false;
  /**
   * idle 신고(에이전트 등록)의 상태: none → (pending →) ok | failed.
   * release 는 failed(등록 실패 확인)·none 이 아니면 보낸다 — session 신고 실패는 등록을 되돌리지 않으므로 반납한다.
   */
  private startState: 'none' | 'pending' | 'ok' | 'failed' = 'none';
  private released = false;
  /** idle 신고(비동기 포함)가 실패했다 — 등록된 적이 없으니 반납할 것이 없다. */
  private idleFailed = false;
  private seqStoreFailed = false;
  /**
   * 아직 안 끝난 비동기 신고 — 있으면 다음 비동기 신고는 그 뒤에 줄을 선다(r5 리뷰 mf).
   * herdr 는 «직전보다 큰 seq» 만 받으므로, 큰 seq(session·turn)가 작은 seq(idle 등록)보다 먼저 도착하면
   * 늦은 등록이 무시돼 상태가 어긋났다. seq 는 넣는 순간 정해지고 줄이 그 순서대로 보낸다.
   * 앞 신고가 없으면 예전처럼 바로 보낸다(동기 러너 결과는 동기로 판정).
   * 동기 release(종료 경로)만 줄을 기다리지 않는다 — 가장 큰 seq 라 늦게 도착한 앞 신고는 herdr 가 버린다.
   */
  private pending: Promise<unknown> | null = null;
  /** 등록 결과를 모르는 채 반납했다 — 등록이 뒤늦게 성공하면 한 번 더 반납한다. */
  private releasedWhilePending = false;

  constructor(
    private readonly paneId: string,
    private readonly sessionId: string,
    private readonly run: HerdrRunner,
    private readonly log: (event: string, data: Record<string, unknown>) => void,
    private readonly now: () => number,
    seqStore: HerdrSeqStore,
    private readonly schedule: (fn: () => void, ms: number) => void,
    private readonly pruneStaleOnStart: boolean,
  ) {
    this.sequence = new HerdrSequenceLease(seqStore, now, (error) => this.seqStoreFail(error));
  }

  /** 마지막으로 요청된 턴 상태와 그 세대 — 재신고는 세대가 그대로일 때만(더 새 턴이 오면 그만). */
  private lastTurn: HerdrTurn | null = null;
  private turnGen = 0;
  private turnRetries = 0;

  start(): void {
    if (this.startState !== 'none') return;
    if (this.pruneStaleOnStart) {
      const pruneSeq = this.nextSeq();
      try {
        const pruned = pruneStaleHerdrAgent(this.paneId, pruneSeq, this.run);
        this.log(pruned.ok ? 'startup-prune-complete' : 'startup-prune-failed', {
          seq: pruneSeq, ...(pruned.stderr ? { stderrHead: stderrHead(pruned.stderr) } : {}),
        });
      } catch (error) {
        this.log('startup-prune-failed', { seq: pruneSeq, stderrHead: stderrHead(error instanceof Error ? error.message : String(error)) });
      }
    }
    const idleOk = this.issue([
      'pane', 'report-agent',
      '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
      '--state', 'idle',
      '--agent-session-id', this.sessionId,
      '--seq', this.nextSeq(),
      this.paneId,
    ], false, 'start');
    if (idleOk === false) { this.startState = 'failed'; return; }
    if (idleOk === true) this.startState = 'ok';
    else {
      // 비동기 — 결과가 나기 전의 release 는 «모름»으로 보고 바로 시도한다.
      this.startState = 'pending';
      void idleOk.then((ok) => this.settleStart(ok), () => this.settleStart(false));
    }
    if (this.disabled) return;
    // session 신고 실패는 이후 turn 만 끈다(신고기 off) — 등록은 idle 로 이미 됐으니 release 는 그대로 보낸다.
    this.issue([
      'pane', 'report-agent-session',
      '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
      '--agent-session-id', this.sessionId,
      '--session-start-source', 'startup',
      '--seq', this.nextSeq(),
      this.paneId,
    ], false, 'session');
  }

  private settleStart(ok: boolean): void {
    if (this.startState !== 'pending') return;
    this.startState = ok && !this.idleFailed ? 'ok' : 'failed';
    // 결과를 모르는 채 반납했는데 등록이 뒤늦게 성공했다 — 반납이 등록보다 먼저 처리됐을 수 있으니
    //   프로세스가 아직 살아 있으면 한 번 더 반납한다(r6 리뷰 완화 · 즉시 종료 경합은 ASK-HERDR-RELEASE-START-RACE).
    if (this.startState === 'ok' && this.releasedWhilePending) this.resendRelease();
  }

  /** 늦은 등록 뒤 재반납 — 비동기·최선 노력 · 한 번만. */
  private resendRelease(): void {
    this.releasedWhilePending = false;
    this.log('release-resend-after-late-start', {});
    const seq = this.nextSeq();
    void this.runAndJudge([
      'pane', 'release-agent',
      this.paneId,
      '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
      '--seq', String(seq),
    ], { sync: false, timeoutMs: ASYNC_TIMEOUT_MS }, 'release');
  }

  turn(t: HerdrTurn): void {
    // 반납 뒤 신고는 반납한 에이전트를 더 큰 seq 로 다시 등록한다 — 막는다.
    if (this.disabled || this.released) return;
    this.lastTurn = t;
    this.turnGen += 1;
    this.turnRetries = 0;
    this.issueTurn(t);
  }

  private issueTurn(t: HerdrTurn): void {
    const state = t === 'busy' ? 'working' : 'idle';
    this.issue([
      'pane', 'report-agent',
      '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
      '--state', state,
      '--seq', this.nextSeq(),
      this.paneId,
    ], false, 'turn');
  }

  release(): void {
    if (this.released) return;
    // idle 등록 실패가 확인됐거나 start 전이면 건너뛴다. pending = 결과 모름 → 반납을 시도한다.
    if (this.startState === 'none' || this.startState === 'failed' || this.idleFailed) return;
    this.released = true;
    if (this.startState === 'pending') {
      this.log('release-start-pending', {});
      this.releasedWhilePending = true;
      // 즉시 종료 경합(TUI-HERDR-EXIT-RACE): 비동기 idle 등록은 herdr 자식 프로세스라 부모가 죽어도 간다.
      //   herdr 0.9.1 실측 — 미등록 에이전트 반납은 rc0 인데 seq 를 안 남긴다 ⇒ 반납 «뒤에» 닿은 작은 seq 등록이
      //   유령으로 남는다(10-22 격리 세션 tf-exit-race). 기다릴 수 없으니(동기 ≤300ms) 순서를 동기로 고정한다:
      //   더 큰 seq 로 동기 재등록 → 동기 반납. 반납이 «등록된» 에이전트를 지우며 seq 를 남기므로
      //   늦게 닿는 앞 등록(작은 seq)은 herdr 가 버린다. 재등록 실패여도 반납은 그대로 시도한다(결과 모름).
      this.issue([
        'pane', 'report-agent',
        '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
        '--state', 'idle',
        '--agent-session-id', this.sessionId,
        '--seq', this.nextSeq(),
        this.paneId,
      ], true, 'release');
    }
    const seq = this.nextSeq();
    // ⛔ herdr 0.9.1 `release-agent` 는 PANE_ID 를 옵션 «앞»에 둬야 받는다 — 뒤에 두면
    //   «unknown option: custom:elanous» rc2 로 반납이 영영 안 됐다(10-18 라이브 실측 · report-agent 는 뒤도 받음).
    this.issue([
      'pane', 'release-agent',
      this.paneId,
      '--source', HERDR_SOURCE, '--agent', HERDR_AGENT,
      '--seq', seq,
    ], true, 'release');
  }

  /**
   * turn 신고 timeout — 신고기를 끄지 않고 마지막 턴 상태를 잠시 뒤 다시 신고한다(TUI-HERDR-STATUS-STALE).
   * herdr 가 그 신고를 이미 적용했어도(답만 늦었다) 다시 보내는 것은 무해하다 — 더 큰 seq 의 같은 상태다.
   */
  private retryTurnAfterTimeout(argv: string[], stderr: string | undefined): void {
    const gen = this.turnGen;
    const state = this.lastTurn;
    const attempt = this.turnRetries + 1;
    if (state === null) return;
    if (attempt > HERDR_TURN_RETRY_MAX) {
      this.log('report-gave-up', { cmd: argv[1] ?? '', state: state === 'busy' ? 'working' : 'idle', attempts: HERDR_TURN_RETRY_MAX, stderrHead: stderrHead(stderr) });
      return;
    }
    this.turnRetries = attempt;
    this.log('report-timeout-retry', { cmd: argv[1] ?? '', state: state === 'busy' ? 'working' : 'idle', attempt, delayMs: HERDR_TURN_RETRY_DELAY_MS, stderrHead: stderrHead(stderr) });
    this.schedule(() => {
      if (this.disabled || this.released || this.turnGen !== gen) return;
      this.issueTurn(state);
    }, HERDR_TURN_RETRY_DELAY_MS);
  }

  private seqStoreFail(error: unknown): void {
    if (this.seqStoreFailed) return;
    this.seqStoreFailed = true;
    this.log('seq-store-failed', { error: error instanceof Error ? error.message : String(error) });
  }

  /** Reserved sequence lease advances monotonically across same-millisecond restarts. */
  private nextSeq(): string {
    return String(this.sequence.next());
  }

  /**
   * release 는 꺼진 뒤에도 보낸다(권한 반납 · start 성공 조건은 release() 가 본다).
   * @returns false = 동기 실패(신고기 꺼짐) · true = 동기 성공 · Promise = 비동기 결과(성공이면 true).
   */
  private issue(argv: string[], sync: boolean, phase: 'start' | 'session' | 'turn' | 'release' | 'stale-cleanup'): IssueResult {
    if (this.disabled && phase !== 'release') return false;
    const opts: HerdrRunOpts = { sync, timeoutMs: sync ? SYNC_TIMEOUT_MS : ASYNC_TIMEOUT_MS };
    if (!sync && this.pending) {
      // 앞 신고 뒤에 줄 선다 — 반납 뒤에 차례가 온 신고는 보내지 않는다(반납한 에이전트를 되살리지 않게).
      const queued = this.pending.then(() => {
        if (this.released || this.disabled) return false;
        return this.runAndJudge(argv, opts, phase);
      });
      this.track(queued);
      return queued;
    }
    let result: HerdrRunResult | Promise<HerdrRunResult>;
    try {
      result = this.run(argv, opts);
    } catch (error) {
      this.fail(argv, phase, error instanceof Error ? error.message : String(error));
      return false;
    }
    if (result && typeof (result as Promise<HerdrRunResult>).then === 'function') {
      const judged = (result as Promise<HerdrRunResult>).then(
        (r) => {
          if (r.ok) return true;
          this.fail(argv, phase, r.stderr, r.timedOut === true);
          return false;
        },
        (error: unknown) => {
          this.fail(argv, phase, error instanceof Error ? error.message : String(error));
          return false;
        },
      );
      if (!sync) this.track(judged);
      return judged;
    }
    const syncResult = result as HerdrRunResult;
    if (!syncResult.ok) {
      this.fail(argv, phase, syncResult.stderr, syncResult.timedOut === true);
      return false;
    }
    return true;
  }

  /** 줄 끝을 이 신고로 옮긴다 — 끝나면(마지막이었다면) 줄을 비운다. */
  private track(p: Promise<unknown>): void {
    const tail = p.catch(() => undefined);
    this.pending = tail;
    void tail.then(() => { if (this.pending === tail) this.pending = null; });
  }

  /** 줄 선 비동기 한 건 — 러너 결과(동기·비동기 모두)를 성패로 접는다. */
  private async runAndJudge(argv: string[], opts: HerdrRunOpts, phase: 'start' | 'session' | 'turn' | 'release' | 'stale-cleanup'): Promise<boolean> {
    try {
      const r = await this.run(argv, opts);
      if (r.ok) return true;
      this.fail(argv, phase, r.stderr, r.timedOut === true);
      return false;
    } catch (error) {
      this.fail(argv, phase, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private fail(argv: string[], phase: 'start' | 'session' | 'turn' | 'release' | 'stale-cleanup', stderr: string | undefined, timedOut = false): void {
    if (phase === 'turn' && timedOut && !this.disabled) {
      this.retryTurnAfterTimeout(argv, stderr);
      return;
    }
    if (phase === 'start') this.idleFailed = true;
    // 반납 실패는 신고기가 이미 꺼졌어도 늘 남긴다(종료 경로의 유일한 흔적).
    if (phase === 'release') {
      this.log('release-failed', { stderrHead: stderrHead(stderr) });
      return;
    }
    if (phase === 'stale-cleanup') {
      this.log('stale-agent-cleanup-failed', { stderrHead: stderrHead(stderr) });
      return;
    }
    if (this.disabled) return;
    this.disabled = true;
    const cmd = argv[1] ?? '';
    this.log('report-failed', { cmd, stderrHead: stderrHead(stderr) });
  }
}
