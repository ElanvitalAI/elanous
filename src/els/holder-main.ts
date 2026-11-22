// holder 프로세스 본체 — els 서버가 spawnHolderDetached(src/els/holder.ts)로 띄운다(D1a).
// 서버가 죽어도 이 프로세스와 pane 자식(PTY)은 산다; 소켓 0700 · meta 원장(0600)을 남겨 다음 서버가 재결속한다.
// 사용: bun src/els/holder-main.ts --state-root <dir> --pane <id> [--cwd <dir>] [--title <text>]
//      [--cols <n>] [--rows <n>] [--grace-ms <n>] -- <command...>
// 자식 env: startPty 는 로그인 셸 캡처본 ⊕ 정체성 키 ⊕ 호출자 env 로 자식 env 를 «다시 짓는다»(process.env 를 그대로 잇지 않는다) —
// 그래서 서버가 holder env 로 싣고 온 pane 의 els 정체성(ELANOUS_ELS_WS/PANE/SOCKET/PANE_TOKEN)을 여기서 이름으로 집어 넘긴다.
// 서버 owner 토큰(ELANOUS_ELS_OWNER_TOKEN)은 holder env 에 있어도 넘기지 않는다.

import { adoptCapturedEnv, capturedEnvAvailable, getCapturedEnv, loginEnvOptedOut } from '../shell-env-bootstrap.js';
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

// 보안 HOLD 수리(OP #129232): 입양 신뢰 물자(비밀·서버 pid·서버 시작시각)도 홀더 env 로 내려온다 —
// startHolder 가 이들을 홀더 메모리에만 남기고 pane 자식 env 에서는 걷어낸다(비밀이 자식에게 내려가면
// pane 안의 임의 코드가 입양 비밀을 읽는다).
const PANE_ENV_KEYS = ['ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_PANE_TOKEN',
  'ELANOUS_ELS_ADOPTION_SECRET', 'ELANOUS_ELS_SERVER_PID', 'ELANOUS_ELS_SERVER_START'] as const;
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
  else getCapturedEnv(); // stdin 인계가 없으면 자체 캡처를 지금 시도한다(startPty 안의 지연 캡처를 앞당김).
  // JUD-2 보안 필수 1(OP #131438·#131445·#131658): 캡처가 없으면 getCapturedEnv() 가 홀더
  // process.env 로 폴백하고 그 합성 환경이 PTY 자식에 그대로 전달되어 입양 비밀이 pane 에 샌다.
  // 캡처 실패 = fail-closed: 그 pane 의 spawn 을 거부하고 명시 오류로 나간다(홀더 환경 대체 금지).
  // 단 loginEnvOptedOut()(ELANOUS_SKIP_LOGIN_ENV=1 · TERM_PROGRAM=monad-agent-nested)은 «캡처를
  // 시도하지 않는 정상 경로»다 — 게이트 호스트(node-b pregate)·중첩 에이전트가 여기에 해당하며 이때의
  // process.env 기반은 설계상 경로지 폴백이 아니다(fc4 RED 원문: 옵아웃 환경에서 스폰 전면 거부).
  if (!capturedEnvAvailable() && !loginEnvOptedOut()) {
    process.stderr.write('holder-main: login-env capture unavailable — refusing to spawn the pane child (holder-env substitution would leak adoption secrets); fail-closed\n');
    process.exit(1);
  }
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
    title: arg('--title') ?? command[0], env: paneEnv(), generationNonce: arg('--generation-nonce'),
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
