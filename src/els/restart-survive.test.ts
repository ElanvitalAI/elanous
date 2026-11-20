// D1a(ELS-SERVER-RESTART-SURVIVE) 서버 절 결합 리터럴 ① — OP 재배정 msg:105811 «서버가 죽거나 재기동해도
// pane 은 살아 있다». 첫 서버의 close() 는 홀더를 놓아주고(stopAll → detach), 두 번째 서버의 start() 가
// meta·소켓으로 재결속해 입양한다. 기대값은 전부 이 파일 안의 독립 리터럴이다(규칙 11 — 제품 상수 참조 0).
// 출처: seat-state/OP/orders/ELS-DEFECT-BOARD-1120.md D1a · OP 재배정 msg:105811.

import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { requestEls } from './client.js';
import { attachEls, type AttachFrame } from './attach-client.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, startElsServer } from './server.js';
import { connectHolderElsPty, reattachHolder, startHolder } from './holder.js';

// A Unix socket path holds at most 103 bytes (macOS): under a long TMPDIR the els server/holder socket would pass it,
// so a state dir falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();

const cleanups: (() => Promise<void> | void)[] = [];
// The in-process servers set the owner token in this process env (and these tests put a stale one back): every test ends on the env it began with.
const envAtStart = { owner: process.env[AUTH_OWNER_TOKEN_ENV], pane: process.env[AUTH_PANE_TOKEN_ENV] };
afterEach(async () => {
  const pending = [...cleanups];
  cleanups.length = 0;
  for (const cleanup of pending.reverse()) await cleanup();
  if (envAtStart.owner === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV]; else process.env[AUTH_OWNER_TOKEN_ENV] = envAtStart.owner;
  if (envAtStart.pane === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envAtStart.pane;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 실화면 한 단계 대기 상한(attach-pty 시험과 같은 형태)
const LIT_WAIT_MS = 15_000;
const LIT_POLL_MS = 20;
const LIT_TEST_MS = 60_000;
const until = async (check: () => Promise<boolean> | boolean, ms: number = LIT_WAIT_MS): Promise<void> => {
  const stop = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > stop) throw new Error('timed out waiting');
    await sleep(LIT_POLL_MS);
  }
};
/**
 * Since the #39143 door a no-credential caller cannot `send`; the same-process server's owner token is not an
 * OP-registered seat until the person's explicit `els seat set OP`. Register it once per server, over the real socket.
 */
async function seatOp(socket: string): Promise<void> {
  const registered = await requestEls(socket, { op: 'seat-set', seat: 'OP' });
  expect(registered).toEqual({ exitCode: 0, message: 'els seat: OP registered' });
}
const screenOf = async (socket: string, pane: string): Promise<string> => (await requestEls(socket, { op: 'read', pane })).message;

test('restart survive: the first server releases the pane holder; the next server adopts the same live pane', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-rst-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  await seatOp(socket);
  cleanups.push(() => first.close());
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  const sent = await requestEls(socket, { op: 'send', pane, text: 'echo RST_FIRST_ALIVE\r' });
  expect(sent.exitCode).toBe(0);
  await until(async () => (await screenOf(socket, pane)).includes('RST_FIRST_ALIVE'));

  // 서버 종료(D1a): stopAll 은 홀더를 죽이지 않고 연결만 놓는다 — pane 은 밖에서 살아 있다.
  await first.close();
  const second = await startElsServer({ stateRoot: root });
  if ('exitCode' in second) throw new Error(second.message);
  await seatOp(socket);
  cleanups.push(() => second.close());
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });

  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; ptyId: string; state: string }[] };
  const row = listed.panes.find((entry) => entry.pane === pane);
  expect(row?.ptyId).not.toBe('');
  expect(row?.state).not.toBe('exited');
  await until(async () => (await screenOf(socket, pane)).includes('RST_FIRST_ALIVE'));
  const typed = await requestEls(socket, { op: 'send', pane, text: 'echo RST_SECOND_ALIVE\r' });
  expect(typed.exitCode).toBe(0);
  await until(async () => (await screenOf(socket, pane)).includes('RST_SECOND_ALIVE'));

  // attach resumes: a real attach to the restarted server shows the pre-restart screen and its typed input reaches the pane.
  const frames: AttachFrame[] = [];
  const attached = attachEls(socket, pane, { cols: 90, rows: 20 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} });
  cleanups.push(() => attached.detach());
  const seen = (text: string): boolean => frames.some((frame) => frame.screen.includes(text));
  await until(() => seen('RST_FIRST_ALIVE'));
  attached.input('echo RST_ATTACH_$((6*7))_OK\r');
  await until(() => seen('RST_ATTACH_42_OK'));
  await until(async () => (await screenOf(socket, pane)).includes('RST_ATTACH_42_OK'));
}, LIT_TEST_MS); // 출처: attach-pty 시험과 같은 실화면 PTY 대기 상한 — 각 단계는 LIT_WAIT_MS 안에 끝난다

