// ── 우편 깨움 — 글을 저장한 «뒤» 받는 몸을 한 번 두드린다 ──
//
// 주소에 «답할 몸»(replyBody)이 있어도 «깨울 길»이 없으면 죽은 주소다(10-14 grok OP 16분 정지).
// 종류(`MessageWake`)마다 하는 일:
//   sse        — 아무것도 안 한다(구독자가 이미 듣는다)
//   cron       — 다음 틱에 읽는다 · `wake-deferred` 로그만
//   pty-inject — elanous TUI(pty 별명 = 자리 소문자)가 턴 idle 일 때만 한 줄 주입
//   herdr      — 자리 폴더 `herdr.pane` 의 pane 이 idle(·done) 일 때만 한 줄 주입 — `eln herdr prompt` 와 같은 생산 함수
//                (`herdrPrompt` · `agent get` 상태 확인 → bracketed `pane run` 한 번). working/blocked 는 넣지 않고 busy.
//   none       — stderr 경고 한 줄 · 해석 실패는 «모름»으로 남긴다(«없다»로 위장 금지)
// ⛔ 우편은 입력칸에 넣지 않는다(대표 10-15 01:20) — 기본은 입력칸 주입 0. 10-15 01:10 사고: 대표 가 치던 문장에
//    깨움 한 줄 ⊕ Enter 가 섞여 제출됐다(«에이전트 idle ≠ 사람이 안 친다»). 자리 폴더에서 푼 대상(pty 별명·
//    pty.ref·herdr.pane)은 `<seat-state>/<자리>/wake-inject` 일반 파일이 있을 때만 주입하고, 없으면
//    `msg.wake skipped{reason}` 만 남긴다.
//    ⚠️ wake-inject 는 «사람이 치지 않는 pane»(무인 에이전트 전용)에만 둔다 — 사람이 치는 pane 에는 켜지 말 것.
// ⛔ 깨움은 post 의 성패를 바꾸지 않는다 — 실패·시간 초과는 결과 값으로만 돌아온다.
// ⛔ 시험 우주에서는 실제 pty/herdr 호출 0 — `ELANOUS_MSG_WAKE_LIVE=1` 로만 연다(격리 실물 시험용).
// ⭐ 버리지 않고 미룬다(TUI-H4 · 10-16 OPT 우편 36 중 18 깨움 0): pty-inject 대상이 턴 중(busy)이거나 5분 창(debounced)이라
//    못 두드린 글은 `pending_wakes` 에 «주소당 한 줄»로 접어 두고, 그 TUI 안의 폴러(`startPendingWakePoller`)가
//    턴이 idle 로 «기록»된 뒤 한 번 다시 두드린다. 5분 창은 다시 두드림에도 걸린다 — 창 안이면 버림이 아니라 다음 틱으로 미룸.
//    상한(시도 3 · 2시간) → `gave-up`. 관측 = `loops.msg-wake` deferred | redelivered | gave-up.
//    재두드림 «전»에 그 주소 미읽음을 잰다 — 0 이면 두드리지 않고 줄을 지운다(`dropped-read` · H4-FOLLOW ③).

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { canonicalSeatId, readUnreadCount } from '../msg/msg-store.js';
import { herdrPrompt, type HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { messageRouteFor, parsePaneMessageAddress, SEAT_MESSAGE_ROUTES, type MessageWake } from './msg-address.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { readSeatRegistry, seatRegistryEntry, seatRegistryPath, type SeatRegistryEntry } from './seat-registry.js';

export const WAKE_DEBOUNCE_MS = 5 * 60_000;
export const WAKE_TIMEOUT_MS = 3_000;
/** A deferred wake is retried at most this many times (an attempt = idle ∧ window free ∧ injection tried). */
export const MAX_REDELIVER_ATTEMPTS = 3;
/** A deferred wake older than this is given up even if the TUI never went idle. */
export const PENDING_WAKE_TTL_MS = 2 * 60 * 60_000;
export const PENDING_WAKE_POLL_MS = 15_000;
/** Seat-folder file that opts a human pane in to wake injection (presence is the switch). */
const WAKE_OPT_IN_FILE = 'wake-inject';

export interface WakeResolution {
  wake: MessageWake;
  /** pty id (pty-inject) or herdr pane id (herdr). */
  target?: string;
  /** Where the answer came from — `unresolved` means «모름», not a measured absence. */
  source: 'loop-table' | 'seat-registry' | 'pty-name' | 'pty.ref' | 'herdr.pane' | 'unresolved';
  /** Registered execution host; `local` uses the current process and any other value is an SSH alias. */
  host?: string;
  reason?: string;
  /** For a seat-folder target: the seat opted in to injection (`<seat>/wake-inject` exists). Absent = not a seat target. */
  optIn?: boolean;
}

export type WakeResult = 'none-sse' | 'wake-deferred' | 'injected' | 'busy' | 'debounced' | 'skipped' | 'skipped-reply'
  | 'skipped-self' | 'skipped-test-universe' | 'no-wake' | 'failed' | 'timeout';

export interface WakeOutcome extends WakeResolution { address: string; msgId: number; result: WakeResult }

export interface WakeDeps {
  /** Seat folders (`<root>/<SEAT>/pty.ref` · `herdr.pane`). Prod: ~/elanous-hq/seat-state · test universe: <root>/seat-state. */
  seatStateRoot?: string;
  /** Debounce claims live here (`<stateRoot>/msg/wake-claims.db`). */
  stateRoot?: string;
  now?: () => number;
  /** Real pty/herdr calls are allowed (default: prod universe or ELANOUS_MSG_WAKE_LIVE=1). */
  live?: boolean;
  timeoutMs?: number;
  listPtys?: () => Array<{ id: string; nickname?: string; alive: boolean; turnState?: 'busy' | 'idle' }>;
  /** Herdr pane census seam used for explicit pane/session addresses and undeclared-seat recovery. */
  listHerdrPanes?: () => Array<{ paneId: string; sessionId?: string; title?: string; cwd?: string; host?: string; status?: string }> | null;
  /** Process boundary seam for testing Herdr's JSON command and failure modes. */
  runHerdrPaneList?: (args: readonly string[]) => { status: number | null; stdout: string; stderr?: string; error?: unknown };
  /** Reads one seat-folder file (`pty.ref` · `herdr.pane`); null when absent. */
  readPane?: (path: string) => string | null;
  /** Does this seat-folder opt-in file exist (`<seat>/wake-inject`)? */
  hasOptIn?: (path: string) => boolean;
  /** Loads the pty writer (the CLI module is heavy, so it is imported only when a pty wake is due). */
  ptyInjector?: () => Promise<(ptyId: string, line: string) => Promise<void>>;
  /** The herdr CLI runner `herdrPrompt` drives (`agent get` · `pane run`). Default: the real `herdr` (HERDR_BIN_PATH · PATH). */
  herdrRun?: HerdrCliRunner;
  /** Builds a herdr runner for a registered remote SSH host. No shell is used for host or argv values. */
  herdrRunForHost?: (host: string) => HerdrCliRunner;
  /** Registry path override; defaults to <seatStateRoot>/seat-registry.json. */
  registryPath?: string;
  /** Test seam for the central registry reader. */
  readRegistry?: () => ReturnType<typeof readSeatRegistry>;
  warn?: (line: string) => void;
  /** Unread count for an address before a deferred re-knock (H4-FOLLOW ③). null = «모름» (never drops). Default: the msg ledger. */
  readUnread?: (address: string) => number | null;
}

type HerdrPane = { paneId: string; sessionId?: string; title?: string; cwd?: string; host?: string; status?: string };

let paneCensusCachedAt = 0;
let paneCensusHasValue = false;
let paneCensusCache: HerdrPane[] | null = null;

function herdrPaneCensus(run?: WakeDeps['runHerdrPaneList']): HerdrPane[] | null {
  if (!run && paneCensusHasValue && Date.now() - paneCensusCachedAt < 500) return paneCensusCache;
  const command = run ?? ((args: readonly string[]) => spawnSync('herdr', [...args], { encoding: 'utf8', timeout: 1500, windowsHide: true }));
  let result = command(['pane', 'list', '--json']);
  // Herdr 0.9.1 emits JSON by default and rejects --json. Retry only that
  // version mismatch; other failures must remain an unknown census.
  if (result.status === 2 && /unknown option[^\n]*--json/i.test(result.stderr ?? '')) {
    result = command(['pane', 'list']);
  }
  let parsed: HerdrPane[] | null = null;
  if (result.status !== 0 || result.error) {
    parsed = null;
  } else {
    try {
      const envelope = JSON.parse(result.stdout) as { result?: { panes?: unknown[] } };
      if (!Array.isArray(envelope.result?.panes)) throw new Error('invalid herdr pane list envelope');
      parsed = envelope.result.panes.map(value => {
        if (!value || typeof value !== 'object') throw new Error('invalid herdr pane row');
        const row = value as Record<string, unknown>;
        const paneId = row.pane_id ?? row.paneId;
        if (typeof paneId !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(paneId)) throw new Error('invalid herdr pane ID');
        const string = (...keys: string[]) => {
          const key = keys.find(candidate => Object.hasOwn(row, candidate));
          if (key === undefined) return undefined;
          if (typeof row[key] !== 'string') throw new Error(`invalid Herdr pane field: ${key}`);
          return row[key] as string;
        };
        const sessionId = string('session_id', 'sessionId');
        const title = string('title', 'name');
        const cwd = string('cwd', 'working_directory');
        const host = string('host', 'ssh_host');
        const status = string('agent_status', 'pane_status', 'status');
        return { paneId, ...(sessionId ? { sessionId } : {}), ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(host ? { host } : {}), ...(status ? { status } : {}) };
      });
    } catch { parsed = null; }
  }
  if (!run) {
    paneCensusCache = parsed;
    paneCensusCachedAt = Date.now();
    paneCensusHasValue = true;
  }
  return parsed;
}

function paneLiveness(pane: HerdrPane): 'live' | 'dead' | 'unknown' {
  const status = pane.status?.trim().toLowerCase();
  if (status && ['idle', 'working', 'blocked'].includes(status)) return 'live';
  if (status && ['done', 'dead', 'exited', 'closed', 'stopped', 'missing'].includes(status)) return 'dead';
  return 'unknown';
}

function paneLivenessReason(pane: HerdrPane, type: 'pane' | 'session'): string {
  return paneLiveness(pane) === 'dead' ? `dead-${type}-address` : 'pane-status-unknown';
}

function unresolved(reason: string): WakeResolution {
  return { wake: 'none', source: 'unresolved', reason };
}

function seatsFromPane(row: HerdrPane): string[] {
  const candidates = [
    /\|\s*([A-Za-z][A-Za-z0-9_-]*)\s*$/.exec(row.title ?? '')?.[1],
    /(?:^|[/\\])seats[/\\]([A-Za-z][A-Za-z0-9_-]*)(?:[/\\]|$)/i.exec(row.cwd ?? '')?.[1],
  ].filter((seat): seat is string => seat !== undefined).map(seat => seat.toUpperCase());
  return [...new Set(candidates)];
}

function paneSeatIdentity(row: HerdrPane): { seats: string[]; complete: boolean; ambiguous: boolean } {
  const seats = seatsFromPane(row);
  return { seats, complete: row.title !== undefined && row.cwd !== undefined, ambiguous: seats.length > 1 };
}

function paneOptIn(row: HerdrPane, deps: WakeDeps): boolean {
  const seats = seatsFromPane(row);
  if (seats.length !== 1) return false;
  const seat = seats[0]!;
  const path = join(resolveSeatStateRoot(deps), seat, WAKE_OPT_IN_FILE);
  return deps.hasOptIn?.(path) ?? existsSync(path);
}

function isLive(deps: WakeDeps): boolean {
  if (deps.live !== undefined) return deps.live;
  return effectiveInstanceRoot() === prodInstanceRoot() || process.env.ELANOUS_MSG_WAKE_LIVE === '1';
}

export function resolveSeatStateRoot(deps: WakeDeps = {}): string {
  if (deps.seatStateRoot) return deps.seatStateRoot;
  const root = effectiveInstanceRoot();
  return root === prodInstanceRoot() ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state');
}

function registryFor(deps: WakeDeps) {
  return deps.readRegistry?.() ?? readSeatRegistry(deps.registryPath ?? seatRegistryPath(resolveSeatStateRoot(deps)));
}

function wakeResolutionForSeat(entry: SeatRegistryEntry): WakeResolution {
  return { wake: entry.wake, ...(entry.target ? { target: entry.target } : {}), source: 'seat-registry',
    host: entry.host, optIn: entry.optIn, ...(entry.wake === 'none' ? { reason: 'registry-wake-disabled' } : {}) };
}

function validateRegisteredHerdrPane(entry: SeatRegistryEntry, census: () => HerdrPane[] | null): WakeResolution {
  const registered = wakeResolutionForSeat(entry);
  if (entry.wake !== 'herdr' || !entry.target) return registered;
  const panes = census();
  if (panes === null) return unresolved('pane-census-unavailable:candidates=unknown');
  const matches = panes.filter(row => row.paneId === entry.target);
  if (matches.length !== 1) return unresolved(`${matches.length > 1 ? 'ambiguous-pane' : 'dead-pane-address'}:candidates=${matches.length}`);
  const pane = matches[0]!;
  const liveness = paneLiveness(pane);
  if (liveness !== 'live') return unresolved(`${paneLivenessReason(pane, 'pane')}:candidates=1`);
  return { ...registered, host: entry.host || pane.host };
}

/** Reply-body policy shares the same address registry used for wake routing. */
export function messageReplyBodyFor(address: string, deps: WakeDeps = {}): string | null {
  const loopRoute = messageRouteFor(address);
  if (loopRoute?.wake) return loopRoute.replyBody ?? null;
  const registry = registryFor(deps);
  if (registry.status !== 'ready') return null;
  return seatRegistryEntry(registry.registry, address)?.replyBody ?? null;
}

/** POSIX-shell quote argv because OpenSSH transmits its remote command as text. */
export function quoteRemoteHerdrCommand(argv: readonly string[]): string {
  const escapedQuote = String.fromCharCode(39, 92, 39, 39);
  return ['herdr', ...argv].map(value => String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), escapedQuote) + String.fromCharCode(39)).join(' ');
}

