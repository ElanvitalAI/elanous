// ── 우편국(post office) 발견 ⊕ 재시작 — `msg serve --sse` 가 자기 포트를 적고, `msg post` 가 죽은 것을 다시 띄운다 ──
//
// 왜 «발견 파일» 인가: `eln msg serve --sse` 는 원장을 빨리 밀어 주는 별도 프로세스이고 설치본을 갈아 끼우면
// 그 프로세스는 조용히 사라진다. `watch --sse` 는 폴링으로 돌아가므로 «동작은 하지만» 구독자는 늦어진다.
// 서비스가 자기 포트·pid 를 `<상태 루트>/msg/sse.json` 에 적으면, 글을 저장한 «뒤» post 경로가
// 그 줄을 읽어 «응답하지 않는 우편국» 을 같은 포트로 한 번 다시 띄울 수 있다.
//
// ⛔ 원장이 정본이다 — 다시 띄운 서비스는 저장된 글을 처음부터(=`since`·`Last-Event-ID`) 재생하므로
//    서비스가 죽어 있던 동안 저장된 글도 잃지 않는다.
// ⛔ 재시작은 글의 성패를 바꾸지 않는다 — 어떤 실패도 결과 값으로만 돌아온다(fail-open).
// ⛔ 시험 우주에서는 실제 프로세스를 띄우지 않는다 — `ELANOUS_MSG_SSE_LIVE=1` 로만 연다(격리 실물 시험용).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';

export interface PostOfficeInfo {
  /** Loopback port the SSE service answers on. */
  port: number;
  /** Process that wrote the line; a dead pid means the service is gone. */
  pid: number;
  url: string;
}

export type PostOfficeEnsure =
  | { state: 'absent' }
  | { state: 'skipped'; reason: string }
  | { state: 'listening'; port: number }
  | { state: 'restarted'; port: number };

/** `<상태 루트>/msg/sse.json` — the ledger directory `msg serve` and `msg post` already share. */
export function postOfficeFile(stateRoot: string): string {
  return join(stateRoot, 'msg', 'sse.json');
}

/** The recorded service, or null when nothing registered one — 파일이 없으면 «모름»이지 «서비스 없음»의 측정이 아니다. */
export function readPostOffice(stateRoot: string): PostOfficeInfo | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(postOfficeFile(stateRoot), 'utf8')); }
  catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { port, pid } = raw as { port?: unknown; pid?: unknown };
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535) return null;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { port, pid, url: `http://127.0.0.1:${port}` };
}

/** Called by `msg serve --sse` right after the service binds its port. */
export function writePostOffice(stateRoot: string, info: { port: number; pid?: number }): PostOfficeInfo {
  const path = postOfficeFile(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const value: PostOfficeInfo = { port: info.port, pid: info.pid ?? process.pid, url: `http://127.0.0.1:${info.port}` };
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return value;
}

/** Called when the service stops — only the writer's own line is removed, never a newer one. */
export function clearPostOffice(stateRoot: string, pid: number = process.pid): boolean {
  const current = readPostOffice(stateRoot);
  if (current !== null && current.pid !== pid) return false;
  try { rmSync(postOfficeFile(stateRoot), { force: true }); return true; }
  catch { return false; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Any HTTP answer (401 included) means the service is listening; silence means it is gone. */
async function probePostOffice(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/stream`, { signal: AbortSignal.timeout(500) });
    try { await response.body?.cancel(); } catch { /* body already closed */ }
    return true;
  } catch { return false; }
}

function liveUniverse(): boolean {
  return effectiveInstanceRoot() === prodInstanceRoot() || process.env.ELANOUS_MSG_SSE_LIVE === '1';
}

/** Restart the same installed CLI entry that is running this command — `eln msg serve --sse --port <p>`. */
function spawnPostOffice({ port }: { port: number }): void {
  const entry = process.argv[1];
  if (!entry) throw new Error('post office restart needs the running CLI entry (process.argv[1])');
  const child = Bun.spawn([process.execPath, entry, 'msg', 'serve', '--sse', '--port', String(port)], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: process.env,
  });
  (child as unknown as { unref?: () => void }).unref?.();
}

export interface EnsurePostOfficeInput {
  /** State root that holds `msg/sse.json`. */
  stateRoot: string;
  /** Test seam — liveness of the recorded pid (default: signal 0). */
  alive?: (pid: number) => boolean;
  /** Test seam — does the recorded service answer on its port? (default: one HTTP probe). */
  probe?: (url: string) => Promise<boolean>;
  /** Test seam / fake-bin — start a new service on the recorded port. */
  launch?: (input: { port: number }) => void;
}

/**
 * Restart a registered post office that no longer answers. Absent registration and a live service are no-ops,
 * so a plain `msg post` keeps its current behavior.
 */
export async function ensurePostOffice(input: EnsurePostOfficeInput): Promise<PostOfficeEnsure> {
  const info = readPostOffice(input.stateRoot);
  if (info === null) return { state: 'absent' };
  const alive = (input.alive ?? pidAlive)(info.pid);
  if (alive && await (input.probe ?? probePostOffice)(info.url)) return { state: 'listening', port: info.port };
  if (input.launch === undefined && !liveUniverse()) return { state: 'skipped', reason: 'test-universe' };
  (input.launch ?? spawnPostOffice)({ port: info.port });
  return { state: 'restarted', port: info.port };
}