// D1a must-1(JUD-B #107693 · OP #107696): 우아한 서버 정지(close · els serve SIGTERM)는 attach 를 «pane exited» 가
// 아니라 «the server is stopping» 으로 끝낸다 — 홀더가 자식을 살려 두므로, 클라는 그 end 를 재기동 대기로 탄다.
// JUD-B 재현 그대로: 첫 서버 close → (클라) end 대기 → 새 서버 재부착 → 같은 자식 화면.
test('restart survive: a graceful close ends the attach as the server going away; the next server re-attaches the same live pane', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-rst-grace-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  cleanups.push(() => first.close());
  await seatOp(socket);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  const sent = await requestEls(socket, { op: 'send', pane, text: 'echo GRACE_CLOSE_ALIVE\r' });
  expect(sent.exitCode).toBe(0);
  await until(async () => (await screenOf(socket, pane)).includes('GRACE_CLOSE_ALIVE'));
  const ends: [number, string][] = [];
  const screens: string[] = [];
  const attached = attachEls(socket, pane, { cols: 51, rows: 22 }, { // 출처: attach-app 시험과 같은 화면 크기(51x22)
    onFrame: (frame) => { screens.push(frame.screen); },
    onEnd: (code, reason) => { ends.push([code, reason]); },
  });
  await until(async () => screens.some((screen) => screen.includes('GRACE_CLOSE_ALIVE')));
  // 우아 정지: close() 는 attach 연결을 stopAll 앞에 서버 떠남으로 끝낸다(기대: [1, 'the server is stopping']).
  const closing = first.close();
  await until(() => ends.length > 0);
  expect(ends).toEqual([[1, 'the server is stopping']]);   // 독립 리터럴: 우아 종료의 end 코드·사유(0/'pane exited' 아님)
  await closing;
  const second = await startElsServer({ stateRoot: root });
  if ('exitCode' in second) throw new Error(second.message);
  cleanups.push(() => second.close());
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
  await seatOp(socket);
  // 같은 자식: 새 서버가 홀더를 입양하고, 새 attach 의 첫 프레임이 첫 서버 시절의 화면을 그대로 다시 그린다.
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; ptyId: string; state: string }[] };
  const row = listed.panes.find((entry) => entry.pane === pane);
  expect(row?.ptyId).not.toBe('');          // 독립 리터럴: 홀더 재발견(ptyId 유지)
  expect(row?.state).not.toBe('exited');    // 독립 리터럴: 같은 자식이 살아 있다
  const before = screens.length;
  const reattached = attachEls(socket, pane, { cols: 51, rows: 22 }, { // 출처: 위와 같은 화면 크기(51x22)
    onFrame: (frame) => { screens.push(frame.screen); },
    onEnd: (code, reason) => { ends.push([code, reason]); },
  });
  cleanups.push(() => { try { reattached.detach(); } catch { /* already detached */ } });
  await until(() => screens.length > before);            // 출처: 새 attach 의 첫 프레임 1개 도달(프레임 수 증가)
  expect(screens.at(-1)).toContain('GRACE_CLOSE_ALIVE'); // 독립 리터럴: 첫 서버 시절 화면이 그대로 재부착됐다
  // main's send family (#39168) types cleaned text and never presses Enter, so the marker is short enough not to wrap at 51 cols.
  const typed = await requestEls(socket, { op: 'send', pane, text: 'GRACE_2ND' });
  expect(typed.exitCode).toBe(0);
  await until(async () => (await screenOf(socket, pane)).includes('GRACE_2ND'));
  expect(ends).toEqual([[1, 'the server is stopping']]);  // 독립 리터럴: 전체에서 end 는 우아 종료 한 번뿐(«pane exited» 0회)
}, LIT_TEST_MS); // 출처: attach-pty 시험과 같은 실화면 PTY 대기 상한 — 각 단계는 LIT_WAIT_MS 안에 끝난다

