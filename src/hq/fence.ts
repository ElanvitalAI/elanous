import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/format.js';

export interface CliProcess { pid: number; ppid: number; ageSeconds: number; cpuSeconds: number; command: string }
export interface OrphanCandidate { process: CliProcess; tree: CliProcess[]; periodMinutes: number }
export interface FenceGcDeps {
  snapshot?: () => CliProcess[];
  run?: (binary: string, args: string[]) => string;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number) => void;
  timeZone?: string;
}

export function cliFingerprint(command: string): string {
  return command.replace(/^\s*(?:\S*\/)?bun\s+(?:\S*\/)?elanous\.mjs\s+/, 'elanous ')
    .replace(/^\s*(?:\S*\/)?(?:elanous\.mjs|eln)\s+/, 'elanous ')
    .trim();
}

function seconds(text: string): number {
  const parts = text.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** ps gives command after the four numeric fields; never split command on whitespace. */
export function processSnapshot(): CliProcess[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,time=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  return result.stdout.split('\n').flatMap(line => {
    const fields = /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+([\d:.]+)\s+(.+)$/.exec(line);
    if (!fields) return [];
    const elapsed = fields[3]!.split('-');
    const ageSeconds = seconds(elapsed.at(-1)!) + (elapsed.length === 2 ? Number(elapsed[0]) * 86_400 : 0);
    const cpuSeconds = seconds(fields[4]!);
    if (!Number.isFinite(ageSeconds) || !Number.isFinite(cpuSeconds)) return [];
    return [{ pid: Number(fields[1]), ppid: Number(fields[2]), ageSeconds, cpuSeconds, command: fields[5]! }];
  });
}

/** Only installed elanous one-shot CLI launches, not shells, daemons, or an incidental flag inside a quoted payload. */
export function oneShotCommand(command: string): boolean {
  const invocation = /^(?:(?:\S*\/)?bun\s+(?:\S*\/)?elanous\.mjs|(?:\S*\/)?(?:elanous|elanous\.mjs|eln))\s+/.exec(command);
  if (!invocation) return false;
  const args = command.slice(invocation[0].length).split(/\s+--\s+|\s+-c\s+/)[0] ?? '';
  const payload = /\s+--\s+(.+)$/.exec(command)?.[1] ?? '';
  const shellBody = /\s+--\s+(?:\S*\/)?(?:sh|bash)\s+-c\s+(.+)$/.exec(command)?.[1];
  if (shellBody !== undefined) {
    if (!/^['"]?(?:\S*\/)?bun\s+(?:\S*\/)?elanous\.mjs\s+/.test(shellBody)
      || /[;|`&]/.test(shellBody) || /\bnexus\s+run\b/.test(shellBody)
      || !/(?:^|\s)(?:--once|tick|--refresh|--notify)(?:\s|['"]|$)/.test(shellBody)) return false;
  }
  // Test-universe and help invocations are never collected — on the fence itself, in its payload, or in a wrapped shell body.
  for (const part of [args, payload, shellBody ?? '']) {
    if (/(?:^|\s|['"])--test(?:\s|=|['"]|$)/.test(part) || /(?:^|\s)(?:--help|-h)(?:\s|['"]|$)/.test(part)) return false;
  }
  // The daemon is never a one-shot, whatever flag rides along (`nexus run --once`), directly or as a fence payload.
  if (/(?:^|\s)nexus\s+run\b/.test(args) || /(?:^|\s)nexus\s+run\b/.test(payload) || /&&|\|\||[;|`&]/.test(payload)) return false;
  if (/^hq\s+fence\s+--role\s+(?:cron|seat-loop|conatus|release-run)\b/.test(args) && payload) {
    return /(?:^|\s)(?:--once|tick|--refresh|--notify)(?:\s|['"]|$)/.test(payload);
  }
  return /(?:^|\s)hq\s+fence\s+--role\s+(?:cron|seat-loop|conatus|release-run)\b/.test(args)
    || /(?:^|\s)--once(?:\s|$)/.test(args)
    || /(?:^|\s)(?:tick|--refresh|--notify)(?:\s|$)/.test(args);
}

/** Unknown/mismatched schedules are not assigned a made-up period. Match the launched action (including fence payload). */
export function scheduledPeriodMinutes(command: string, schedules: readonly { command: string; cron: string }[], now: Date, timeZone = resolveTimeZone().timeZone): number | null {
  const current = cliFingerprint(command);
  const matches = schedules.filter(job => {
    const action = job.command.trim().replace(/^cd\s+\S+\s*&&\s*/, '').replace(/\s+>>?\s+\S+(?:\s+2>&1)?\s*$/, '');
    if (action.length < 16) return false;
    if (current === cliFingerprint(action)) return true;
    // The installed hq-fence shell wrapper execs the CLI with an explicit role and -- payload.
    // Accept only a single, unambiguous quoted command; never infer a period from a substring.
    const wrapper = /^(?:\S*\/)?hq-fence\s+(cron|seat-loop|conatus|release-run)\s+'([^']+)'$/.exec(action);
    if (!wrapper) return false;
    return current === `elanous hq fence --role ${wrapper[1]} -- ${wrapper[2]}`;
  });
  if (matches.length !== 1) return null;
  const cron = matches[0]!.cron;
  if (cron.trim().split(/\s+/).length !== 5) return null;
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  // A 7-day minute scan per process is costly with many hung trees; one tick asks the same (cron, zone, minute) often.
  const memoKey = `${cron}\0${timeZone}\0${start}`;
  if (periodMemo.has(memoKey)) return periodMemo.get(memoKey)!;
  const period = cronPeriodMinutes(cron, start, timeZone);
  if (periodMemo.size > 256) periodMemo.clear();
  periodMemo.set(memoKey, period);
  return period;
}

const periodMemo = new Map<string, number | null>();

function cronPeriodMinutes(cron: string, start: number, timeZone: string): number | null {
  const fires: number[] = [];
  try {
    // Every fire in the next 7 days, not just the first few: a weekday-hours cron (`0 9-17 * * 1-5`) is hourly
    // for three gaps and then pauses for a night or a weekend — that is no single period.
    for (let i = 0; i < 7 * 24 * 60; i++) {
      const at = start + i * 60_000;
      if (cronMatches(cron, new Date(at), { timeZone })) fires.push(at);
    }
  } catch { return null; }
  // An irregular schedule (any unequal gap within the window, e.g. `0 9,18 * * *`, weekday hours) has no single period
  // to multiply — unknown, never collected. Fewer than three fires in 7 days (weekly) is unknown too (safe side).
  if (fires.length < 3) return null;
  const gap = fires[1]! - fires[0]!;
  for (let i = 2; i < fires.length; i++) if (fires[i]! - fires[i - 1]! !== gap) return null;
  return gap / 60_000;
}

export function orphanCandidates(first: readonly CliProcess[], second: readonly CliProcess[], schedules: readonly { command: string; cron: string }[], now: Date, timeZone?: string): OrphanCandidate[] {
  const byPid = new Map(second.map(row => [row.pid, row]));
  const initial = new Map(first.map(row => [row.pid, row]));
  const candidates: OrphanCandidate[] = [];
  // The collector itself and every ancestor of it (the guardian tick's cron/fence parents) are never signalled.
  const self = new Set<number>([process.pid]);
  for (let pid: number | undefined = byPid.get(process.pid)?.ppid; pid !== undefined && pid > 1 && !self.has(pid); pid = byPid.get(pid)?.ppid) self.add(pid);
  for (const root of first) {
    if (root.pid === process.pid || !oneShotCommand(root.command)) continue;
    const current = byPid.get(root.pid);
    if (!current || current.command !== root.command || current.ppid !== root.ppid || current.cpuSeconds !== root.cpuSeconds) continue;
    // Identity: a reused PID restarts its age; the same process can only have grown older between snapshots.
    if (current.ageSeconds < root.ageSeconds) continue;
    const periodMinutes = scheduledPeriodMinutes(root.command, schedules, now, timeZone);
    if (!periodMinutes || root.ageSeconds <= periodMinutes * 3 * 60) continue;
    // An old ancestor with an actively executing payload is not an orphan.
    if (second.some(row => row.ppid === root.pid && !initial.has(row.pid))) continue;
    const tree = [current];
    for (let i = 0; i < tree.length; i++) {
      for (const child of second) if (child.ppid === tree[i]!.pid && !tree.some(row => row.pid === child.pid)) tree.push(child);
    }
    if (tree.some(row => {
      const before = initial.get(row.pid);
      return !before || before.command !== row.command || before.cpuSeconds !== row.cpuSeconds || before.ppid !== row.ppid
        || Math.abs((row.ageSeconds - before.ageSeconds) - (current.ageSeconds - root.ageSeconds)) > 2;
    })) continue;
    if (tree.some(row => self.has(row.pid))) continue;
    candidates.push({ process: current, tree, periodMinutes });
  }
  return candidates.filter(candidate => !candidates.some(parent => parent !== candidate && parent.tree.some(row => row.pid === candidate.process.pid)));
}

export function gcTools(deps: FenceGcDeps = {}) {
  return {
    snapshot: deps.snapshot ?? processSnapshot,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    run: deps.run ?? ((binary: string, args: string[]) => {
      // Linux has no macOS sample. Over one second, sample each thread's wait channel and state (readable by the
      // process owner); the kernel stack is root-only on most hosts, so it is added only when readable.
      if (binary === 'sample' && process.platform === 'linux') {
        const pid = args[0];
        const samples: string[] = [];
        const deadline = Date.now() + 1_000;
        do {
          for (const tid of readdirSync(`/proc/${pid}/task`)) {
            const base = `/proc/${pid}/task/${tid}`;
            const state = /^State:\s*(.+)$/m.exec(readFileSync(`${base}/status`, 'utf8'))?.[1] ?? '?';
            let stack = '';
            // Root-only on most kernels: carried when readable, otherwise the evidence says so (not a collection gate).
            try { stack = `\n${readFileSync(`${base}/stack`, 'utf8')}`; } catch (error) { stack = ` kernel-stack=unreadable(${(error as NodeJS.ErrnoException).code ?? 'error'})`; }
            samples.push(`tid=${tid} state=${state} wchan=${readFileSync(`${base}/wchan`, 'utf8') || '0'}${stack}`);
          }
          if (Date.now() < deadline) Bun.sleepSync(Math.min(100, deadline - Date.now()));
        } while (Date.now() < deadline);
        if (samples.length === 0) throw new Error(`sample: no threads for PID ${pid}`);
        return samples.join('\n');
      }
      // macOS `sample` by absolute path: a PATH shim (e.g. pyenv's `sample`) must not stand in for the profiler.
      const resolved = binary === 'sample' && process.platform === 'darwin' ? '/usr/bin/sample' : binary;
      // sample symbolicates a large Bun binary after its 1s window — allow time and room, or it would never succeed.
      const result = spawnSync(resolved, args, { encoding: 'utf8', timeout: binary === 'sample' ? 30_000 : 10_000, maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`${binary}: ${result.error ?? result.stderr ?? 'failed'}`);
      return result.stdout;
    }),
    kill: deps.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM')),
  };
}

/** The target's own Bun binary — read from the target PID, so a PID that died (or was reused) fails closed. */
export function bunVersion(pid: number, run: (binary: string, args: string[]) => string): string {
  const bin = process.platform === 'linux' ? readlinkSync(`/proc/${pid}/exe`) : run('ps', ['-o', 'comm=', '-p', String(pid)]).trim();
  if (!/(?:^|\/)bun(?:$|\s)/.test(bin)) throw new Error(`PID ${pid} is not a Bun process`);
  return run(bin, ['--version']).trim();
}
