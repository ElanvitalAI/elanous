import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { defaultResourceRun, type ResourceCommandRunner } from '../cli/resource-ledger-cli.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { guardianHostLeaseRecords, readResourceLedger, resourceLedgerPath } from '../resource-ledger/resource-ledger.js';

export interface ReservedHost { readonly host: string; readonly runId: string }
export interface ObservedHostProcess {
  readonly pid: number;
  readonly startedAt: string;
  readonly birthToken?: string;
  readonly command: string;
  readonly cwd?: string;
  readonly seat?: string;
}
export interface HostReservationViolation {
  readonly host: string;
  readonly runId: string;
  readonly pid: number;
  readonly seat: string;
  readonly identity: string;
}

export interface HostReservationWatchDeps {
  reservations(): readonly ReservedHost[];
  processes(host: string, runId: string): HostProcessObservation;
  incident(violation: HostReservationViolation): void;
  notify(violation: HostReservationViolation): void;
}

export interface HostProcessObservation {
  readonly processes: readonly ObservedHostProcess[];
  readonly unmeasured: readonly string[];
}

function gateProcess(command: string, runId: string): boolean {
  if (!/(?:^|\s)(?:\S*\/)?elanous\.mjs\s+release\s+(?:run|resume)(?=\s|$)/.test(command)) return false;
  const recordedRun = /(?:^|\s)--(?:gate-)?run-id(?:=|\s)([A-Za-z0-9._-]+)(?=\s|$)/.exec(command)?.[1];
  return recordedRun === runId;
}

function seatOf(command: string, cwd?: string): string | undefined {
  const match = /(?:^|\s)(?:--seat(?:=|\s)|ELANOUS_TRACK=)([A-Z][A-Z0-9_-]*)\b/.exec(command)
    ?? /(?:^|\/)seats\/([A-Z][A-Z0-9_-]*)(?:\/|\s|$)/.exec(command)
    ?? (cwd ? /(?:^|\/)seats\/([A-Z][A-Z0-9_-]*)(?:\/|$)/.exec(cwd) : null);
  return match?.[1];
}

function seatFromEnvironment(value: string): string | undefined {
  return /(?:^|\0|\s)ELANOUS_TRACK=([A-Z][A-Z0-9_-]*)(?=\0|\s|$)/.exec(value)?.[1];
}

export function parseHostProcesses(output: string): ObservedHostProcess[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) { if (line.trim()) throw new Error('host process snapshot malformed'); return []; }
    if (!Number.isSafeInteger(Number(match[1]))) throw new Error('managed process PID invalid');
    const command = match[3]!;
    const seat = seatOf(command);
    return [{ pid: Number(match[1]), startedAt: match[2]!, command, ...(seat ? { seat } : {}) }];
  });
}

function linuxBirthToken(stat: string, pid: number): string | undefined {
  const close = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const tick = fields[19]; // Source: proc_pid_stat(5): starttime is field 22, and post-comm fields begin at field 3.
  return tick && /^\d+$/.test(tick) ? `linux:${tick}` : undefined;
}

function processBirthToken(host: string, pid: number, run: ResourceCommandRunner): string | undefined {
  const linux = run('cat', [`/proc/${pid}/stat`], host);
  if (linux.status === 0) {
    const birth = linuxBirthToken(linux.stdout, pid);
    const boot = run('cat', ['/proc/sys/kernel/random/boot_id'], host);
    return birth && boot.status === 0 && /^[0-9a-f-]{36}$/i.test(boot.stdout.trim())
      ? `${boot.stdout.trim()}:${birth}` : undefined; // Source: Linux proc(5) boot_id scopes PID start ticks to one boot.
  }
  // Source: src/harness/harness-cli-command.ts readDarwinStartMicros uses PROC_PIDTBSDINFO's microsecond birth time.
  const script = `const{dlopen,FFIType}=require("bun:ffi");const p=${pid};const l=dlopen("/usr/lib/libproc.dylib",{proc_pidinfo:{args:[FFIType.i32,FFIType.i32,FFIType.u64,FFIType.ptr,FFIType.i32],returns:FFIType.i32}});const b=new Uint8Array(136);const n=l.symbols.proc_pidinfo(p,3,0n,b,b.length);if(n!==b.length)process.exit(1);const v=new DataView(b.buffer);if(v.getUint32(12,true)!==p)process.exit(1);console.log((v.getBigUint64(120,true)*1000000n+v.getBigUint64(128,true)).toString());l.close()`;
  const probe = run('bun', ['-e', `'${script}'`], host);
  return probe.status === 0 && /^\d+$/.test(probe.stdout.trim()) ? `darwin:${probe.stdout.trim()}` : undefined;
}