// D1a r2 (JUD-CONFIRM #39155 · reattach after a restart): an owner terminal (`els attach` run by the person) holds the OWNER
// token of the server it started with. A restart mints a new one (written next to the socket), so the reattach must present
// the CURRENT one — with the old env token it was an outsider: view-only, typing silently refused.
test('restart survive: after a restart the owner terminal re-attaches with the new owner token and its typing reaches the same child', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-rst-type-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  cleanups.push(() => first.close());
  await seatOp(socket);
  const ownerTokenOfFirstRun = process.env[AUTH_OWNER_TOKEN_ENV]!;
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  const ends: [number, string][] = [];
  const errors: string[] = [];
  const screens: string[] = [];
  const attached = attachEls(socket, pane, { cols: 51, rows: 22 }, { onFrame: (frame) => { screens.push(frame.screen); }, onEnd: (code, reason) => { ends.push([code, reason]); }, onError: (message) => { errors.push(message); } });
  await until(() => screens.length > 0);
  attached.input('echo TYPE_BEFORE_RESTART\r');
  await until(() => screens.some((screen) => screen.includes('TYPE_BEFORE_RESTART')));
  await first.close();
  await until(() => ends.length > 0);
  const second = await startElsServer({ stateRoot: root });
  if ('exitCode' in second) throw new Error(second.message);
  cleanups.push(() => second.close());
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
  // This process env now holds the second run's token (the in-process server sets it); the owner TERMINAL is another process
  // that still carries the first run's token — put it back so the reattach starts from exactly that stale credential.
  expect(process.env[AUTH_OWNER_TOKEN_ENV]).not.toBe(ownerTokenOfFirstRun);
  process.env[AUTH_OWNER_TOKEN_ENV] = ownerTokenOfFirstRun;
  delete process.env[AUTH_PANE_TOKEN_ENV];
  const after: string[] = [];
  const reattached = attachEls(socket, pane, { cols: 51, rows: 22 }, { onFrame: (frame) => { after.push(frame.screen); }, onEnd: () => {}, onError: (message) => { errors.push(message); } });
  cleanups.push(() => { try { reattached.detach(); } catch { /* already detached */ } });
  await until(() => after.length > 0);
  expect(after[0]).toContain('TYPE_BEFORE_RESTART');                   // the same child, the same screen
  reattached.input('echo TYPE_AFTER_RESTART\r');
  await until(() => after.some((screen) => screen.includes('TYPE_AFTER_RESTART')));   // one typed line reached the child through the attach
  expect(errors).toEqual([]);                                          // and nothing was refused on the way
}, LIT_TEST_MS);

// The owner-token file belongs to the RUNNING server: a second start that is refused («already answers») must not rewrite it,
// or an owner terminal re-reading it after a restart gets a token no server knows.
test('a refused second start leaves the live server\'s owner-token file alone', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-rst-tok-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  cleanups.push(() => first.close());
  const tokenFile = join(root, 'els', 'owner-token');
  const liveToken = readFileSync(tokenFile, 'utf8');
  expect(liveToken).toMatch(/^\S+$/);
  const liveEnv = process.env[AUTH_OWNER_TOKEN_ENV];
  const second = await startElsServer({ stateRoot: root });
  expect('exitCode' in second ? second.message : 'started').toContain('already answers');
  process.env[AUTH_OWNER_TOKEN_ENV] = liveEnv;                       // the refused start also touched this process env — not under test here
  expect(readFileSync(tokenFile, 'utf8')).toBe(liveToken);
});

