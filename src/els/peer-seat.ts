// Socket credentials and live OS ancestry, never client-supplied pane/env/from.
import type { Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const peerIdentitySupported = (platform: string): boolean => platform === 'darwin';
export const validHerdrPane = (pane: string): boolean => /^w[A-Za-z0-9]+:p[0-9]+$(?![\s\S])/.test(pane);

export function peerPid(socket: Socket): number | undefined {
  try {
    if (!peerIdentitySupported(process.platform)) return;
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (!Number.isInteger(fd) || fd! < 0) return;
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    try {
      const data = new Int32Array(process.platform === 'darwin' ? 1 : 3), len = new Uint32Array([data.byteLength]);
      const rc = lib.symbols.getsockopt(fd!, process.platform === 'darwin' ? 0 : 1, process.platform === 'darwin' ? 2 : 17, ptr(data), ptr(len));
      return rc === 0 && len[0] === data.byteLength && data[0]! > 0 ? data[0] : undefined;
    } finally { lib.close(); }
  } catch { return undefined; }
}

// Darwin proc_bsdinfo has a microsecond process birth time and controlling tty device.
// Unsupported kernels and short/unknown ABI results deny rather than guessing.
export type ProcessIdentity = { pid: number; ppid: number; session: number; tty: number; start: string; startedMs: number };

// Date.now is millisecond resolution: the process must predate the entire sampled millisecond.
export function baselineBeforePidLookup(identity: ProcessIdentity | undefined, pid: number | undefined, beforeMs: number): ProcessIdentity | undefined {
  return identity && identity.pid === pid && Number.isSafeInteger(beforeMs) && identity.startedMs < beforeMs ? identity : undefined;
}
export function processIdentity(pid: number | undefined): ProcessIdentity | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || !pid || pid < 1) return;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    try {
      const b = Buffer.alloc(136);
      if (lib.symbols.proc_pidinfo(pid, 3, 0, ptr(b), b.length) !== b.length || b.readUInt32LE(12) !== pid) return;
      const sec = b.readBigUInt64LE(120), usec = b.readBigUInt64LE(128), session = lib.symbols.getsid(pid);
      const tty = b.readUInt32LE(108), flags = b.readUInt32LE(0), status = b.readUInt32LE(4);
      if (!sec || usec >= 1000000n || session <= 0 || tty === 0xffffffff || !(flags & 0x40) || status === 5) return;
      return { pid, ppid: b.readUInt32LE(16), session, tty, start: `${sec}:${usec}`, startedMs: Number(sec * 1000n + usec / 1000n) };
    } finally { lib.close(); }
  } catch { return; }
}

/** 보안 HOLD 수리(OP #129232): 데몬(제어 tty 없는 els 서버·홀더)의 시작 시각만 돌려준다 —
 *  processIdentity 의 tty/session 조건 없이 proc_pidinfo 의 시작 시각(sec:usec)을 그대로 쓴다.
 *  입양 신뢰 기록(홀더가 기록한 서버 pid+시작시각)의 시작시각 원천이다. */
export function processStartStamp(pid: number | undefined): string | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || !pid || pid < 1) return;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      const b = Buffer.alloc(136);
      if (lib.symbols.proc_pidinfo(pid, 3, 0, ptr(b), b.length) !== b.length || b.readUInt32LE(12) !== pid) return;
      const sec = b.readBigUInt64LE(120), usec = b.readBigUInt64LE(128);
      if (!sec) return;
      return `${sec}:${usec}`;
    } finally { lib.close(); }
  } catch { return; }
}

type Seat = { pane: string; seat: string };

/** Server-owned live pane generation; start must be captured when its PTY identity is bound. */
export type ElsSeatBinding = { pane: string; seat: string; pid: number; start: string; generation: string };

/** Pane ownership is not process identity. Until bindings carry independently verified
 * actor identity, they must never grant a peer seat, even with stable OS ancestry. */
export function resolveElsPeerSeat(
  pid: number | undefined,
  baseline: ProcessIdentity | undefined,
  bindings: () => readonly ElsSeatBinding[],
  deps: { identity: typeof processIdentity } = { identity: processIdentity },
): Seat | undefined {
  // The binding's seat is the creator/owner of the resource, not the actor
  // running inside it. A process-generation check cannot bridge that trust gap.
  void pid; void baseline; void bindings; void deps;
  return undefined;
}

