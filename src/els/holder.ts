// els holder — D1a(ELS-SERVER-RESTART-SURVIVE): pane PTY 의 소유권을 els 서버 밖의 holder 프로세스로 옮긴다.
// dtach 꼴: pane 당 하나의 holder 가 PTY 를 쥐고(소켓 0700), 서버와 attach 클라이언트는 소켓 라인 JSON 으로
// 입출력·resize·화면 snapshot 을 주고받는다. 서버가 죽거나 재기동해도 holder 와 자식은 살아 있고, 다음 서버가
// meta 원장(0600)과 소켓으로 재결속한다. 자식은 명시적 kill op(«els kill/close»)이나 holder 종료로만 죽는다.
// 출처: seat-state/OP/orders/ELS-DEFECT-BOARD-1120.md D1a · OP 재배정 msg:105811 · 결함판 40행.

import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onPtyEvent, startPty, unregisterPty } from '../pty-shell/registry.js';
import type { ElsPty } from './core.js';
import { createLineDecoder } from './wire.js';

// 출처: sockaddr_un.sun_path 상한 — src/els/server.ts MAX_SOCKET_PATH_BYTES 와 같은 값(holder 소켓 경로가
// els.sock 보다 길어 서버와 같은 상한으로 거부해야 한다; server.ts 를 import 하면 2번 조각과 순환이 생겨 값 고정).
const MAX_SOCKET_PATH_BYTES = 103;

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
      socketPath: raw.socketPath, startedAt: raw.startedAt, cols: raw.cols, rows: raw.rows };
  } catch { return undefined; }
}

export function removeHolderMeta(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

export type HolderRequest =
  | { readonly op: 'ping' }
  | { readonly op: 'input'; readonly bytes: string }
  | { readonly op: 'write-all'; readonly text: string }
  | { readonly op: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly op: 'snapshot'; readonly ansi?: boolean }
  | { readonly op: 'kill' };

export type HolderMessage =
  | { readonly type: 'pong'; readonly paneId: string; readonly ptyId: string; readonly pid: number }
  | { readonly type: 'snapshot'; readonly paneId: string; readonly ptyId: string; readonly pid: number; readonly alive: boolean;
      readonly cols: number; readonly rows: number; readonly exitCode: number | null; readonly bracketedPaste: boolean;
      readonly lastOutputAt: number | null; readonly screen: string }
  | { readonly type: 'output'; readonly paneId: string; readonly chunk: string }
  | { readonly type: 'exit'; readonly paneId: string; readonly exitCode: number | null; readonly screen: string }
  | { readonly type: 'wrote'; readonly paneId: string }
  | { readonly type: 'error'; readonly message: string };

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
    const send = (message: HolderMessage): void => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
    const lines = createLineDecoder((line) => { void request(line, send); });
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
  try {
    handle = startPty({ cmd: start.command[0], args: start.command.slice(1), kind: 'shell', nickname: start.title,
      workdir: start.cwd, purpose: 'els-pane', env: { ...start.env },
      ...(start.cols !== undefined ? { cols: start.cols } : {}), ...(start.rows !== undefined ? { rows: start.rows } : {}) });
  } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* never spawned */ }
    throw error;
  }
  const meta: HolderMeta = { paneId: start.paneId, ptyId: handle.id, pid: handle.pid, cwd: start.cwd, command: [...start.command],
    title: start.title, socketPath, startedAt: handle.startedAt, cols: handle.cols, rows: handle.rows };
  const metaPath = holderMetaPath(start.stateRoot, start.paneId);
  try { saveHolderMeta(metaPath, meta); } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* never bound */ }
    try { handle.kill('SIGKILL'); } catch { /* just spawned */ }
    throw error;
  }

  const request = async (line: string, send: (message: HolderMessage) => void): Promise<void> => {
    let message: HolderRequest;
    try { message = JSON.parse(line) as HolderRequest; } catch { send({ type: 'error', message: 'els holder: malformed line' }); return; }
    try {
      switch (message.op) {
        case 'ping': send({ type: 'pong', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid }); return;
        case 'input': handle.write(message.bytes); return;
        case 'write-all': await handle.writeAll(message.text); send({ type: 'wrote', paneId: meta.paneId }); return;
        case 'resize': handle.resize(message.cols, message.rows); return;
        case 'snapshot': send({ type: 'snapshot', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid, alive: handle.isAlive(),
          cols: handle.cols, rows: handle.rows, exitCode: handle.exitCode, bracketedPaste: handle.bracketedPasteEnabled(),
          lastOutputAt: handle.lastOutputAt ?? null, screen: await handle.renderScreen(message.ansi === true ? { ansi: true } : undefined) }); return;
        case 'kill': handle.kill(); return;
        default: send({ type: 'error', message: 'els holder: unknown op' });
      }
    } catch (error) { send({ type: 'error', message: `els holder: ${error instanceof Error ? error.message : String(error)}` }); }
  };

  // 종료: PTY 끝 → 마지막 화면 방송 → grace → 정리. 접속 끊김은 그 어느 것도 건드리지 않는다(serveAttach 계약).
  let closed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const offOutput = onPtyEvent((event) => {
    if (event.type === 'output' && event.id === handle.id) broadcast({ type: 'output', paneId: meta.paneId, chunk: event.chunk });
  });
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { markDone = resolve; });
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (graceTimer) clearTimeout(graceTimer);
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
      (screen) => broadcast({ type: 'exit', paneId: meta.paneId, exitCode: handle.exitCode, screen }),
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
      try { if (handle.isAlive()) handle.kill('SIGKILL'); } catch { /* already gone */ }
      await cleanup();
      markDone();
    },
  };
}