/** Default SSH transport for a registered remote herdr host. */
export function remoteHerdrRunner(host: string): HerdrCliRunner {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) throw new Error('invalid registered SSH host');
  return (argv, timeoutMs) => new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', host, quoteRemoteHerdrCommand(argv)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }); return; }
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish({ code: null, stdout, stderr: stderr || 'remote herdr timed out' }); }, Math.max(1, timeoutMs));
    child.stdout?.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.on('error', error => finish({ code: null, stdout, stderr: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}

/** How a post to `address` would wake its reader — table first, then a live pty named after the seat, then herdr. */
export function resolveWake(address: string, deps: WakeDeps = {}): WakeResolution {
  const raw = address.trim();
  const name = raw.toUpperCase();
  if (name === 'ALL') return { wake: 'none', source: 'unresolved', reason: 'topic' };
  const loop = messageRouteFor(name);
  if (loop?.wake) return { wake: loop.wake, source: 'loop-table' };
  const direct = parsePaneMessageAddress(raw);
  const census = () => deps.listHerdrPanes ? deps.listHerdrPanes() : herdrPaneCensus(deps.runHerdrPaneList);
  if (direct?.kind === 'pane') {
    const panes = census();
    if (panes === null) return unresolved('pane-census-unavailable:candidates=unknown');
    const matches = panes.filter(row => row.paneId === direct.paneId);
    const pane = matches.length === 1 && paneLiveness(matches[0]!) === 'live' ? matches[0] : undefined;
    return pane ? { wake: 'herdr', target: pane.paneId, source: 'herdr.pane', ...(pane.host ? { host: pane.host } : {}), optIn: paneOptIn(pane, deps) }
      : unresolved(`${matches.length > 1 ? 'ambiguous-pane' : matches.length === 1 ? paneLivenessReason(matches[0]!, 'pane') : 'dead-pane-address'}:candidates=${matches.length}`);
  }
  if (direct?.kind === 'session') {
    const panes = census();
    if (panes === null) return unresolved('pane-census-unavailable:candidates=unknown');
    if (panes.some(row => row.sessionId === undefined)) return unresolved(`session-address-fields-unknown:candidates=${panes.length}`);
    const matches = panes.filter(row => row.sessionId === direct.sessionId);
    const pane = matches.length === 1 && paneLiveness(matches[0]!) === 'live' ? matches[0] : undefined;
    return pane ? { wake: 'herdr', target: pane.paneId, source: 'herdr.pane', ...(pane.host ? { host: pane.host } : {}), optIn: paneOptIn(pane, deps) }
      : unresolved(matches.length > 1 ? `ambiguous-session:candidates=${matches.length}` : matches.length === 1
        ? `${paneLivenessReason(matches[0]!, 'session')}:candidates=1` : `dead-session-address:candidates=0`);
  }
  if (direct?.kind === 'seat-pane') {
    const panes = census();
    if (panes === null) return unresolved('pane-census-unavailable:candidates=unknown');
    const paneRows = panes.filter(row => row.paneId === direct.pane || row.paneId.endsWith(`:${direct.pane}`));
    if (paneRows.some(row => paneSeatIdentity(row).ambiguous)) return unresolved(`ambiguous-pane:candidates=${paneRows.length}`);
    if (paneRows.some(row => !paneSeatIdentity(row).complete)) return unresolved(`pane-address-fields-unknown:candidates=${paneRows.length}`);
    const matches = paneRows.filter(row => paneSeatIdentity(row).seats.includes(direct.seat));
    const pane = matches.length === 1 && paneLiveness(matches[0]!) === 'live' ? matches[0] : undefined;
    return pane ? { wake: 'herdr', target: pane.paneId, source: 'herdr.pane', ...(pane.host ? { host: pane.host } : {}), optIn: paneOptIn(pane, deps) }
      : unresolved(matches.length > 1 ? `ambiguous-pane:candidates=${matches.length}` : matches.length === 1
        ? `${paneLivenessReason(matches[0]!, 'pane')}:candidates=1` : `dead-pane-address:candidates=0`);
  }
  // Explicit registry entries remain authoritative; an absent declaration can resolve by pane title/cwd.
  const registry = registryFor(deps);
  if (registry.status === 'invalid') return { wake: 'none', source: 'unresolved', reason: `invalid-seat-registry:${registry.reason}` };
  if (registry.status === 'ready') {
    const entry = seatRegistryEntry(registry.registry, name);
    if (entry) return validateRegisteredHerdrPane(entry, census);
  }
  const seatName = name.replace(/^SEAT:/, '');
  const panes = census();
  if (panes === null) return unresolved('pane-census-unavailable:candidates=unknown');
  const allMatches = panes.filter(row => seatsFromPane(row).includes(seatName));
  if (allMatches.some(row => paneSeatIdentity(row).ambiguous)) return unresolved(`ambiguous-seat:candidates=${allMatches.length}`);
  if (panes.some(row => !paneSeatIdentity(row).complete)) return unresolved(`seat-address-fields-unknown:candidates=${panes.length}`);
  return allMatches.length === 1 && paneLiveness(allMatches[0]!) === 'live'
    ? { wake: 'herdr', target: allMatches[0]!.paneId, source: 'herdr.pane', ...(allMatches[0]!.host ? { host: allMatches[0]!.host } : {}), optIn: paneOptIn(allMatches[0]!, deps) }
    : unresolved(allMatches.length > 1 ? `ambiguous-seat:candidates=${allMatches.length}`
      : allMatches.length === 1 ? `${paneLivenessReason(allMatches[0]!, 'pane')}:candidates=1`
        : `${registry.status === 'absent' ? 'seat-registry-missing' : 'undeclared-address'}:candidates=${panes.length}`);
}

export interface RegisterSeatPaneOptions {
  address: string;
  paneId: string;
  host: string;
  enableWake?: boolean;
  replace?: boolean;
}

export interface RegisterSeatPaneResult {
  address: string;
  paneId: string;
  host: string;
  registryFile: string;
  changed: boolean;
  wakeEnabled: boolean;
}

function atomicPrivateWrite(path: string, contents: string, replace = false): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(temp, path);
    else { linkSync(temp, path); unlinkSync(temp); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* no temporary file remains */ }
    throw error;
  }
}

