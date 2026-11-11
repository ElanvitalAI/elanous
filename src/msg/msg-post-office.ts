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
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { ResourceLedger } from '../control-plane/ledger.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';

const RESOURCE_ID = 'instance:msg-sse';
const STANDALONE_OWNER = 'msg-sse';
const RESIDENT_OWNER = 'msg-sse-resident';
// Source: the resident post office refreshes its control resource entry every minute; five minutes tolerates short stalls.
const RESOURCE_TTL_MS = 5 * 60_000;
const RESOURCE_REFRESH_MS = 60_000;
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>();
const standaloneRefreshTimers = new Map<string, { pid: number; port: number; timer: ReturnType<typeof setInterval> }>();

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

function controlPostOffice(stateRoot: string, includeExpired = false): { info: PostOfficeInfo; resident: boolean; owner: string } | null {
  const record = new ResourceLedger(stateRoot).list({ kind: 'instance', name: 'msg-sse' })
    .find((row) => row.id === RESOURCE_ID && [STANDALONE_OWNER, RESIDENT_OWNER].includes(row.owner) && (includeExpired || !row.expired));
  if (!record) return null;
  const { port, pid, resident } = record.attrs;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1
    || record.endpoint !== `http://127.0.0.1:${port}`) return null;
  return { info: { port, pid, url: record.endpoint }, resident: record.owner === RESIDENT_OWNER || resident === true, owner: record.owner };
}

/** The recorded service, or null when nothing registered one — 파일이 없으면 «모름»이지 «서비스 없음»의 측정이 아니다. */
export function readPostOffice(stateRoot: string): PostOfficeInfo | null {
  try { const control = controlPostOffice(stateRoot); if (control) return control.info; }
  catch { /* A missing or unreadable control ledger leaves the legacy discovery line available. */ }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(postOfficeFile(stateRoot), 'utf8')); }
  catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { port, pid } = raw as { port?: unknown; pid?: unknown };
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535) return null;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { port, pid, url: `http://127.0.0.1:${port}` };
}

/** A live registered owner prevents Nexus from starting a competing resident listener. */
export function livePostOffice(stateRoot: string): PostOfficeInfo | null {
  const info = readPostOffice(stateRoot);
  return info && pidAlive(info.pid) ? info : null;
}