/** Observe all processes; a failed ownership probe marks only that PID unmeasured. */
export function observeHostProcesses(host: string, run: ResourceCommandRunner = defaultResourceRun, runId?: string): HostProcessObservation {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new Error('invalid reservation host');
  const result = run('ps', ['-eo', 'pid=,lstart=,args='], host);
  if (result.status !== 0) throw new Error(`host process observation failed: ${host}`);
  const unmeasured: string[] = [];
  const processes = parseHostProcesses(result.stdout).flatMap(process => {
    if (runId && gateProcess(process.command, runId)) return [process];
    let seat = process.seat;
    let cwd: string | undefined;
    if (!seat) {
      const linuxEnv = run('cat', [`/proc/${process.pid}/environ`], host);
      const privilegedEnv = linuxEnv.status === 0 ? undefined : run('sudo', ['-n', 'cat', `/proc/${process.pid}/environ`], host);
      const macEnv = linuxEnv.status === 0 || privilegedEnv?.status === 0 ? undefined
        : run('ps', ['eww', '-p', String(process.pid), '-o', 'command='], host);
      seat = seatFromEnvironment(linuxEnv.status === 0 ? linuxEnv.stdout
        : privilegedEnv?.status === 0 ? privilegedEnv.stdout : macEnv?.stdout ?? '');
      if (!seat) {
        const linux = run('readlink', [`/proc/${process.pid}/cwd`], host);
        const privilegedCwd = linux.status === 0 ? undefined : run('sudo', ['-n', 'readlink', `/proc/${process.pid}/cwd`], host);
        const mac = linux.status === 0 || privilegedCwd?.status === 0 ? undefined
          : run('lsof', ['-a', '-p', String(process.pid), '-d', 'cwd', '-Fn'], host);
        cwd = linux.status === 0 ? linux.stdout.trim()
          : privilegedCwd?.status === 0 ? privilegedCwd.stdout.trim() : /^n(.+)$/m.exec(mac?.stdout ?? '')?.[1];
        if (!cwd) { unmeasured.push(`${host}/${process.pid}`); return []; }
        seat = seatOf(process.command, cwd);
      }
    }
    if (!seat) return [];
    const birthToken = processBirthToken(host, process.pid, run);
    if (!birthToken) { unmeasured.push(`${host}/${process.pid}`); return []; }
    return [{ ...process, ...(cwd ? { cwd } : {}), seat, birthToken }];
  });
  return { processes, unmeasured };
}

/** Shadow only: observe reserved hosts, report a seat consumer, never stop a process. */
export function hostReservationWatchTick(deps: HostReservationWatchDeps): {
  readonly observed: number; readonly violations: readonly HostReservationViolation[]; readonly unmeasured: readonly string[];
} {
  const violations: HostReservationViolation[] = [];
  const unmeasured: string[] = [];
  let observed = 0;
  for (const reservation of deps.reservations()) {
    let observation: HostProcessObservation;
    try { observation = deps.processes(reservation.host, reservation.runId); }
    catch { unmeasured.push(reservation.host); continue; }
    observed += 1;
    unmeasured.push(...observation.unmeasured);
    for (const process of observation.processes) {
      if (gateProcess(process.command, reservation.runId) || !process.seat) continue;
      if (!process.birthToken) { unmeasured.push(`${reservation.host}/${process.pid}`); continue; }
      const identity = createHash('sha256').update(`${reservation.host}\0${process.pid}\0${process.birthToken}`).digest('hex');
      const violation = { host: reservation.host, runId: reservation.runId,
        pid: process.pid, seat: process.seat, identity };
      violations.push(violation);
      deps.incident(violation);
      deps.notify(violation);
    }
  }
  return { observed, violations, unmeasured };
}

function currentReservations(root: string, now = new Date()): ReservedHost[] {
  const reservations = guardianHostLeaseRecords(readResourceLedger(resourceLedgerPath(root)))
    .filter(record => record.state === 'active' && record.request.consumer === 'release-gate'
      && Date.parse(record.request.expiresAt) > now.getTime())
    .map(record => ({ host: record.request.host, runId: record.request.runId }));
  return [...new Map(reservations.map(reservation => [reservation.host, reservation])).values()];
}

export function runHostReservationWatch(root = effectiveInstanceRoot(),
  overrides: Partial<Pick<HostReservationWatchDeps, 'reservations' | 'processes'>> & { run?: ResourceCommandRunner } = {}): ReturnType<typeof hostReservationWatchTick> {
  let store: MsgStore | undefined;
  try {
    return hostReservationWatchTick({
      reservations: overrides.reservations ?? (() => currentReservations(root)),
      processes: overrides.processes ?? ((host, runId) => observeHostProcesses(host, overrides.run, runId)),
      incident: violation => {
        const path = join(root, 'loops', 'host-reservation-watch', 'incidents', `${violation.identity}.json`);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
          writeFileSync(path, `${JSON.stringify({ event: 'host-reservation-violation', at: new Date().toISOString(), ...violation })}\n`,
            { mode: 0o600, flag: 'wx' });
          debug.log('loop.host-reservation-watch', 'violation', violation, { level: 'warn' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      },
      notify: violation => {
        (store ??= openMsgStore(join(root, 'msg', 'messages.db'))).appendWithProvenance({ from: 'GUARDIAN', to: violation.seat, kind: 'incident',
          body: `예약 호스트 ${violation.host}에서 자리 프로세스 pid=${violation.pid}가 감지됐습니다. 게이트 런 ${violation.runId} 동안 다른 호스트로 옮겨 주세요. 그림자 감시: 프로세스를 종료하지 않았습니다.` },
        `coord:${violation.identity}:${violation.seat}`);
      },
    });
  } finally { store?.close(); }
}

if (import.meta.main) {
  try {
    const result = runHostReservationWatch();
    console.log(JSON.stringify({ outcome: result.unmeasured.length ? 'partial' : 'ok', observed: result.observed,
      violations: result.violations.length, unmeasured: result.unmeasured }));
  } catch (error) {
    console.error(`host reservation watch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