// D11(RES 2회차 ced7641f · OP #106630): 없는 실행 파일로 els new 를 열면 exit 0·빈 pane 이 아니라
// 실패 코드·사유로 거부된다 — detached 홀더 스폰이 성공해도 커맨드 스폰 실패는 els new 응답 «전»에 밝혀야 한다.
// (원문: bad_command_exit=0 · p506bcc51 exited — seat-state/RES-INFRA/evidence/20261120/els-round2-ced/)
test('restart survive: a missing executable is refused by els new with a reason and leaves no pane behind', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d11-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const server = await startElsServer({ stateRoot: root });
  if ('exitCode' in server) throw new Error(server.message);
  await seatOp(socket);
  cleanups.push(() => server.close());
  const bad = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/not/a/real/command'] });
  expect(bad.exitCode).toBe(1);                            // 독립 리터럴: 실패 코드(exit 0·주소 아님)
  expect(bad.message).toContain('failed to spawn');        // 독립 리터럴: core.newPane 실패 사유 접두
  expect(bad.message).toContain('/not/a/real/command');    // 독립 리터럴: 문제의 실행 파일 이름
  expect(bad.message).toContain('ENOENT');                 // 독립 리터럴: 사유 코드
  const bare = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['els-d11-no-such-command'] });
  expect(bare.exitCode).toBe(1);
  expect(bare.message).toContain('ENOENT');
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string }[] };
  expect(listed.panes).toEqual([]);                        // 독립 리터럴: 실패 스폰은 pane 원장에 남기지 않는다
}, LIT_TEST_MS);

// D11 shebang(JUD-B #107015/#107017 · OP #107012): X_OK 스크립트의 shebang 인터프리터가 없으면 커널
// execve 실패가 성공 pane 반환 «뒤» 비동기 종료된다(RES 독립 3/3 재현 → must 1). 스폰 전 점검이 실패
// 코드·사유로 거부하고 pane 을 남기지 않는다 — 좋은 shebang 은 그대로 스폰된다(회귀 가드).
test('restart survive: a script whose shebang interpreter is missing is refused up front, a good shebang still spawns', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d11s-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const server = await startElsServer({ stateRoot: root });
  if ('exitCode' in server) throw new Error(server.message);
  await seatOp(socket);
  cleanups.push(() => server.close());
  const bad = join(root, 'lit-bad-shebang.sh');
  writeFileSync(bad, '#!/no/such/interp/lit-d11\nexit 0\n');
  chmodSync(bad, 0o755);                                          // 출처: 실행 권한 — X_OK 는 통과하되 인터프리터가 없는 경계
  const refused = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: [bad] });
  expect(refused.exitCode).toBe(1);                                // 독립 리터럴: 실패 코드(성공·주소 아님)
  expect(refused.message).toContain('failed to spawn');           // 독립 리터럴: core.newPane 실패 사유 접두
  expect(refused.message).toContain('missing shebang interpreter'); // 독립 리터럴: 사유 문구
  expect(refused.message).toContain('ENOENT');                    // 독립 리터럴: 사유 코드
  const envBad = join(root, 'lit-bad-env-shebang.sh');
  writeFileSync(envBad, '#!/usr/bin/env lit-no-such-tool-d11\nexit 0\n');
  chmodSync(envBad, 0o755);                                       // 출처: 같은 경계의 env 꼴 — PATH 에 없는 도구
  const envRefused = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: [envBad] });
  expect(envRefused.exitCode).toBe(1);                            // 독립 리터럴: 실패 코드
  expect(envRefused.message).toContain('lit-no-such-tool-d11');   // 독립 리터럴: 문제의 인터프리터 이름
  const good = join(root, 'lit-good-shebang.sh');
  writeFileSync(good, '#!/bin/sh\necho SHEBANG_OK_LIT_D11\n');
  chmodSync(good, 0o755);                                         // 출처: 회귀 가드 — 정상 shebang 은 거부되지 않는다
  const spawned = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: [good] });
  expect(spawned.exitCode).toBe(0);                               // 독립 리터럴: 정상 스폰 성공 코드
  const goodPane = JSON.parse(spawned.message) as { pane: string };
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane: goodPane.pane }); });
  await until(async () => (await screenOf(socket, goodPane.pane)).includes('SHEBANG_OK_LIT_D11'));
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string }[] };
  expect(listed.panes.map((row) => row.pane)).toEqual([goodPane.pane]); // 독립 리터럴: 거부된 스폰은 원장에 남지 않고 좋은 스폰만 남는다
}, LIT_TEST_MS);

