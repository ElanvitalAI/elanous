// JUD-2 보안 필수 1(OP #131438·#131445·#131658 · jud-39580-70de8c80d48e): holder-main 은 stdin 인계가
// 없으면 스스로 로그인 env 캡처를 시도하고, 캡처마저 실패하면 getCapturedEnv() 가 홀더 process.env 로
// 폴백한다 — 입양 비밀(ELANOUS_ELS_ADOPTION_SECRET·SERVER_PID·SERVER_START)이 실린 합성 환경이
// PTY 자식(pane)에 그대로 내려가 비밀 노출 경로가 된다. 완료선: 캡처 실패 = fail-closed(spawn 거부·
// 명시 오류), 홀더 환경 대체 금지, 정상 경로(인계 성공)에서는 자식 env 에 홀더 전용 키 0.
// 게이트는 spawnPty 백엔드 선택(bun-native-pty·node-pty) 위의 holder 진입점에 있으므로 두 백엔드에
// 동일하게 적용된다(백엔드는 모두 resolveSpawnShape→buildPtyEnv 로 같은 env 를 소비한다).

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginEnvKey, packLoginEnv } from './login-env-handoff.js';
import { AUTH_OWNER_TOKEN_ENV } from './server-auth.js';
// 입양 물자 env 키는 holder.ts 의 private const 와 같은 문자열(export 되지 않아 리터럴로 고정 —
// 키 이름이 바뀌면 이 시험의 부재 단언이 그 사실을 알려준다).
const ADOPTION_SECRET_ENV = 'ELANOUS_ELS_ADOPTION_SECRET';
const ADOPTION_SERVER_PID_ENV = 'ELANOUS_ELS_SERVER_PID';
const ADOPTION_SERVER_START_ENV = 'ELANOUS_ELS_SERVER_START';
const PANE_TOKEN_ENV = 'ELANOUS_ELS_PANE_TOKEN'; // 실제 홀더 env 은 pane 자신의 토큰을 싣는다(paneEnv → childEnv 명시 경로)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 이 자리는 실 els pane 안이다 — 앰비언트 자격/상태 환경이 격리 우주를 오염시킨다(attach 16/16 교훈).
const AMBIENT_ELS_ENV_KEYS = [
  'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET',
  'ELANOUS_ELS_WS', 'ELANOUS_ELS_RUNTIME_TOKEN_FILE', 'ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE',
] as const;
const ambientAtStart: Record<string, string | undefined> = Object.fromEntries(
  AMBIENT_ELS_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of AMBIENT_ELS_ENV_KEYS) delete process.env[key];
