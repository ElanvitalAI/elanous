import { execFile } from 'node:child_process';
import { readFileSync, promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
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
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const execFileAsync = promisify(execFile);

type Measurement<T> = { value: T; source: string; observedAt: number; status: 'ok' }
  | { value: null; source: string; observedAt: number; status: 'unmeasured'; reason: string };

function unmeasured<T>(source: string, observedAt: number, reason: string): Measurement<T> {
  return { value: null, source, observedAt, status: 'unmeasured', reason };
}

export interface HarnessParentSummary {
  count: Measurement<number>;
  oldestAgeSeconds: Measurement<number>;
  versionMismatchCount: Measurement<number>;
}

// Pod image commit is fixed at process startup; file paths and mutable package versions are not process identities.
const STARTUP_IMAGE_COMMIT = process.env.ELANOUS_IMAGE_COMMIT?.trim();
const HARNESS_PARENT_COMMAND = /^(?:(?:\S*\/)?(?:bun|node)\s+)?(?:\S*\/)?elanous\.mjs\s+harness\s+(?:say|ask)(?:\s|$)/;

export function parseHarnessParentPs(text: string): HarnessProcessList {
  if (!text.trim()) return { status: 'incomplete', stage: 'ps-parse' };
  const records: Array<{ pid: number; command: string; elapsedSeconds: number }> = [];
  let incomplete = false;
  for (const line of text.split('\n')) {
    const candidate = line.trim().match(/^\d+\s+\S+\s+(.+)$/)?.[1];
    if (!candidate || !HARNESS_PARENT_COMMAND.test(candidate)) continue;
    const match = line.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/);
    if (!match) { incomplete = true; continue; }
    const pid = Number(match[1]);
    const days = Number(match[2] ?? 0);
    const hours = Number(match[3] ?? 0);
    const minutes = Number(match[4]);
    const seconds = Number(match[5]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || minutes >= 60 || seconds >= 60 || (match[3] !== undefined && hours >= 24)) { incomplete = true; continue; }
    records.push({ pid, elapsedSeconds: days * 86_400 + hours * 3_600 + minutes * 60 + seconds, command: match[6]! });
  }
  return incomplete ? { status: 'incomplete', stage: 'ps-parse' } : { status: 'ok', records };
}

interface HarnessProcessList {
  status: 'ok' | 'incomplete' | 'failed';
  stage?: string;
  records?: readonly { pid: number; command: string; elapsedSeconds: number; version?: string }[];
}

async function readHarnessProcessVersion(pid: number): Promise<string | undefined> {
  if (platform() !== 'linux') return undefined;
  try {
    const env = await fs.readFile(`/proc/${pid}/environ`, { encoding: 'utf8', signal: AbortSignal.timeout(PROCESS_PROBE_TIMEOUT_MS) });
    const versions = env.split('\0').filter(entry => entry.startsWith('ELANOUS_IMAGE_COMMIT='))
      .map(entry => entry.slice('ELANOUS_IMAGE_COMMIT='.length).trim());
    return versions.length === 1 && versions[0] ? versions[0] : undefined;
  } catch { return undefined; }
}

export async function listHarnessParents(
  run: typeof execFileAsync = execFileAsync,
  readVersion: (pid: number) => Promise<string | undefined> = readHarnessProcessVersion,
): Promise<HarnessProcessList> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,etime=,command='], {
      encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = parseHarnessParentPs(stdout);
    if (parsed.status !== 'ok' || !parsed.records) return parsed;
    const records = await Promise.all(parsed.records.map(async record => {
      const version = await readVersion(record.pid).catch(() => undefined);
      return { ...record, ...(version ? { version } : {}) };
    }));
    return { status: 'ok', records };
  } catch { return { status: 'failed', stage: 'ps-exec' }; }
}

/** A process command/path is not the version loaded into a running process. Only startup-stamped identities count. */
export function measureHarnessParents(
  observedAt = Date.now(),
  observation: HarnessProcessList = { status: 'failed', stage: 'ps-exec' },
  currentVersion?: string,
): HarnessParentSummary {
  const source = 'ps:harness-processes';
  if (observation.status !== 'ok' || !observation.records) {
    const reason = observation.status === 'incomplete' ? 'ps-parse incomplete' : (observation.stage ?? 'ps-exec');
    return { count: unmeasured(source, observedAt, reason), oldestAgeSeconds: unmeasured(source, observedAt, reason),
      versionMismatchCount: unmeasured(source, observedAt, reason) };
  }
  const ok = (value: number): Measurement<number> => ({ value, source, observedAt, status: 'ok' });
  const records = observation.records.filter(record => HARNESS_PARENT_COMMAND.test(record.command));
  const count = ok(records.length);
  const oldestAgeSeconds = records.length === 0
    ? unmeasured<number>(source, observedAt, 'no-parents')
    : records.every(record => Number.isFinite(record.elapsedSeconds) && record.elapsedSeconds >= 0)
      ? ok(Math.max(...records.map(record => record.elapsedSeconds)))
      : unmeasured<number>(source, observedAt, 'elapsed-unavailable');
  const versionMismatchCount = records.length === 0 ? ok(0)
    : currentVersion && records.every(record => typeof record.version === 'string' && record.version.length > 0)
      ? ok(records.filter(record => record.version !== currentVersion).length)
      : unmeasured<number>(source, observedAt, 'version-unavailable');
  return { count, oldestAgeSeconds, versionMismatchCount };
}

