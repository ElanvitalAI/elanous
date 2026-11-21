// holder 단위 리터럴 — D1a 첫 조각(OP #106188). ELS-SERVER-RESTART-SURVIVE: pane PTY 소유권이 els 서버 밖
// holder 프로세스로 옮겨졌는지를 서버 없이 홀더 혼자 검증한다(서버 재결속·재기동 생존 = 결합 리터럴 ①, 둘째 조각).
// 규칙 11: 모든 기대값은 이 파일 안의 독립 리터럴(제품 상수 import 0).

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { createLineDecoder } from './wire.js';
import {
  holderMetaPath, holderSocketPath, loadHolderMeta, spawnHolderDetached, startHolder, type HolderMessage,
} from './holder.js';

const cleanups: (() => Promise<void> | void)[] = [];
const ownerTokenBefore = process.env.ELANOUS_ELS_OWNER_TOKEN;   // saved once; the afterEach below restores process.env
afterEach(async () => {
  if (ownerTokenBefore === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ownerTokenBefore;
  const pending = [...cleanups];
  cleanups.length = 0;
  for (const cleanup of pending.reverse()) await cleanup();
});

// 출처: 독립 리터럴 — 규칙 11(이 시험 안에서 정한 경계 · 제품 상수 참조 0)
const LIT_COLS = 40;
const LIT_ROWS = 10;
const LIT_COLS_AFTER = 30;
const LIT_ROWS_AFTER = 8;
const LIT_GRACE_MS = 150;
// 출처: 독립 리터럴 — 실제 PTY 한 단계 대기 상한(attach-pty 시험과 같은 형태)
const LIT_WAIT_MS = 15_000;
const LIT_BOOT_MS = 20_000;
const LIT_POLL_MS = 20;
// 출처: OP 재배정 msg:105811 — «소켓 0700/0600» 계약(모드 비교 전체 마스크)
const LIT_MODE_MASK = 0o777;
const LIT_SOCKET_MODE = 0o700;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function connectOnce(socketPath: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => { socket.destroy(); resolve(undefined); });
  });
}

/** 살아 있는 홀더 소켓이 나올 때까지 잇는다(자식 홀더는 기동에 시간이 든다). */
async function connectHolder(socketPath: string, ms: number): Promise<Socket> {
  const stop = Date.now() + ms;
  for (;;) {
    const socket = await connectOnce(socketPath);
    if (socket) return socket;
    if (Date.now() > stop) throw new Error(`holder socket never answered at ${socketPath}`);
    await sleep(LIT_POLL_MS);
  }
}

/** 한 연결의 요청/방송 원문을 주고받는다: send 로 op 를, next 로 조건에 맞는 첫 메시지를 받는다. */
function holderClient(socket: Socket): {
  send(value: object): void;
  next(match: (message: HolderMessage) => boolean, ms: number): Promise<HolderMessage>;
} {
  let queue: HolderMessage[] = [];
  let waiters: Array<{ match: (message: HolderMessage) => boolean; resolve: (message: HolderMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];
  const dispatch = (message: HolderMessage): void => {
    const waiter = waiters.find((entry) => entry.match(message));
    if (waiter) {
      waiters = waiters.filter((entry) => entry !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue = [...queue, message];
  };
  const lines = createLineDecoder((line) => {
    try { dispatch(JSON.parse(line) as HolderMessage); } catch { /* not JSON: never a holder line */ }
  });
  socket.on('data', (chunk: Buffer) => { lines.push(chunk); });
  return {
    send(value: object): void { socket.write(`${JSON.stringify(value)}\n`); },
    next(match: (message: HolderMessage) => boolean, ms: number): Promise<HolderMessage> {
      const found = queue.find(match);
      if (found) {
        queue = queue.filter((message) => message !== found);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((entry) => entry.timer !== timer);
          reject(new Error('holder message did not arrive'));
        }, ms);
        waiters = [...waiters, { match, resolve, timer }];
      });
    },
  };
}