/** Called by `msg serve --sse` right after the service binds its port. */
export function writePostOffice(stateRoot: string, info: { port: number; pid?: number; refreshMs?: number }): PostOfficeInfo {
  const path = postOfficeFile(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const value: PostOfficeInfo = { port: info.port, pid: info.pid ?? process.pid, url: `http://127.0.0.1:${info.port}` };
  const owner = STANDALONE_OWNER;
  const publish = () => new ResourceLedger(stateRoot).register({
    id: RESOURCE_ID, kind: 'instance', machine: hostname(), name: 'msg-sse', owner,
    endpoint: value.url, attrs: { port: value.port, pid: value.pid, resident: false }, observedAt: Date.now(), ttlMs: RESOURCE_TTL_MS,
  }, owner);
  const registered = withFileLockSync(join(stateRoot, 'msg', 'sse-registration.lock'), () => {
    let current: ReturnType<typeof controlPostOffice>;
    try { current = controlPostOffice(stateRoot); }
    catch { current = null; }
    if (current && (current.info.pid !== value.pid || current.info.port !== value.port) && pidAlive(current.info.pid)) {
      return current.info;
    }
    try {
      const ledger = new ResourceLedger(stateRoot);
      const previous = ledger.list({ kind: 'instance', name: 'msg-sse' }).find((row) => row.id === RESOURCE_ID);
      if (previous && ![STANDALONE_OWNER, RESIDENT_OWNER].includes(previous.owner))
        throw new Error('post office resource owned by another service');
      if (previous && previous.owner !== owner) ledger.delete(RESOURCE_ID, previous.owner);
      publish();
    }
    catch {
      // A resident may have taken the ledger lock after our first read.
      try { const winner = controlPostOffice(stateRoot); if (winner?.resident) return winner.info; }
      catch { /* Standalone service keeps the legacy discovery line when the ledger is unavailable. */ }
    }
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    return value;
  }, { breakDeadHolder: true });
  if (registered.port !== value.port || registered.pid !== value.pid) return registered;
  if (value.pid === process.pid) {
    const old = standaloneRefreshTimers.get(stateRoot);
    if (old) clearInterval(old.timer);
    const timer = setInterval(() => {
      try {
        const current = controlPostOffice(stateRoot, true);
        if (current?.owner !== STANDALONE_OWNER || current.info.pid !== value.pid || current.info.port !== value.port) {
          clearInterval(timer);
          standaloneRefreshTimers.delete(stateRoot);
          return;
        }
        new ResourceLedger(stateRoot).heartbeat(RESOURCE_ID, STANDALONE_OWNER);
      } catch { /* A transient ledger failure retries on the next tick. */ }
    }, info.refreshMs ?? RESOURCE_REFRESH_MS);
    timer.unref();
    standaloneRefreshTimers.set(stateRoot, { pid: value.pid, port: value.port, timer });
  }
  return registered;
}

/** Publish a Nexus resident under the ledger's own lock, fencing older writer heartbeats during handoff. */
export async function writeResidentPostOffice(stateRoot: string, info: { port: number; pid?: number }): Promise<PostOfficeInfo> {
  const value: PostOfficeInfo = { port: info.port, pid: info.pid ?? process.pid, url: `http://127.0.0.1:${info.port}` };
  const ledger = new ResourceLedger(stateRoot);
  const registered = await ledger.withSerializedMutation(() => {
    const control = controlPostOffice(stateRoot);
    const current = control?.info ?? readPostOffice(stateRoot);
    if (current && (current.pid !== value.pid || current.port !== value.port) && pidAlive(current.pid)) {
      return current;
    }
    const previous = ledger.list({ kind: 'instance', name: 'msg-sse' }).find((row) => row.id === RESOURCE_ID);
    if (previous && ![STANDALONE_OWNER, RESIDENT_OWNER].includes(previous.owner))
      throw new Error('post office resource owned by another service');
    if (previous && previous.owner !== RESIDENT_OWNER) ledger.delete(RESOURCE_ID, previous.owner);
    ledger.register({ id: RESOURCE_ID, kind: 'instance', machine: hostname(), name: 'msg-sse', owner: RESIDENT_OWNER,
      endpoint: value.url, attrs: { port: value.port, pid: value.pid, resident: true }, observedAt: Date.now(), ttlMs: RESOURCE_TTL_MS,
    }, RESIDENT_OWNER);
    mkdirSync(dirname(postOfficeFile(stateRoot)), { recursive: true });
    writeFileSync(postOfficeFile(stateRoot), `${JSON.stringify(value)}\n`);
    return value;
  });
  if (registered.port === value.port && registered.pid === value.pid) {
    const oldTimer = refreshTimers.get(stateRoot);
    if (oldTimer) clearInterval(oldTimer);
    const timer = setInterval(() => {
      try { ledger.heartbeat(RESOURCE_ID, RESIDENT_OWNER); }
      catch { /* A later heartbeat retries while discovery still has its TTL. */ }
    }, RESOURCE_REFRESH_MS);
    timer.unref();
    refreshTimers.set(stateRoot, timer);
  }
  return registered;
}

/** Called when the service stops — only the writer's own line is removed, never a newer one. */
export function clearPostOffice(stateRoot: string, pid: number = process.pid, port?: number): boolean {
  mkdirSync(join(stateRoot, 'msg'), { recursive: true });
  return withFileLockSync(join(stateRoot, 'msg', 'sse-registration.lock'), () => {
    const current = readPostOffice(stateRoot);
    if (current !== null && (current.pid !== pid || (port !== undefined && current.port !== port))) return false;
    const timer = refreshTimers.get(stateRoot);
    if (timer) { clearInterval(timer); refreshTimers.delete(stateRoot); }
    const standaloneTimer = standaloneRefreshTimers.get(stateRoot);
    if (standaloneTimer?.pid === pid && (port === undefined || standaloneTimer.port === port)) {
      clearInterval(standaloneTimer.timer);
      standaloneRefreshTimers.delete(stateRoot);
    }
    try {
      const owned = controlPostOffice(stateRoot, true);
      if (owned && owned.info.pid === pid && (port === undefined || owned.info.port === port))
        new ResourceLedger(stateRoot).delete(RESOURCE_ID, owned.owner);
    }
    catch { /* The resource entry may already have expired or been removed. */ }
    try { rmSync(postOfficeFile(stateRoot), { force: true }); return true; }
    catch { return false; }
  }, { breakDeadHolder: true });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Only the resident SSE service's health signature counts; another listener on the port is not discovery. */
async function probePostOffice(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    try { await response.body?.cancel(); } catch { /* body already closed */ }
    return response.status === 204 && response.headers.get('x-elanous-service') === 'msg-sse';
  } catch { return false; }
}

/** Read-only discovery seam for `msg watch`; the CLI may pass this URL to its existing SSE branch. */
export async function discoverPostOfficeUrl(stateRoot: string = elanousStateRoot()): Promise<string | null> {
  const info = readPostOffice(stateRoot);
  if (!info || !pidAlive(info.pid) || !await probePostOffice(info.url)) return null;
  return info.url;
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
