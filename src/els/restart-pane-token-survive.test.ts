// ELS-RESTART-PANE-TOKEN-SURVIVE P0 (OP #128343 · 승인 #128469 · OP #128325): 서버 재기동은 PaneRegistry
// (byToken·spawnBindings)를 메모리에서 잃는다 — 살아남은 홀더의 pane 자식이 자기 env 의 서버발급 pane 토큰을
// 제시하면 «els: invalid credential» 로 거부된다(재기동 전에는 hand/op 역할로 분류되던 토큰). OP 승인 방향:
// 재기동 후 생존 홀더 입양 시 holder 가 가진 pane 토큰을 서버가 재등록(저널 ownerSeat·workspace 로 역할 복원,
// 홀더가 증명한 토큰만, 회수·충돌 토큰은 재등록 거부 → 읽기 전용). 음성 경계는 JUD #128320·#128323 답변 범위.
// 출처: seat-state/OP/orders/OP-128343 · OP 승인 msg #128469 · 결함원인 server-auth.ts L50-55 · server.ts auth 즉거부.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, startElsServer } from './server.js';
import { holderMetaPath, holderSocketPath, loadHolderMeta } from './holder.js';
import { processIdentity } from './peer-seat.js';
import { requestEls } from './client.js';
import type { ElsResult } from './core.js';

// 이 자리는 실 els pane 안이다 — 앰비언트 자격/상태 환경이 격리 우주를 오염시켜 «malformed answer» 오진을
// 낳는다(attach 16/16 교훈·malformed 재구성 §3: 환경 토큰 → paneAuth 핸드셰이크 → invalid credential → malformed
// 오기록). 시험 전에 훑어 비우고 끝나면 되돌린다.
const AMBIENT_ELS_ENV_KEYS = [
  'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET',
  'ELANOUS_ELS_WS', 'ELANOUS_ELS_RUNTIME_TOKEN_FILE', 'ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE',
] as const;
const ambientAtStart: Record<string, string | undefined> = Object.fromEntries(
  AMBIENT_ELS_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of AMBIENT_ELS_ENV_KEYS) delete process.env[key];
// 스크럽은 매 시험마다 다시 — afterEach 의 복원이 다음 시험을 오염시킨다(attach 16/16 교훈: 복원된 실자리
// 토큰이 paneAuth 핸드셰이크를 발동 → invalid credential → «malformed» 오기록으로 좌초).
beforeEach(() => {
  for (const key of AMBIENT_ELS_ENV_KEYS) delete process.env[key];
  // node-b 게이트 호스트의 로그인 셸 캡처는 3s SIGKILL 상한을 넘겨 실패한다(옵트아웃 아님 → fail-closed 정상
  // 거부 — fc5 focused 원문: input op exitCode 1). 이 파일의 계약(토큰 생존)은 캡처와 무관하므로 설계된
  // 옵트아웃 경로로 결정론화한다. 옵트아웃 누출은 holder.ts startPty unsetEnv 가 막는다(JUD-2 필수 1 · #131893).
  process.env.ELANOUS_SKIP_LOGIN_ENV = '1';
});

// 출처: restart-survive.test.ts L20 과 같은 형태 — 긴 TMPDIR 아래에서 소켓 경로 상한(103B)을 넘지 않게 /tmp 로.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();

