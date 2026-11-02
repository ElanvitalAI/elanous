/** Owner-host distribution of Codex access-only credentials to OPC seat homes. */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { hqFenceDecision } from '../hq/hq.js';
import { createCodexAccessMirror } from './codex-access-mirror.js';
import { codexAccountRefreshLockPath, refreshCodexAccountHome, withCodexAccountRefreshLock } from './codex.js';
import { codexStoreKey, isValidAccountName } from './codex-account.js';
import { authStorePath, loadTokens } from './store.js';

export const CODEX_SEAT_REFRESH_BEFORE_MS = 10 * 60 * 1000;
export const CODEX_SEAT_HOME_ROOT = join(getElanousConfigDir(), 'codex-seat-homes');
export const CODEX_SEAT_HOME_POLL_MS = 60 * 1000;

/** Stable OP mapping for directly launched Codex seat processes. */
export function codexSeatAccountForSeat(seat: string): 'default' | 'team' | 'third' {
  const normalized = seat.trim().toUpperCase();
  if (['TC', 'MK', 'UX'].includes(normalized)) return 'team';
  if (['OPC', 'OPT', 'MOCKDEV'].includes(normalized)) return 'third';
  return 'default';
}

/** default intentionally inherits ~/.codex; named seats get one shared access-only home per account. */
export function codexSeatHomeForSeat(seat: string, root: string = CODEX_SEAT_HOME_ROOT): string | undefined {
  const account = codexSeatAccountForSeat(seat);
  return account === 'default' ? undefined : join(root, account);
}

export type CodexSeatLaunchEnvironmentResult =
  | { ok: true; env: NodeJS.ProcessEnv; home?: string }
  | { ok: false; kind: 'missing-mirror' | 'invalid-mirror' | 'expired-mirror'; reason: string };

/** Build the environment used by the real Codex child process. Default seats inherit their environment unchanged. */
export function codexSeatLaunchEnvironment(
  seat: string,
  options: { env?: NodeJS.ProcessEnv; seatHomeRoot?: string; now?: number } = {},
): CodexSeatLaunchEnvironmentResult {
  const inherited = options.env ?? process.env;
  const home = codexSeatHomeForSeat(seat, options.seatHomeRoot);
  if (!home) return { ok: true, env: { ...inherited } };
  let auth: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, kind: 'invalid-mirror', reason: `seat-home auth mirror is not access-only chatgpt auth for ${codexSeatAccountForSeat(seat)}` };
    }
    auth = parsed as Record<string, unknown>;
  }
  catch { return { ok: false, kind: 'missing-mirror', reason: `seat-home auth mirror is missing or unreadable for ${codexSeatAccountForSeat(seat)}` }; }
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  const refreshFields = [tokens?.refresh_token, tokens?.refreshToken];
  if (auth.auth_mode !== 'chatgpt' || typeof tokens?.access_token !== 'string'
    || refreshFields.some((value) => value !== '' && value !== undefined)) {
    return { ok: false, kind: 'invalid-mirror', reason: `seat-home auth mirror is not access-only chatgpt auth for ${codexSeatAccountForSeat(seat)}` };
  }
  const expiresAt = accessExpiresAt(auth);
  if (expiresAt === null || expiresAt <= (options.now ?? Date.now())) {
    return { ok: false, kind: 'expired-mirror', reason: `seat-home access token is expired or has no readable expiry for ${codexSeatAccountForSeat(seat)}` };
  }
  return { ok: true, env: { ...inherited, CODEX_HOME: home }, home };
}

export interface CodexSeatLaunchDeps {
  env?: NodeJS.ProcessEnv;
  seatHomeRoot?: string;
  now?: number;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  onSpawn?: (child: ChildProcess) => void;
}

export type CodexSeatLaunchFailureKind = 'missing-mirror' | 'invalid-mirror' | 'expired-mirror' | 'spawn-failed';