test('holder adapter: detach leaves the holder serving; reattachHolder adopts it again by its meta', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-hold-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const holder = await startHolder({ stateRoot: root, paneId: 'lit-rst-pane', cwd: root, command: ['/bin/sh'], title: 'lit' });
  cleanups.push(() => holder.close());
  const adapter = connectHolderElsPty(root, 'lit-rst-pane', undefined);
  adapter.write('echo ADAPTER_DETACH_OK\r');
  await until(async () => (await adapter.renderScreen()).includes('ADAPTER_DETACH_OK'));
  if (!adapter.detach) throw new Error('holder adapter must expose detach');
  adapter.detach();
  expect(adapter.isAlive()).toBe(false);
  // 홀더는 여전히 산다 — meta 로 재결속하고 같은 화면을 이어서 본다.
  const back = reattachHolder(root, 'lit-rst-pane');
  expect(back).toBeDefined();
  await until(async () => (await back!.renderScreen()).includes('ADAPTER_DETACH_OK'));
  back!.write('echo REATTACH_SECOND_OK\r');
  await until(async () => (await back!.renderScreen()).includes('REATTACH_SECOND_OK'));
  back!.kill();
}, LIT_TEST_MS); // 출처: attach-pty 시험과 같은 실화면 PTY 대기 상한 — 각 단계는 LIT_WAIT_MS 안에 끝난다

/** createElsCore 의 가짜 PTY — detach/kill 호출만 기록한다(숫자 리터럴 없음). */
const fakePty = (id: string, log: string[], withDetach: boolean): ElsPty => ({
  id,
  isAlive: () => true,
  write: () => {},
  renderScreen: async () => 'screen',
  onExit: () => {},
  kill: () => { log.push(`kill:${id}`); },
  ...(withDetach ? { detach: () => { log.push(`detach:${id}`); } } : {}),
});

test('stopAll releases holder adapters (detach) and still kills direct PTYs', () => {
  const log: string[] = [];
  let saved: SpaceJournal = emptyJournal();
  let firstCall = true;
  const core = createElsCore({ load: () => saved, save: (journal) => { saved = journal; },
    spawn: () => { const withDetach = firstCall; firstCall = false; return fakePty(withDetach ? 'fx-hold' : 'fx-plain', log, withDetach); } });
  expect(core.start()).toBeUndefined();
  expect(core.newPane({ ws: 'A', cwd: tmpdir(), command: ['sh'] }).exitCode).toBe(0);
  expect(core.newPane({ ws: 'A', cwd: tmpdir(), command: ['sh'] }).exitCode).toBe(0);
  core.stopAll();
  expect(log).toEqual(['detach:fx-hold', 'kill:fx-plain']);
});

test('start adopts a pane whose PTY an outside holder still owns, and clears the rest', () => {
  const log: string[] = [];
  let saved: SpaceJournal = emptyJournal();
  const first = createElsCore({ load: () => saved, save: (journal) => { saved = journal; },
    spawn: () => fakePty('fx-live', log, true) });
  expect(first.start()).toBeUndefined();
  expect(first.newPane({ ws: 'A', cwd: tmpdir(), command: ['sh'] }).exitCode).toBe(0);
  const paneId = saved.panes.find(() => true)!.id;
  first.stopAll();
  expect(log).toEqual(['detach:fx-live']);
  // 홀더가 살아 있다(가짜): 두 번째 서버는 그 PTY 를 입양해 그대로 이어간다.
  const second = createElsCore({ load: () => saved, save: (journal) => { saved = journal; },
    spawn: () => { throw new Error('spawn must not be called'); },
    reattach: (pane) => pane.ptyId === 'fx-live' ? fakePty('fx-live', log, true) : undefined });
  expect(second.start()).toBeUndefined();
  const adopted = saved.panes.find((pane) => pane.id === paneId)!;
  expect(adopted.ptyId).toBe('fx-live');
  expect(adopted.state).toBe('working');
  // 홀더가 없다(세 번째 서버): 예전 계약 그대로 ptyId 소거 + idle.
  const third = createElsCore({ load: () => saved, save: (journal) => { saved = journal; },
    spawn: () => { throw new Error('spawn must not be called'); } });
  expect(third.start()).toBeUndefined();
  const cleared = saved.panes.find((pane) => pane.id === paneId)!;
  expect(cleared.ptyId).toBe('');
  expect(cleared.state).toBe('idle');
});
