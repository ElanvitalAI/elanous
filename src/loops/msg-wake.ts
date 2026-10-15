// ── 우편 깨움 — 글을 저장한 «뒤» 받는 몸을 한 번 두드린다 ──
//
// 주소에 «답할 몸»(replyBody)이 있어도 «깨울 길»이 없으면 죽은 주소다(10-14 grok OP 16분 정지).
// 종류(`MessageWake`)마다 하는 일:
//   sse        — 아무것도 안 한다(구독자가 이미 듣는다)
//   cron       — 다음 틱에 읽는다 · `wake-deferred` 로그만
//   pty-inject — elanous TUI(pty 별명 = 자리 소문자)가 턴 idle 일 때만 한 줄 주입
//   herdr      — 자리 폴더 `herdr.pane` 의 pane 이 agent_status=idle 일 때만 한 줄 주입
//   none       — stderr 경고 한 줄 · 해석 실패는 «모름»으로 남긴다(«없다»로 위장 금지)
// ⛔ 우편은 입력칸에 넣지 않는다(대표 10-15 01:20) — 기본은 입력칸 주입 0. 10-15 01:10 사고: 대표 가 치던 문장에
//    깨움 한 줄 ⊕ Enter 가 섞여 제출됐다(«에이전트 idle ≠ 사람이 안 친다»). 자리 폴더에서 푼 대상(pty 별명·
//    pty.ref·herdr.pane)은 `<seat-state>/<자리>/wake-inject` 일반 파일이 있을 때만 주입하고, 없으면
//    `msg.wake skipped{reason}` 만 남긴다.
//    ⚠️ wake-inject 는 «사람이 치지 않는 pane»(무인 에이전트 전용)에만 둔다 — 사람이 치는 pane 에는 켜지 말 것.
// ⛔ 깨움은 post 의 성패를 바꾸지 않는다 — 실패·시간 초과는 결과 값으로만 돌아온다.
// ⛔ 시험 우주에서는 실제 pty/herdr 호출 0 — `ELANOUS_MSG_WAKE_LIVE=1` 로만 연다(격리 실물 시험용).

import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { messageRouteFor, type MessageWake } from './msg-address.js';

export const WAKE_DEBOUNCE_MS = 5 * 60_000;
export const WAKE_TIMEOUT_MS = 3_000;
/** Seat-folder file that opts a human pane in to wake injection (presence is the switch). */
const WAKE_OPT_IN_FILE = 'wake-inject';

export interface WakeResolution {
  wake: MessageWake;
  /** pty id (pty-inject) or herdr pane id (herdr). */
  target?: string;
  /** Where the answer came from — `unresolved` means «모름», not a measured absence. */
  source: 'loop-table' | 'pty-name' | 'pty.ref' | 'herdr.pane' | 'unresolved';
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
  /** Reads one seat-folder file (`pty.ref` · `herdr.pane`); null when absent. */
  readPane?: (path: string) => string | null;
  /** Does this seat-folder opt-in file exist (`<seat>/wake-inject`)? */
  hasOptIn?: (path: string) => boolean;
  /** Loads the pty writer (the CLI module is heavy, so it is imported only when a pty wake is due). */
  ptyInjector?: () => Promise<(ptyId: string, line: string) => Promise<void>>;
  herdrStatus?: (paneId: string, signal: AbortSignal) => Promise<string>;
  herdrInject?: (paneId: string, line: string, signal: AbortSignal) => Promise<void>;
  warn?: (line: string) => void;
}

function isLive(deps: WakeDeps): boolean {
  if (deps.live !== undefined) return deps.live;
  return effectiveInstanceRoot() === prodInstanceRoot() || process.env.ELANOUS_MSG_WAKE_LIVE === '1';
}

function seatStateRoot(deps: WakeDeps): string {
  if (deps.seatStateRoot) return deps.seatStateRoot;
  const root = effectiveInstanceRoot();
  return root === prodInstanceRoot() ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state');
}

/** The opt-in must be a regular file — a directory, a symlink or anything else at that name does not open injection. */
function isRegularFile(path: string): boolean {
  // lstat — 링크는 따라가지 않는다(자리 자체의 일반 파일만 opt-in).
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/** The seat's own opt-in, read independently of whatever target the seat folder points at now. */
function seatOptedIn(address: string, deps: WakeDeps): boolean {
  return (deps.hasOptIn ?? isRegularFile)(join(seatStateRoot(deps), address.trim().toUpperCase(), WAKE_OPT_IN_FILE));
}

function readPaneFile(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null; }
  catch { return null; }
}