/** Launch the installed Codex CLI under the mapped seat home; the wrapper owns only this child process. */
export async function runCodexSeatCommand(
  seat: string,
  args: readonly string[] = [],
  deps: CodexSeatLaunchDeps = {},
): Promise<{ ok: true; exitCode: number } | { ok: false; kind: CodexSeatLaunchFailureKind; reason: string }> {
  const resolved = codexSeatLaunchEnvironment(seat, { env: deps.env, seatHomeRoot: deps.seatHomeRoot, now: deps.now });
  if (!resolved.ok) return resolved;
  const spawn = deps.spawn ?? nodeSpawn;
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('codex', args, { env: resolved.env, stdio: 'inherit' });
      deps.onSpawn?.(child);
    } catch (error) {
      resolve({ ok: false, kind: 'spawn-failed', reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.once('error', (error) => resolve({ ok: false, kind: 'spawn-failed', reason: error.message }));
    child.once('exit', (code) => resolve({ ok: true, exitCode: code ?? 1 }));
  });
}

export type CodexSeatHomeSyncResult =
  | { ok: true; account: 'team' | 'third'; path: string; expiresAt: number; refreshed: boolean }
  | { ok: false; kind: 'owner-lease-lost' | 'bad-account' | 'missing-account' | 'unreadable' | 'wrong-auth-mode' | 'refresh-failed' | 'write-failed'; reason: string };

export interface CodexSeatHomeDeps {
  storePath?: string;
  seatHomeRoot?: string;
  now?: () => number;
  ownerLeaseHeld?: () => boolean;
  refresh?: (account: string) => Promise<{ ok: boolean; message?: string }>;
}

function accessExpiresAt(auth: Record<string, unknown>): number | null {
  const token = (auth.tokens as Record<string, unknown> | undefined)?.access_token;
  if (typeof token !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = Number(payload.exp) * 1000;
    return Number.isFinite(exp) && exp > 0 ? exp : null;
  } catch { return null; }
}

function leaseHeld(deps: CodexSeatHomeDeps): boolean {
  try { return deps.ownerLeaseHeld?.() ?? hqFenceDecision('ledger-cli').run; } catch { return false; }
}