beforeEach(() => { for (const key of AMBIENT_ELS_ENV_KEYS) delete process.env[key]; });
afterEach(() => { for (const [key, value] of Object.entries(ambientAtStart)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

const HOLDER_MAIN = fileURLToPath(new URL('./holder-main.ts', import.meta.url));
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();

/** holder-main 을 실제 프로세스로 띄운다. forceFailedCapture 는 «진짜 캡처 실패»를 유도한다: SHELL 을
 *  존재하지 않는 경로로 지정 → captureSeed 는 통과(basename 이 zsh)하지만 runPrintenvCapture 의
 *  spawnSync 가 ENOENT 로 실패 → getCapturedEnv() 가 process.env 폴백, capturedEnvAvailable()=false.
 *  (예전 방식 ELANOUS_SKIP_LOGIN_ENV=1 — loginEnvOptedOut — 은 fc4 이후 «캡처를 시도하지 않는 정상
 *  경로»로 제품이 분류했다: 옵아웃 환경(게이트 호스트·중첩 에이전트)에서 스폰이 전면 거부되는 fc4 RED.) */
function spawnHolderDetached(root: string, paneId: string, stdinText: string | null, forceFailedCapture = false, optOut = false) {
  const marker = join(root, `marker-${paneId}`);
  const child = spawn(process.execPath, [HOLDER_MAIN, '--state-root', root, '--pane', paneId, '--cwd', root,
    '--grace-ms', '100', '--', '/bin/sh', '-c', `env > ${join(root, `env-${paneId}`)}; echo ran > ${marker}`], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      SHELL: forceFailedCapture ? join(root, 'nonexistent-zsh') : (process.env.SHELL ?? '/bin/zsh'),
      TERM: 'xterm-256color',
      [PANE_TOKEN_ENV]: 'a'.repeat(48),
      ...(optOut ? { ELANOUS_SKIP_LOGIN_ENV: '1' } : {}),
      [ADOPTION_SECRET_ENV]: 'f'.repeat(48),
      [ADOPTION_SERVER_PID_ENV]: '424242',
      [ADOPTION_SERVER_START_ENV]: '2026-11-22T00:00:00.000Z',
      [AUTH_OWNER_TOKEN_ENV]: 'owner-secret-should-never-cross',
    },
    stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (stdinText !== null && child.stdin) { child.stdin.write(stdinText); void child.stdin.end(); }
  return { child, marker, envFile: join(root, `env-${paneId}`) };
}

const waitFor = async (probe: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (probe()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return probe();
};

test('capture failure is fail-closed: the pane child is never spawned (holder env substitution forbidden)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-fc-'));
  try {
    const { child, marker } = spawnHolderDetached(root, 'failclosed', null, true); // 진짜 캡처 실패 강제 + 인계 없음
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const code = await new Promise<number | null>((resolve) => { child.on('exit', (c) => resolve(c)); });
    expect(code).not.toBe(0);
    expect(stderr).toContain('fail-closed');
    expect(existsSync(marker)).toBe(false); // 자식(pane)은 한 번도 떠서는 안 된다
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('a handed login env still spawns the pane child with zero holder-only keys (healthy path intact)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-ho-'));
  try {
    const handed = packLoginEnv({ PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', TERM: 'xterm-256color', LANG: 'C', USER: process.env.USER ?? 'nobody' }, loginEnvKey());
    const { child, marker, envFile } = spawnHolderDetached(root, 'handed', handed);
    const ok = await waitFor(() => existsSync(marker), 20_000);
    expect(ok).toBe(true);
    const envText = readFileSync(envFile, 'utf8');
    expect(envText).not.toContain('f'.repeat(48));               // 입양 비밀
    expect(envText).not.toContain(ADOPTION_SECRET_ENV);          // 비밀 키 이름 자체
    expect(envText).not.toContain(ADOPTION_SERVER_PID_ENV);
    expect(envText).not.toContain(ADOPTION_SERVER_START_ENV);
    expect(envText).not.toContain('owner-secret-should-never-cross'); // 서버 owner 토큰
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('opt-out is a designed spawn path, not a leak: fallback env is scrubbed of holder-only keys, the pane keeps its own token (JUD-2 필수 1 · #131893)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-oo-'));
  try {
    const { child, marker, envFile } = spawnHolderDetached(root, 'optout', null, false, true); // 옵트아웃 + 인계 없음 → getCapturedEnv() 폴백 = 홀더 env
    const ok = await waitFor(() => existsSync(marker), 20_000);
    expect(ok).toBe(true);
    const envText = readFileSync(envFile, 'utf8');
    expect(envText).not.toContain('f'.repeat(48));               // 입양 비밀 — 폴백에서 되살아나면 누출
    expect(envText).not.toContain(ADOPTION_SECRET_ENV);          // 비밀 키 이름 자체
    expect(envText).not.toContain(ADOPTION_SERVER_PID_ENV);
    expect(envText).not.toContain(ADOPTION_SERVER_START_ENV);
    expect(envText).not.toContain('owner-secret-should-never-cross'); // 서버 owner 토큰
    expect(envText).toContain('a'.repeat(48));                   // pane 자신의 PANE_TOKEN 은 명시 경로(childEnv)로 유지
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