const cleanups: (() => Promise<void> | void)[] = [];
// 인-프로세스 서버는 이 프로세스 env 에 owner 토큰을 얹는다(startElsServer) — 시험은 시작 env 로 끝난다(출처: restart-survive.test.ts L23-31).
const envAtStart = { owner: process.env[AUTH_OWNER_TOKEN_ENV], pane: process.env[AUTH_PANE_TOKEN_ENV] };
// node-b 게이트 호스트 대비 결정론화(아래 beforeEach 주석) — 이 파일 전체에서 로그인 셸 캡처를 설계 옵트아웃으로 건너뛴다.
const skipLoginAtStart = process.env.ELANOUS_SKIP_LOGIN_ENV;
afterEach(async () => {
  const pending = [...cleanups];
  cleanups.length = 0;
  for (const cleanup of pending.reverse()) await cleanup();
  if (envAtStart.owner === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV]; else process.env[AUTH_OWNER_TOKEN_ENV] = envAtStart.owner;
  if (envAtStart.pane === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envAtStart.pane;
  for (const key of AMBIENT_ELS_ENV_KEYS) {
    const value = ambientAtStart[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // 이 파일이 설계 옵트아웃으로 건너뛴 로그인 캡처를 프로세스 env 에서 되돌린다(다른 시험 파일 오염 방지).
  if (skipLoginAtStart === undefined) delete process.env.ELANOUS_SKIP_LOGIN_ENV; else process.env.ELANOUS_SKIP_LOGIN_ENV = skipLoginAtStart;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// 출처: restart-survive.test.ts 와 같은 실화면 대기 상한(attach-pty 시험 형태).
const LIT_WAIT_MS = 15_000;
const LIT_POLL_MS = 20;
const LIT_TEST_MS = 90_000;
const until = async (check: () => Promise<boolean> | boolean, ms: number = LIT_WAIT_MS): Promise<void> => {
  const stop = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > stop) throw new Error('timed out waiting');
    await sleep(LIT_POLL_MS);
  }
};
/** 문이 열리려면 소유자의 명시적 OP 등록이 필요하다(#39143 이후 같은 형태 — restart-survive.test.ts seatOp). */
async function seatOp(socket: string): Promise<void> {
  const registered = await requestEls(socket, { op: 'seat-set', seat: 'OP' });
  expect(registered).toMatchObject({ exitCode: 0, message: 'els seat: OP registered' });
}
const screenOf = async (socket: string, pane: string): Promise<string> => (await requestEls(socket, { op: 'read', pane })).message;

/** 이 프로세스(토큰 없는 env)가 임의의 자격값을 첫 auth 줄로 제시한다 — client.ts paneAuth 의 credential 인자 경로. */
async function presentToken(socket: string, token: string): Promise<ElsResult> {
  const savedPane = process.env[AUTH_PANE_TOKEN_ENV];
  const savedOwner = process.env[AUTH_OWNER_TOKEN_ENV];
  delete process.env[AUTH_PANE_TOKEN_ENV];
  delete process.env[AUTH_OWNER_TOKEN_ENV];
  try { return await requestEls(socket, { op: 'ls' }, 10_000, token); }
  finally {
    if (savedPane === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = savedPane;
    if (savedOwner === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV]; else process.env[AUTH_OWNER_TOKEN_ENV] = savedOwner;
  }
}

const INVALID = 'els: invalid credential';                       // 독립 리터럴: 미지 토큰 즉거부(server.ts auth)
// 실측 어휘(attach.test.ts:233·client.test.ts:69 에서 확립된 서버 인증 거부 형태): 원장에 있는 토큰을
// 비자손 피어가 제시하면 분류에 성공하고 «auth: outsider» 로 거부된다 — «토큰이 살아 재분류됐다»의 증거.
const OUTSIDER = 'auth: outsider';
// 이 칸 base 는 auth-ack 수리(1bc940f1473, 미배포 — malformed 재구성 §5) 이전이라 미지 토큰 거부가
// «els: malformed answer from the els server» 로 오기록된다; ack 수리 병합 후에는 'auth: invalid credential'.
// 셋 모두 «거부됨»의 증거로 받아들인다(본 시험의 결함은 원장 소실이지 ack 형식이 아니다).
const DENIED_SHAPES = [INVALID, 'auth: invalid credential', 'els: malformed answer from the els server'] as const;
const denied = (result: ElsResult): boolean =>
  result.exitCode === 1 && DENIED_SHAPES.some((m) => result.message.includes(m));
const deniedOrClassified = (result: ElsResult): boolean =>
  denied(result) || (result.exitCode === 1 && result.message.includes(OUTSIDER));

/** pane 안에서 실제 els 호출: pane 자식(홀더가 띄운 /bin/sh)이 bun 으로 미리 써둔 헬퍼 파일을 돌려 결과를 찍는다.
 *  자식 코드는 파일로(255자 tty 정준모드 상한·51칼럼 랩 회피), 마커는 쪼개 인자로 넘긴다 — pty 가 명령줄을
 *  그대로 echo 하므로 리터럴 마커가 화면에 오면 until 이 실제 출력 전에 풀려버린다(restart-survive L146 교훈). */
async function paneEls(root: string, socket: string, pane: string, marker: string): Promise<string> {
  const clientJs = new URL('./client.js', import.meta.url).pathname;
  const helper = join(root, 'pane-els.mjs');
  writeFileSync(helper, `const m = await import(${JSON.stringify(clientJs)});\nconst r = await m.requestEls(process.env.ELANOUS_ELS_SOCKET, { op: 'ls' });\nconst marker = process.argv.slice(2).join('');\nconsole.log(marker + ' ' + r.exitCode + ' ' + r.message.slice(0, 60));\n`);
  const half = Math.ceil(marker.length / 2);
  // machineInput 가드(core.ts): paste 모드가 아니면 입력 줄에 y/Y·제어 문자가 있으면 거부한다. ${helper}
  // 절대경로의 mkdtemp 무작위 접미사에 y 가 나오면 오탐에 걸린다(RED 가 통과한 건 접미사에 y 가 없었을 뿐 —
  // 결정론적 결함). pane 의 cwd 는 root 이므로 상대경로로 부른다: 입력 줄이 항상 y-free·control-free.
  const line = `${process.execPath} ./pane-els.mjs ${marker.slice(0, half)} ${marker.slice(half)}\r`;
  const sent = await requestEls(socket, { op: 'input', pane, bytes: line });
  if (sent.exitCode !== 0) throw new Error(`paneEls input op refused: ${JSON.stringify(sent)}`);
  let screen = '';
  await until(async () => { screen = await screenOf(socket, pane); return screen.includes(marker); });
  return screen;
}

/** OP #132354: 재기동 생존 pane 이 자기 토큰으로 send op 까지 성공하는 실경로 단언용 — paneEls 와 같은 형태로
 *  헬퍼 파일이 {op:'send', pane: 자기 ELANOUS_ELS_PANE, text} 를 제출한다. send 는 소유 게이트(server.ts ownPane —
 *  callerPane 일치)를 지나는 쓰기 경로라 ls 성공보다 강한 증거다. 텍스트는 enter 없이 paste 로만 붙으므로(core.ts
 *  machinePaste(…, false)) 화면에 마커를 남기지 않는다 — 헬퍼의 결과 줄(SURVSEND <exitCode>)만이 증거다. */
async function paneElsSend(root: string, socket: string, pane: string, marker: string): Promise<string> {
  const clientJs = new URL('./client.js', import.meta.url).pathname;
  const helper = join(root, 'pane-send.mjs');
  writeFileSync(helper, `const m = await import(${JSON.stringify(clientJs)});\nconst r = await m.requestEls(process.env.ELANOUS_ELS_SOCKET, { op: 'send', pane: process.env.ELANOUS_ELS_PANE, text: 'echo SENT_OK' });\nconst marker = process.argv.slice(2).join('');\nconsole.log(marker + ' ' + r.exitCode + ' ' + r.message.slice(0, 60));\n`);
  const half = Math.ceil(marker.length / 2);
  const line = `${process.execPath} ./pane-send.mjs ${marker.slice(0, half)} ${marker.slice(half)}\r`;
  const sent = await requestEls(socket, { op: 'input', pane, bytes: line });
  if (sent.exitCode !== 0) throw new Error(`paneElsSend input op refused: ${JSON.stringify(sent)}`);
  let screen = '';
  await until(async () => { screen = await screenOf(socket, pane); return screen.includes(marker); });
  return screen;
}

/** pane 자식의 env 에 들어간 서버발급 토큰을 화면으로 읽어낸다(원장 밖, 실제 자식이 실제로 가진 값).
 *  machinePaste 가드(core.ts): paste 모드가 아니면 입력 줄에 y/Y 가 있으면 거부한다(L98 paneEls 교훈과 동일).
 *  ECHO/TOKEN 등 대문자에도 y 가 있으므로 마커를 쪼개 인자로 넘기는 헬퍼 파일을 돌린다: 입력 줄이 항상 y-free. */
async function paneTokenFromScreen(root: string, socket: string, pane: string): Promise<string> {
  // 검증 복귀(70de8c80d48e GREEN 형태): echo 는 셸 내장이라 CWD·런타임(execPath) 의존이 전혀 없다.
  // machinePaste 가드(core.ts)의 y/Y 거부는 exitCode 1 로 드러나므로(실패 원문은 input op exitCode 0),
  // y-가드는 범인이 아니었다 — 32a013adb8 의 ${execPath} ./helper 줄이 마커 전달을 깨뜨렸다.
  // $ELANOUS_ELS_PANE_TOKEN 에는 y 가 없고 값은 pane 자식 안에서만 전개된다 — 줄은 항상 approval-free.
  const line = `echo SURVTOK_B $ELANOUS_ELS_PANE_TOKEN SURVTOK_E\r`;
  const sent = await requestEls(socket, { op: 'input', pane, bytes: line });
  expect(sent.exitCode).toBe(0);
  let screen = '';
  await until(async () => { screen = await screenOf(socket, pane); return /SURVTOK_B [0-9a-f]{48} SURVTOK_E/.test(screen); });
  return /SURVTOK_B ([0-9a-f]{48}) SURVTOK_E/.exec(screen)![1]!;
}

test('restart survive: a surviving pane keeps its server-minted credential across a restart (holder proof re-registered from the journal)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-toksurv-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  cleanups.push(() => first.close());
  await seatOp(socket);

  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane, confirmed: true }); });
  const token = await paneTokenFromScreen(root, socket, pane);

  // 재기동 전 대조: 이 토큰은 원장에 있다 — 이 프로세스는 그 pane 의 자손이 아니므로 «outsider» 분류 거부로
  // 분류 자체는 성공함을 증명한다(등록 토큰이 살아 있다는 최초 실측).
  const before = await presentToken(socket, token);
  expect(before.exitCode).toBe(1);
  expect(before.message).toContain(OUTSIDER);
  // 재기동 전 실경로 대조: pane 자식이 자기 토큰으로 ls 를 호출하면 성공한다.
  expect((await paneEls(root, socket, pane, 'SURVLS1')).includes('SURVLS1 0 ')).toBe(true);

  // 재기동(D1a): close() 는 홀더를 놓아주고 두 번째 서버가 입양한다 — 살아남은 자식은 같은 토큰을 계속 들고 있다.
  await first.close();
  const second = await startElsServer({ stateRoot: root });
  if ('exitCode' in second) throw new Error(second.message);
  cleanups.push(() => second.close());
  await seatOp(socket);

  // 미고치 결함(RED): 원장은 비어 있다 — 생존 pane 의 토큰은 즉시 거부된다(이 base 에서는 «malformed» 오기록,
  // ack 수리 병합 후 'auth: invalid credential', 본 수리 후에는 «자손 아님» 분류 — 셋 다 거부의 증거).
  // 수리 전에는 아래 until 이 영원히 성립하지 못해 이 시험이 여기서 시간 초과로 실패한다 — 그것이 RED다.
  const after = await presentToken(socket, token);
  expect(deniedOrClassified(after)).toBe(true);

  // GREEN: 입양 시 홀더가 증명한 토큰이 저널 ownerSeat·workspace 로 재등록된다(비동기 — 착지 때까지 기다린다).
  // 재등록되면 이 프로세스(비자손)의 제시는 «auth: outsider» 분류 거부로 바뀐다.
  await until(async () => (await presentToken(socket, token)).message.includes(OUTSIDER));
  // GREEN 실경로: pane 자식(홀더 자손)이 같은 토큰으로 ls 를 호출하면 다시 성공한다.
  expect((await paneEls(root, socket, pane, 'SURVLS2')).includes('SURVLS2 0 ')).toBe(true);

  // OP #132354 (JUD-C HOLD 해소): 재기동 생존 pane 이 자기 토큰으로 send op 까지 성공한다 — ls 보다 강한
  // 실경로 증거(소유 게이트 ownPane·callerPane 일치 + machineInputRefusal 화면 검사 + PTY 쓰기까지 통과).
  // 마커 SURVSEND1 는 헬퍼 결과 줄에만 등장한다(send 의 paste 는 enter 없이 붙으므로 실행되지 않는다).
  expect((await paneElsSend(root, socket, pane, 'SURVSEND1')).includes('SURVSEND1 0 ')).toBe(true);

  // 음성 1: 죽은 pane(재기동 전에 닫아 홀더가 사라진)의 토큰은 재등록되지 않는다 — 여전히 미지 토큰이다.
  const second_ = await requestEls(socket, { op: 'new', ws: 'SURV', cwd: root, command: ['/bin/sh'] });
  expect(second_.exitCode).toBe(0);
  const dead = JSON.parse(second_.message) as { pane: string };
  const deadToken = await paneTokenFromScreen(root, socket, dead.pane);
  // close 는 사람 확인 게이트(#39143): close 요청에 confirmed:true 가 없으면 exitCode 1 로 거부된다.
  const closed = await requestEls(socket, { op: 'close', pane: dead.pane, confirmed: true });
  expect(closed.exitCode).toBe(0);
  cleanups.pop();
  expect(denied(await presentToken(socket, deadToken))).toBe(true);

  // 음성 2: 홀더가 증명한 적 없는 임의의 48-hex 토큰은 여전히 미지 토큰이다.
  const forged = 'f'.repeat(48);
  expect(denied(await presentToken(socket, forged))).toBe(true);

  // 음성 3 (OP #128880 보안 HOLD): 같은 UID 의 다른 프로세스(이 시험 프로세스 — 홀더가 아니고 입양 서버도
  // 아니다)가 홀더 소켓(0700, 같은 uid 로 열린다)에 직접 credential 을 요청한다. 미인증 연결에는 토큰이
  // 돌아가지 않는다 — bare 요청·조작 nonce 모두 null. (수리 전에는 pane 토큰 원문이 그대로 돌아왔다 = RED.)
  const holderSocket = holderSocketPath(root, pane);
  const askHolder = async (line: object): Promise<string> => await new Promise((resolve, reject) => {
    const sock = createConnection(holderSocket);
    const fail = (error: unknown): void => { sock.destroy(); reject(error instanceof Error ? error : new Error(String(error))); };
    sock.once('error', fail);
    sock.setTimeout(5_000, () => fail(new Error('holder credential ask timed out')));
    sock.once('connect', () => sock.write(`${JSON.stringify(line)}\n`));
    let buf = '';
    sock.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); const nl = buf.indexOf('\n'); if (nl >= 0) { sock.destroy(); resolve(buf.slice(0, nl)); } });
  });
  const bare = JSON.parse(await askHolder({ op: 'credential' })) as { token: string | null };
  expect(bare.token).toBeNull();
  const forgedNonce = JSON.parse(await askHolder({ op: 'credential', nonce: 'f'.repeat(48) })) as { token: string | null };
  expect(forgedNonce.token).toBeNull();
}, LIT_TEST_MS);