/** Bind an issued pane credential to the socket peer, never to a claimed PID or pane owner. */
export function verifyPanePeer(
  pid: number | undefined, baseline: ProcessIdentity | undefined, pane: string,
  binding: () => { readonly pid: number; readonly start: string; readonly generation: string } | undefined,
  shells: () => readonly { readonly pane: string; readonly pid: number }[],
  identity: typeof processIdentity = processIdentity,
): boolean {
  try {
    if (!pid || !baseline || baseline.pid !== pid) return false;
    const target = binding();
    if (!target || !target.start || !target.generation) return false;
    const shellList = shells();
    if (shellList.filter(s => s.pid === target.pid && s.pane === pane).length !== 1 ||
        shellList.some(s => s.pid === target.pid && s.pane !== pane)) return false;
    const chain: ProcessIdentity[] = [];
    let current = pid;
    while (current > 1 && chain.length < 128) {
      if (chain.some(item => item.pid === current)) return false;
      const item = identity(current);
      if (!item || item.pid !== current || item.session !== baseline.session || item.tty !== baseline.tty ||
          (chain.length === 0 && item.start !== baseline.start)) return false;
      chain.push(item);
      const nearest = shellList.filter(s => s.pid === current);
      if (nearest.length) {
        if (nearest.length !== 1 || nearest[0]!.pane !== pane || current !== target.pid || item.start !== target.start) return false;
        const live = binding();
        if (!live || live.pid !== target.pid || live.start !== target.start || live.generation !== target.generation) return false;
        const currentShells = shells();
        if (chain.some(old => {
          const before = shellList.filter(s => s.pid === old.pid).map(s => s.pane).sort();
          const after = currentShells.filter(s => s.pid === old.pid).map(s => s.pane).sort();
          return before.length !== after.length || before.some((value, i) => value !== after[i]);
        })) return false;
        return chain.every(old => {
          const now = identity(old.pid);
          return !!now && now.start === old.start && now.ppid === old.ppid && now.session === old.session && now.tty === old.tty;
        });
      }
      if (current === baseline.session || item.ppid <= 1) return false;
      current = item.ppid;
    }
    return false;
  } catch { return false; }
}

type ResolverDeps = { identity: typeof processIdentity; ledger: (path: string) => Promise<string>; paneInfo: (pane: string) => Promise<unknown> };
const resolverDeps: ResolverDeps = {
  identity: processIdentity,
  ledger: (path) => readFile(path, 'utf8'),
  paneInfo: async (pane) => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(join(homedir(), '.local/bin/herdr'), ['pane', 'process-info', '--pane', pane], {
        encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
        env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', NODE_ENV: 'production' },
      }, (error, out) => error ? reject(error) : resolve(out));
    });
    return JSON.parse(stdout)?.result?.process_info;
  },
};
/** Only the fixed installation is consulted, never PATH or client-provided environment. */
export async function resolvePeerSeatWithAnchor(pid: number | undefined, baseline?: ProcessIdentity, ledger = join(homedir(), 'elanous-hq/seat-state/OP/tools/seat-panes.tsv'), deps: ResolverDeps = resolverDeps): Promise<(Seat & { anchor: ProcessIdentity }) | undefined> {
  try {
    if (!baseline || baseline.pid !== pid) return;
    const ledgerText = await deps.ledger(ledger);
    const rows = ledgerText.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
    const chain: ProcessIdentity[] = [];
    for (let p = pid!; p > 1;) {
      if (chain.length >= 128 || chain.some(item => item.pid === p)) return;
      const item = deps.identity(p);
      if (!item || item.session !== baseline.session || item.tty !== baseline.tty) return;
      chain.push(item);
      // Only walk the peer's session; its leader is the last relevant ancestor.
      if (p === baseline.session) break;
      p = item.ppid;
    }
    if (!chain.length || chain[0]!.start !== baseline.start) return;
    const found: (Seat & { shell: ProcessIdentity })[] = [];
    for (const row of rows) {
      const [seat, pane] = row;
      if (!pane || !seat || rows.filter(r => r[0] === seat || r[1] === pane).length !== 1) return;
      if (seat !== 'OP' && seat !== 'RES-INFRA') continue;
      if (!validHerdrPane(pane)) return;
      // An unavailable candidate grants nothing, but must not deny a different,
      // independently verified seat. Ledger-wide ambiguity is still fatal above.
      let info: { pane_id?: unknown; shell_pid?: unknown } | undefined;
      try { info = await deps.paneInfo(pane) as typeof info; } catch { continue; }
      if (!info || info.pane_id !== pane || !Number.isSafeInteger(info.shell_pid)) continue;
      const shell = chain.find(item => item.pid === info.shell_pid);
      if (shell) found.push({ pane, seat, shell });
    }
    if (found.length !== 1) return;
    // Requery the live pane: an unchanged process chain is not proof the pane still owns that shell.
    const selected = found[0]!;
    const live = await deps.paneInfo(selected.pane) as { pane_id?: unknown; shell_pid?: unknown } | undefined;
    if (!live || live.pane_id !== selected.pane || live.shell_pid !== selected.shell.pid) return;
    // Check the ledger first; no async operation follows the final generation checks.
    if (await deps.ledger(ledger) !== ledgerText) return;
    for (const old of chain) {
      const now = deps.identity(old.pid);
      if (!now || now.start !== old.start || now.ppid !== old.ppid || now.session !== old.session || now.tty !== old.tty) return;
    }
    return { pane: selected.pane, seat: selected.seat, anchor: selected.shell };
  } catch { return; }
}