/** els 서버가 pane 자식 대신 띄우는 detached holder 프로세스. 환경 = 서버 env ⊕ pane env(그대로 자식에게 내려간다). */
export function spawnHolderDetached(start: HolderStart & { readonly execPath?: string; readonly scriptPath?: string }): { readonly pid: number } {
  const scriptPath = start.scriptPath ?? fileURLToPath(new URL('./holder-main.ts', import.meta.url));
  const argv = [start.execPath ?? process.execPath, scriptPath,
    '--state-root', start.stateRoot, '--pane', start.paneId, '--cwd', start.cwd, '--title', start.title,
    ...(start.cols !== undefined ? ['--cols', String(start.cols)] : []),
    ...(start.rows !== undefined ? ['--rows', String(start.rows)] : []),
    ...(start.exitGraceMs !== undefined ? ['--grace-ms', String(start.exitGraceMs)] : []),
    '--', ...start.command];
  const child = Bun.spawn(argv, { cwd: start.cwd, env: { ...process.env, ...start.env },
    stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  child.unref();
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

/** 홀더 소켓에 붙는 ElsPty — 연결·재시도·exit 방송·쓰기 큐를 한데 묶는다(기동 전 쓰기는 소켓 뒤에 쌓인다). */
export function connectHolderElsPty(stateRoot: string, paneId: string, meta: HolderMeta | undefined): ElsPty {
  const id = holderAdapterId(paneId);
  const socketPath = holderSocketPath(stateRoot, paneId);
  let alive = true;
  let detached = false;
  let exited = false;
  let bracketedPaste = false;
  let lastOutputAt: number | undefined;
  let pidNow = meta?.pid;
  let lastScreen: string | undefined;
  let killQueued = false;
  let socket: Socket | undefined;
  const exitCbs = new Set<() => void>();
  const outputCbs = new Set<(chunk: string) => void>();
  const pending: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const outbox: string[] = [];
  const settle = (waiting: { resolve(text: string): void; reject(error: Error): void }[]): void => {
    for (const waiter of waiting) waiter.reject(new Error('els holder: connection lost'));
  };
  const fireExit = (): void => {
    if (exited || detached) return;
    exited = true;
    alive = false;
    settle(pending.splice(0));
    for (const cb of [...exitCbs]) { try { cb(); } catch { /* a listener */ } }
  };
  // 죽은 홀더가 남긴 meta 는 다음 재시작이 다시 기다리지 않도록 지운다(홀더가 못 지운 것이다).
  const giveUp = (): void => { removeHolderMeta(holderMetaPath(stateRoot, paneId)); fireExit(); };
  const push = (value: object): void => {
    const line = `${JSON.stringify(value)}\n`;
    if (socket && !socket.destroyed) socket.write(line); else outbox.push(line);
  };
  const onMessage = (message: HolderMessage): void => {
    switch (message.type) {
      case 'pong': pidNow = message.pid; pending.shift()?.resolve(''); return;
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
      case 'error': pending.shift()?.reject(new Error(message.message)); return;
    }
  };
  const attach = (connected: Socket): void => {
    socket = connected;
    const lines = createLineDecoder((line) => { try { onMessage(JSON.parse(line) as HolderMessage); } catch { /* not a holder line */ } });
    connected.on('data', (chunk: Buffer) => { lines.push(chunk); });
    connected.on('error', () => { connected.destroy(); });
    connected.on('close', () => {
      if (socket !== connected) return;
      socket = undefined;
      // detach 한 뒤가 아니라면 홀더가 사라진 것이다 — 이 pane 의 생애도 끝난다(exit 방송이 마지막 화면을 실어 왔다).
      if (!detached) fireExit();
    });
    for (const line of outbox.splice(0)) connected.write(line);
    if (killQueued) connected.write(`${JSON.stringify({ op: 'kill' })}\n`);
  };
  const attempt = (): void => {
    if (detached || exited || socket) return;
    const connected = createConnection(socketPath);
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
      push({ op: 'snapshot', ...(options?.ansi ? { ansi: true } : {}) });
    }),
    onExit: (cb) => { if (exited) { try { cb(); } catch { /* a listener */ } return; } exitCbs.add(cb); },
    kill: () => {
      if (exited || detached) return;
      killQueued = true;
      if (socket && !socket.destroyed) socket.write(`${JSON.stringify({ op: 'kill' })}\n`);
    },
    resize: (cols, rows) => { if (detached || exited) return; push({ op: 'resize', cols, rows }); },
    onOutput: (cb) => {
      outputCbs.add(cb);
      return { dispose: () => { outputCbs.delete(cb); } };
    },
    detach: () => {
      // D1a: 서버 종료 — 연결만 놓는다. 홀더와 자식은 살아 있고, 다음 서버가 meta·소켓으로 재결속한다.
      if (detached) return;
      detached = true;
      alive = false;
      settle(pending.splice(0));
      outbox.length = 0;
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
    spawnHolderDetached({ stateRoot, paneId, cwd, title, env, command });
    return connectHolderElsPty(stateRoot, paneId, undefined);
  };
}

/** 재기동: 살아 남은 홀더를 meta 로 찾아 재결속한다; meta 가 없으면 undefined(죽은 홀더 판정은 어댑터가 내린다). */
export function reattachHolder(stateRoot: string, paneId: string): ElsPty | undefined {
  const meta = loadHolderMeta(holderMetaPath(stateRoot, paneId));
  if (!meta) return undefined;
  return connectHolderElsPty(stateRoot, paneId, meta);
}
