// holder 프로세스 본체 — els 서버가 spawnHolderDetached(src/els/holder.ts)로 띄운다(D1a).
// 서버가 죽어도 이 프로세스와 pane 자식(PTY)은 산다; 소켓 0700 · meta 원장(0600)을 남겨 다음 서버가 재결속한다.
// 사용: bun src/els/holder-main.ts --state-root <dir> --pane <id> [--cwd <dir>] [--title <text>]
//      [--cols <n>] [--rows <n>] [--grace-ms <n>] -- <command...>
// 자식 env: startPty 는 로그인 셸 캡처본 ⊕ 정체성 키 ⊕ 호출자 env 로 자식 env 를 «다시 짓는다»(process.env 를 그대로 잇지 않는다) —
// 그래서 서버가 holder env 로 싣고 온 pane 의 els 정체성(ELANOUS_ELS_WS/PANE/SOCKET/PANE_TOKEN)을 여기서 이름으로 집어 넘긴다.
// 서버 owner 토큰(ELANOUS_ELS_OWNER_TOKEN)은 holder env 에 있어도 넘기지 않는다.

import { adoptCapturedEnv } from '../shell-env-bootstrap.js';
import { loginEnvKey, unpackLoginEnv } from './login-env-handoff.js';
import { startHolder } from './holder.js';

// The server writes the payload right after the spawn; a pipe that stays silent this long means: capture it yourself.
const HANDOFF_WAIT_MS = 2_000;
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const raw = arg(name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) ? value : undefined;
};

const PANE_ENV_KEYS = ['ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_PANE_TOKEN'] as const;
const paneEnv = (): Record<string, string> => Object.fromEntries(PANE_ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));

async function main(): Promise<void> {
  // The server's owner token rides in this process env; startPty's login-shell capture would hand it to the pane. Drop it first.
  delete process.env.ELANOUS_ELS_OWNER_TOKEN;
  // The server's login-env capture arrives on stdin (empty when none): adopt it so startPty runs no login shell of its own.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handed = await Promise.race([Bun.stdin.text(), new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), HANDOFF_WAIT_MS); })]);
  clearTimeout(timer);
  const loginEnv = handed ? unpackLoginEnv(handed, loginEnvKey()) : undefined;
  if (loginEnv) adoptCapturedEnv(loginEnv);
  const stateRoot = arg('--state-root');
  const paneId = arg('--pane');
  const dash = process.argv.indexOf('--');
  const command = dash >= 0 ? process.argv.slice(dash + 1) : [];
  if (!stateRoot || !paneId || !command[0]) {
    process.stderr.write('holder-main: --state-root, --pane and a command after -- are required\n');
    process.exit(2);
  }
  const cols = num('--cols');
  const rows = num('--rows');
  const grace = num('--grace-ms');
  const holder = await startHolder({ stateRoot, paneId, cwd: arg('--cwd') ?? process.cwd(), command,
    title: arg('--title') ?? command[0], env: paneEnv(),
    ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}),
    ...(grace !== undefined ? { exitGraceMs: grace } : {}) });
  // 외부 신호 = 명시적 종료: 자식을 죽이고 원장·소켓을 정리한 뒤 나간다. 그 외의 경로(접속 끊김)는 무시한다.
  const stop = (): void => { void holder.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await holder.done.then(() => process.exit(0));
}

void main().catch((error: unknown): void => {
  process.stderr.write(`holder-main: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
