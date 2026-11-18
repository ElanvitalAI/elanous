// eln TUI → herdr 소켓 상태 권위 (ELN-HERDR-AGENT-STATE).
//
// herdr pane CLI(`pane report-agent`)는 전경 프로세스 감지를 못 덮어
// `agent_status: unknown` 으로 남긴다. 통합 훅과 같은 길 — HERDR_SOCKET_PATH 에
// newline JSON `{id, method, params}` — 으로 `pane.report_agent` /
// `pane.report_metadata` / `pane.release_agent` 를 보낸다.
//
// herdr 계약(src/api/schema/panes.rs): PaneReportAgentParams 에는 메타 칸이 없다 — 제목·배지·토큰은
// 반드시 별도 `pane.report_metadata`. 상태(hook)와 메타의 seq 표는 source 마다 따로 있어 서로를 버리지 않는다.
// 보내기 주인은 하나(SocketReporter 의 펌프): 한 번에 한 프레임 · 응답을 받은 뒤 다음 프레임 —
// report_agent 가 받아진 뒤에만 report_metadata. seq 는 보내는 순간 lease 에서 받아 보낸 순서대로 단조.
// 실패하면 «herdr 가 받은 상태»(confirmed)를 그대로 두고 다시 시도해 같은 상태 억제가 복구를 막지 않는다.
// 메타 TTL 은 활성 동안 refreshMs 마다 다시 보내 working·idle 이 길어도 배지가 만료되지 않는다.
//
// 활성은 HERDR_ENV=1 ⊕ HERDR_PANE_ID ⊕ HERDR_SOCKET_PATH 일 때만.
// 소켓 없음·쓰기 실패·응답 오류는 던지지 않고 debug 한 줄. herdr 밖에서는 연결 0.
//
// herdr 는 같은 pane·source 에서 «직전보다 큰 seq» 만 받는다(작으면 rc0 인데 버림).
// seq 는 CLI 신고기와 같은 HerdrSequenceLease — max(직전+1 · 시각 · 예약 high-watermark+1).
// 프로세스마다 1부터 다시 세면 같은 pane 재기동(H9 포함) 뒤 보고가 전부 버려진다.

import { spawnSync } from 'node:child_process';
import { connect, type Socket } from 'node:net';

import { debug } from '../debug/log.js';
import { createFileSeqStore, type HerdrSeqStore, type HerdrSignalTarget } from './herdr-agent-report.js';
import { HerdrSequenceLease } from './herdr-sequence-lease.js';

export type HerdrSocketState = 'idle' | 'working' | 'blocked';

export interface HerdrSocketMetadata {
  readonly displayAgent?: string;
  readonly title?: string;
  readonly tokens?: Readonly<Record<string, string>>;
  readonly stateLabels?: Readonly<Record<string, string>>;
  /** 낡은 배지 자동 소멸. 스키마 상한 86_400_000. */
  readonly ttlMs?: number;
}

/** true = herdr 가 이 프레임을 받았다(`result`). false·reject·throw = 못 받음 → 재시도. */
export interface HerdrSocketSend {
  (frame: HerdrSocketFrame): boolean | Promise<boolean>;
}