export async function resolvePeerSeat(pid: number | undefined, baseline?: ProcessIdentity, ledger?: string, deps?: ResolverDeps): Promise<Seat | undefined> {
  const found = await resolvePeerSeatWithAnchor(pid, baseline, ledger, deps);
  return found ? { pane: found.pane, seat: found.seat } : undefined;
}

export function inspectReadAncestry(
  pid: number | undefined,
  baseline: ProcessIdentity | undefined,
  shellPids: readonly { pane: string; pid: number }[],
  deps: { identity: (pid: number) => ProcessIdentity | undefined } = resolverDeps,
): { kind: 'human' } | { kind: 'pane'; pane: string } | { kind: 'unknown' } {
  try {
    if (!pid || !baseline || baseline.pid !== pid) return { kind: 'unknown' };
    const origin = deps.identity(pid);
    if (!origin || origin.start !== baseline.start || origin.ppid !== baseline.ppid || origin.session !== baseline.session || origin.tty !== baseline.tty) return { kind: 'unknown' };
    const shells = new Map(shellPids.map(entry => [entry.pid, entry.pane]));
    const chain: ProcessIdentity[] = [];
    let current = origin;
    for (let steps = 0; steps < 128; steps++) {
      chain.push(current);
      const pane = shells.get(current.pid);
      if (pane) return { kind: 'pane', pane };
      if (current.pid === origin.session) {
        // A changing or recycled process chain is not evidence of a human caller.
        const stable = chain.every(old => {
          const now = deps.identity(old.pid);
          return !!now && now.pid === old.pid && now.start === old.start && now.ppid === old.ppid
            && now.session === old.session && now.tty === old.tty;
        });
        return stable ? { kind: 'human' } : { kind: 'unknown' };
      }
      if (current.ppid <= 1 || current.ppid >= current.pid) return { kind: 'unknown' };
      const parent = deps.identity(current.ppid);
      if (!parent || parent.session !== origin.session || parent.tty !== origin.tty) return { kind: 'unknown' };
      current = parent;
    }
  } catch { /* an unavailable identity is not evidence of a human */ }
  return { kind: 'unknown' };
}

/** JUD #39096 must ⓒ (OP #106966·#107197): 무토큰 연결의 프로세스 조상에 els pane 셸이 있으면
 *  그 호출자는 사람이 아니라 pane 프로세스(손)다. resolvePeerSeat 은 seat-panes.tsv 원장의
 *  herdr pane(OP/RES-INFRA)만 보므로, els pane 자손은 이 검사로 막는다. */
export async function resolveAncestorPane(
  pid: number | undefined,
  baseline: ProcessIdentity | undefined,
  shellPids: readonly { pane: string; pid: number }[],
  deps: { identity: (pid: number) => ProcessIdentity | undefined } = resolverDeps,
): Promise<{ pane: string } | undefined> {
  try {
    if (!pid) return;
    const shells = new Map<number, string>();
    for (const entry of shellPids) shells.set(entry.pid, entry.pane);
    if (!shells.size) return;
    // 피어 자신이 pane 셸 프로세스인 경우는 baseline 없이도 확정적이다 (procIdentity FFI 불가 환경 포함).
    if (shells.has(pid)) return { pane: shells.get(pid)! };
    const origin = baseline ?? deps.identity(pid);
    if (!origin || origin.pid !== pid) return;
    let p = origin.ppid, steps = 0;
    while (p > 1 && steps++ < 128) {
      if (shells.has(p)) return { pane: shells.get(p)! };
      const item = deps.identity(p);
      if (!item) return;
      if (item.session !== origin.session || item.tty !== origin.tty) return;
      if (p === origin.session) return;
      if (item.ppid >= p) return;
      p = item.ppid;
    }
    return;
  } catch { return; }
}