/** How a post to `address` would wake its reader — table first, then a live pty named after the seat, then herdr. */
export function resolveWake(address: string, deps: WakeDeps = {}): WakeResolution {
  const name = address.trim().toUpperCase();
  if (name === 'ALL') return { wake: 'none', source: 'unresolved', reason: 'topic' };
  const route = messageRouteFor(name);
  if (route?.wake) return { wake: route.wake, source: 'loop-table' };
  // 호스트 해석은 표에 선언된 자리 줄(wakeFrom: 'host')만 — 모르는 주소는 같은 이름의 pty 가 있어도 깨우지 않는다.
  if (route?.wakeFrom !== 'host') return { wake: 'none', source: 'unresolved', reason: 'undeclared-address' };
  // ⭐ 별명은 «정확히» 같은 것만 — pty ref 해석의 부분 일치(op ⊂ opt)로 남의 TUI 에 넣지 않는다.
  const lower = name.toLowerCase();
  let ptys: ReturnType<NonNullable<WakeDeps['listPtys']>> = [];
  try { ptys = (deps.listPtys ?? listPtyManifestRows)(); } catch { ptys = []; }
  const named = ptys.filter(row => row.alive && (row.nickname ?? '').toLowerCase() === lower);
  const optIn = seatOptedIn(name, deps);
  if (named.length === 1) return { wake: 'pty-inject', target: named[0]!.id, source: 'pty-name', optIn };
  // seat-inbox.sh 와 같은 자리 폴더 파일: pty.ref(살아 있는 행의 id·별명과 정확히 같을 때만) → herdr.pane.
  const readSeatFile = deps.readPane ?? readPaneFile;
  const ref = readSeatFile(join(seatStateRoot(deps), name, 'pty.ref'))?.toLowerCase();
  const byRef = ref ? ptys.filter(row => row.alive && (row.id.toLowerCase() === ref || (row.nickname ?? '').toLowerCase() === ref)) : [];
  if (byRef.length === 1) return { wake: 'pty-inject', target: byRef[0]!.id, source: 'pty.ref', optIn };
  const pane = readSeatFile(join(seatStateRoot(deps), name, 'herdr.pane'));
  if (pane) return { wake: 'herdr', target: pane, source: 'herdr.pane', optIn };
  return { wake: 'none', source: 'unresolved', reason: named.length > 1 ? `pty-name-ambiguous:${named.length}` : 'no-pty-name-no-herdr-pane' };
}

function claimDbPath(deps: WakeDeps): string {
  return join(deps.stateRoot ?? effectiveInstanceRoot(), 'msg', 'wake-claims.db');
}

interface WakeClaim { db: string; address: string; token: string }

/**
 * Atomically claim the 5-minute wake window for one address. One SQLite upsert decides it under the
 * write lock — the row is replaced only when the held claim is older than the window — so two
 * concurrent `msg post` processes cannot both win, including when both saw an expired claim.
 */
export function claimWake(db: string, address: string, now: number): WakeClaim | null {
  mkdirSync(dirname(db), { recursive: true });
  const token = `${now} ${process.pid} ${randomUUID()}`;
  const conn = new Database(db);
  try {
    conn.exec('PRAGMA busy_timeout = 2000');
    conn.exec('CREATE TABLE IF NOT EXISTS wake_claims (address TEXT PRIMARY KEY, at INTEGER NOT NULL, token TEXT NOT NULL)');
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

function run(cmd: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(`${cmd} aborted`)); return; }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timeout`)); }, timeoutMs);
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}`)); });
  });
}

async function defaultHerdrStatus(paneId: string, signal: AbortSignal): Promise<string> {
  const parsed = JSON.parse(await run('herdr', ['pane', 'get', paneId], WAKE_TIMEOUT_MS, signal)) as { result?: { pane?: { agent_status?: unknown } } };
  const status = parsed.result?.pane?.agent_status;
  return typeof status === 'string' ? status : 'unknown';
}

async function defaultHerdrInject(paneId: string, line: string, signal: AbortSignal): Promise<void> {
  // `pane run` = send-text ⊕ Enter 한 번에.
  await run('herdr', ['pane', 'run', paneId, line], WAKE_TIMEOUT_MS, signal);
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
        if (!seatOptedIn(address, deps)) { resolution = { ...resolution, optIn: false }; return done('skipped', 'human-pane-no-opt-in'); }
        if (again.wake !== 'pty-inject' || again.target !== resolution.target) return done('busy', `target-moved:${again.target ?? again.wake}`);
        const row = (deps.listPtys ?? listPtyManifestRows)().find(item => item.id === resolution.target);
        if (!row?.alive || row.turnState !== 'idle') return done('busy', `turn=${row?.alive === false ? 'dead' : row?.turnState ?? 'unknown'}`);
        // ⛔ 마감이 지났으면 새 주입을 시작하지 않는다.
        if (expired()) return done('timeout');
        injecting = true;
        await inject(resolution.target!, line);
      } else {
        const status = await (deps.herdrStatus ?? defaultHerdrStatus)(resolution.target!, controller.signal);
        if (status !== 'idle') return done('busy', `agent_status=${status}`);
        // 조회 사이 자리의 pane 이 바뀌었으면 옛 pane 에 넣지 않는다 — 주소→대상을 다시 푼다.
        const again = resolveWake(address, deps);
        // opt-in 은 주입 직전에 «먼저» 다시 본다 — 기다리는 사이 `wake-inject` 를 지웠으면(대상이 바뀌었어도) 주입 0.
        if (!seatOptedIn(address, deps)) { resolution = { ...resolution, optIn: false }; return done('skipped', 'human-pane-no-opt-in'); }
        if (again.wake !== 'herdr' || again.target !== resolution.target) return done('busy', `target-moved:${again.target ?? again.wake}`);
        // ⛔ 마감은 «주입 바로 앞»에서 — 재해석이 늦어 넘겼어도 새 주입 0.
        if (expired()) return done('timeout');
        injecting = true;
        await (deps.herdrInject ?? defaultHerdrInject)(resolution.target!, line, controller.signal);
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
      ...(outcome.target ? { target: outcome.target } : {}) });
  } catch { /* reporting never turns a wake outcome into a throw */ }
  return outcome;
}