/** snapshot 을 요청해 화면에 글자가 보일 때까지 기다린다(PTY 기동·printf 는 비동기다). */
async function untilSnapshot(client: { send(value: object): void; next(match: (message: HolderMessage) => boolean, ms: number): Promise<HolderMessage> }, text: string, ms: number): Promise<Extract<HolderMessage, { type: 'snapshot' }>> {
  const stop = Date.now() + ms;
  client.send({ op: 'snapshot' });
  for (;;) {
    const snapshot = await client.next((message) => message.type === 'snapshot', Math.max(stop - Date.now(), LIT_POLL_MS));
    if (snapshot.type !== 'snapshot') throw new Error(`holder sent ${snapshot.type} instead of snapshot`);
    if (snapshot.screen.includes(text)) return snapshot;
    if (Date.now() > stop) throw new Error(`holder screen never showed ${text}`);
    await sleep(LIT_POLL_MS);
    client.send({ op: 'snapshot' });
  }
}

// ① 홀더가 pane PTY 를 소유한다: 소켓 0700 · meta 원장 · ping/snapshot · input/resize 전부 홀더 소켓으로 산다.
test('holder: owns the pane PTY behind a 0700 socket — meta, ping, snapshot, input and resize all answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-holder-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const holder = await startHolder({ stateRoot: root, paneId: 'lit-hold-1', cwd: root,
    command: ['/bin/sh', '-c', 'printf "holder-lit-open\\r\\n"; exec cat'], title: 'lit-hold-1',
    cols: LIT_COLS, rows: LIT_ROWS, exitGraceMs: LIT_GRACE_MS });
  cleanups.push(() => holder.close());
  expect(holder.meta.paneId).toBe('lit-hold-1');
  expect(Number.isInteger(holder.meta.pid)).toBe(true);
  const meta = loadHolderMeta(holderMetaPath(root, 'lit-hold-1'));
  expect(meta?.ptyId).toBe(holder.meta.ptyId);
  expect(meta?.cols).toBe(LIT_COLS);
  expect(statSync(holderSocketPath(root, 'lit-hold-1')).mode & LIT_MODE_MASK).toBe(LIT_SOCKET_MODE);

  const client = holderClient(await connectHolder(holderSocketPath(root, 'lit-hold-1'), LIT_WAIT_MS));
  client.send({ op: 'ping' });
  const pong = await client.next((message) => message.type === 'pong', LIT_WAIT_MS);
  if (pong.type !== 'pong') throw new Error('not a pong');
  expect(pong.paneId).toBe('lit-hold-1');
  expect(pong.pid).toBe(holder.meta.pid);
  const opened = await untilSnapshot(client, 'holder-lit-open', LIT_WAIT_MS);
  expect(opened.alive).toBe(true);
  expect(opened.cols).toBe(LIT_COLS);
  expect(opened.rows).toBe(LIT_ROWS);

  client.send({ op: 'input', bytes: 'holder-lit-echo\\r' });
  await client.next((message) => message.type === 'output' && message.chunk.includes('holder-lit-echo'), LIT_WAIT_MS);
  client.send({ op: 'resize', cols: LIT_COLS_AFTER, rows: LIT_ROWS_AFTER });
  const resized = await untilSnapshot(client, 'holder-lit-echo', LIT_WAIT_MS);
  expect(resized.cols).toBe(LIT_COLS_AFTER);
  expect(resized.rows).toBe(LIT_ROWS_AFTER);
}, LIT_BOOT_MS);