export interface HerdrSocketFrame {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 한 번 부르는 타이머. 돌려준 함수로 취소. 기본은 unref 된 setTimeout. */
export type HerdrSocketSchedule = (fn: () => void, ms: number) => () => void;

export interface HerdrSocketReporterDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** 시험이 유닉스 소켓 대신 프레임을 받는다. 없으면 HERDR_SOCKET_PATH 로 연결. */
  readonly send?: HerdrSocketSend;
  /** releaseNow 의 동기 전송. 없으면 자식 프로세스로 HERDR_SOCKET_PATH 에 보내고 응답을 기다린다. */
  readonly sendSync?: (frame: HerdrSocketFrame) => boolean;
  /** pane 별 seq high-watermark. 없으면 CLI 신고기와 같은 파일 저장소. */
  readonly seqStore?: HerdrSeqStore;
  readonly now?: () => number;
  readonly cwd?: string;
  /**
   * 지금 선택된 모델. 메타를 보낼 때마다 다시 읽는다(세션 중 /model 전환 반영).
   * 없거나 빈 값이면 display_agent·model 토큰을 만들지 않는다(«eln·eln» 금지 · herdr unknown 보존).
   */
  readonly model?: string | (() => string | undefined);
  /** 큐 깊이·경과 등 토큰. 구조 값만 — 화면 문장 판정 0. */
  readonly tokens?: () => Readonly<Record<string, string>>;
  readonly connectTimeoutMs?: number;
  /** 메타 TTL 갱신 주기. 기본 ttl 의 절반. */
  readonly refreshMs?: number;
  /** 실패 뒤 첫 재시도 간격(배로 늘어 refreshMs 에서 멈춤). */
  readonly retryMs?: number;
  readonly schedule?: HerdrSocketSchedule;
}

export interface HerdrSocketReporter {
  /** 턴 시작 working · 승인/질문 대기 blocked · 턴 끝 idle. herdr 가 이미 받은 같은 상태는 다시 안 보낸다. */
  state(next: HerdrSocketState, message?: string): void;
  /** 제목·배지·토큰 패치. 다음 전송 순서에 실린다. */
  metadata(meta?: HerdrSocketMetadata): void;
  /** 종료 때 권위 반납. 한 번만 · 남은 상태/메타는 버리고 진행 중 프레임 뒤에 보낸다. */
  release(): void;
  /**
   * 'exit' 훅용 동기 반납 — 그 안에서는 이벤트 루프가 돌지 않아 release() 의 비동기 프레임이 나가지 않는다.
   * 이미 반납을 청했으면(신호 지킴이가 응답까지 기다림) 아무것도 안 한다.
   */
  releaseNow(): void;
  /** 지금 줄 선 전송이 다 끝나면 풀린다(시험·종료 대기). */
  settled(): Promise<void>;
}

const SOURCE = 'elanous';
const AGENT = 'elanous';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CONNECT_MS = 300;
const DEFAULT_RETRY_MS = 1_000;

const defaultLog = (event: string, data: Record<string, unknown>): void => {
  debug.log('pty.herdr-socket', event, data);
};

const defaultSchedule: HerdrSocketSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export function herdrSocketActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === '1'
    && (env.HERDR_PANE_ID?.trim().length ?? 0) > 0
    && (env.HERDR_SOCKET_PATH?.trim().length ?? 0) > 0;
}

/** cwd `…/seats/<SEAT>/…` 에서 자리 이름. 없으면 마지막 경로 조각. */
export function seatTitleFromCwd(cwd: string): string {
  const parts = cwd.split(/[/\\]/u).filter((p) => p.length > 0);
  const seats = parts.lastIndexOf('seats');
  if (seats >= 0 && parts[seats + 1]) return parts[seats + 1]!;
  return parts.at(-1) ?? 'eln';
}

export function createHerdrSocketReporter(deps: HerdrSocketReporterDeps = {}): HerdrSocketReporter | null {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  if (!herdrSocketActive(env)) {
    log('skipped', { reason: 'no-herdr-socket' });
    return null;
  }
  const paneId = env.HERDR_PANE_ID!.trim();
  const socketPath = env.HERDR_SOCKET_PATH!.trim();
  const modelDep = deps.model;
  const model = typeof modelDep === 'function' ? modelDep : () => modelDep;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const seqStore = deps.seqStore ?? createFileSeqStore(paneId);
  const refreshMs = Math.max(1, Math.floor(deps.refreshMs ?? DEFAULT_TTL_MS / 2));
  return new SocketReporter({
    paneId,
    socketPath,
    model,
    title: seatTitleFromCwd(cwd),
    log,
    send: deps.send,
    sendSync: deps.sendSync ?? ((frame) => writeHerdrSocketSync(socketPath, frame, log)),
    now,
    sequence: new HerdrSequenceLease(seqStore, now, (error) => {
      log('seq-store-failed', { error: error instanceof Error ? error.message : String(error) });
    }),
    tokens: deps.tokens,
    connectTimeoutMs: deps.connectTimeoutMs ?? DEFAULT_CONNECT_MS,
    refreshMs,
    retryMs: Math.min(refreshMs, Math.max(1, Math.floor(deps.retryMs ?? DEFAULT_RETRY_MS))),
    schedule: deps.schedule ?? defaultSchedule,
  });
}

