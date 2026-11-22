// els holder — D1a(ELS-SERVER-RESTART-SURVIVE): pane PTY 의 소유권을 els 서버 밖의 holder 프로세스로 옮긴다.
// dtach 꼴: pane 당 하나의 holder 가 PTY 를 쥐고(소켓 0700), 서버와 attach 클라이언트는 소켓 라인 JSON 으로
// 입출력·resize·화면 snapshot 을 주고받는다. 서버가 죽거나 재기동해도 holder 와 자식은 살아 있고, 다음 서버가
// meta 원장(0600)과 소켓으로 재결속한다. 자식은 명시적 kill op(«els kill/close»)이나 holder 종료로만 죽는다.
// 출처: seat-state/OP/orders/ELS-DEFECT-BOARD-1120.md D1a · OP 재배정 msg:105811 · 결함판 40행.

import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onPtyEvent, startPty, unregisterPty } from '../pty-shell/registry.js';
import type { ElsPty } from './core.js';
import { peerPid, processIdentity, processStartStamp } from './peer-seat.js';
import { createLineDecoder } from './wire.js';
import { loginEnvForSpawn } from './login-env-handoff.js';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { osc7CwdParser } from './osc7-cwd.js';

// 출처: sockaddr_un.sun_path 상한 — src/els/server.ts MAX_SOCKET_PATH_BYTES 와 같은 값(holder 소켓 경로가
// els.sock 보다 길어 서버와 같은 상한으로 거부해야 한다; server.ts 를 import 하면 2번 조각과 순환이 생겨 값 고정).
const MAX_SOCKET_PATH_BYTES = 103;

// 출처: server-auth.ts AUTH_PANE_TOKEN_ENV 과 같은 키 — server-auth 를 import 하면 순환이 생겨 값 고정
// (MAX_SOCKET_PATH_BYTES 선례). OP #128343: 입양 서버의 credential 질의가 이 키로 홀더 env 를 읽는다.
const PANE_TOKEN_ENV = 'ELANOUS_ELS_PANE_TOKEN';

// ── 보안 HOLD 수리(OP #129232): 입양 신뢰(adoption trust) ─────────────────────────
// 홀더의 pane 토큰은 이제 exitCode:0 만으로는 절대 나가지 않는다. 서버는 등록(spawn env — 신뢰 경로) 시점에
// 홀더에게 per-pane 입양 비밀을 주고, adopt-verify 에는 매 요청 새 challenge(randomBytes(32))에 대한
// HMAC-SHA256(비밀, challenge‖nonce‖pane) 답을 요구한다. 더해 답하는 서버의 커널 peer pid+시작시각이
// 홀더가 기록한 서버(마지막 신뢰 등록 순간의 서버)와 일치해야 한다. 비밀 불일치·pid 불일치 → token null.
const ADOPTION_SECRET_ENV = 'ELANOUS_ELS_ADOPTION_SECRET';
const ADOPTION_SERVER_PID_ENV = 'ELANOUS_ELS_SERVER_PID';
const ADOPTION_SERVER_START_ENV = 'ELANOUS_ELS_SERVER_START';
const ADOPTION_SECRET_RE = /^[0-9a-f]{64}$/;

/** 홀더가 기록한 신뢰 등록: 입양 비밀 + 그 비밀을 내려준 서버의 pid·시작시각(재결속 핸드셰이크가 갱신한다). */
interface AdoptionTrust { readonly secret: string; readonly pid: number; readonly start: string }
const adoptionPeer = (pid: number): { pid: number; start: string } | undefined => {
  const start = processStartStamp(pid);
  return start !== undefined ? { pid, start } : undefined;
};
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function holdersDir(stateRoot: string): string {
  return join(stateRoot, 'els', 'holders');
}

export function holderSocketPath(stateRoot: string, paneId: string): string {
  return join(holdersDir(stateRoot), `${paneId}.sock`);
}

export function holderMetaPath(stateRoot: string, paneId: string): string {
  return join(holdersDir(stateRoot), `${paneId}.json`);
}

export interface HolderMeta {
  readonly paneId: string;
  readonly ptyId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly title: string;
  readonly socketPath: string;
  readonly startedAt: number;
  readonly processStart?: string;
  // JUD #128534: 홀더가 bind 시점에 기록하는 세대 nonce — 재결속(reattachHolder)이 이 값을 기대치로
  // 건네 홀더 세대(trusted generation)를 확인한다. 값이 없는 meta(기존 홀더)는 확인 없이 재결속한다(호환 범위).
  readonly generationNonce?: string;
  readonly cols: number;
  readonly rows: number;
}

// meta 는 tmp → rename 원자 기록(디렉터리 0700 · 파일 0600) — els journal 저장과 같은 형태(src/els/journal.ts).
let metaSequence = 0;
export function saveHolderMeta(path: string, meta: HolderMeta): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${++metaSequence}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    throw error;
  }
}

/** 읽을 수 없거나 모양이 다른 meta 는 없는 것으로 본다(재결속은 살아 있는 것만 믿는다). */
export function loadHolderMeta(path: string): HolderMeta | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HolderMeta>;
    if (typeof raw.paneId !== 'string' || typeof raw.ptyId !== 'string' || typeof raw.pid !== 'number' || !Number.isInteger(raw.pid)
      || typeof raw.cwd !== 'string' || !Array.isArray(raw.command) || !raw.command.every((part) => typeof part === 'string')
      || typeof raw.title !== 'string' || typeof raw.socketPath !== 'string' || typeof raw.startedAt !== 'number'
      || typeof raw.cols !== 'number' || typeof raw.rows !== 'number') return undefined;
    return { paneId: raw.paneId, ptyId: raw.ptyId, pid: raw.pid, cwd: raw.cwd, command: raw.command, title: raw.title,
      socketPath: raw.socketPath, startedAt: raw.startedAt, ...(typeof raw.processStart === 'string' && raw.processStart ? { processStart: raw.processStart } : {}),
      ...(typeof raw.generationNonce === 'string' && raw.generationNonce ? { generationNonce: raw.generationNonce } : {}), cols: raw.cols, rows: raw.rows };
  } catch { return undefined; }
}

export function removeHolderMeta(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

// ── D1b(ELS-SERVER-RESTART-SURVIVE): 화면·스크롤백 스냅샷 ─────────────────────────
// 출처: seat-state/HAND-TUI-D/evidence/d1a-holder/D1B-DESIGN-screen-scrollback.md — 홀더가 살아 있는
// 동안 화면·스크롤백을 디바운스로 파일에 남긴다(출력 배치마다 예약). 재부팅이 홀더를 치우면(SIGTERM 정리 →
// meta 소거) 다음 서버의 재결속이 실패하고, 그때 이 파일이 저장 화면을 상태 줄과 함께 보여준다.

export function holderSnapshotPath(stateRoot: string, paneId: string): string {
  return join(holdersDir(stateRoot), `${paneId}.snap.json`);
}

export interface ScreenSnapshot {
  readonly version: 1;
  readonly paneId: string;
  readonly ptyId: string;
  readonly cols: number;
  readonly rows: number;
  readonly screen: string;
  readonly scrollback: string;
  readonly savedAt: number;
}

// 출처: D1B-DESIGN «스크롤백 꼬리(홀더 링버퍼 재사용, 상한 존재)» — 화면 에뮬레이터(src/pty-shell/registry.ts
// xterm scrollback 1000줄 링버퍼)에서 이만큼만 남겨 파일을 아껴도 직전 화면 이력은 충분하다(초과분은 오래된 것부터 버린다).
export const SNAPSHOT_SCROLLBACK_MAX_LINES = 500;
// 출처: D1B-DESIGN «명시적 상한» — 화면 줄 상한. renderScreen 출력은 헤더 1줄 + rows 줄이므로 이보다 큰
// screen 필드는 renderScreen 결과가 아니라 쓰레기다(없는 것으로 본다).
export const SNAPSHOT_SCREEN_MAX_LINES = 2_000;
// 출처: D1B-DESIGN «디바운스 스냅샷 기록» — 출력 배치마다 예약하고 마지막 배치로부터 이 시간 뒤 한 번 기록한다.
// 종료·SIGTERM flush 가 나머지 간극을 덮는다.
const SNAPSHOT_DEBOUNCE_MS = 5_000;

// 스냅샷도 meta 와 같은 형태로 기록한다(tmp → rename 원자기록 · 디렉터리 0700 · 파일 0600).
let snapshotSequence = 0;
export function saveScreenSnapshot(path: string, snapshot: ScreenSnapshot): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${++snapshotSequence}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    throw error;
  }
}