// ② 같은 pane 에 두 번째 홀더는 거부된다(산 홀더를 다시 만들지 않는다 — 재기동 서버는 재결속이다).
//    거부는 명령 스폰 «이전»에 일어난다(JUD-B M1 #106624): 두 번째 명령이 표지 파일을 만들도록 요청해도
//    소켓 소유권 확보 실패로 스폰 0 — 표지 파일이 남으면 이 계약이 깨진 것이다.
test('holder: a second holder for the same live pane is refused without running its command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-holderdup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const holder = await startHolder({ stateRoot: root, paneId: 'lit-hold-2', cwd: root,
    command: ['/bin/sh', '-c', 'exec cat'], title: 'lit-hold-2', cols: LIT_COLS, rows: LIT_ROWS, exitGraceMs: LIT_GRACE_MS });
  cleanups.push(() => holder.close());
  const marker = join(root, 'lit-hold-2-second-command-ran');
  let refused: unknown;
  try { await startHolder({ stateRoot: root, paneId: 'lit-hold-2', cwd: root,
    command: ['/bin/sh', '-c', `touch ${marker}; exec cat`], title: 'lit-hold-2' }); }
  catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain('already answers');
  // 출처: JUD-B M1(#106624) 리터럴 — 거부된 두 번째 홀더의 명령 부작용은 0(표지 파일 없음).
  expect(existsSync(marker)).toBe(false);
  const client = holderClient(await connectHolder(holderSocketPath(root, 'lit-hold-2'), LIT_WAIT_MS));
  client.send({ op: 'ping' });
  const pong = await client.next((message) => message.type === 'pong', LIT_WAIT_MS);
  if (pong.type !== 'pong') throw new Error('not a pong');
  expect(pong.pid).toBe(holder.meta.pid);
}, LIT_BOOT_MS);

// ③ kill 은 유일한 명시적 종료다: exit 메시지가 마지막 화면을 싣고, 소켓·meta 는 홀더가 스스로 지운다.
test('holder: kill ends the child with the final screen, then the holder removes its socket and meta', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-holderkill-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const holder = await startHolder({ stateRoot: root, paneId: 'lit-hold-3', cwd: root,
    command: ['/bin/sh', '-c', 'printf "holder-lit-final\\r\\n"; exec cat'], title: 'lit-hold-3',
    cols: LIT_COLS, rows: LIT_ROWS, exitGraceMs: LIT_GRACE_MS });
  cleanups.push(() => holder.close());
  const client = holderClient(await connectHolder(holderSocketPath(root, 'lit-hold-3'), LIT_WAIT_MS));
  await untilSnapshot(client, 'holder-lit-final', LIT_WAIT_MS);
  client.send({ op: 'kill' });
  const exit = await client.next((message) => message.type === 'exit', LIT_WAIT_MS);
  if (exit.type !== 'exit') throw new Error('not an exit');
  expect(exit.screen.includes('holder-lit-final')).toBe(true);
  const settled = await Promise.race([holder.done.then(() => 'done'), sleep(LIT_WAIT_MS).then(() => 'timeout')]);
  expect(settled).toBe('done');
  expect(existsSync(holderSocketPath(root, 'lit-hold-3'))).toBe(false);
  expect(existsSync(holderMetaPath(root, 'lit-hold-3'))).toBe(false);
}, LIT_BOOT_MS);

// ④ spawnHolderDetached 로 띄운 홀더 프로세스는 띄운 쪽과 운명을 함께하지 않는다: 소켓으로 홀로 응답하고 홀로 정리된다.
test('holder: a detached holder process answers on its socket independently of its spawner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-holderdet-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  spawnHolderDetached({ stateRoot: root, paneId: 'lit-detach-4', cwd: root,
    command: ['/bin/sh', '-c', 'printf "holder-lit-detach\\r\\n"; exec cat'], title: 'lit-detach-4', exitGraceMs: LIT_GRACE_MS });
  const socketPath = holderSocketPath(root, 'lit-detach-4');
  cleanups.push(async () => {
    const socket = await connectOnce(socketPath);
    if (socket) { socket.write(`${JSON.stringify({ op: 'kill' })}\n`); socket.destroy(); }
    const stop = Date.now() + LIT_WAIT_MS;
    while (existsSync(holderMetaPath(root, 'lit-detach-4')) && Date.now() < stop) await sleep(LIT_POLL_MS);
  });
  const client = holderClient(await connectHolder(socketPath, LIT_BOOT_MS));
  client.send({ op: 'ping' });
  const pong = await client.next((message) => message.type === 'pong', LIT_WAIT_MS);
  if (pong.type !== 'pong') throw new Error('not a pong');
  expect(pong.paneId).toBe('lit-detach-4');
  const detached = await untilSnapshot(client, 'holder-lit-detach', LIT_WAIT_MS);
  expect(detached.alive).toBe(true);
  expect(loadHolderMeta(holderMetaPath(root, 'lit-detach-4'))?.pid).toBe(pong.pid);
  client.send({ op: 'kill' });
  const stop = Date.now() + LIT_WAIT_MS;
  while (existsSync(holderMetaPath(root, 'lit-detach-4'))) {
    if (Date.now() > stop) throw new Error('detached holder did not clean up its meta');
    await sleep(LIT_POLL_MS);
  }
  expect(existsSync(socketPath)).toBe(false);
}, LIT_BOOT_MS + LIT_WAIT_MS);

