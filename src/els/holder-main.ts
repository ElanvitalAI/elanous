// holder 프로세스 본체 — els 서버가 spawnHolderDetached(src/els/holder.ts)로 띄운다(D1a).
// 서버가 죽어도 이 프로세스와 pane 자식(PTY)은 산다; 소켓 0700 · meta 원장(0600)을 남겨 다음 서버가 재결속한다.
// 사용: bun src/els/holder-main.ts --state-root <dir> --pane <id> [--cwd <dir>] [--title <text>]
//      [--cols <n>] [--rows <n>] [--grace-ms <n>] -- <command...>
// 자식 env: 이 프로세스의 환경 그대로 내려간다(startPty 가 process.env 를 합성) — 서버가 pane env(ELANOUS_ELS_*)를
// holder env 로 싣고 왔으므로 그대로 전달된다.

import { startHolder } from './holder.js';

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const raw = arg(name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) ? value : undefined;
};

async function main(): Promise<void> {
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
    title: arg('--title') ?? command[0],
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
