import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { readPrimaryJoin } from './primary.js';
import { resolveMachineName } from '../roles/machine-name.js';
import { readMachineProfile } from '../roles/machine-profile.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 300_000;
// Ordinary ticks start within the 10-minute TTL; first failure retries within 30 seconds.
const MAX_INTERVAL_MS = MAX_RETRY_MS;
const REQUEST_TIMEOUT_MS = 5_000;

export function measureLoad(now: () => number = Date.now): {
  loadAvg: number[]; cpuCount: number; freeMem: number; totalMem: number; observedAt: number;
} {
  return {
    loadAvg: loadavg(), cpuCount: cpus().length,
    freeMem: freemem(), totalMem: totalmem(), observedAt: now(),
  };
}

/** Read only the member credential. A missing or malformed file never creates credentials. */
export function readMemberToken(root: string = effectiveInstanceRoot()): string | undefined {
  const joined = readPrimaryJoin(root)?.tokens.member;
  if (joined) return joined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'control', 'tokens.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const token = (parsed as Record<string, unknown>).member;
    return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface MemberResource {
  id: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export interface MemberHeartbeatOptions {
  coordinatorUrl: string;
  token: string;
  machine: MemberResource;
  instance: MemberResource & { endpoint: string };
  intervalMs?: number;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** 넥서스 멤버의 기계 신원 — OS hostname 이 아니라 임대·관제가 쓰는 기계 식별자(`resolveMachineName`)를 쓴다.
 *  🅢 09-27: mbp 넥서스가 `machine:MacBookProM5` 로 올라가 프로필 id `mbp` 와 어긋날 뻔했다(가벼운 멤버는 이미 id 를 쓴다).
 *  프로필이 있으면 맡은 일·자리 순위를 속성에 싣는다(가벼운 멤버와 같은 칸). */
export function nexusMemberMachine(root: string = effectiveInstanceRoot(), host?: string): MemberResource {
  const { machine } = resolveMachineName({ root, ...(host ? { host } : {}) });
  const profile = readMachineProfile(root);
  return {
    id: `machine:${machine}`, name: machine,
    ...(profile && profile.id === machine ? { attrs: { duties: profile.duties, seats: profile.seats } } : {}),
  };
}

/** Best-effort registration; no network work is awaited by the caller. */
export function startMemberHeartbeat(opts: MemberHeartbeatOptions): () => void {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_INTERVAL_MS) throw new Error('invalid member heartbeat interval');
  const base = new URL(opts.coordinatorUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid coordinator URL');
  if (!opts.token || !opts.machine.id || !opts.instance.id || !opts.instance.endpoint) throw new Error('missing member configuration');
  const send = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  let heartbeatsSinceInstanceRefresh = 0;
  let failures = 0;
  let lastFailure: string | undefined;
  const machineId = opts.machine.id;
  // 자원의 `machine` 칸 = 기계 «이름»(가벼운 멤버·임대와 같은 값). 기계 범위 토큰은 이 칸을 토큰의 기계와 대조한다(server.ts requireMachine).
  const machineName = opts.machine.name;

  const post = async (path: string, body: unknown): Promise<void> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeout]);
    let response: Response;
    try {
      response = await send(new URL(path, base), {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new Error('network-or-timeout');
    }
    if (!response.ok) {
      if (response.status === 404 && path.endsWith('/heartbeat')) registered = false;
      throw new Error(`http-${response.status}`);
    }
  };
  const register = async (): Promise<void> => {
    await post('/v1/resources/register', {
      ...opts.machine, kind: 'machine', machine: machineName, owner: '',
      attrs: { ...opts.machine.attrs, load: measureLoad(now) }, observedAt: now(), ttlMs: MAX_RETRY_MS * 2,
    });
    await post('/v1/resources/register', {
      ...opts.instance, kind: 'instance', machine: machineName, owner: '',
      attrs: opts.instance.attrs ?? {}, observedAt: now(), ttlMs: MAX_RETRY_MS * 2,
    });
    registered = true;
    heartbeatsSinceInstanceRefresh = 0;
  };
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, ms);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (!registered) await register();
      else {
        await post(`/v1/resources/${encodeURIComponent(machineId)}/heartbeat`, { attrs: { load: measureLoad(now) } });
        heartbeatsSinceInstanceRefresh++;
        if (heartbeatsSinceInstanceRefresh * interval >= MAX_RETRY_MS) {
          await post(`/v1/resources/${encodeURIComponent(opts.instance.id)}/heartbeat`, {});
          heartbeatsSinceInstanceRefresh = 0;
        }
      }
      if (stopped) return;
      failures = 0;
      schedule(interval);
    } catch (error) {
      if (stopped) return;
      const reason = error instanceof Error ? error.message : 'unknown';
      if (reason !== lastFailure) {
        try { debug.log('control.member', 'heartbeat-failed', { reason }); } catch { /* logging is best-effort */ }
      }
      lastFailure = reason;
      failures++;
      // A lost record needs immediate re-registration. Other failures retry ahead of
      // the ordinary tick so a single timeout at the longest interval cannot exceed TTL.
      schedule(!registered && reason === 'http-404'
        ? 0
        : Math.min(MAX_RETRY_MS, Math.min(interval, DEFAULT_INTERVAL_MS) * 2 ** (failures - 1)));
    }
  };
  queueMicrotask(() => { void tick(); });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  };
}