// ── JUD 보안 HOLD 공격 회귀: 가짜 els.sock 리스너 ─────────────────────────────
// 결함(수리 전): 홀더의 serverConfirmsAdoption 은 els.sock 답을 exitCode:0 만으로 신뢰한다 —
// 답하는 주체를 전혀 인증하지 않는다. 같은 UID 공격자가 서버 재기동 창(진짜 서버 다운)에
// els.sock 경로를 잡고 exitCode:0 만 답하면 살아남은 진짜 홀더가 진짜 pane 토큰을 반환한다.
// 출처: JUD HOLD(node-b 격리 프로브 CONFIRMED 4/0 ×2) · OP 처방(challenge-HMAC + peer pid/start).
test('attack regression: a fake els.sock listener answering exitCode:0 never receives the pane token', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-adopt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const first = await startElsServer({ stateRoot: root });
  if ('exitCode' in first) throw new Error(first.message);
  await seatOp(socket);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  // 정확-pid 홀더 정리: pane 자식(= meta.pid)의 부모가 곧 홀더 프로세스다.
  const holderPidOf = (): number | undefined => {
    const child = loadHolderMeta(holderMetaPath(root, pane));
    return child ? processIdentity(child.pid)?.ppid : undefined;
  };
  cleanups.push(() => { const pid = holderPidOf(); if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } } });
  const realToken = await paneTokenFromScreen(root, socket, pane);
  const realGenerationNonce = loadHolderMeta(holderMetaPath(root, pane))?.generationNonce;
  expect(realGenerationNonce).toBeTruthy();

  // 공격 창 (A): 진짜 서버를 내린다 — els.sock 이 풀린다.
  await first.close();
  // 공격자(같은 UID)가 els.sock 경로를 잡고 adopt-verify 에 exitCode:0 만 답한다.
  let attackerQueries = 0;
  const fake = createServer((conn) => {
    conn.on('data', () => { attackerQueries += 1; conn.write(`${JSON.stringify({ exitCode: 0, message: 'adopt-verify: ok' })}\n`); });
  });
  cleanups.push(() => { fake.close(); try { unlinkSync(socket); } catch { /* never bound */ } });
  await new Promise<void>((resolve) => fake.listen(socket, resolve));

  // 공격자는 입양 서버의 48-hex 세대 nonce 꼴을 위조해 실어 보낸다(진짜 서버의 nonce 는 서버 메모리에만
  // 있다 — 공격자는 모른다). 수리 전 홀더는 (가짜) els.sock 의 exitCode:0 만 믿고 토큰을 내놓는다.
  const answer = JSON.parse(await new Promise<string>((resolve, reject) => {
    const sock = createConnection(holderSocketPath(root, pane));
    const fail = (error: unknown): void => { sock.destroy(); reject(error instanceof Error ? error : new Error(String(error))); };
    sock.once('error', fail);
    sock.setTimeout(15_000, () => fail(new Error('holder credential ask timed out')));
    sock.once('connect', () => sock.write(`${JSON.stringify({ op: 'credential', nonce: 'f'.repeat(48) })}\n`));
    let buf = '';
    sock.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); const nl = buf.indexOf('\n'); if (nl >= 0) { sock.destroy(); resolve(buf.slice(0, nl)); } });
  })) as { token: string | null };

  // 공격자 리스너가 쿼리를 받았다(adopt-verify 가 실제로 가짜에게 갔다) — 그리고 토큰은 새어나가면 안 된다.
  expect(attackerQueries).toBeGreaterThan(0);
  expect(answer.token).toBeNull();   // 수리 전 이 단언이 실패한다: 토큰이 공격자에게 새어나간다(RED).
}, LIT_TEST_MS);
