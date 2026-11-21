// Server-observed process identity; never derived from request fields or pane ownership.
import { randomBytes, timingSafeEqual } from 'node:crypto';
export type RuntimeProcess = { pid: number; ppid: number; uid: number; start: string; name: string };
type Lookup = (pid: number) => RuntimeProcess | undefined;

/** Read Darwin proc_bsdinfo directly; unlike pane identity this does not require a TTY. */
export function runtimeProcessIdentity(pid: number): RuntimeProcess | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid < 1) return;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      const b = Buffer.alloc(136);
      if (lib.symbols.proc_pidinfo(pid, 3, 0, ptr(b), b.length) !== b.length || b.readUInt32LE(12) !== pid || b.readUInt32LE(4) === 5) return;
      const sec = b.readBigUInt64LE(120), usec = b.readBigUInt64LE(128);
      const name = b.subarray(48, 64).toString('utf8').split('\0')[0];
      if (!sec || usec >= 1000000n || !name) return;
      return { pid, ppid: b.readUInt32LE(16), uid: b.readUInt32LE(20), start: `${sec}:${usec}`, name };
    } finally { lib.close(); }
  } catch { return; }
}
const skipped = new Set(['sh', 'zsh', 'bash', 'fish', 'els', 'elanous']);
const forbiddenRuntime = new Set([...skipped, 'tmux', 'screen', 'sshd', 'ssh', 'launchd', 'login', 'ghostty', 'terminal', 'iterm2', 'iterm2-server', 'alacritty', 'kitty', 'wezterm', 'wezterm-gui']);
export type RuntimeClaim = { pid: number; start: string };
const valid = (p: RuntimeProcess | undefined, pid: number, uid: number): p is RuntimeProcess =>
  !!p && p.pid === pid && p.uid === uid && !!p.start && Number.isSafeInteger(p.ppid) && p.ppid > 0;

/** Per-server registration; socket peer generation is captured before async authorization. */
export class SeatRuntimeRegistry {
  private runtime: RuntimeProcess | undefined;
  private token: string | undefined;
  private generation: string | undefined;
  constructor(private readonly lookup: Lookup = runtimeProcessIdentity) {}

  register(peer: number | undefined, uid: number | undefined, baseline: RuntimeProcess | undefined, claim?: RuntimeClaim, paneShell?: RuntimeClaim): boolean {
    if (peer === undefined || uid === undefined || !baseline || baseline.pid !== peer || baseline.uid !== uid) return false;
    if (!claim || !Number.isSafeInteger(claim.pid) || claim.pid <= 1 || claim.pid === peer || typeof claim.start !== 'string' || !/^\d+:\d+$/.test(claim.start)) return false;
    const now = this.lookup(peer);
    if (!now || now.uid !== uid || now.start !== baseline.start) return false;
    const runtime = this.lookup(claim.pid);
    if (!valid(runtime, claim.pid, uid) || runtime.start !== claim.start || forbiddenRuntime.has(runtime.name.toLowerCase())) return false;
    if (paneShell) {
      const shell = this.lookup(paneShell.pid);
      if (!valid(shell, paneShell.pid, uid) || shell.start !== paneShell.start || !matchSeatRuntime(runtime.pid, uid, shell, this.lookup)) return false;
    }
    const after = this.lookup(peer);
    if (!after || after.uid !== uid || after.start !== baseline.start || !matchSeatRuntime(peer, uid, runtime, this.lookup)) return false;
    const finalPeer = this.lookup(peer);
    if (!finalPeer || finalPeer.uid !== uid || finalPeer.start !== baseline.start) return false;
    this.runtime = runtime;
    this.token = randomBytes(32).toString('hex');
    this.generation = `runtime:${randomBytes(16).toString('hex')}`;
    return true;
  }

  registrationToken(): string | undefined { return this.token; }

  checkpoint(): () => void {
    const runtime = this.runtime, token = this.token, generation = this.generation;
    return () => { this.runtime = runtime; this.token = token; this.generation = generation; };
  }

  clear(): void { this.runtime = undefined; this.token = undefined; this.generation = undefined; }

  key(): string | undefined { return this.generation; }

  /** Queue entries pin a registration, not the short-lived request process or secret token. */
  isLiveGeneration(key: string | undefined): boolean {
    if (!key || key !== this.generation || !this.runtime) return false;
    const now = this.lookup(this.runtime.pid);
    return !!now && now.pid === this.runtime.pid && now.uid === this.runtime.uid && now.start === this.runtime.start;
  }

  /** Classification is independent of credentials; credentials are still required for authority. */
  isDescendant(peer: number | undefined, uid: number | undefined, baseline: RuntimeProcess | undefined): boolean {
    if (peer === undefined || uid === undefined || !baseline || baseline.pid !== peer || baseline.uid !== uid || !this.runtime) return false;
    const now = this.lookup(peer);
    if (!now || now.uid !== uid || now.start !== baseline.start || !matchSeatRuntime(peer, uid, this.runtime, this.lookup)) return false;
    const after = this.lookup(peer);
    return !!after && after.uid === uid && after.start === baseline.start;
  }

  matches(peer: number | undefined, uid: number | undefined, baseline: RuntimeProcess | undefined, token?: string): boolean {
    if (!this.token || typeof token !== 'string') return false;
    const expected = Buffer.from(this.token, 'utf8'), actual = Buffer.from(token, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual) && this.isDescendant(peer, uid, baseline);
  }
}

/** Called only for an authorized seat-set connection. The socket peer is the short-lived CLI. */
export function findSeatRuntime(peer: number, uid: number, lookup: Lookup): RuntimeProcess | undefined {
  const seen = new Set<number>();
  let pid = peer;
  for (let depth = 0; depth < 128 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const p = lookup(pid);
    if (!valid(p, pid, uid)) return undefined;
    if (pid !== peer && !skipped.has(p.name.toLowerCase())) return p;
    pid = p.ppid;
  }
  return undefined;
}

/** A live descendant must reach the original PID, UID and process generation. */
export function matchSeatRuntime(peer: number, uid: number, runtime: RuntimeProcess, lookup: Lookup): boolean {
  if (uid !== runtime.uid) return false;
  const seen = new Set<number>();
  let pid = peer;
  for (let depth = 0; depth < 128 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const p = lookup(pid);
    if (!valid(p, pid, uid)) return false;
    if (pid === runtime.pid) return p.start === runtime.start;
    pid = p.ppid;
  }
  return false;
}