function readNamedAuth(account: 'team' | 'third', storePath: string): { storeEntry: NonNullable<ReturnType<typeof loadTokens>>; codexAuth: Record<string, unknown> } | null {
  const storeKey = codexStoreKey(account);
  const storeEntry = loadTokens(storeKey, storePath);
  if (!storeEntry?.codexHome) return null;
  try {
    const codexAuth = JSON.parse(readFileSync(join(storeEntry.codexHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
    return { storeEntry, codexAuth };
  } catch { return null; }
}

function atomicWriteAccessOnly(path: string, contents: string): void {
  const dir = dirname(path);
  const root = dirname(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, `${contents}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Refresh a named account only when it is within 10 minutes of expiry, then atomically deploy access-only auth.json. */
export async function syncCodexSeatHome(accountName: string, deps: CodexSeatHomeDeps = {}): Promise<CodexSeatHomeSyncResult> {
  if (accountName !== 'team' && accountName !== 'third' || !isValidAccountName(accountName)) {
    return { ok: false, kind: 'bad-account', reason: 'seat homes accept named team/third accounts only; default remains ~/.codex' };
  }
  if (!leaseHeld(deps)) return { ok: false, kind: 'owner-lease-lost', reason: 'HQ Codex owner lease is not held' };
  const storePath = deps.storePath ?? authStorePath();
  const now = deps.now ?? Date.now;
  const account = accountName;
  const lockPath = codexAccountRefreshLockPath(account, storePath);
  if (!lockPath) return { ok: false, kind: 'missing-account', reason: 'named account refresh lock path is unavailable' };
  let result: CodexSeatHomeSyncResult | undefined;
  try {
    // Share the exact account lock with every existing refresh path. Read, refresh, and install form one snapshot.
    await withCodexAccountRefreshLock(lockPath, async () => {
      if (!leaseHeld(deps)) throw new Error('owner-lease-lost');
      let source = readNamedAuth(account, storePath);
      if (!source) throw new Error('missing-account');
      if (source.codexAuth.auth_mode !== 'chatgpt') throw new Error('wrong-auth-mode');
      let expiresAt = accessExpiresAt(source.codexAuth);
      if (expiresAt === null) throw new Error('unreadable');
      let refreshed = false;
      if (expiresAt <= now() + CODEX_SEAT_REFRESH_BEFORE_MS) {
        const refreshResult = deps.refresh
          ? await deps.refresh(account)
          : await refreshCodexAccountHome(account, { storePath });
        if (!refreshResult.ok) throw new Error('refresh-failed');
        refreshed = true;
        source = readNamedAuth(account, storePath);
        if (!source) throw new Error('missing-account');
        if (source.codexAuth.auth_mode !== 'chatgpt') throw new Error('wrong-auth-mode');
        expiresAt = accessExpiresAt(source.codexAuth);
        if (expiresAt === null || expiresAt <= now() + CODEX_SEAT_REFRESH_BEFORE_MS) throw new Error('unreadable');
      }
      if (!leaseHeld(deps)) throw new Error('owner-lease-lost');
      let mirror: ReturnType<typeof createCodexAccessMirror>;
      try {
        mirror = createCodexAccessMirror({
          account,
          store: { version: 1, providers: { [codexStoreKey(account)]: source.storeEntry as unknown as Record<string, unknown> } },
          codexAuth: source.codexAuth as { [key: string]: unknown; auth_mode?: string; tokens: Record<string, unknown> },
        });
      } catch { throw new Error('unreadable'); }
      const path = join(deps.seatHomeRoot ?? CODEX_SEAT_HOME_ROOT, account, 'auth.json');
      try { atomicWriteAccessOnly(path, mirror.codexAuth); }
      catch { throw new Error('write-failed'); }
      result = { ok: true, account, path, expiresAt: mirror.expiresAt, refreshed };
      try { debug.log('oauth.codex-seat-home', 'access-mirror-installed', { account, path, expiresAt: mirror.expiresAt, refreshed }); } catch { /* fail-soft */ }
    });
  } catch (error) {
    const allowed = ['owner-lease-lost','bad-account','missing-account','unreadable','wrong-auth-mode','refresh-failed','write-failed'] as const;
    const kind = error instanceof Error && allowed.includes(error.message as typeof allowed[number])
      ? error.message as typeof allowed[number]
      : 'refresh-failed';
    return { ok: false, kind, reason: kind };
  }
  return result ?? { ok: false, kind: 'write-failed', reason: 'access-only auth mirror was not installed' };
}

/** Long-running owner-side updater. SIGINT/SIGTERM end the loop without touching Codex sessions. */
export async function runCodexSeatHomeRefreshLoop(
  accounts: readonly string[],
  deps: CodexSeatHomeDeps & { pollMs?: number; sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean; onError?: (account: string, result: Extract<CodexSeatHomeSyncResult, { ok: false }>) => void } = {},
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(10_000, deps.pollMs ?? CODEX_SEAT_HOME_POLL_MS);
  while (!(deps.shouldStop?.() ?? false)) {
    for (const account of accounts) {
      if (deps.shouldStop?.()) break;
      const result = await syncCodexSeatHome(account, deps);
      if (!result.ok) {
        try { deps.onError?.(account, result); } catch { /* diagnostics must not stop other seats */ }
        try { debug.log('oauth.codex-seat-home', 'access-mirror-update-failed', { account, reason: result.kind }); } catch { /* fail-soft */ }
      }
    }
    if (!(deps.shouldStop?.() ?? false)) await sleep(pollMs);
  }
}
