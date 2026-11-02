import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLockAsync } from '../storage/file-lock.js';
import { debug } from '../debug/log.js';

export interface GridSshResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly remoteStarted?: boolean;
}

export type GridSshTransport = (host: string, script: string, timeoutMs?: number) =>
  GridSshResult | Promise<GridSshResult>;

export interface GridSshBrokerOptions {
  readonly transport?: GridSshTransport;
  readonly spawn?: typeof spawn;
  readonly sshOptions?: readonly string[];
  readonly maxSessions?: number;
  readonly maxChannels?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly observe?: (event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => void;
  readonly controlDir?: string;
}

interface Waiter {
  grant: (release: () => void) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface HostState {
  active: number;
  queued: number;
  completed: number;
  retries: number;
  refused: number;
  waiters: Waiter[];
}

interface SharedQueueState {
  nextTicket: number;
  maxChannels: number | null;
  waiters: Array<{ ticket: number; pid: number; queuedAt: number }>;
}

interface SharedSlot {
  ticket: number;
  release: () => void;
}

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_MAX_RETRY_DELAY_MS = 1_000;
const SHARED_LOCK_STALE_MS = 5 * 60_000;
const SHARED_QUEUE_POLL_MS = 100;
const REMOTE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const REFUSAL = /session open refused|maxstartups|kex_exchange_identification|ssh-fail/i;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Stable per-host path lets separate elanous processes reuse the same OpenSSH master connection. */
export function gridSshControlPath(
  host: string,
  controlDir = join(homedir(), '.ssh', 'elanous-control'),
  sshOptions: readonly string[] = [],
): string {
  const key = createHash('sha256').update(JSON.stringify([host, sshOptions])).digest('hex').slice(0, 24);
  return join(controlDir, `cm-${key}`);
}

export function gridSshControlOptions(host: string, controlDir?: string, sshOptions: readonly string[] = []): string[] {
  const path = gridSshControlPath(host, controlDir, sshOptions);
  return ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${path}`];
}

function assertNoControlSocketOverride(sshOptions: readonly string[]): void {
  // OpenSSH gives -S precedence over -o ControlPath regardless of argument order.
  if (sshOptions.some(option => option === '-S' || (option.startsWith('-S') && option.length > 2)))
    throw new Error('grid-ssh-ssh-options-cannot-set-control-socket');
}

function defaultTransport(controlDir: string, spawnCommand: typeof spawn, sshOptions: readonly string[]): GridSshTransport {
  assertNoControlSocketOverride(sshOptions);
  return (host, script, timeoutMs) => new Promise((resolve) => {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    const marker = `__ELANOUS_SSH_BROKER_STARTED_${randomUUID()}__`;
    const input = `printf '%s\\n' ${shellQuote(marker)}\n${script}`;
    const child = spawnCommand('ssh', [
      ...gridSshControlOptions(host, controlDir, sshOptions),
      ...sshOptions, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', host, 'sh', '-s',
    ], { cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const markerText = `${marker}\n`;
      const remoteStarted = out.includes(markerText) || out.endsWith(marker);
      resolve({
        status: timedOut || overflow ? null : status,
        stdout: out.replace(markerText, '').replace(marker, ''),
        stderr: err,
        ...(error ? { error } : timedOut ? { error: 'grid-ssh-timeout' } : overflow ? { error: 'grid-ssh-output-limit' } : {}),
        remoteStarted,
      });
    };
    const terminate = (reason: 'timeout' | 'overflow') => {
      if (timedOut || overflow || settled) return;
      if (reason === 'timeout') timedOut = true;
      else overflow = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (timedOut || overflow || settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > REMOTE_OUTPUT_LIMIT) { terminate('overflow'); return; }
      target.push(value);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
    if (timeoutMs !== undefined && timeoutMs > 0) deadline = setTimeout(() => terminate('timeout'), timeoutMs);
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function isPreSessionRefusal(result: GridSshResult): boolean {
  if (result.remoteStarted || (result.status !== 255 && result.status !== null)) return false;
  return REFUSAL.test(`${result.stderr}\n${result.error ?? ''}`);
}

function isLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('acquireLockAsync: timed out at ');
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readQueue(path: string): SharedQueueState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SharedQueueState>;
    if (!Number.isSafeInteger(parsed.nextTicket) || (parsed.nextTicket ?? 0) < 1
      || (parsed.maxChannels !== null && (!Number.isSafeInteger(parsed.maxChannels) || (parsed.maxChannels ?? 0) < 1))
      || !Array.isArray(parsed.waiters)
      || parsed.waiters.some(row => !Number.isSafeInteger(row.ticket) || !Number.isSafeInteger(row.pid) || !Number.isFinite(row.queuedAt))) {
      throw new Error('grid-ssh-queue-state-invalid');
    }
    return parsed as SharedQueueState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nextTicket: 1, maxChannels: null, waiters: [] };
    throw error;
  }
}

function writeQueue(path: string, state: SharedQueueState): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, path);
}

async function withQueueState<T>(
  path: string,
  deadline: number | undefined,
  sleepFor: (ms: number) => Promise<void>,
  fn: (state: SharedQueueState) => T | Promise<T>,
): Promise<T | null> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (deadline === undefined || Date.now() < deadline) {
    const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    try {
      const lock = await acquireLockAsync(`${path}.lock`, {
        staleMs: SHARED_LOCK_STALE_MS,
        retryBusyMs: 0,
        maxTries: 1,
      });
      try {
        if (!lock.stillHeld()) continue;
        const state = readQueue(path);
        state.waiters = state.waiters.filter(waiter => processAlive(waiter.pid));
        const result = await fn(state);
        writeQueue(path, state);
        return result;
      } finally { lock.release(); }
    } catch (error) {
      if (!isLockBusy(error)) throw error;
      if (deadline !== undefined && Date.now() >= deadline) return null;
      await sleepFor(Math.min(SHARED_QUEUE_POLL_MS, remaining ?? SHARED_QUEUE_POLL_MS));
    }
  }
  return null;
}

function hostHash(host: string): string {
  return createHash('sha256').update(host).digest('hex').slice(0, 24);
}

/** Host-scoped FIFO channel broker with a durable cross-process ticket queue and slots below MaxSessions. */
export function createGridSshBroker(options: GridSshBrokerOptions = {}) {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 2) throw new Error('grid-ssh-invalid-max-sessions');
  const maxChannels = options.maxChannels ?? maxSessions - 1;
  if (!Number.isSafeInteger(maxChannels) || maxChannels < 1 || maxChannels >= maxSessions)
    throw new Error('grid-ssh-channel-limit-must-be-below-max-sessions');
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('grid-ssh-invalid-max-retries');
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs)
    throw new Error('grid-ssh-invalid-retry-delay');
  const sshOptions = [...(options.sshOptions ?? [])];
  assertNoControlSocketOverride(sshOptions);
  const controlDir = options.controlDir ?? join(homedir(), '.ssh', 'elanous-control');
  const queueDir = join(controlDir, 'queues');
  const slotDir = join(controlDir, 'slots');
  const transport = options.transport ?? defaultTransport(controlDir, options.spawn ?? spawn, sshOptions);
  const wait = options.sleep ?? sleep;
  const rawObserve = options.observe ?? ((event: string, data: Record<string, unknown>, level: 'info' | 'warn' = 'info') => {
    debug.log('grid.ssh', event, data, { level });
  });
  const observe = (event: string, data: Record<string, unknown>, level: 'info' | 'warn' = 'info') => {
    try { rawObserve(event, data, level); } catch { /* Observation never holds a channel or changes its result. */ }
  };
  const hosts = new Map<string, HostState>();

  const stateFor = (host: string): HostState => {
    let state = hosts.get(host);
    if (!state) { state = { active: 0, queued: 0, completed: 0, retries: 0, refused: 0, waiters: [] }; hosts.set(host, state); }
    return state;
  };

  const releaseLocal = (state: HostState): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        state.queued -= 1;
        next.grant(releaseLocal(state));
      } else state.active -= 1;
    };
  };

  const acquireLocal = async (host: string, deadline?: number): Promise<(() => void) | null> => {
    const state = stateFor(host);
    if (deadline !== undefined && Date.now() >= deadline) return null;
    if (state.active < maxChannels) { state.active += 1; return releaseLocal(state); }
    state.queued += 1;
    observe('queued', { host, queued: state.queued, active: state.active, maxChannels });
    return new Promise(resolve => {
      const waiter: Waiter = { grant: resolve };
      if (deadline !== undefined) waiter.timer = setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        state.queued -= 1;
        resolve(null);
      }, Math.max(0, deadline - Date.now()));
      state.waiters.push(waiter);
    });
  };

  const acquireSharedSlot = async (host: string, deadline?: number): Promise<SharedSlot | null> => {
    const key = hostHash(host);
    const queuePath = join(queueDir, `${key}.json`);
    const ticket = await withQueueState(queuePath, deadline, wait, async state => {
      if (state.maxChannels === null) state.maxChannels = maxChannels;
      else if (state.maxChannels !== maxChannels) {
        const configured = state.maxChannels;
        if (state.waiters.length > 0) throw new Error(`grid-ssh-host-channel-limit-mismatch:${host}:${configured}!=${maxChannels}`);
        mkdirSync(slotDir, { recursive: true, mode: 0o700 });
        const held: Awaited<ReturnType<typeof acquireLockAsync>>[] = [];
        try {
          for (let slot = 0; slot < Math.max(configured, maxChannels); slot += 1) {
            const path = join(slotDir, `${key}-${slot}.lock`);
            try {
              held.push(await acquireLockAsync(path, { staleMs: SHARED_LOCK_STALE_MS, retryBusyMs: 0, maxTries: 1 }));
            } catch (error) {
              if (isLockBusy(error)) throw new Error(`grid-ssh-host-channel-limit-mismatch:${host}:${configured}!=${maxChannels}`);
              throw error;
            }
          }
          state.maxChannels = maxChannels;
        } finally { for (const lock of held.reverse()) lock.release(); }
      }
      const assigned = state.nextTicket++;
      state.waiters.push({ ticket: assigned, pid: process.pid, queuedAt: Date.now() });
      observe('shared-queued', { host, ticket: assigned, queued: state.waiters.length, maxChannels });
      return assigned;
    });
    if (ticket === null) return null;
    let handedOff = false;
    try {
      mkdirSync(slotDir, { recursive: true, mode: 0o700 });
      while (deadline === undefined || Date.now() < deadline) {
        const snapshot = readQueue(queuePath);
        const head = snapshot.waiters[0];
        if (head?.pid !== undefined && !processAlive(head.pid)) {
          await withQueueState(queuePath, deadline, wait, state => {
            state.waiters = state.waiters.filter(waiter => processAlive(waiter.pid));
            return true;
          });
          continue;
        }
        if (head?.ticket === ticket) {
          for (let slot = 0; slot < maxChannels; slot += 1) {
            const path = join(slotDir, `${key}-${slot}.lock`);
            let lock;
            try {
              lock = await acquireLockAsync(path, { staleMs: SHARED_LOCK_STALE_MS, retryBusyMs: 0, maxTries: 1 });
            } catch (error) {
              if (!isLockBusy(error)) throw error;
              continue;
            }
            let ticketClaimed = false;
            try {
              const removed = await withQueueState(queuePath, deadline, wait, state => {
                if (state.waiters[0]?.ticket !== ticket) return false;
                state.waiters.shift();
                return true;
              });
              if (removed) {
                ticketClaimed = true;
                handedOff = true;
                return { ticket, release: lock.release };
              }
            } finally {
              if (!ticketClaimed) lock.release();
            }
            break;
          }
        }
        if (deadline !== undefined && Date.now() >= deadline) break;
        await wait(Math.min(SHARED_QUEUE_POLL_MS, deadline === undefined ? SHARED_QUEUE_POLL_MS : Math.max(0, deadline - Date.now())));
      }
      return null;
    } finally {
      if (!handedOff) {
        try {
          await withQueueState(queuePath, undefined, wait, state => {
            state.waiters = state.waiters.filter(waiter => waiter.ticket !== ticket);
            return true;
          });
        } catch (error) {
          observe('ticket-cleanup-failed', { host, ticket, error: error instanceof Error ? error.message : String(error) }, 'warn');
        }
      }
    }
  };

  return {
    async run(host: string, script: string, timeoutMs?: number): Promise<GridSshResult> {
      if (!host.trim()) throw new Error('grid-ssh-host-required');
      const startedAt = Date.now();
      const deadline = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : undefined;
      let sharedRelease: (() => void) | null = null;
      let localRelease: (() => void) | null = null;
      try {
        const remaining = () => deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
        const shared = await acquireSharedSlot(host, deadline);
        if (!shared) return { status: null, stdout: '', stderr: '', error: 'grid-ssh-queue-timeout' };
        sharedRelease = shared.release;
        localRelease = await acquireLocal(host, deadline);
        if (!localRelease) return { status: null, stdout: '', stderr: '', error: 'grid-ssh-queue-timeout' };
        observe('start', { host, ticket: shared.ticket, active: stateFor(host).active, queued: stateFor(host).queued, maxChannels });
        for (let attempt = 0; ; attempt += 1) {
          const timeLeft = remaining();
          if (timeLeft !== undefined && timeLeft <= 0) return { status: null, stdout: '', stderr: '', error: 'grid-ssh-timeout' };
          let result: GridSshResult;
          try { result = await transport(host, script, timeLeft); }
          catch (error) { result = { status: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) }; }
          const state = stateFor(host);
          state.completed += 1;
          if (!isPreSessionRefusal(result)) {
            observe('complete', { host, ticket: shared.ticket, status: result.status, elapsedMs: Date.now() - startedAt,
              retries: attempt, active: state.active, queued: state.queued }, result.status === 0 ? 'info' : 'warn');
            return result;
          }
          state.refused += 1;
          if (attempt >= maxRetries) {
            observe('refused', { host, ticket: shared.ticket, status: result.status, retries: attempt, elapsedMs: Date.now() - startedAt }, 'warn');
            return result;
          }
          state.retries += 1;
          const delayMs = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** attempt));
          observe('retry', { host, ticket: shared.ticket, status: result.status, attempt: attempt + 1, delayMs });
          if (timeLeft !== undefined && delayMs >= timeLeft)
            return { status: null, stdout: result.stdout, stderr: result.stderr, error: 'grid-ssh-timeout' };
          await wait(delayMs);
        }
      } finally { sharedRelease?.(); localRelease?.(); }
    },
    snapshot(host?: string) {
      return [...hosts].filter(([name]) => host === undefined || name === host).map(([name, state]) => ({
        host: name, active: state.active, queued: state.queued, completed: state.completed,
        retries: state.retries, refused: state.refused, maxChannels, scope: 'process' as const,
      }));
    },
  };
}

/** Shared process-wide broker used by read-only host inspection callers. */
export const gridSshBroker = createGridSshBroker();