interface DesiredState {
  readonly state: HerdrSocketState;
  readonly message?: string;
}

class SocketReporter implements HerdrSocketReporter {
  private id = 0;
  /** 호출자가 원하는 마지막 상태. 펌프만 confirmed 로 옮긴다. */
  private desired: DesiredState | null = null;
  /** herdr 가 `result` 로 받은 마지막 상태. 실패면 안 바뀐다. */
  private confirmed: DesiredState | null = null;
  /** 보낼 메타 패치(명시 metadata 호출 · 상태 수락 뒤 · TTL 갱신). 성공해야 비운다. */
  private pendingMeta: HerdrSocketMetadata | null = null;
  private releaseRequested = false;
  private released = false;
  /** 직전 전송이 실패해 재시도 타이머를 기다리는 중. 새 입력이 오면 바로 다시 보낸다. */
  private backingOff = false;
  private pumping: Promise<void> | null = null;
  private retryDelay: number;
  private cancelTimer: (() => void) | null = null;
  private readonly startedAt: number;

  constructor(private readonly opts: {
    readonly paneId: string;
    readonly socketPath: string;
    readonly model: () => string | undefined;
    readonly title: string;
    readonly log: (event: string, data: Record<string, unknown>) => void;
    readonly send?: HerdrSocketSend;
    readonly sendSync: (frame: HerdrSocketFrame) => boolean;
    readonly sequence: HerdrSequenceLease;
    readonly now: () => number;
    readonly tokens?: () => Readonly<Record<string, string>>;
    readonly connectTimeoutMs: number;
    readonly refreshMs: number;
    readonly retryMs: number;
    readonly schedule: HerdrSocketSchedule;
  }) {
    this.startedAt = opts.now();
    this.retryDelay = opts.retryMs;
  }

  state(next: HerdrSocketState, message?: string): void {
    if (this.releaseRequested) return;
    if (this.desired?.state === next && this.desired.message === message) return;
    this.desired = { state: next, ...(message ? { message } : {}) };
    this.wake();
  }

  metadata(meta: HerdrSocketMetadata = {}): void {
    if (this.releaseRequested) return;
    this.pendingMeta = { ...(this.pendingMeta ?? {}), ...meta };
    this.wake();
  }

  release(): void {
    if (this.releaseRequested) return;
    this.releaseRequested = true;
    this.desired = null;
    this.pendingMeta = null;
    this.clearTimer();
    this.kick();
  }