export interface DiskIoPressure {
  pageouts: Measurement<number>;
  io: Measurement<{ someAvg10: number; fullAvg10: number }>;
}

export async function measureDiskIoPressure(
  observedAt = Date.now(),
  deps: { platform?: NodeJS.Platform; vmStat?: () => Promise<string> | string; readPressure?: () => Promise<string> | string } = {},
  pageoutBaseline?: { value: number },
): Promise<DiskIoPressure> {
  const os = deps.platform ?? platform();
  let pageouts: Measurement<number> = unmeasured('vm_stat:pageouts', observedAt, 'platform');
  if (os === 'darwin') {
    try {
      const text = await (deps.vmStat ?? (async () => (await execFileAsync('vm_stat', [], {
        encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      })).stdout))();
      // Real macOS vm_stat prints `Pageouts:`; older/other formats print `Pages paged out:`.
      const value = text.match(/^(?:Pageouts|Pages paged out):\s*([\d,]+)\s*\.?\s*$/m)?.[1];
      if (value && Number.isSafeInteger(Number(value.replaceAll(',', '')))) {
        const total = Number(value.replaceAll(',', ''));
        pageouts = pageoutBaseline
          ? Number.isFinite(pageoutBaseline.value) && total >= pageoutBaseline.value
            ? { value: total - pageoutBaseline.value, source: 'vm_stat:pageouts', observedAt, status: 'ok' }
            : unmeasured('vm_stat:pageouts', observedAt, 'baseline-unavailable')
          : { value: total, source: 'vm_stat:pageouts', observedAt, status: 'ok' };
        if (pageoutBaseline) pageoutBaseline.value = total;
      }
      else pageouts = unmeasured('vm_stat:pageouts', observedAt, 'invalid-output');
    } catch { pageouts = unmeasured('vm_stat:pageouts', observedAt, 'vm_stat-failed'); }
  }
  let io: DiskIoPressure['io'] = unmeasured('/proc/pressure/io', observedAt, 'platform');
  if (os === 'linux') {
    try {
      const text = await (deps.readPressure ?? (() => fs.readFile('/proc/pressure/io', {
        encoding: 'utf8', signal: AbortSignal.timeout(PROCESS_PROBE_TIMEOUT_MS),
      })))();
      const some = text.match(/^some\s+avg10=(\d+(?:\.\d+)?)(?:\s|$)/m)?.[1];
      const full = text.match(/^full\s+avg10=(\d+(?:\.\d+)?)(?:\s|$)/m)?.[1];
      if (some !== undefined && full !== undefined && Number.isFinite(Number(some)) && Number.isFinite(Number(full)))
        io = { value: { someAvg10: Number(some), fullAvg10: Number(full) }, source: '/proc/pressure/io', observedAt, status: 'ok' };
      else io = unmeasured('/proc/pressure/io', observedAt, 'invalid-output');
    } catch { io = unmeasured('/proc/pressure/io', observedAt, 'pressure-read-failed'); }
  }
  return { pageouts, io };
}

export async function measureLoad(
  now: () => number = Date.now,
  pageoutBaseline?: { value: number },
  deps: { listParents?: () => Promise<HarnessProcessList>; diskIo?: (at: number, baseline?: { value: number }) => Promise<DiskIoPressure>; currentVersion?: string } = {},
): Promise<{
  loadAvg: number[]; cpuCount: number; freeMem: number; totalMem: number; observedAt: number;
  harnessParents: HarnessParentSummary; diskIo: DiskIoPressure;
}> {
  const observedAt = now();
  const [parents, diskIo] = await Promise.all([
    (deps.listParents ?? listHarnessParents)().catch((): HarnessProcessList => ({ status: 'failed', stage: 'ps-exec' })),
    (deps.diskIo ?? ((at, baseline) => measureDiskIoPressure(at, {}, baseline)))(observedAt, pageoutBaseline)
      .catch((): DiskIoPressure => ({ pageouts: unmeasured<number>('vm_stat:pageouts', observedAt, 'probe-failed'),
        io: unmeasured<{ someAvg10: number; fullAvg10: number }>('/proc/pressure/io', observedAt, 'probe-failed') })),
  ]);
  return {
    loadAvg: loadavg(), cpuCount: cpus().length,
    freeMem: freemem(), totalMem: totalmem(), observedAt,
    harnessParents: measureHarnessParents(observedAt, parents, deps.currentVersion ?? STARTUP_IMAGE_COMMIT), diskIo,
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
  measure?: (now: () => number, pageoutBaseline: { value: number }) => Promise<Awaited<ReturnType<typeof measureLoad>>>;
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
  const pageoutBaseline: { value: number } = { value: Number.NaN };
  const machineLoad = () => (opts.measure ?? measureLoad)(now, pageoutBaseline);
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
      attrs: { ...opts.machine.attrs, load: await machineLoad() }, observedAt: now(), ttlMs: MAX_RETRY_MS * 2,
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
        await post(`/v1/resources/${encodeURIComponent(machineId)}/heartbeat`, { attrs: { load: await machineLoad() } });
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