/** 상한을 넘는 스크롤백은 오래된 것부터 버리고 정확히 상한만 남긴다(D1B-DESIGN «절단»). */
export function trimScrollbackLines(lines: readonly string[], limit: number): string[] {
  if (limit <= 0) return [];
  return lines.length > limit ? lines.slice(lines.length - limit) : [...lines];
}

/** 읽을 수 없거나 모양이 다른 스냅샷은 없는 것으로 본다(loadHolderMeta 급 엄격 파서 + 명시적 상한).
 *  상한은 시험이 작은 리터럴로 경계를 점검하도록 매개변수로 열어 둔다(기본 = 제품 상수). */
export function loadScreenSnapshot(
  path: string,
  scrollbackMaxLines: number = SNAPSHOT_SCROLLBACK_MAX_LINES,
  screenMaxLines: number = SNAPSHOT_SCREEN_MAX_LINES,
): ScreenSnapshot | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScreenSnapshot>;
    if (raw.version !== 1 || typeof raw.paneId !== 'string' || typeof raw.ptyId !== 'string'
      || typeof raw.cols !== 'number' || typeof raw.rows !== 'number' || typeof raw.screen !== 'string'
      || typeof raw.scrollback !== 'string' || typeof raw.savedAt !== 'number') return undefined;
    if (raw.screen.split('\n').length > screenMaxLines) return undefined;
    const scrollback = trimScrollbackLines(raw.scrollback.split('\n'), scrollbackMaxLines).join('\n');
    return { version: 1, paneId: raw.paneId, ptyId: raw.ptyId, cols: raw.cols, rows: raw.rows,
      screen: raw.screen, scrollback, savedAt: raw.savedAt };
  } catch { return undefined; }
}