/**
 * The first registration snapshots existing statically declared seat routes once; after that,
 * seat-registry.json is authoritative. New seats are admitted by this command without changing code.
 */
export function registerSeatPaneAddress(input: RegisterSeatPaneOptions, deps: WakeDeps = {}): RegisterSeatPaneResult {
  const address = canonicalSeatId(input.address);
  if (messageRouteFor(address)?.wake) throw new Error(`loop address is not a seat: ${address}`);
  const host = input.host.trim();
  if (!host) throw new Error('host is required (use local or an SSH alias)');
  if (host === 'unknown' || !/^(?:local|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/.test(host)) throw new Error('invalid host (use local or an SSH alias)');
  const paneId = input.paneId.trim();
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(paneId)) throw new Error('invalid herdr pane ID');
  const root = resolveSeatStateRoot(deps);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const registryFile = deps.registryPath ?? seatRegistryPath(root);
  try { if (lstatSync(registryFile).isSymbolicLink()) throw new Error('seat registry must not be a symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // A local PID check can mistake a live lock owner on another shared-registry host for a dead process.
  const unlock = acquireLockSync(`${registryFile}.lock`, { breakDeadHolder: false, staleMs: 5 * 60_000 });
  try {
    const currentRead = readSeatRegistry(registryFile);
    if (currentRead.status === 'invalid') throw new Error(`invalid seat registry: ${currentRead.reason}`);
    let seats = currentRead.status === 'ready' ? [...currentRead.registry.seats] : [];
    if (currentRead.status === 'absent') {
      // Preserve static address/reply policy only; pane IDs and opt-in are host-local.
      for (const legacyAddress of Object.keys(SEAT_MESSAGE_ROUTES)) {
        if (legacyAddress !== address) seats.push({ address: legacyAddress, host: 'unknown', wake: 'none', replyBody: SEAT_MESSAGE_ROUTES[legacyAddress]?.replyBody ?? 'none', optIn: false });
      }
    }
    const previous = seats.find(entry => entry.address === address);
    const changed = previous?.target !== paneId || previous.host !== host || previous.wake !== 'herdr';
    const hasBinding = previous !== undefined && (previous.target !== undefined || previous.wake !== 'none');
    if (hasBinding && changed && !input.replace) throw new Error(`seat ${address} already points to ${previous.host}:${previous.target ?? '(none)'}; pass --replace to update`);
    const entry: SeatRegistryEntry = {
      address, host, target: paneId, wake: 'herdr', replyBody: previous?.replyBody ?? 'agent',
      // Rebinding revokes consent unless this command explicitly opts the new target in.
      optIn: input.enableWake === true ? true : changed ? false : previous?.optIn ?? false,
    };
    const nextSeats = [...seats.filter(row => row.address !== address), entry].sort((a, b) => a.address.localeCompare(b.address));
    const next = JSON.stringify({ version: 1, seats: nextSeats }, null, 2) + '\n';
    const oldContents = currentRead.status === 'ready' ? JSON.stringify(currentRead.registry, null, 2) + '\n' : null;
    const changedFile = oldContents !== next;
    if (changedFile) atomicPrivateWrite(registryFile, next, currentRead.status === 'ready');
    return { address, paneId, host, registryFile, changed: changedFile, wakeEnabled: entry.optIn };
  } finally { unlock(); }
}

function claimDbPath(deps: WakeDeps): string {
  return join(deps.stateRoot ?? effectiveInstanceRoot(), 'msg', 'wake-claims.db');
}

interface WakeClaim { db: string; address: string; token: string }

function openWakeDb(db: string): Database {
  mkdirSync(dirname(db), { recursive: true });
  const conn = new Database(db);
  try {
    conn.exec('PRAGMA busy_timeout = 2000');
    conn.exec('CREATE TABLE IF NOT EXISTS wake_claims (address TEXT PRIMARY KEY, at INTEGER NOT NULL, token TEXT NOT NULL)');
    conn.exec(`CREATE TABLE IF NOT EXISTS pending_wakes (address TEXT PRIMARY KEY, first_msg_id INTEGER NOT NULL,
      last_msg_id INTEGER NOT NULL, last_from TEXT NOT NULL, count INTEGER NOT NULL, since INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL)`);
    return conn;
  } catch (error) { conn.close(); throw error; }
}

/**
 * Atomically claim the 5-minute wake window for one address. One SQLite upsert decides it under the
 * write lock — the row is replaced only when the held claim is older than the window — so two
 * concurrent `msg post` processes cannot both win, including when both saw an expired claim.
 */
export function claimWake(db: string, address: string, now: number): WakeClaim | null {
  const token = `${now} ${process.pid} ${randomUUID()}`;
  const conn = openWakeDb(db);
  try {
    const changed = conn.query(`INSERT INTO wake_claims (address, at, token) VALUES (?1, ?2, ?3)
      ON CONFLICT(address) DO UPDATE SET at = excluded.at, token = excluded.token WHERE wake_claims.at <= ?2 - ?4`)
      .run(address, now, token, WAKE_DEBOUNCE_MS).changes;
    return changed === 1 ? { db, address, token } : null;
  } finally { conn.close(); }
}

/** Give the window back when nothing was injected (busy · timeout · failure) — only our own claim. */
function releaseClaim(claim: WakeClaim): void {
  try {
    const conn = new Database(claim.db);
    try { conn.exec('PRAGMA busy_timeout = 2000'); conn.query('DELETE FROM wake_claims WHERE address = ?1 AND token = ?2').run(claim.address, claim.token); }
    finally { conn.close(); }
  } catch { /* a stale claim only delays the next wake by one window */ }
}

async function defaultPtyInjector(): Promise<(ptyId: string, line: string) => Promise<void>> {
  const { runPtyText } = await import('../cli/pty-takeover-cli.js');
  return async (ptyId, line) => {
    const result = await runPtyText(ptyId, line, true);
    if (result.exitCode !== 0) throw new Error(result.message);
  };
}

export function wakeLine(from: string, address: string, msgId: number): string {
  return `[우편 깨움] ${from} → ${address} #${msgId} — eln msg list --to ${address} 로 읽고 처리`;
}

export const NO_WAKE_NOTICE = '이 주소는 깨울 길이 없다 — 받는 몸이 스스로 읽을 때까지 쌓인다';

/**
 * Wake the reader of a just-saved message. Never throws; the caller's post outcome is already final.
 * `message.from`/`kind` decide the skips (a reply or a self-addressed note never wakes anyone).
 */
export async function wakeRecipient(address: string, msgId: number, message: { from: string; kind?: string }, deps: WakeDeps = {}): Promise<WakeOutcome> {
  const timeoutMs = deps.timeoutMs ?? WAKE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolution: WakeResolution = { wake: 'none', source: 'unresolved', reason: 'not-resolved' };
  const controller = new AbortController();
  // 마감은 «진입» 시각 기준 — 동기 작업(claim 잠금 대기 등)이 늦어 타이머가 못 울려도 넘기면 주입하지 않는다.
  const deadline = Date.now() + timeoutMs;
  const expired = () => controller.signal.aborted || Date.now() >= deadline;
  let claim: WakeClaim | null = null;
  let injecting = false;
  const attempt = (async (): Promise<WakeOutcome> => {
    const done = (result: WakeResult, reason?: string): WakeOutcome =>
      ({ ...resolution, ...(reason ? { reason } : {}), address, msgId, result });
    if (message.kind === 'reply') return done('skipped-reply', 'kind=reply');
    if (message.from.toUpperCase() === address.toUpperCase()) return done('skipped-self', 'from=to');
    resolution = resolveWake(address, deps);
    if (resolution.wake === 'sse') return done('none-sse');
    if (resolution.wake === 'cron') return done('wake-deferred');
    if (resolution.wake === 'none') return done('no-wake');
    // 사람이 앉는 pane 은 명시 opt-in 이 없으면 주입 0 — 에이전트가 idle 이어도 사람이 치는 중일 수 있다.
    if (resolution.optIn === false) return done('skipped', 'human-pane-no-opt-in');
    if (!isLive(deps)) return done('skipped-test-universe');
    claim = claimWake(claimDbPath(deps), address, (deps.now ?? Date.now)());
    if (!claim) return done('debounced');
    try {
      const line = wakeLine(message.from, address, msgId);
      if (resolution.wake === 'pty-inject') {
        // 모듈을 «먼저» 불러오고, 그 뒤에 턴을 읽는다 — 로드 사이 busy 로 바뀐 TUI 에 넣지 않는다.
        const inject = await (deps.ptyInjector ?? defaultPtyInjector)();
        // turnState 는 TUI 가 스스로 적은 값(#27485) — 살아 있고 idle 이 «기록»돼 있을 때만 넣는다(모름 = 넣지 않음).
        // 로드 사이 별명·pty.ref 가 다른 행으로 옮겨 갔으면 넣지 않는다 — 주소→대상을 다시 푼다.
        const again = resolveWake(address, deps);
        // opt-in 은 주입 직전에 «먼저» 다시 본다 — 기다리는 사이 `wake-inject` 를 지웠으면(대상이 바뀌었어도) 주입 0.
        if (again.optIn !== true) { resolution = { ...resolution, optIn: false }; return done('skipped', 'human-pane-no-opt-in'); }
        if (again.wake !== 'pty-inject' || again.target !== resolution.target || again.host !== resolution.host) return done('busy', `target-moved:${again.target ?? again.wake}`);
        const row = (deps.listPtys ?? listPtyManifestRows)().find(item => item.id === resolution.target);
        if (!row?.alive || row.turnState !== 'idle') return done('busy', `turn=${row?.alive === false ? 'dead' : row?.turnState ?? 'unknown'}`);
        // ⛔ 마감이 지났으면 새 주입을 시작하지 않는다.
        if (expired()) return done('timeout');
        injecting = true;
        await inject(resolution.target!, line);
      } else {
        // 구조 pane list 확인(지원 agent · idle 만) → 제출 앞 관문 → bracketed `pane run` 한 번.
        // 화면 문구는 빈 입력 판정에 쓰지 않는다 — placeholder 와 사용자가 친 같은 문장을 구별할 수 없다.
        const target = resolution.target!;
        const prompted = await herdrPrompt({ target, text: line, anyAgent: true, requirePaneListStatus: true,
          timeoutMs: Math.max(1, deadline - Date.now()) }, {
          ...((resolution.host && resolution.host !== 'local')
            ? { run: (deps.herdrRunForHost ?? remoteHerdrRunner)(resolution.host) }
            : deps.herdrRun ? { run: deps.herdrRun } : {}),
          beforeSubmit: () => {
            // opt-in 은 주입 직전에 «먼저» 다시 본다 — 기다리는 사이 `wake-inject` 를 지웠으면(대상이 바뀌었어도) 주입 0.
            const again = resolveWake(address, deps);
            if (again.optIn !== true) { resolution = { ...resolution, optIn: false }; return 'human-pane-no-opt-in'; }
            // 조회 사이 자리의 pane 이 바뀌었으면 옛 pane 에 넣지 않는다 — 주소→대상을 다시 푼다.
            if (again.wake !== 'herdr' || again.target !== target || again.host !== resolution.host) return `target-moved:${again.host ?? again.target ?? again.wake}`;
            // ⛔ 마감은 «주입 바로 앞»에서 — 재해석이 늦어 넘겼어도 새 주입 0.
            if (expired()) return 'timeout';
            injecting = true;
            return undefined;
          },
        });
        if (!prompted.accepted) injecting = false;
        const reason = prompted.reason;
        const result: WakeResult = reason === 'submitted' ? 'injected'
          : reason === 'human-pane-no-opt-in' ? 'skipped'
            : reason === 'timeout' ? 'timeout'
              : reason.startsWith('target-moved:') || reason === 'agent_working' || reason === 'agent_blocked' || reason === 'agent_unknown' ? 'busy'
                : 'failed';
        const outReason = result === 'busy' && !reason.startsWith('target-moved:') ? `agent_status=${prompted.status ?? 'unknown'}`
          : result === 'injected' || result === 'timeout' ? undefined : reason;
        logPending('herdr-prompt', { seat: address.trim().toUpperCase(), msgId, target, result, accepted: prompted.accepted, reason,
          ...(prompted.status ? { status: prompted.status } : {}), ...(prompted.agent ? { agent: prompted.agent } : {}), ms: prompted.ms });
        if (result !== 'injected') return done(result, outReason);
      }
      return done('injected');
    } catch (error) {
      // 주입이 «시작»됐다 실패하면 들어갔는지 모른다 — 창을 돌려줘 다음 글이 다시 깨우게 한다.
      injecting = false;
      throw error;
    } finally { if (!injecting && claim) releaseClaim(claim); }
  })();
  let outcome: WakeOutcome;
  try {
    outcome = await Promise.race([attempt, new Promise<WakeOutcome>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        // 시간 초과면 창을 돌려준다 — 주입 전이면 들어간 것이 없고, 주입 중 멈췄으면 들어갔는지 «모른다».
        // 모를 때는 다음 글이 다시 두드리게 둔다(내용 없는 한 줄의 중복은 무해, 깨움 누락은 16분 정지).
        if (claim) releaseClaim(claim);
        resolve({ ...resolution, address, msgId, result: 'timeout' });
      }, timeoutMs);
    })]);
  } catch (error) {
    outcome = { ...resolution, address, msgId, result: 'failed', reason: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
  attempt.catch(() => { /* a late failure after timeout is already reported as timeout */ });
  try {
    if (outcome.result === 'no-wake') (deps.warn ?? (line => console.error(line)))(
      outcome.source === 'unresolved' ? `${NO_WAKE_NOTICE} (wake=none · 모름: ${outcome.reason})` : `${NO_WAKE_NOTICE} (wake=none)`);
    debug.log('msg.wake', outcome.result === 'skipped' ? 'skipped' : outcome.wake, { address, msgId, wake: outcome.wake, result: outcome.result, reason: outcome.reason ?? outcome.source,
      ...(outcome.target ? { target: outcome.target } : {}), ...(outcome.host ? { host: outcome.host } : {}) });
  } catch { /* reporting never turns a wake outcome into a throw */ }
  try { settlePending(outcome, message.from, deps); } catch { /* the deferral ledger never turns a post into a throw */ }
  return outcome;
}

// ── 미룬 깨움(pending) ─────────────────────────────────────────────────────────

interface PendingWakeRow { address: string; first_msg_id: number; last_msg_id: number; last_from: string; count: number; since: number; attempts: number; reason: string }

export type PendingWakeEvent = 'deferred' | 'redelivered' | 'gave-up' | 'dropped-read' | 'skip' | 'herdr-prompt';

function logPending(event: PendingWakeEvent, data: Record<string, unknown>): void {
  try { debug.log('loops.msg-wake', event, data); } catch { /* observability is fail-open */ }
}

/**
 * After a fresh wake: busy, debounced, or failed pty-inject wakes are remembered for unread-aware recovery;
 * an injected wake absorbs whatever was pending for that address (the line tells the reader to list everything).
 */
function settlePending(outcome: WakeOutcome, from: string, deps: WakeDeps): void {
  if (!isLive(deps)) return;
  // TTL 은 폴러 «밖»에서도 닫는다 — TUI 가 죽은 채 안 돌아오면 그 폴러는 없다. 어느 주소든 post 가 오면 낡은 줄을 거둔다.
  try { prunePendingWakes(deps); } catch { /* fail-soft */ }
  if (outcome.wake !== 'pty-inject') return;
  const address = outcome.address.trim().toUpperCase();
  if (outcome.result === 'injected') {
    // 이 줄은 «그때까지 저장된 글 전부를 읽어라»라 msgId 이하만 덮는다 — 주입 «뒤»에 저장·미뤄진 글(더 큰 id)이 섞인 줄은 남긴다.
    const conn = openWakeDb(claimDbPath(deps));
    try { conn.query('DELETE FROM pending_wakes WHERE address = ?1 AND last_msg_id <= ?2').run(address, outcome.msgId); } finally { conn.close(); }
    return;
  }
  if (outcome.result !== 'busy' && outcome.result !== 'debounced' && outcome.result !== 'failed') return;
  const reason = outcome.result === 'debounced' ? 'debounced' : outcome.reason ?? outcome.result;
  const conn = openWakeDb(claimDbPath(deps));
  let count = 1;
  try {
    // 주소당 한 줄 — 묶음이 늘어도 다시 두드림은 한 번. 범위는 id 순서로(동시 post 가 역순으로 와도 min·max),
    // 보낸 이는 끝 id 의 것. 끝 id 가 바뀌면(새 글) 시도 수는 0 — 새 글은 자기 몫의 시도를 받는다. 시작 시각(TTL)은 첫 미룸 기준.
    conn.query(`INSERT INTO pending_wakes (address, first_msg_id, last_msg_id, last_from, count, since, attempts, reason)
      VALUES (?1, ?2, ?2, ?3, 1, ?4, 0, ?5)
      ON CONFLICT(address) DO UPDATE SET first_msg_id = min(first_msg_id, excluded.first_msg_id),
        last_msg_id = max(last_msg_id, excluded.last_msg_id),
        last_from = CASE WHEN excluded.last_msg_id > last_msg_id THEN excluded.last_from ELSE last_from END,
        attempts = CASE WHEN excluded.last_msg_id > last_msg_id THEN 0 ELSE attempts END,
        count = count + 1, reason = excluded.reason`)
      .run(address, outcome.msgId, from, (deps.now ?? Date.now)(), reason);
    count = (conn.query('SELECT count FROM pending_wakes WHERE address = ?1').get(address) as { count: number } | null)?.count ?? 1;
  } finally { conn.close(); }
  logPending('deferred', { seat: address, count, reason, msgId: outcome.msgId });
}

function logGaveUp(row: PendingWakeRow, reason: string, attempts = row.attempts): void {
  logPending('gave-up', { seat: row.address, count: row.count, reason, attempts, firstMsgId: row.first_msg_id, lastMsgId: row.last_msg_id });
}

/** Give up deferrals older than the TTL (a TUI that died and never came back has no poller to do it). */
export function prunePendingWakes(deps: WakeDeps = {}): number {
  const db = claimDbPath(deps);
  if (!existsSync(db)) return 0;
  const cutoff = (deps.now ?? Date.now)() - PENDING_WAKE_TTL_MS;
  const conn = openWakeDb(db);
  try {
    const stale = conn.query('SELECT * FROM pending_wakes WHERE since < ?1').all(cutoff) as PendingWakeRow[];
    for (const row of stale) {
      if (conn.query('DELETE FROM pending_wakes WHERE address = ?1 AND last_msg_id = ?2').run(row.address, row.last_msg_id).changes === 1) logGaveUp(row, 'ttl');
    }
    return stale.length;
  } finally { conn.close(); }
}

export interface RedeliverOutcome { seat: string; result: 'redelivered' | 'gave-up' | 'dropped-read' | 'waiting' | 'failed'; count: number; reason?: string }

/** Unread count for a deferred address — injected reader first, else the msg ledger beside the claims db. Never throws. */
function readUnreadFor(address: string, deps: WakeDeps): number | null {
  try {
    if (deps.readUnread) return deps.readUnread(address);
    return readUnreadCount(address, join(deps.stateRoot ?? effectiveInstanceRoot(), 'msg', 'messages.db'));
  } catch { return null; }
}

export function redeliverLine(row: Pick<PendingWakeRow, 'address' | 'last_from' | 'first_msg_id' | 'last_msg_id' | 'count'>): string {
  const ids = row.first_msg_id === row.last_msg_id ? `#${row.last_msg_id}` : `#${row.first_msg_id}..#${row.last_msg_id}`;
  return `[우편 깨움 · 미룬 ${row.count}통] ${row.last_from} → ${row.address} ${ids} — eln msg list --to ${row.address} 로 읽고 처리`;
}

/**
 * Re-knock deferred wakes whose TUI is now recorded idle. `target` limits the sweep to one pty (the TUI's own poller).
 * Never throws per row; a row stays pending while the TUI is busy or the 5-minute window is held.
 */
// not-live 우주의 재점검은 침묵 대신 이유 한 줄을 남긴다 — 폴러가 15초마다 틱하므로 프로세스당 처음 한 번만(래치).
let notLiveSkipLogged = false;

export async function redeliverPendingWakes(deps: WakeDeps = {}, opts: { target?: string } = {}): Promise<RedeliverOutcome[]> {
  if (!isLive(deps)) {
    if (!notLiveSkipLogged) { notLiveSkipLogged = true; logPending('skip', { reason: 'not-live' }); }
    return [];
  }
  const db = claimDbPath(deps);
  if (!existsSync(db)) return [];
  const conn = openWakeDb(db);
  let rows: PendingWakeRow[];
  try { rows = conn.query('SELECT * FROM pending_wakes ORDER BY since').all() as PendingWakeRow[]; } finally { conn.close(); }
  const results: RedeliverOutcome[] = [];
  const now = () => (deps.now ?? Date.now)();
  // 지울 때는 «읽은 그 묶음»만 — 그 사이 새로 미룬 글이 오면 줄이 남아 한 번 더 두드린다.
  const drop = (row: PendingWakeRow): boolean => {
    const c = openWakeDb(db);
    try { return c.query('DELETE FROM pending_wakes WHERE address = ?1 AND last_msg_id = ?2').run(row.address, row.last_msg_id).changes === 1; }
    finally { c.close(); }
  };
  // 포기는 «실제로 지운» 묶음만 — 그 사이 새 글이 합쳐졌으면(끝 id 바뀜) 줄은 새 묶음으로 남고 시도 수는 0 으로 돌아가 있다.
  const giveUp = (row: PendingWakeRow, reason: string) => {
    if (drop(row)) {
      logGaveUp(row, reason);
      results.push({ seat: row.address, result: 'gave-up', count: row.count, reason });
    } else results.push({ seat: row.address, result: 'waiting', count: row.count, reason: 'batch-changed' });
  };
  for (const row of rows) {
    try {
      if (row.attempts >= MAX_REDELIVER_ATTEMPTS) { giveUp(row, `attempts>=${MAX_REDELIVER_ATTEMPTS}`); continue; }
      if (now() - row.since > PENDING_WAKE_TTL_MS) { giveUp(row, 'ttl'); continue; }
      // H4-FOLLOW ③ — 그 사이 이미 읽었으면(미읽음 0) 재두드림하지 않고 줄을 지운다(10-16 OPT 가 ack 한 #9250 재두드림).
      //   «모름»(원장 없음·못 읽음)은 지우지 않는다 — 0 으로 읽지 않는다.
      const unread = readUnreadFor(row.address, deps);
      if (unread === 0) {
        if (drop(row)) {
          logPending('dropped-read', { seat: row.address, count: row.count, attempts: row.attempts, firstMsgId: row.first_msg_id, lastMsgId: row.last_msg_id });
          results.push({ seat: row.address, result: 'dropped-read', count: row.count });
        } else results.push({ seat: row.address, result: 'waiting', count: row.count, reason: 'batch-changed' });
        continue;
      }
      const resolution = resolveWake(row.address, deps);
      if (resolution.optIn === false) { giveUp(row, 'human-pane-no-opt-in'); continue; }
      // TUI 가 없거나(재기동 중) 다른 pty 의 몫이면 이번 틱은 건너뛴다 — 수명은 TTL 이 닫는다.
      if (resolution.wake !== 'pty-inject' || !resolution.target) continue;
      if (opts.target !== undefined && resolution.target !== opts.target) continue;
      const tui = (deps.listPtys ?? listPtyManifestRows)().find(item => item.id === resolution.target);
      if (!tui?.alive || tui.turnState !== 'idle') { results.push({ seat: row.address, result: 'waiting', count: row.count, reason: `turn=${tui?.turnState ?? 'unknown'}` }); continue; }
      const claim = claimWake(db, row.address, now());
      // 5분 창 안 — 버림이 아니라 미룸: 줄은 그대로, 다음 틱.
      if (!claim) { results.push({ seat: row.address, result: 'waiting', count: row.count, reason: 'debounced' }); continue; }
      const c = openWakeDb(db);
      try { c.query('UPDATE pending_wakes SET attempts = attempts + 1 WHERE address = ?1 AND last_msg_id = ?2').run(row.address, row.last_msg_id); } finally { c.close(); }
      let injected = false;
      try {
        const inject = await (deps.ptyInjector ?? defaultPtyInjector)();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([inject(resolution.target, redeliverLine(row)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), deps.timeoutMs ?? WAKE_TIMEOUT_MS);
        })]).finally(() => clearTimeout(timer));
        injected = true;
      } catch (error) {
        releaseClaim(claim);
        const reason = error instanceof Error ? error.message : String(error);
        // 상한에 닿은 실패는 그 자리에서 닫는다 — 다음 틱을 기다리지 않는다.
        if (row.attempts + 1 >= MAX_REDELIVER_ATTEMPTS) giveUp({ ...row, attempts: row.attempts + 1 }, `attempts>=${MAX_REDELIVER_ATTEMPTS}:${reason}`);
        else {
          logPending('deferred', { seat: row.address, count: row.count, reason: `inject-failed:${reason}`, attempts: row.attempts + 1 });
          results.push({ seat: row.address, result: 'failed', count: row.count, reason });
        }
      }
      if (injected) {
        drop(row);
        logPending('redelivered', { seat: row.address, count: row.count, reason: row.reason, attempts: row.attempts + 1, target: resolution.target, firstMsgId: row.first_msg_id, lastMsgId: row.last_msg_id });
        results.push({ seat: row.address, result: 'redelivered', count: row.count });
      }
    } catch (error) {
      results.push({ seat: row.address, result: 'failed', count: row.count, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * The TUI's own poller: every tick, re-knock wakes deferred for this pty once its turn is recorded idle.
 * Reuses the manifest `turn_state` the TUI already writes (#27485) — no new IPC. Unref'd; never throws.
 */
export function startPendingWakePoller(surfaceId: string, deps: WakeDeps = {}, intervalMs = PENDING_WAKE_POLL_MS): () => void {
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void redeliverPendingWakes(deps, { target: surfaceId }).catch(() => []).finally(() => { inFlight = false; });
  };
  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