  releaseNow(): void {
    if (this.releaseRequested) return;
    this.releaseRequested = true;
    this.released = true;
    this.desired = null;
    this.pendingMeta = null;
    this.clearTimer();
    const frame: HerdrSocketFrame = {
      id: this.nextId(),
      method: 'pane.release_agent',
      params: { pane_id: this.opts.paneId, source: SOURCE, agent: AGENT, seq: this.nextSeq() },
    };
    try {
      if (!this.opts.sendSync(frame)) this.opts.log('release-sync-failed', {});
    } catch (error) {
      this.opts.log('release-sync-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async settled(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  private wake(): void {
    this.backingOff = false;
    this.clearTimer();
    this.kick();
  }

  /** 펌프는 하나만 돈다. 도는 중이면 루프가 새 desired·pendingMeta 를 다음 차례에 집는다. */
  private kick(): void {
    if (this.pumping || this.released) return;
    const run = this.pump().catch((error: unknown) => {
      this.opts.log('pump-failed', { error: error instanceof Error ? error.message : String(error) });
      this.backingOff = true;
    }).finally(() => {
      this.pumping = null;
      if (this.released) return;
      if (this.backingOff) this.armRetry();
      else if (this.releaseRequested || this.stateDue() || this.pendingMeta) this.kick();
      else this.armRefresh();
    });
    this.pumping = run;
  }

  private stateDue(): boolean {
    const want = this.desired;
    if (!want) return false;
    return want.state !== this.confirmed?.state || want.message !== this.confirmed?.message;
  }

  /** 한 번에 한 프레임 · 응답 뒤 다음. 실패하면 confirmed·pendingMeta 를 그대로 두고 backingOff. */
  private async pump(): Promise<void> {
    await Promise.resolve();
    while (!this.released) {
      if (this.releaseRequested) {
        this.released = true;
        await this.emit({
          id: this.nextId(),
          method: 'pane.release_agent',
          params: { pane_id: this.opts.paneId, source: SOURCE, agent: AGENT, seq: this.nextSeq() },
        });
        return;
      }
      if (this.stateDue()) {
        const want = this.desired!;
        const ok = await this.emit({
          id: this.nextId(),
          method: 'pane.report_agent',
          params: {
            pane_id: this.opts.paneId,
            source: SOURCE,
            agent: AGENT,
            state: want.state,
            seq: this.nextSeq(),
            ...(want.message ? { message: want.message } : {}),
          },
        });
        if (this.releaseRequested) continue;
        if (!ok) { this.backingOff = true; return; }
        this.confirmed = want;
        this.retryDelay = this.opts.retryMs;
        // 수락된 상태 뒤의 메타 — 배지·제목·경과를 그 상태와 맞춘다.
        this.pendingMeta = this.pendingMeta ?? {};
        continue;
      }
      if (this.pendingMeta) {
        const meta = this.pendingMeta;
        const ok = await this.emit({
          id: this.nextId(),
          method: 'pane.report_metadata',
          params: {
            pane_id: this.opts.paneId,
            source: SOURCE,
            agent: AGENT,
            ...this.metadataParams(meta),
            seq: this.nextSeq(),
          },
        });
        if (this.releaseRequested) continue;
        if (!ok) { this.backingOff = true; return; }
        this.retryDelay = this.opts.retryMs;
        // 보내는 동안 새 패치가 왔으면 남긴다.
        if (this.pendingMeta === meta) this.pendingMeta = null;
        continue;
      }
      return;
    }
  }

  /** 활성 동안 TTL 이 지나기 전에 메타를 다시 보낸다(working·idle 이 길어도 배지 유지). */
  private armRefresh(): void {
    this.arm(this.opts.refreshMs, () => {
      this.pendingMeta = this.pendingMeta ?? {};
    });
  }

  /** 실패 뒤 현재 상태(또는 못 보낸 메타)를 다시 보낸다. 간격은 배로 늘어 refreshMs 에서 멈춘다. */
  private armRetry(): void {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.opts.refreshMs, this.retryDelay * 2);
    this.opts.log('retry-scheduled', { delayMs: delay });
    this.arm(delay, () => {
      this.backingOff = false;
    });
  }

  private arm(ms: number, onFire: () => void): void {
    this.clearTimer();
    if (this.releaseRequested) return;
    let cancel: (() => void) | null = null;
    cancel = this.opts.schedule(() => {
      if (this.cancelTimer !== cancel) return;
      this.cancelTimer = null;
      if (this.releaseRequested) return;
      onFire();
      this.kick();
    }, ms);
    this.cancelTimer = cancel;
  }

  private clearTimer(): void {
    const cancel = this.cancelTimer;
    this.cancelTimer = null;
    if (cancel) { try { cancel(); } catch { /* 타이머 취소 실패가 보고를 막지 않는다 */ } }
  }

  /** 모델이 없으면 display_agent 를 빼 unknown 을 보존한다. 빈 모델로 «eln·eln» 을 만들지 않는다. */
  private metadataParams(meta: HerdrSocketMetadata = {}): Record<string, unknown> {
    const elapsed = Math.max(0, this.opts.now() - this.startedAt);
    let model = '';
    try { model = (this.opts.model() ?? '').trim(); } catch { model = ''; }
    let extra: Readonly<Record<string, string>> = {};
    try { extra = this.opts.tokens?.() ?? {}; } catch { extra = {}; }
    const tokens: Record<string, string> = {
      ...(model ? { model } : {}),
      elapsed: formatElapsed(elapsed),
      ...extra,
      ...(meta.tokens ?? {}),
    };
    const display = meta.displayAgent ?? (model ? `eln·${model}` : undefined);
    return {
      ...(display ? { display_agent: display } : {}),
      title: meta.title ?? this.opts.title,
      tokens: boundTokens(tokens),
      ...(meta.stateLabels ? { state_labels: { ...meta.stateLabels } } : {}),
      ttl_ms: clampTtl(meta.ttlMs ?? DEFAULT_TTL_MS),
    };
  }

  private nextSeq(): number {
    return this.opts.sequence.next();
  }

  private nextId(): string {
    this.id += 1;
    return `eln-${this.id}`;
  }

  private async emit(frame: HerdrSocketFrame): Promise<boolean> {
    try {
      if (this.opts.send) return (await this.opts.send(frame)) === true;
      return await writeHerdrSocket(this.opts.socketPath, frame, this.opts.connectTimeoutMs, (event, data) => {
        this.opts.log(event, data);
      });
    } catch (error) {
      this.opts.log('send-failed', { method: frame.method, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}

const RELEASE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const DEFAULT_SIGNAL_RELEASE_WAIT_MS = 500;
const SYNC_RELEASE_WAIT_MS = 1_000;

/**
 * SIGINT·SIGTERM 기본 죽음에도 소켓 권위를 반납한다. `release_agent` 는 비동기 프레임이라
 * 반납을 청한 뒤 응답(상한 waitMs)을 기다리고, 그 동안은 자기 리스너를 남겨 다른 지킴이가 먼저 죽이지 않게 한다.
 * 다 끝나면 자기 리스너를 걷고, 아무도 안 들으면 같은 신호를 다시 올려 기본 죽음을 지킨다. 두 번째 신호는 기다리지 않는다.
 */
export function guardHerdrSocketReleaseOnSignal(
  reporter: Pick<HerdrSocketReporter, 'release' | 'settled'>,
  proc: HerdrSignalTarget = process,
  waitMs: number = DEFAULT_SIGNAL_RELEASE_WAIT_MS,
): () => void {
  let off = false;
  let releasing = false;
  const remove = (): void => {
    if (off) return;
    off = true;
    for (const sig of RELEASE_SIGNALS) { try { proc.removeListener(sig, onSignal); } catch { /* 종료 경로를 깨지 않는다 */ } }
  };
  const die = (sig: NodeJS.Signals): void => {
    remove();
    let alone = true;
    try { alone = proc.listenerCount(sig) === 0; } catch { alone = true; }
    if (alone) { try { proc.kill(proc.pid, sig); } catch { /* 이미 끝나는 중 */ } }
  };
  function onSignal(sig: NodeJS.Signals): void {
    if (releasing) { die(sig); return; }
    releasing = true;
    try { reporter.release(); } catch { /* 신호 경로를 깨지 않는다 */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
    let settled: Promise<void>;
    try { settled = reporter.settled(); } catch { settled = Promise.resolve(); }
    void Promise.race([settled.catch(() => {}), capped]).then(() => {
      if (timer) clearTimeout(timer);
      die(sig);
    });
  }
  for (const sig of RELEASE_SIGNALS) proc.on(sig, onSignal);
  return remove;
}

function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_MS;
  return Math.min(86_400_000, Math.max(1, Math.floor(ttl)));
}

function boundTokens(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (Object.keys(out).length >= 16) break;
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(key)) continue;
    out[key] = value.length > 64 ? value.slice(0, 64) : value;
  }
  return out;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * 한 프레임을 newline JSON 으로 보내고 응답 한 줄을 읽는다. throw 0 · 실패는 log 한 줄.
 * true = `result` 응답. 연결·쓰기·타임아웃·error 응답·해석 불가는 false.
 * 연결은 요청마다 열고 닫는다 — 순서는 호출자(펌프)가 응답을 기다려 지킨다.
 */
export function writeHerdrSocket(
  socketPath: string,
  frame: HerdrSocketFrame,
  timeoutMs: number,
  log: (event: string, data: Record<string, unknown>) => void = defaultLog,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      log('connect-failed', { method: frame.method, error: error instanceof Error ? error.message : String(error) });
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (event: string | null, data: Record<string, unknown> = {}): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (event) log(event, { method: frame.method, ...data });
      resolve(event === null);
    };
    const timer = setTimeout(() => finish('timeout', {}), timeoutMs);
    socket.once('error', (error) => finish('connect-failed', { error: error.message }));
    socket.once('close', () => finish('closed-before-response', {}));
    socket.once('connect', () => {
      let buf = '';
      socket.on('data', (chunk: Buffer | string) => {
        buf += String(chunk);
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        try {
          const parsed = JSON.parse(line) as { result?: unknown; error?: { code?: string; message?: string } };
          if (parsed.error) finish('response-error', { code: parsed.error.code ?? '', message: parsed.error.message ?? '' });
          else if (parsed.result === undefined) finish('response-error', { message: 'no-result' });
          else finish(null);
        } catch {
          finish('response-error', { message: 'unparseable' });
        }
      });
      try {
        socket.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        finish('send-failed', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}


const SYNC_CLIENT = [
  "const s=require('node:net').connect(process.env.ELN_HERDR_SOCK);let b='';",
  "s.on('connect',()=>s.write(process.env.ELN_HERDR_FRAME+'\\n'));",
  "s.on('data',d=>{b+=d;const n=b.indexOf('\\n');if(n<0)return;",
  "let r={};try{r=JSON.parse(b.slice(0,n))}catch{}process.exit(r.result!==undefined&&!r.error?0:2)});",
  "s.on('error',()=>process.exit(3));s.on('close',()=>process.exit(4));",
].join('');

/** writeHerdrSocket 의 동기판 — 자식 프로세스가 보내고 응답을 받을 때까지(상한 timeoutMs) 막는다. */
export function writeHerdrSocketSync(
  socketPath: string,
  frame: HerdrSocketFrame,
  log: (event: string, data: Record<string, unknown>) => void = defaultLog,
  timeoutMs: number = SYNC_RELEASE_WAIT_MS,
): boolean {
  try {
    const out = spawnSync(process.execPath, ['-e', SYNC_CLIENT], {
      env: { ...process.env, BUN_BE_BUN: '1', ELN_HERDR_SOCK: socketPath, ELN_HERDR_FRAME: JSON.stringify(frame) },
      stdio: 'ignore',
      timeout: timeoutMs,
    });
    if (out.status === 0) return true;
    log('send-sync-failed', { method: frame.method, status: out.status ?? -1, signal: out.signal ?? '' });
  } catch (error) {
    log('send-sync-failed', { method: frame.method, error: error instanceof Error ? error.message : String(error) });
  }
  return false;
}
