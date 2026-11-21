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
import { processIdentity } from './peer-seat.js';
import { createLineDecoder } from './wire.js';
import { loginEnvForSpawn } from './login-env-handoff.js';

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
  readonly processStart?: string;
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
      socketPath: raw.socketPath, startedAt: raw.startedAt, ...(typeof raw.processStart === 'string' && raw.processStart ? { processStart: raw.processStart } : {}), cols: raw.cols, rows: raw.rows };
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
  | { readonly op: 'kill' };

export type HolderMessage =
  | { readonly type: 'pong'; readonly paneId: string; readonly ptyId: string; readonly pid: number; readonly processStart?: string }
  | { readonly type: 'snapshot'; readonly paneId: string; readonly ptyId: string; readonly pid: number; readonly processStart?: string; readonly alive: boolean;
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
  const beforeSpawn = Date.now();
  try {
    handle = startPty({ cmd: start.command[0], args: start.command.slice(1), kind: 'shell', nickname: start.title,
      workdir: start.cwd, purpose: 'els-pane', env: { ...start.env, ELANOUS_CEO_TELEGRAM_TOKEN: '' },
      ...(start.cols !== undefined ? { cols: start.cols } : {}), ...(start.rows !== undefined ? { rows: start.rows } : {}) });
  } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* never spawned */ }
    throw error;
  }
  const born = processIdentity(handle.pid);
  const processStart = born?.pid === handle.pid && born.ppid === process.pid && born.startedMs >= beforeSpawn ? born.start : undefined;
  const meta: HolderMeta = { paneId: start.paneId, ptyId: handle.id, pid: handle.pid, cwd: start.cwd, command: [...start.command],
    title: start.title, socketPath, startedAt: handle.startedAt, ...(processStart ? { processStart } : {}), cols: handle.cols, rows: handle.rows };
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
        case 'ping': send({ type: 'pong', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid, ...(processStart ? { processStart } : {}) }); return;
        case 'input': handle.write(message.bytes); return;
        case 'write-all': await handle.writeAll(message.text); send({ type: 'wrote', paneId: meta.paneId }); return;
        case 'resize': handle.resize(message.cols, message.rows); return;
        case 'snapshot': send({ type: 'snapshot', paneId: meta.paneId, ptyId: handle.id, pid: handle.pid, ...(processStart ? { processStart } : {}), alive: handle.isAlive(),
          cols: handle.cols, rows: handle.rows, exitCode: handle.exitCode, bracketedPaste: handle.bracketedPasteEnabled(),
          lastOutputAt: handle.lastOutputAt ?? null, screen: await handle.renderScreen(message.ansi === true ? { ansi: true, ...(message.scrollBack ? { scrollBack: message.scrollBack } : {}) } : undefined) }); return;
        case 'kill': handle.kill(); return;
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
        void writeSnapshot(screen).catch(() => { /* best-effort */ });
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

/** els 서버가 pane 자식 대신 띄우는 detached holder 프로세스. 환경 = 서버 env ⊕ pane env(그대로 자식에게 내려간다). */
export function spawnHolderDetached(start: HolderStart & { readonly execPath?: string; readonly scriptPath?: string; readonly loginEnv?: string }): { readonly pid: number } {
  const scriptPath = start.scriptPath ?? fileURLToPath(new URL('./holder-main.ts', import.meta.url));
  const argv = [start.execPath ?? process.execPath, scriptPath,
    '--state-root', start.stateRoot, '--pane', start.paneId, '--cwd', start.cwd, '--title', start.title,
    ...(start.cols !== undefined ? ['--cols', String(start.cols)] : []),
    ...(start.rows !== undefined ? ['--rows', String(start.rows)] : []),
    ...(start.exitGraceMs !== undefined ? ['--grace-ms', String(start.exitGraceMs)] : []),
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
export function connectHolderElsPty(stateRoot: string, paneId: string, meta: HolderMeta | undefined, lookupIdentity = processIdentity): ElsPty {
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
    if ('paneId' in message && message.paneId !== paneId) {
      socket?.destroy();
      fireExit();
      return;
    }
    if (message.type === 'pong' || message.type === 'snapshot') {
      if (typeof message.ptyId !== 'string' || !message.ptyId || !Number.isSafeInteger(message.pid) || message.pid <= 0
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
      if (!identityEstablished) {
        processStart = verifiedStart;
        identityEstablished = true;
      } else if (processStart !== verifiedStart) {
        processStart = undefined;
      }
    }
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
    // Establish the holder generation before exposing its process identity to the server.
    pending.unshift({ resolve: () => {}, reject: () => {} });
    connected.write(`${JSON.stringify({ op: 'ping' })}\n`);
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
    // The server's one login capture rides to the holder; while it is still running the spawn waits for it (the adapter retries its connect).
    void loginEnvForSpawn()
      .catch(() => undefined)
      .then((loginEnv) => { spawnHolderDetached({ stateRoot, paneId, cwd, title, env, command, ...(loginEnv === undefined ? {} : { loginEnv }) }); })
      .catch((error: unknown) => { process.stderr.write(`els holder: spawn failed for ${paneId}: ${error instanceof Error ? error.message : String(error)}\n`); });
    return connectHolderElsPty(stateRoot, paneId, undefined);
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
 *  뒤 소켓이 끝내 안 열리는 경우(pid 재사용 등)는 어댑터의 연결 시한이 내린다(기존 계약). */
export function reattachHolder(stateRoot: string, paneId: string): ElsPty | undefined {
  const metaPath = holderMetaPath(stateRoot, paneId);
  const meta = loadHolderMeta(metaPath);
  if (!meta) return undefined;
  if (!holderLooksReal(stateRoot, meta)) { removeHolderMeta(metaPath); return undefined; }
  return connectHolderElsPty(stateRoot, paneId, meta);
}