// ⑤ ELS-BUILD-BADGE: the pane's own els identity (ELANOUS_ELS_WS/PANE/SOCKET/PANE_TOKEN) must reach the child through the real
// holder process — startPty rebuilds the child env from the login-shell capture, so a holder that does not hand it over
// leaves every pane without the credential its build report (and child tabs, self-context) needs. The owner token never goes down.
test('holder: a detached holder hands the pane its els identity and token, never the server owner token', async () => {
  const root = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'els-holderenv-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  process.env.ELANOUS_ELS_OWNER_TOKEN = 'lit-owner-secret';
  const priorCeoToken = process.env.ELANOUS_CEO_TELEGRAM_TOKEN;
  cleanups.push(() => { if (priorCeoToken === undefined) delete process.env.ELANOUS_CEO_TELEGRAM_TOKEN; else process.env.ELANOUS_CEO_TELEGRAM_TOKEN = priorCeoToken; });
  process.env.ELANOUS_CEO_TELEGRAM_TOKEN = 'synthetic-parent-bot-token';
  spawnHolderDetached({ stateRoot: root, paneId: 'lit-env-5', cwd: root, title: 'lit-env-5', exitGraceMs: LIT_GRACE_MS,
    env: { ELANOUS_ELS_WS: 'lit-ws', ELANOUS_ELS_PANE: 'lit-env-5', ELANOUS_ELS_SOCKET: '/lit/els.sock', ELANOUS_ELS_PANE_TOKEN: 'lit-pane-token' },
    command: ['/bin/sh', '-c', 'printf "lit-env:%s:%s:%s:%s:%s:%s\\r\\n" "$ELANOUS_ELS_WS" "$ELANOUS_ELS_PANE" "$ELANOUS_ELS_SOCKET" "$ELANOUS_ELS_PANE_TOKEN" "${ELANOUS_ELS_OWNER_TOKEN:-none}" "${ELANOUS_CEO_TELEGRAM_TOKEN:-none}"; exec cat'] });
  const socketPath = holderSocketPath(root, 'lit-env-5');
  cleanups.push(async () => {
    const socket = await connectOnce(socketPath);
    if (socket) { socket.write(`${JSON.stringify({ op: 'kill' })}\n`); socket.destroy(); }
    const stop = Date.now() + LIT_WAIT_MS;
    while (existsSync(holderMetaPath(root, 'lit-env-5')) && Date.now() < stop) await sleep(LIT_POLL_MS);
  });
  const client = holderClient(await connectHolder(socketPath, LIT_BOOT_MS));
  client.send({ op: 'ping' });
  await client.next((message) => message.type === 'pong', LIT_WAIT_MS);
  const shown = await untilSnapshot(client, 'lit-env:', LIT_WAIT_MS);
  expect(shown.screen).toContain('lit-env:lit-ws:lit-env-5:/lit/els.sock:lit-pane-token:none:none');
}, LIT_BOOT_MS + LIT_WAIT_MS);