export function removeScreenSnapshot(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

// 출처: D1B-DESIGN «상태 한 줄 표시: «재부팅으로 종료됨 — 이전 화면» + 재생성 안내(Enter)» — 원문 그대로.
const REBOOT_STATUS_LINE = '재부팅으로 종료됨 — 이전 화면 — Enter 로 다시 만들기';

/** 저장 화면 합성: 스크롤백(오래된 이력) → 화면 → 상태 한 줄(빈 칸은 덜어낸다). */
export function composeRestoredScreen(screen: string, scrollback: string): string {
  return [scrollback, screen, REBOOT_STATUS_LINE].filter((part) => part !== '').join('\n');
}

/** 재결속 실패(재부팅 감별) 뒤 저장 화면을 꺼내 준다 — 비파괴 읽기다. 파일은 저널 commit 이 성공한 뒤
 *  consumeScreenSnapshot 이 지운다(저장 실패에도 복구 가능한 원본이 살아 있어야 한다). 스냅샷의 paneId 가
 *  요청 pane 과 다르면 없는 것으로 본다(파일 이름이 틀린 pane 의 화면을 보이지 않게). */
export function restoreScreenFromSnapshot(stateRoot: string, paneId: string): string | undefined {
  const snapshot = loadScreenSnapshot(holderSnapshotPath(stateRoot, paneId));
  if (!snapshot || snapshot.paneId !== paneId) return undefined;
  return composeRestoredScreen(snapshot.screen, snapshot.scrollback);
}

/** 저널 commit 이 성공한 뒤에만 부르는 스냅샷 소비(삭제). */
export function consumeScreenSnapshot(stateRoot: string, paneId: string): void {
  removeScreenSnapshot(holderSnapshotPath(stateRoot, paneId));
}

export type HolderRequest =
  | { readonly op: 'ping' }
  | { readonly op: 'input'; readonly bytes: string }
  | { readonly op: 'write-all'; readonly text: string }
  | { readonly op: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly op: 'snapshot'; readonly ansi?: boolean; readonly scrollBack?: number }
  | { readonly op: 'kill' }
  /** OP #128343(OP 승인 #128469): the adopting server asks the live holder to prove the pane token it carried into its child.
   *  OP #128880: only with this server generation's nonce — a bare or forged nonce never sees the token.
   *  보안 HOLD 수리(OP #129232): the proof now rides the challenge-HMAC + recorded-server-identity gates (아래). */
  | { readonly op: 'credential'; readonly nonce?: string }
  /** 보안 HOLD 수리(OP #129232): the reattach handshake's trust registration — the adopting server generation installs a fresh
   *  adoption secret. Proof = this holder's own generation nonce (meta 원장 0600 · 소켓 0700 — JUD #128534 신뢰 경로). */
  | { readonly op: 'adopt-renew'; readonly secret: string; readonly proof: string };

export type HolderMessage =
  | { readonly type: 'pong'; readonly paneId: string; readonly ptyId: string; readonly pid: number; readonly processStart?: string; readonly generationNonce?: string }
  | { readonly type: 'snapshot'; readonly paneId: string; readonly ptyId: string; readonly pid: number; readonly processStart?: string; readonly alive: boolean;
      readonly cols: number; readonly rows: number; readonly exitCode: number | null; readonly bracketedPaste: boolean;
      readonly lastOutputAt: number | null; readonly screen: string }
  | { readonly type: 'output'; readonly paneId: string; readonly chunk: string }
  | { readonly type: 'exit'; readonly paneId: string; readonly exitCode: number | null; readonly screen: string }
  | { readonly type: 'wrote'; readonly paneId: string }
  | { readonly type: 'error'; readonly message: string }
  /** OP #128343: the holder's proof — the pane token its child env actually carries (null = it never had one). */
  | { readonly type: 'credential'; readonly paneId: string; readonly token: string | null };

/** 보안 HOLD 수리(OP #129232): 입양 서버에게 매 요청 새 challenge(randomBytes(32))를 내고
 *  HMAC-SHA256(비밀, challenge‖nonce‖pane) 답과 답하는 서버의 커널 peer pid+시작시각을 모두 검증한다.
 *  exitCode 단독 신뢰는 폐지 — 가짜 els.sock 리스너(unlink+bind, 같은 UID)가 exitCode:0 만 답하는
 *  공격으로부터 토큰을 지킨다. 하나라도 불일치·불명이면 false(fail-closed). */
function serverConfirmsAdoption(paneId: string, nonce: string, adoption: AdoptionTrust): Promise<boolean> {
  const socketPath = process.env.ELANOUS_ELS_SOCKET;
  if (!socketPath) return Promise.resolve(false);
  const self = processIdentity(process.pid);
  const challenge = randomBytes(32).toString('hex');
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const fail = (): void => { socket.destroy(); resolve(false); };
    socket.once('error', fail);
    socket.setTimeout(5_000, fail);
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'adopt-verify', pane: paneId, holderPid: process.pid, ...(self?.pid === process.pid ? { holderStart: self.start } : {}), nonce, challenge })}\n`));
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      // 커널 peer 검증: 답한 리스너가 기록된 서버와 같은 pid+시작시각인가(LOCAL_PEERCRED, 출처 peerPid).
      // destroy 뒤에는 소켓 handle/fd가 사라져 peerPid가 undefined를 돌려준다 — kernelPeerOk 가
      // 영구 false로 굳어져 재등록이 시간 초과된다(이 파일의 RED 161). 반드시 살아 있는 소켓에서 먼저 잡는다.
      const peer = peerPid(socket);
      const peerStart = peer !== undefined ? processStartStamp(peer) : undefined;
      socket.destroy();
      try {
        const answer = JSON.parse(buf.slice(0, nl)) as { proof?: unknown; serverPid?: unknown; serverStart?: unknown; exitCode?: unknown };
        const proof = createHmac('sha256', adoption.secret).update(challenge + nonce + paneId).digest('hex');
        const kernelPeerOk = peer !== undefined && peerStart !== undefined && peer === adoption.pid && peerStart === adoption.start;
        const declaredOk = answer.serverPid === adoption.pid && answer.serverStart === adoption.start;
        // exitCode:0(승인)과 증명을 함께 요구한다 — 서버는 거부 답에 proof 를 안 실으므로, exitCode 만
        // 혹은 proof 만 맞는 답은 모두 거짓말(위조 nonce 거부 답에 증명이 실렸던 RED 196).
        resolve(answer.exitCode === 0 && typeof answer.proof === 'string' && answer.proof === proof && kernelPeerOk && declaredOk);
      } catch { resolve(false); }
    });
  });
}

function socketTaken(socketPath: string): Promise<'live' | 'dead' | 'none'> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.on('connect', () => { socket.destroy(); resolve('live'); });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === 'ENOENT' ? 'none' : error.code === 'ECONNREFUSED' ? 'dead' : 'live');
    });
  });
}

function listen(server: Server, socketPath: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => { server.off('listening', onListening); resolve(error); };
    const onListening = (): void => { server.off('error', onError); resolve(undefined); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

/** PTY 종료 뒤에도 최종 snapshot 을 이만큼 더 들려준다(서버가 마지막 화면을 els 저널에 저장할 시간). */
export const HOLDER_EXIT_GRACE_MS = 30_000;

export interface HolderStart {
  readonly stateRoot: string;
  readonly paneId: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly title: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly exitGraceMs?: number;
  readonly generationNonce?: string;
}

export interface Holder {
  readonly meta: HolderMeta;
  /** 정리가 끝났다(PTY 종료 + grace, 또는 close()): 소켓 unlink · meta 제거 · 구독 해제. */
  readonly done: Promise<void>;
  close(): Promise<void>;
}

export async function startHolder(start: HolderStart): Promise<Holder> {
  const socketPath = holderSocketPath(start.stateRoot, start.paneId);
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(`els holder: socket path too long (${socketPath} is ${bytes} bytes; at most ${MAX_SOCKET_PATH_BYTES})`);
  if (!start.command[0]) throw new Error('els holder: a command is required');
  // OP #128343(OP 승인 #128469): 이 홀더가 자식에게 내려준 pane 토큰 — 입양 서버의 credential 질의의 답.
  // start.env(홀더가 실제로 준 값)만 본다: 주변 process.env 승격은 없다(detached 경로는 holder-main 이
  // process.env 에서 start.env 로 옮겨 온다 — 두 값이 일치한다).
  const paneToken = start.env?.[PANE_TOKEN_ENV] ?? null;
  // 보안 HOLD 수리(OP #129232) 등록 시점: spawn env(신뢰 경로 — PANE_TOKEN_ENV 를 실어 나르는 그 환경)로
  // 내려온 per-pane 입양 비밀과 내려준 서버의 pid+시작시각. 이 값들은 홀더 메모리에만 남는다(디스크·
  // els.sock 금지). 비밀이 없으면 credential 은 fail-closed(null) — 구형 서버가 스폰한 홀더 호환.
  const adoptionSecret = start.env?.[ADOPTION_SECRET_ENV];
  const adoptionPid = Number(start.env?.[ADOPTION_SERVER_PID_ENV]);
  const adoptionStart = start.env?.[ADOPTION_SERVER_START_ENV];
  let adoption: AdoptionTrust | undefined = adoptionSecret !== undefined && ADOPTION_SECRET_RE.test(adoptionSecret)
    && Number.isSafeInteger(adoptionPid) && adoptionPid > 0 && adoptionStart ? { secret: adoptionSecret, pid: adoptionPid, start: adoptionStart } : undefined;
  // 입양 비밀은 절대 pane 자식 env 로 내려가지 않는다(pane 안의 임의 코드가 읽으면 위조 답이 가능해진다).
  const childEnv: Record<string, string> = { ...start.env, ELANOUS_CEO_TELEGRAM_TOKEN: '' };
  delete childEnv[ADOPTION_SECRET_ENV];
  delete childEnv[ADOPTION_SERVER_PID_ENV];
  delete childEnv[ADOPTION_SERVER_START_ENV];
  const dir = holdersDir(start.stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  // D1a JUD-B must 1(#106624): 소켓 소유권을 먼저 확보한다(중복 홀더 판정 포함). 명령 스폰은 확보 뒤에만 —
  // 거부된 두 번째 홀더가 명령 부작용(표지 파일 등)을 남기지 않는다.
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    const drop = (): void => { clients.delete(socket); };
    socket.on('close', drop);
    socket.on('error', drop);
    // 보안 HOLD 수리(OP #129232): 이 연결의 커널 peer 정체(pid+시작시각) — credential 요청의 소유자 판정과
    // adopt-renew 등록의 기록 원천. 커널이 준 값만 쓴다(LOCAL_PEERCRED; 자기신고 pid 는 받지 않는다).
    const peer = peerPid(socket);
    const peerIdentity = peer !== undefined ? adoptionPeer(peer) : undefined;
    const send = (message: HolderMessage): void => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
    const lines = createLineDecoder((line) => { void request(line, send, peerIdentity); });
    socket.on('data', (chunk: Buffer) => { lines.push(chunk); });
  });
  const broadcast = (message: HolderMessage): void => {
    const text = `${JSON.stringify(message)}\n`;
    for (const socket of clients) if (!socket.destroyed) socket.write(text);
  };
  let failed = await listen(server, socketPath);
  if (failed?.code === 'EADDRINUSE') {
    const taken = await socketTaken(socketPath);
    // 산 holder 위에 두 번째 holder 를 띄우지 않는다(재기동한 서버는 재결속해야지 다시 만들면 안 된다).
    if (taken === 'live') { server.close(); throw new Error(`els holder: a holder already answers for pane ${start.paneId}`); }
    if (taken === 'dead') { try { unlinkSync(socketPath); } catch { /* removed meanwhile */ } }
    failed = await listen(server, socketPath);
  }
  if (failed) { server.close(); throw new Error(`els holder: cannot listen on ${socketPath}: ${failed.message}`); }
  chmodSync(socketPath, 0o700);
  // 이제 PTY 를 띄운다: 소켓은 이미 우리 것이다. 스폰 실패 시 소켓을 직접 정리한다.
  let handle: ReturnType<typeof startPty>;
  const beforeSpawn = Date.now();
  try {
    // ⛔⭐⭐ JUD-2 필수 1(#131893 · 2026-11-22): 옵트아웃·캡처 실패 모두 getCapturedEnv() 가 홀더 process.env
    // 폴백을 내놓는다 — childEnv 에서 지운 입양 비밀이 합성(captured 를 먼저 펼친 뒤 callerEnv)에서 되살아난다.
    // 최종 env 구성 직전에 홀더 전용 키를 무조건 지운다. buildPtyEnv 의 unset 은 caller-승자 규칙이라
    // childEnv 가 명시적으로 싣는 이 pane 자신의 PANE_TOKEN 은 유지되고 폴백의 사본만 잘린다.
    handle = startPty({ cmd: start.command[0], args: start.command.slice(1), kind: 'shell', nickname: start.title,
      workdir: start.cwd, purpose: 'els-pane', env: childEnv,
      unsetEnv: [ADOPTION_SECRET_ENV, ADOPTION_SERVER_PID_ENV, ADOPTION_SERVER_START_ENV, PANE_TOKEN_ENV],
      ...(start.cols !== undefined ? { cols: start.cols } : {}), ...(start.rows !== undefined ? { rows: start.rows } : {}) });
  } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* never spawned */ }
    throw error;
  }
  const born = processIdentity(handle.pid);
  const processStart = born?.pid === handle.pid && born.ppid === process.pid && born.startedMs >= beforeSpawn ? born.start : undefined;
  const meta: HolderMeta = { paneId: start.paneId, ptyId: handle.id, pid: handle.pid, cwd: start.cwd, command: [...start.command],
    title: start.title, socketPath, startedAt: handle.startedAt, ...(processStart ? { processStart } : {}),
    ...(start.generationNonce ? { generationNonce: start.generationNonce } : {}), cols: handle.cols, rows: handle.rows };
  const metaPath = holderMetaPath(start.stateRoot, start.paneId);
  try { saveHolderMeta(metaPath, meta); } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* never bound */ }
    try { handle.kill('SIGKILL'); } catch { /* just spawned */ }
    throw error;
  }

  // The holder survives the server: retain the newest validated OSC even while no
  // server is attached. A screen snapshot cannot reconstruct terminal controls.
  let holderCwd: string | undefined;
  let cwdUncertainAfter = 0;
  let cwdSequence = 0;
  const cwdQueue: { cwd: string; sequence: number }[] = [];
  let cwdWork: Promise<void> | undefined;
  const observeCwd = osc7CwdParser((cwd) => {
    if (cwdQueue.length >= 64) {
      cwdUncertainAfter = Math.max(cwdUncertainAfter, cwdQueue.shift()!.sequence);
      process.stderr.write(`els: ${meta.paneId} osc-saturated\n`);
    }
    cwdQueue.push({ cwd, sequence: ++cwdSequence });
    if (!cwdWork) {
      cwdWork = (async () => {
        while (cwdQueue.length) {
          const candidate = cwdQueue.shift()!;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const valid = await Promise.race([
              stat(candidate.cwd).then(result => result.isDirectory(), () => false),
              new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); }),
            ]);
            if (valid === undefined) cwdUncertainAfter = Math.max(cwdUncertainAfter, candidate.sequence);
            else if (valid) {
              holderCwd = candidate.cwd;
              if (candidate.sequence > cwdUncertainAfter) cwdUncertainAfter = 0;
            }
          } finally { if (timer) clearTimeout(timer); }
        }
      })().finally(() => { cwdWork = undefined; });
    }
  });

  const request = async (line: string, send: (message: HolderMessage) => void, peerIdentity?: { pid: number; start: string }): Promise<void> => {
    let message: HolderRequest;
    try { message = JSON.parse(line) as HolderRequest; } catch { send({ type: 'error', message: 'els holder: malformed line' }); return; }
    try {
      switch (message.op) {
        case 'ping': {
          // Wait for the observed batch before taking the snapshot; an old cached
          // cwd must never be replayed after a newer OSC. Keep the handshake bounded.
          if (cwdWork) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([cwdWork, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
            finally { if (timer) clearTimeout(timer); }
          }
          if (!cwdWork && !cwdUncertainAfter && holderCwd) send({ type: 'output', paneId: meta.paneId, chunk: `\x1b]7;${pathToFileURL(holderCwd).href}\x07` });
          send({ type: 'pong', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid, ...(processStart ? { processStart } : {}), ...(start.generationNonce ? { generationNonce: start.generationNonce } : {}) });
          return;
        }
        case 'input': handle.write(message.bytes); return;
        case 'write-all': await handle.writeAll(message.text); send({ type: 'wrote', paneId: meta.paneId }); return;
        case 'resize': handle.resize(message.cols, message.rows); return;
        case 'snapshot': send({ type: 'snapshot', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid, ...(processStart ? { processStart } : {}), alive: handle.isAlive(),
          cols: handle.cols, rows: handle.rows, exitCode: handle.exitCode, bracketedPaste: handle.bracketedPasteEnabled(),
          lastOutputAt: handle.lastOutputAt ?? null, screen: await handle.renderScreen(message.ansi === true ? { ansi: true, ...(message.scrollBack ? { scrollBack: message.scrollBack } : {}) } : undefined) }); return;
        case 'kill': handle.kill(); return;
        case 'adopt-renew': {
          // 보안 HOLD 수리(OP #129232) 재결속(reattach) 핸드셰이크 — JUD #128534 신뢰 경로 위의 신뢰 등록:
          // 입양 세대의 서버가 새 입양 비밀을 설치하고 이 연결의 커널 peer 정체를 기록한다. 증명물은 이
          // 홀더 자신의 세대 nonce(meta 원장 0600 · 소켓 0700 — 같은 UID 의 meta 판독자는 JUD #128534
          // 가 이미 수용한 경계다). 기록된 서버가 살아 있으면(재기동 아님) 새 설치는 그 서버의 연결만 허용.
          const secret = typeof message.secret === 'string' && ADOPTION_SECRET_RE.test(message.secret) ? message.secret : undefined;
          const proof = typeof message.proof === 'string' ? message.proof : '';
          if (!secret || !start.generationNonce || proof !== start.generationNonce || peerIdentity === undefined) return;
          const fromRecorded = adoption !== undefined && peerIdentity.pid === adoption.pid && peerIdentity.start === adoption.start;
          const recordedAlive = adoption !== undefined ? processAlive(adoption.pid) : false;
          if (fromRecorded || !recordedAlive) adoption = { secret, pid: peerIdentity.pid, start: peerIdentity.start };
          return;
        }
        case 'credential': {
          // OP #128880: the token leaves only when the live server of this generation confirms the
          // nonce this request carried — a bare or forged nonce (a same-uid stranger) gets null.
          // 보안 HOLD 수리(OP #129232) fail-closed 게이트 3중: (①) spawn env 로 받은 per-pane 비밀,
          // (②) 묻는 연결의 커널 peer pid+시작시각 == 기록된 서버, (③) 매 요청 새 challenge 에 대한
          // HMAC 답(가짜 els.sock 리스너는 비밀이 없어 못 맞춘다) — exitCode 단독은 신뢰하지 않는다.
          const nonce = typeof message.nonce === 'string' ? message.nonce : undefined;
          // 답변자 검증은 serverConfirmsAdoption 이 맡는다(커널 peer pid+시작시각 == 기록 서버 · HMAC) —
          // 질문자(credential 요청 연결)를 미리 걸러두면 OP #129232 처방의 adopt-verify 왕복 자체가
          // 일어나지 않아 가짜 리스너 공격 경로가 관측·회귀되지 않는다.
          const confirmed = nonce !== undefined && /^[0-9a-f]{48}$/.test(nonce)
            && adoption !== undefined
            ? await serverConfirmsAdoption(meta.paneId, nonce, adoption) : false;
          send({ type: 'credential', paneId: meta.paneId, token: confirmed ? paneToken : null });
          return;
        }
        default: send({ type: 'error', message: 'els holder: unknown op' });
      }
    } catch (error) { send({ type: 'error', message: `els holder: ${error instanceof Error ? error.message : String(error)}` }); }
  };

  // 종료: PTY 끝 → 마지막 화면 방송 → grace → 정리. 접속 끊김은 그 어느 것도 건드리지 않는다(serveAttach 계약).
  let closed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  // D1b: 화면·스크롤백 스냅샷 — 출력 배치마다 예약해 디바운스로 남긴다(재부팅 뒤 이전 화면 렌더의 원천).
  // 종료와 close()(SIGTERM)에서 flush 한다; 스냅샷은 최선을 다하는 부수 효과라 홀더를 죽이지 않는다.
  const snapPath = holderSnapshotPath(start.stateRoot, start.paneId);
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  const writeSnapshot = async (screen?: string): Promise<void> => {
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = undefined; }
    const text = screen ?? await handle.renderScreen();
    const scrollback = await (handle.renderScrollback?.(SNAPSHOT_SCROLLBACK_MAX_LINES) ?? '');
    saveScreenSnapshot(snapPath, { version: 1, paneId: meta.paneId, ptyId: handle.id, cols: handle.cols,
      rows: handle.rows, screen: text, scrollback, savedAt: Date.now() });
  };
  const offOutput = onPtyEvent((event) => {
    if (event.type === 'output' && event.id === handle.id) {
      observeCwd(event.chunk);
      broadcast({ type: 'output', paneId: meta.paneId, chunk: event.chunk });
      // D1b: 출력 배치마다 스냅샷을 다시 예약한다(타이머는 홀더 프로세스를 붙잡지 않는다).
      if (!snapTimer) {
        snapTimer = setTimeout(() => {
          snapTimer = undefined;
          void writeSnapshot().catch(() => { /* best-effort */ });
        }, SNAPSHOT_DEBOUNCE_MS);
        snapTimer.unref?.();
      }
    }
  });
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { markDone = resolve; });
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = undefined; }
    offOutput();
    const sockets = [...clients];
    clients.clear();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    removeHolderMeta(metaPath);
    try { unregisterPty(handle.id); } catch { /* already gone */ }
  };
  handle.onExit(() => {
    void handle.renderScreen().then(
      (screen) => {
        broadcast({ type: 'exit', paneId: meta.paneId, exitCode: handle.exitCode, screen });
        // D1b 종료 flush: 최종 화면을 스냅샷에도 남긴다(서버가 exit 방송을 받지 못한 재시작에 대비).
        // ELS-ORPHAN-SERVE-REAP(OP #131393③): meta 가 이미 지워졌으면 이 pane 은 회수(스윕)로 소유가
        // 끊긴 잔재다 — 아무도 이 화면을 복구하지 못하므로 죽어가는 홀더가 스냅샷을 되살려 쓰지 않는다.
        if (existsSync(metaPath)) void writeSnapshot(screen).catch(() => { /* best-effort */ });
      },
      () => broadcast({ type: 'exit', paneId: meta.paneId, exitCode: handle.exitCode, screen: '' }))
      .finally(() => {
        graceTimer = setTimeout(() => { void cleanup().finally(markDone); }, start.exitGraceMs ?? HOLDER_EXIT_GRACE_MS);
        graceTimer.unref?.();
      });
  });
  return {
    meta,
    done,
    close: async (): Promise<void> => {
      // D1b SIGTERM flush: 정리 전 마지막 화면을 남긴다(재부팅 뒤 이 화면이 복원된다).
      try { await writeSnapshot(); } catch { /* best-effort */ }
      try { if (handle.isAlive()) handle.kill('SIGKILL'); } catch { /* already gone */ }
      await cleanup();
      markDone();
    },
  };
}

/** 이 프로세스가 띄운 holder 들(살아 있는 것만) — 시험 누수 감시(src/els/test-support/els-process-guard.ts)가 읽는 구조 원장.
 *  Subprocess 로 쥐어 pid 재사용에 속지 않는다; 끝난 holder 는 exited 에서 빠진다. */
const holdersSpawnedHere = new Set<import('bun').Subprocess>();
export function liveHoldersSpawnedHere(): readonly { readonly pid: number; kill(signal?: NodeJS.Signals): void }[] {
  return [...holdersSpawnedHere].filter((child) => child.exitCode === null && child.signalCode === null);
}

/** els 서버가 pane 자식 대신 띄우는 detached holder 프로세스. 환경 = 서버 env ⊕ pane env(그대로 자식에게 내려간다). */
export function spawnHolderDetached(start: HolderStart & { readonly execPath?: string; readonly scriptPath?: string; readonly loginEnv?: string }): { readonly pid: number } {
  const scriptPath = start.scriptPath ?? fileURLToPath(new URL('./holder-main.ts', import.meta.url));
  const argv = [start.execPath ?? process.execPath, scriptPath,
    '--state-root', start.stateRoot, '--pane', start.paneId, '--cwd', start.cwd, '--title', start.title,
    ...(start.cols !== undefined ? ['--cols', String(start.cols)] : []),
    ...(start.rows !== undefined ? ['--rows', String(start.rows)] : []),
    ...(start.exitGraceMs !== undefined ? ['--grace-ms', String(start.exitGraceMs)] : []),
    ...(start.generationNonce ? ['--generation-nonce', start.generationNonce] : []),
    '--', ...start.command];
  // The server's owner credential never rides into a holder (nor its pane): whether it comes from process.env or start.env.
  const holderEnv: Record<string, string | undefined> = { ...process.env, ...start.env };
  delete holderEnv.ELANOUS_ELS_OWNER_TOKEN;
  // The ELS-only Telegram adapter credential must never ride into any pane.
  // OP receives only its scoped ingress socket secret through envFor(OP).
  delete holderEnv.ELANOUS_CEO_TELEGRAM_TOKEN;
  // The captured login env (login-env-handoff.ts) goes over the pipe, not argv/env/disk; no payload = /dev/null and the holder captures itself.
  const child = Bun.spawn(argv, { cwd: start.cwd, env: holderEnv,
    stdio: [start.loginEnv === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], detached: true });
  if (start.loginEnv !== undefined) { child.stdin!.write(start.loginEnv); void child.stdin!.end(); }
  child.unref();
  holdersSpawnedHere.add(child);
  // ELS-ORPHAN-SERVE-REAP M2(OP #131393③ · 골 #132048③): 홀더가 이벤트로 죽으면(child.exited — 폴링
  // 아님) SIGKILL 이 못 지운 잔재를 그 죽음이 관측된 자리에서 곧바로 회수한다. 정상 종료는 홀더가 이미
  // 자기 정리를 마친 뒤라 회수는 전부 no-op 다. 스냅샷은 남긴다(D1b 복구가 여전히 필요하다).
  void child.exited.then(() => { holdersSpawnedHere.delete(child); reapHolderResidue(start.stateRoot, start.paneId, { keepSnapshot: true, killPtyIfReal: true }); });
  return { pid: Number(child.pid) };
}

// ── 서버 쪽 어댑터(D1a 둘째 조각) ─────────────────────────────────────────────────
// spawn 직후(홀더가 기동 중)와 재결속(홀더가 이미 산다)이 같은 어댑터를 쓴다. 어댑터 id 는 pane id 에서
// 파생한다(h:<paneId>): 저널의 pane.ptyId 는 재시작을 거쳐도 같은 값을 유지하고, core 의 livePty 판정
// (pane.ptyId === pty.id)이 홀더의 registry pty id 와 무관하게 성립한다.
export function holderAdapterId(paneId: string): string {
  return `h:${paneId}`;
}

// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 한 단계 실화면 대기와 같은 형태. 홀더 기동
// (PTY → 소켓 bind → meta 기록)과 재결속의 dead-홀더 판정이 이 안에 끝나야 한다(100 ms 간격 재시도).
const HOLDER_CONNECT_TIMEOUT_MS = 5_000;
const HOLDER_CONNECT_RETRY_MS = 100;

/** 홀더 소켓에 붙는 ElsPty — 연결·재시도·exit 방송·쓰기 큐를 한데 묶는다(기동 전 쓰기는 소켓 뒤에 쌓인다).
 *  보안 HOLD 수리(OP #129232): renewAdoptionSecret 를 주면(재결속 경로) 연결 즉시 그 비밀을 홀더에 등록한다 —
 *  서버측 pong/generationNonce 확인(기존 JUD #128534 신뢰 경로)을 통과한 세대가 credential 질의 전에
 *  새 입양 비밀을 설치한다(홀더는 등록된 서버 정체를 그 연결의 커널 peer 로 기록). */
export function connectHolderElsPty(stateRoot: string, paneId: string, meta: HolderMeta | undefined, lookupIdentity = processIdentity, connect = createConnection, expectedGenerationNonce?: string, renewAdoptionSecret?: string): ElsPty {
  const id = holderAdapterId(paneId);
  const socketPath = holderSocketPath(stateRoot, paneId);
  let alive = true;
  let detached = false;
  let exited = false;
  let bracketedPaste = false;
  let lastOutputAt: number | undefined;
  let pidNow = meta?.pid;
  let holderPtyId = meta?.ptyId;
  let processStart: string | undefined;
  let identityEstablished = false;
  let handshakeComplete = false;
  let earlyExit: Extract<HolderMessage, { type: 'exit' }> | undefined;
  // Unverified broadcasts stay private until pong. Bound memory and fail closed on overflow.
  const earlyOutput: string[] = [];
  let earlyOutputBytes = 0;
  const earlyOutputMaxBytes = 1024 * 1024;
  let lastScreen: string | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: Socket | undefined;
  const exitCbs = new Set<() => void>();
  const outputCbs = new Set<(chunk: string) => void>();
  const cwdReadyCbs = new Set<() => void>();
  const pending: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const outbox: string[] = [];
  // OP #128343: credential 질의의 대기자 — 보통 pending 큐와 별도로(해석 순서는 소켓 라인 순서 그대로).
  const credentialWaiters: { resolve(token: string | undefined): void }[] = [];
  const settle = (waiting: { resolve(text: string): void; reject(error: Error): void }[]): void => {
    for (const waiter of waiting) waiter.reject(new Error('els holder: connection lost'));
  };
  const fireExit = (): void => {
    if (exited || detached) return;
    exited = true;
    alive = false;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    outbox.length = 0;
    earlyOutput.length = 0;
    earlyOutputBytes = 0;
    earlyExit = undefined;
    settle(pending.splice(0));
    for (const waiter of credentialWaiters.splice(0)) waiter.resolve(undefined);
    for (const cb of [...exitCbs]) { try { cb(); } catch { /* a listener */ } }
  };
  // 죽은 홀더가 남긴 meta 는 다음 재시작이 다시 기다리지 않도록 지운다(홀더가 못 지운 것이다).
  const giveUp = (): void => { removeHolderMeta(holderMetaPath(stateRoot, paneId)); fireExit(); };
  const push = (value: object): void => {
    const line = `${JSON.stringify(value)}\n`;
    if (handshakeComplete && socket && !socket.destroyed) socket.write(line); else outbox.push(line);
  };
  const onMessage = (message: HolderMessage): void => {
    // The decoder can deliver more lines from the same data event after termination.
    if (exited || detached) return;
    if ('paneId' in message && message.paneId !== paneId) {
      socket?.destroy();
      fireExit();
      return;
    }
    // No response except the generation-check pong can authorize queued operations.
    // Exit may precede pong; retain it privately until the generation is verified.
    // Other broadcasts cannot authorize any queued operations.
    if (!handshakeComplete && message.type !== 'pong') {
      if (message.type === 'exit' && message.paneId === paneId) {
        if (typeof message.screen !== 'string' || earlyOutputBytes + Buffer.byteLength(message.screen) > earlyOutputMaxBytes) { socket?.destroy(); fireExit(); return; }
        earlyExit ??= message;
      }
      if (message.type === 'output' && !earlyExit && typeof message.chunk === 'string') {
        earlyOutputBytes += Buffer.byteLength(message.chunk);
        // Also bound array overhead for a peer sending many tiny or empty chunks.
        if (earlyOutputBytes > earlyOutputMaxBytes || earlyOutput.length >= 4096) { socket?.destroy(); fireExit(); return; }
        earlyOutput.push(message.chunk);
      }
      return;
    }
    if (message.type === 'pong' || message.type === 'snapshot') {
      if (message.paneId !== paneId || typeof message.ptyId !== 'string' || !message.ptyId || !Number.isSafeInteger(message.pid) || message.pid <= 0
        || (message.type === 'pong' && !handshakeComplete && expectedGenerationNonce !== undefined && message.generationNonce !== expectedGenerationNonce)
        || (holderPtyId !== undefined && holderPtyId !== message.ptyId)
        || (pidNow !== undefined && pidNow !== message.pid)) {
        socket?.destroy();
        fireExit();
        return;
      }
      holderPtyId = message.ptyId;
      const identity = lookupIdentity(message.pid);
      const claimedStart = typeof message.processStart === 'string' && message.processStart ? message.processStart : undefined;
      const verifiedStart = claimedStart && identity?.pid === message.pid && identity.start === claimedStart
        && (!meta || meta.processStart === claimedStart) ? claimedStart : undefined;
      if (meta?.processStart && verifiedStart !== meta.processStart) {
        socket?.destroy();
        fireExit();
        return;
      }
      if (!identityEstablished) {
        processStart = verifiedStart;
        identityEstablished = true;
      } else if (processStart !== verifiedStart) {
        processStart = undefined;
      }
    }
    switch (message.type) {
      case 'pong':
        pidNow = message.pid;
        if (!handshakeComplete) {
          // Deliver verified output, but keep effects queued until a known early exit is handled.
          if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = undefined; }
          for (const chunk of earlyOutput.splice(0)) {
            for (const cb of [...outputCbs]) { try { cb(chunk); } catch { /* a listener */ } }
            if (detached || exited) return;
          }
          earlyOutputBytes = 0;
          for (const cb of [...cwdReadyCbs]) { try { cb(); } catch { /* a listener */ } }
          if (detached || exited) return;
          if (earlyExit) {
            lastScreen = earlyExit.screen;
            earlyExit = undefined;
            fireExit();
            return;
          }
          while (outbox.length && !exited && !detached) socket?.write(outbox.shift()!);
          if (!exited && !detached) handshakeComplete = true;
        }
        return;
      case 'snapshot':
        alive = message.alive;
        bracketedPaste = message.bracketedPaste;
        lastOutputAt = message.lastOutputAt ?? undefined;
        pidNow = message.pid;
        pending.shift()?.resolve(message.screen);
        // exit 방송을 놓친 채 grace 창에 붙었다: 살아 있지 않음을 이제 알았으니 종료로 기록한다.
        if (!message.alive) fireExit();
        return;
      case 'output':
        for (const cb of [...outputCbs]) { try { cb(message.chunk); } catch { /* a listener */ } }
        return;
      case 'exit':
        lastScreen = message.screen;
        alive = false;
        pending.shift()?.resolve(message.screen);
        fireExit();
        return;
      case 'wrote': pending.shift()?.resolve(''); return;
      case 'credential': credentialWaiters.shift()?.resolve(typeof message.token === 'string' && message.token.length > 0 ? message.token : undefined); return;
      case 'error': pending.shift()?.reject(new Error(message.message)); return;
    }
  };
  const attach = (connected: Socket): void => {
    if (detached || exited) { connected.destroy(); return; }
    socket = connected;
    const lines = createLineDecoder((line) => { try { onMessage(JSON.parse(line) as HolderMessage); } catch { /* not a holder line */ } });
    connected.on('data', (chunk: Buffer) => {
      if (!handshakeComplete && lines.pending() + chunk.length > earlyOutputMaxBytes) { connected.destroy(); fireExit(); return; }
      lines.push(chunk);
    });
    connected.on('error', () => { connected.destroy(); });
    connected.on('close', () => {
      if (socket !== connected) return;
      socket = undefined;
      // detach 한 뒤가 아니라면 홀더가 사라진 것이다 — 이 pane 의 생애도 끝난다(exit 방송이 마지막 화면을 실어 왔다).
      if (!detached) fireExit();
    });
    // Bound the handshake too: a connected but silent peer must not strand requests.
    handshakeTimer = setTimeout(() => { connected.destroy(); fireExit(); }, Math.max(0, deadline - Date.now()));
    handshakeTimer.unref?.();
    // Only the validated pong releases the queue or a deferred kill.
    // 보안 HOLD 수리(OP #129232): 신뢰 등록(새 입양 비밀 설치)을 credential 큐 앞에 싣는다 —
    // 홀더는 라인 순서대로 처리하므로 credential 질의보다 등록이 먼저 도착한다.
    if (renewAdoptionSecret && expectedGenerationNonce)
      connected.write(`${JSON.stringify({ op: 'adopt-renew', secret: renewAdoptionSecret, proof: expectedGenerationNonce })}\n`);
    connected.write(`${JSON.stringify({ op: 'ping' })}\n`);
  };
  const attempt = (): void => {
    if (detached || exited || socket) return;
    const connected = connect(socketPath);
    connected.once('connect', () => attach(connected));
    connected.once('error', () => {
      connected.destroy();
      if (detached || exited || socket) return;
      if (Date.now() >= deadline) { giveUp(); return; }
      setTimeout(attempt, HOLDER_CONNECT_RETRY_MS);
    });
  };
  const deadline = Date.now() + HOLDER_CONNECT_TIMEOUT_MS;
  attempt();
  return {
    id,
    get pid() { return pidNow; },
    get processBinding() { return pidNow && holderPtyId && processStart && !exited && !detached ? { pid: pidNow, generation: holderPtyId, start: processStart } : undefined; },
    isAlive: () => alive,
    write: (text) => {
      if (detached || exited) throw new Error('els holder: pane is not running');
      push({ op: 'input', bytes: text });
    },
    writeAll: async (text) => {
      if (detached || exited) throw new Error('els holder: pane is not running');
      await new Promise<void>((resolve, reject) => {
        pending.push({ resolve: () => resolve(), reject });
        push({ op: 'write-all', text });
      });
    },
    bracketedPasteEnabled: () => bracketedPaste,
    lastOutputAt: () => lastOutputAt,
    renderScreen: (options) => new Promise<string>((resolve, reject) => {
      if (exited || detached) {
        // exit 방송이 실어 온 마지막 화면이 있으면 그것이 최종 snapshot 이다(recordFinalScreen 경로).
        if (lastScreen !== undefined) resolve(lastScreen); else reject(new Error('els holder: pane is not running'));
        return;
      }
      pending.push({ resolve, reject });
      push({ op: 'snapshot', ...(options?.ansi ? { ansi: true } : {}), ...(options?.scrollBack ? { scrollBack: options.scrollBack } : {}) });
    }),
    onExit: (cb) => { if (exited) { try { cb(); } catch { /* a listener */ } return; } exitCbs.add(cb); },
    kill: () => {
      if (exited || detached) return;
      push({ op: 'kill' });
    },
    resize: (cols, rows) => { if (detached || exited) return; push({ op: 'resize', cols, rows }); },
    onCwdReady: (cb) => {
      cwdReadyCbs.add(cb);
      return { dispose: () => { cwdReadyCbs.delete(cb); } };
    },
    // OP #128343(OP 승인 #128469): 홀더가 증명한 pane 토큰 — 입양 서버의 재등록 질의(0700 소켓, 같은 uid).
    // OP #128880: 입양 서버의 세대 nonce 를 함께 실어 보낸다 — 홀더는 그 nonce 를 서버에 되물어 확인한 뒤에만 토큰을 돌려준다.
    credential: (nonce) => new Promise<string | undefined>((resolve) => {
      if (exited || detached) { resolve(undefined); return; }
      credentialWaiters.push({ resolve });
      push({ op: 'credential', nonce });
    }),
    onOutput: (cb) => {
      outputCbs.add(cb);
      return { dispose: () => { outputCbs.delete(cb); } };
    },
    detach: () => {
      // D1a: 서버 종료 — 연결만 놓는다. 홀더와 자식은 살아 있고, 다음 서버가 meta·소켓으로 재결속한다.
      if (detached) return;
      detached = true;
      alive = false;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      settle(pending.splice(0));
      outbox.length = 0;
      earlyOutput.length = 0;
      earlyOutputBytes = 0;
      earlyExit = undefined;
      socket?.destroy();
      socket = undefined;
    },
  };
}

/** D11(RES 2회차 ced7641f · OP #106630): detached 홀더 스폰은 홀더 바이너리가 뜨는 순간 성공이라,
 *  커맨드 스폰 실패는 els new 가 exit 0·주소를 돌려준 «뒤»에 홀더 안에서 비동기로 일어난다(빈 pane · 즉시 exited).
 *  홀더 자식은 서버 환경을 상속한다(spawnHolderDetached env {...process.env, ...start.env} → startPty 가
 *  process.env 와 합침) — 같은 PATH 기준으로 스폰 «이전»에 점검해 실패 코드·사유를 core.newPane 의
 *  failed-to-spawn 변환(els new: 실패 코드·사유 계약)으로 그대로 돌려준다. */
function resolveCommandExecutable(head: string, cwd: string, env: Readonly<Record<string, string>>): string | undefined {
  if (isAbsolute(head)) return head;
  if (head.includes('/')) return resolve(cwd, head);
  const pathList = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathList.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, head);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next PATH entry */ }
  }
  return undefined;
}

/** D11 shebang 확장(JUD-B #107020 · OP #107012): X_OK 인 스크립트도 shebang 인터프리터가 없으면 커널
 *  execve 가 실패해 홀더 PTY 를 성공 반환 «뒤»에 비동기 종료한다(빈 pane · RES 독립 재현 3/3 → must 1).
 *  스폰 «전»에 첫 줄만 읽어 인터프리터(와 `env X` 꼴의 X)까지 점검해 els new 실패 코드·사유로 돌린다. */
const SHEBANG_PREFIX = '#!';
const SHEBANG_PEEK_BYTES = 256; // 출처: 첫 줄 점검용 읽기 상한 — 그 아래 줄은 실행 계약(execve)에 맡긴다

function readFirstLineBounded(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(SHEBANG_PEEK_BYTES);
    const size = readSync(fd, chunk, 0, chunk.length, 0);
    const text = chunk.toString('utf8', 0, size);
    const newline = text.indexOf('\n');
    if (newline < 0 && size === chunk.length) return undefined; // 첫 줄이 상한을 넘는다 — 점검 생략, 실행에 맡긴다
    return newline < 0 ? text : text.slice(0, newline);
  } finally { closeSync(fd); }
}

function shebangPreflightFailure(exe: string, cwd: string, env: Readonly<Record<string, string>>): string | undefined {
  let first: string | undefined;
  try { first = readFirstLineBounded(exe); } catch { return undefined; }
  if (!first || !first.startsWith(SHEBANG_PREFIX)) return undefined;
  const tokens = first.slice(SHEBANG_PREFIX.length).trim().split(/\s+/).filter((token) => token.length > 0);
  const interpreter = tokens[0];
  if (!interpreter || !interpreter.includes('/')) {
    return `spawn ${exe} ENOENT: missing shebang interpreter (${interpreter ?? 'empty'})`;
  }
  try { accessSync(interpreter, constants.X_OK); }
  catch { return `spawn ${exe} ENOENT: missing shebang interpreter (${interpreter})`; }
  if (interpreter.endsWith('/env')) {
    const target = tokens[1];
    const resolved = target ? resolveCommandExecutable(target, cwd, env) : undefined;
    if (!resolved) return `spawn ${exe} ENOENT: missing shebang interpreter (${target ?? 'env without an argument'})`;
  }
  return undefined;
}

function spawnPreflightFailure(command: readonly string[], cwd: string, env: Readonly<Record<string, string>>): string | undefined {
  try { if (!statSync(cwd).isDirectory()) return `spawn ${command[0]} ENOTDIR: cwd is not a directory (${cwd})`; }
  catch { return `spawn ${command[0]} ENOENT: no such file or directory (cwd ${cwd})`; }
  const exe = resolveCommandExecutable(command[0], cwd, env);
  if (!exe) return `spawn ${command[0]} ENOENT: no such file or directory`;
  try { accessSync(exe, constants.X_OK); }
  catch (error) {
    const code = (error as { readonly code?: string }).code;
    return code === 'EACCES' ? `spawn ${exe} EACCES: not executable` : `spawn ${exe} ENOENT: no such file or directory`;
  }
  return shebangPreflightFailure(exe, cwd, env);
}

/** 새 pane: detached 홀더를 띄우고 그 소켓에 붙는 어댑터를 돌려준다(server.ts 의 기본 spawn 계약). */
export function holderPty(stateRoot: string): (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>) => ElsPty {
  return (command, cwd, title, env) => {
    const paneId = env.ELANOUS_ELS_PANE;
    if (!paneId) throw new Error('els holder: ELANOUS_ELS_PANE is missing (newPane always sets it)');
    // D11: 스폰 «전» 점검 — 없는 실행 파일·cwd·shebang 인터프리터는 els new 가 실패 코드·사유로 거부한다(원문 invalid-and-spoof.raw · JUD-B #107020).
    const why = spawnPreflightFailure(command, cwd, env);
    if (why) throw new Error(why);
    // The server's one login capture rides to the holder; while it is still running the spawn waits for it (the adapter retries its connect).
    const generationNonce = randomUUID();
    void loginEnvForSpawn()
      .catch(() => undefined)
      .then((loginEnv) => { spawnHolderDetached({ stateRoot, paneId, cwd, title, env, command, generationNonce, ...(loginEnv === undefined ? {} : { loginEnv }) }); })
      .catch((error: unknown) => { process.stderr.write(`els holder: spawn failed for ${paneId}: ${error instanceof Error ? error.message : String(error)}\n`); });
    return connectHolderElsPty(stateRoot, paneId, undefined, processIdentity, createConnection, generationNonce);
  };
}

/** meta 가 가리키는 홀더가 «실제로 있는가» — 동기 점검: meta.pid(= PTY 자식)가 살아 있고 소켓 파일이 소켓이다.
 *  비정상 종료(SIGKILL·정전)는 홀더가 못 지운 meta·소켓만 남기므로 meta 존재만으로는 생존을 믿을 수 없다. */
function holderLooksReal(stateRoot: string, meta: HolderMeta): boolean {
  if (!Number.isInteger(meta.pid) || meta.pid <= 0) return false;
  try { process.kill(meta.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  try { return statSync(holderSocketPath(stateRoot, meta.paneId)).isSocket(); } catch { return false; }
}

/** 재기동: 살아 남은 홀더를 meta 로 찾아 재결속한다. meta 가 없거나 가리키는 홀더가 실재하지 않으면(죽은 pid · 소켓
 *  없음) 남은 meta 를 지우고 undefined — 호출자(core.start)가 저장 화면 복구 분기로 들어간다. 생존 판정을 통과한
 *  뒤 소켓이 끝내 안 열리는 경우(pid 재사용 등)는 어댑터의 연결 시한이 내린다(기존 계약).
 *  JUD #128534: 재결속도 홀더 세대를 확인한다 — meta 에 기록된(신뢰된) generation nonce 를 기대 nonce 로
 *  건네, 잘못된 세대의 홀더가 소켓에 답하면 pong 불일치로 거부한다(어댑터 즉시 종료 · 큐에 쌓인 제어 미전달).
 *  nonce 없는 meta 로 기록된 기존 홀더는 확인 없이 재결속한다(호환 범위 — 이전 홀더의 pong 에는 nonce 가 없다). */
export function reattachHolder(stateRoot: string, paneId: string, renewAdoptionSecret?: string): ElsPty | undefined {
  const metaPath = holderMetaPath(stateRoot, paneId);
  const meta = loadHolderMeta(metaPath);
  if (!meta) return undefined;
  if (!holderLooksReal(stateRoot, meta)) { removeHolderMeta(metaPath); return undefined; }
  return connectHolderElsPty(stateRoot, paneId, meta, processIdentity, createConnection, meta.generationNonce, renewAdoptionSecret);
}

// ── ELS-ORPHAN-SERVE-REAP(OP #131393③ · 골 #132048③): 아무도 소유하지 않은 홀더 잔재 회수 ────────
// SIGKILL 된 홀더는 자기 정리를 못 한다(meta·소켓·고아 PTY 자식이 남는다). 회수는 두 지점에서 일어난다:
// ① 이 프로세스가 띄운 홀더가 이벤트로 죽는 순간(spawnHolderDetached 의 exited 훅 — 폴링 아님),
// ② serve 기동 스윕(저널이 주장하지 않는 pane 의 잔재만 — 재결속이 판단할 pane 은 건드리지 않는다).

/** 하나의 pane 잔재 회수: meta 소각 → (실재하는 고아 PTY 자식이면)종료 → 소켓·스냅샷 제거.
 *  meta 를 «먼저» 지우는 것은 계약이다 — 살아 있는 홀더의 D1b 종료 flush 가 meta 부재를 보고 쓰기를
 *  그만두므로, 회수로 지운 스냅샷이 홀더의 마지막 flush 로 되살아나지 않는다. killPtyIfReal 은
 *  holderLooksReal(PTY 자식 생존 + 실제 소켓)을 통과한 경우에만 자식을 끊는다 — 무고한 pid 는 절대
 *  건드리지 않는다(fail-closed).
 *  OP #132417 필수 1: pid 생존·소켓 존재만 보고 신호를 보내면 pid 재사용에서 남의 프로세스를 종료할 수
 *  있다. 신호 «전»에 기록된 PTY 세대(processStart — 홀더가 bind 시점에 남긴 시작시각)와 현재 프로세스의
 *  시작시각이 같은 «같은 프로세스»일 때만 신호를 보낸다. 식별 불가(플랫폼 미지원으로 processStart 없음)·
 *  불일치면 신호를 건너뛰고 감사 1줄만 남긴다(파일 회수는 그대로 — 신호 없이도 잔재는 사라진다). */
export function reapHolderResidue(stateRoot: string, paneId: string, options: { readonly keepSnapshot: boolean; readonly killPtyIfReal: boolean }): void {
  const metaPath = holderMetaPath(stateRoot, paneId);
  const meta = loadHolderMeta(metaPath);
  removeHolderMeta(metaPath);
  if (options.killPtyIfReal && meta && holderLooksReal(stateRoot, meta)) {
    // 같은 프로세스 검증(OP #132417): meta.processStart 와 현재 pid 의 시작시각이 일치할 때만 신호.
    const now = processIdentity(meta.pid);
    const sameProcess = !!meta.processStart && !!now && now.start === meta.processStart;
    if (sameProcess) {
      try { process.kill(meta.pid, 'SIGTERM'); } catch { /* already gone */ }
    } else {
      process.stderr.write(`els holder: reap skipped SIGTERM for pane ${paneId} pid ${meta.pid} — pid identity unverified (reuse suspected); residue files reaped anyway\n`);
    }
  }
  try { unlinkSync(holderSocketPath(stateRoot, paneId)); } catch { /* absent */ }
  if (!options.keepSnapshot) { try { unlinkSync(holderSnapshotPath(stateRoot, paneId)); } catch { /* absent */ } }
}

/** serve 기동 스윕: holdersDir 안에서 저널이 주장하지 않는 pane 의 잔재를 회수한다. 죽은 홀더의 잔재
 *  (meta·소켓·스냅샷)는 지워지고, SIGKILL 된 serve 가 남긴 살아 있는 고아 홀더는 PTY 자식이 종료되어
 *  홀더의 자기 종료 경로로 사라진 뒤 잔재가 정리된다. meta 없는 소켓·스냅샷(아무도 입양할 수 없다)도
 *  잔재다. 저널이 주장하는 pane 의 파일은 재결속·D1b 복구 경로의 소유다 — 스윕은 절대 건드리지 않는다. */
export function sweepOrphanHolderResidue(stateRoot: string, claimed: (paneId: string) => boolean): void {
  let entries: readonly string[];
  try { entries = readdirSync(holdersDir(stateRoot)); } catch { return; }
  const names = new Set(entries);
  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.snap.json')) continue;
    const paneId = name.slice(0, -'.json'.length);
    if (claimed(paneId)) continue;
    reapHolderResidue(stateRoot, paneId, { keepSnapshot: false, killPtyIfReal: true });
  }
  for (const name of entries) {
    if (!name.endsWith('.sock')) continue;
    const paneId = name.slice(0, -'.sock'.length);
    if (claimed(paneId) || names.has(`${paneId}.json`)) continue;
    try { unlinkSync(holderSocketPath(stateRoot, paneId)); } catch { /* absent */ }
  }
  for (const name of entries) {
    if (!name.endsWith('.snap.json')) continue;
    const paneId = name.slice(0, -'.snap.json'.length);
    if (claimed(paneId) || names.has(`${paneId}.json`)) continue;
    try { unlinkSync(holderSnapshotPath(stateRoot, paneId)); } catch { /* absent */ }
  }
}
