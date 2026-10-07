// Last line of defense: a test process never writes ops state or sends real alerts, even without the test preload.
// 10-07 incident: the public-export tree ran `bun test` without bunfig.toml (#24629), so tests wrote the ops deferred
// queue, ops logs.db and sent real Telegram messages. This guard does not depend on the preload or on HOME.
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';

export class TestOpsWriteRefusedError extends Error {
  constructor(what: string, path: string, signal: string) {
    super(`[test-guard] refused: a test process (${signal}) tried to ${what} in the operational root (${path}). `
      + 'Point the test at an isolated root (ELANOUS_STATE_DIR / --config-dir tmp) or inject a fake sender.');
    this.name = 'TestOpsWriteRefusedError';
  }
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Which signal marks this process as a test, or null for a real run.
 *  Measured under bun 1.4.2: `bun test` sets NODE_ENV=test unless the caller set another value, and `Bun.main` is the
 *  running test file (argv carries no «test» word). ELANOUS_TEST_HOME is set by the deterministic runner and inherited
 *  by children it spawns. A real CLI/daemon has none of the three. */
export function testProcessSignal(env: NodeJS.ProcessEnv = process.env, main: string | undefined = bunMain()): string | null {
  if (env.NODE_ENV === 'test') return 'NODE_ENV=test';
  if (env.ELANOUS_TEST_HOME?.trim()) return 'ELANOUS_TEST_HOME';
  if (main && TEST_FILE.test(main)) return 'Bun.main=test-file';
  return null;
}

function isTestProcess(): boolean { return testProcessSignal() !== null; }

function bunMain(): string | undefined {
  try { return (globalThis as { Bun?: { main?: string } }).Bun?.main; } catch { return undefined; }
}

/** Real path of `path` with the kernel's lookup order: components left to right, each symlink (live or dangling)
 *  expanded before a later `..` applies — `alias/../x` with `alias → ops/child` is `ops/x`. Missing tails are kept. */
export function physicalPath(path: string): string {
  const pending = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split('/').filter(Boolean);
  let current = '/';
  let links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = current === '/' ? `/${part}` : `${current}/${part}`;
    let target: string | null = null;
    try { if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next); } catch { /* missing: keep the name */ }
    if (target !== null && links++ < 40) {
      pending.unshift(...target.split('/').filter(Boolean));
      if (isAbsolute(target)) current = '/';
      continue;
    }
    current = next;
  }
  return current;
}

type SpawnSync = (cmd: string[]) => { exitCode: number; stdout: { toString(): string } };

/** The OS account's home from the account database, not HOME — test runners redirect HOME. Null when unresolvable. */
function lookupAccountHome(): string | null {
  try {
    const spawnSync = (globalThis as { Bun?: { spawnSync: SpawnSync } }).Bun?.spawnSync;
    const user = userInfo().username;
    const uid = process.getuid?.();
    const valid = (home: string | undefined): string | null => (home && isAbsolute(home) ? home : null);
    if (process.platform === 'darwin' && spawnSync) {
      const r = spawnSync(['/usr/bin/dscl', '.', '-read', `/Users/${user}`, 'NFSHomeDirectory']);
      const home = valid(r.exitCode === 0 ? r.stdout.toString().trim().split(/\s+/).at(-1) : undefined);
      if (home) return home;
    }
    if (process.platform !== 'darwin' && uid !== undefined) {
      try {
        const home = valid(readFileSync('/etc/passwd', 'utf8').split('\n')
          .map((line) => line.split(':')).find((f) => Number(f[2]) === uid)?.[5]);
        if (home) return home;
      } catch { /* try getent */ }
      if (spawnSync) {
        const r = spawnSync(['getent', 'passwd', String(uid)]);
        const home = valid(r.exitCode === 0 ? r.stdout.toString().trim().split(':')[5] : undefined);
        if (home) return home;
      }
    }
  } catch { /* unresolvable */ }
  return null;
}

let accountHomeLookup: () => string | null = lookupAccountHome;
let opsRootsOverride: string[] | null = null; // added roots, never a replacement
let cachedOpsRoots: string[] | null = null;

/** Tests add «ops-like» roots to prove the refusal; the real account root stays protected. null clears them. */
export function setOpsRootsForTesting(roots: string[] | null): void { opsRootsOverride = roots ? roots.map(physicalPath) : null; }

/** Tests inject a failing account lookup to prove the fallback; null restores the real one. Clears the cache. */
export function setAccountHomeLookupForTesting(lookup: (() => string | null) | null): void {
  accountHomeLookup = lookup ?? lookupAccountHome;
  cachedOpsRoots = null;
  accountHomeUnresolved = false;
}

/** The operational instance root(s) the guard protects — the account's real `~/.elanous`.
 *  When the account database cannot be read, fail toward protection: every conventional home of this user plus HOME. */
export function opsRoots(): string[] {
  // Widening only: injected roots and the env list add to the real account root; nothing can remove it.
  const extra = (process.env[EXTRA_OPS_ROOTS_ENV] ?? '').split(delimiter).filter((p) => isAbsolute(p)).map(physicalPath);
  const added = [...(opsRootsOverride ?? []), ...extra];
  return added.length ? [...new Set([...accountOpsRoots(), ...added])] : accountOpsRoots();
}

/** Extra roots the guard protects in this process (path-delimited). Used to prove the guard in a real child entry. */
export const EXTRA_OPS_ROOTS_ENV = 'ELANOUS_TEST_GUARD_EXTRA_OPS_ROOTS';

function accountOpsRoots(): string[] {
  if (cachedOpsRoots) return cachedOpsRoots;
  const home = accountHomeLookup();
  let homes: string[];
  if (home) homes = [home];
  else {
    let user = '';
    try { user = userInfo().username; } catch { /* unknown user */ }
    homes = [...(user ? [`/Users/${user}`, `/home/${user}`] : []), ...(process.getuid?.() === 0 ? ['/root'] : []), homedir()];
    try { debug.log('test-guard', 'account-home-unresolved', { protected: homes.length }); } catch { /* observation only */ }
  }
  accountHomeUnresolved = !home;
  cachedOpsRoots = [...new Set(homes.map((h) => physicalPath(join(h, '.elanous'))))];
  return cachedOpsRoots;
}

let accountHomeUnresolved = false;

export function isInsideOpsRoot(path: string, roots: string[] = opsRoots()): boolean {
  const target = physicalPath(path);
  // Unknown account home (non-standard, unreadable): any `<dir>/.elanous` tree may be the ops root — protect them all.
  // Isolated test roots are temp dirs or `<root>/state`, never a directory named `.elanous` under a home.
  // Both spellings: a `.elanous` that is itself a symlink to an oddly named directory is still that tree.
  if (accountHomeUnresolved && [resolve(path), target].some((p) => p.split(sep).includes('.elanous'))) return true;
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

function refuse(what: string, path: string, signal: string): never {
  try { debug.log('test-guard', 'ops-write-refused', { what, path, signal }); } catch { /* the refusal stands */ }
  throw new TestOpsWriteRefusedError(what, path, signal);
}

/** Throw when a test process is about to write `path` inside the operational root. No-op in real runs. */
export function assertNotTestWritingOps(path: string, what: string): void {
  const signal = testProcessSignal();
  if (!signal) return;
  if (path === ':memory:' || !isInsideOpsRoot(path)) return;
  refuse(what, path, signal);
}

/** Throw when a test process is about to perform a network send it must not make.
 *  - Routing (config dir · state root · conatus dir · acp-token dir) inside the ops root: always refused, faked or
 *    not — a test that resolved the ops universe is the leak itself, whatever its transport does.
 *  - `external` (a third-party bot API — Telegram, Discord): refused unless the transport is a test double that
 *    replaces the real one (`transportFaked`), whatever root the credentials came from. A double that deliberately
 *    calls the original is an explicit choice to send and is out of this guard's reach. */
export function assertNoRealSendFromTest(what: string, opts: {
  transportFaked: boolean; routingRoots: string[]; external?: boolean;
}): void {
  const signal = testProcessSignal();
  if (!signal) return;
  const opsRoot = opts.routingRoots.find((root) => root && isInsideOpsRoot(root));
  if (opsRoot) refuse(what, opsRoot, signal);
  if (opts.external && !opts.transportFaked) refuse(what, 'a real third-party bot API', signal);
}

/** True when `fn` is a bun:test/jest double whose behaviour replaces `real`. A bare `spyOn` keeps calling the
 *  original (its implementation IS `real`), so it is not a fake. */
export function isTestDouble(fn: unknown, real?: unknown): boolean {
  if (!isMockFn(fn)) return false;
  const impl = fn.getMockImplementation?.();
  return real === undefined || impl !== unwrapMock(real);
}

type MockFn = { mock: object; getMockImplementation?: () => unknown };
function isMockFn(fn: unknown): fn is MockFn {
  return typeof fn === 'function' && typeof (fn as { mock?: unknown }).mock === 'object' && (fn as { mock?: unknown }).mock !== null;
}

/** The function under a chain of spies — a «real» captured after a bare spy was installed is the spy itself.
 *  Unwrapping a fake yields the fake, so a capture taken under a fake refuses rather than allows. */
function unwrapMock(fn: unknown): unknown {
  let current = fn;
  for (let i = 0; i < 8 && isMockFn(current); i++) {
    const impl: unknown = current.getMockImplementation?.();
    if (typeof impl !== 'function' || impl === (current as unknown)) break;
    current = impl;
  }
  return current;
}

// Resolve the account home while no test has mocked anything yet; real runs never pay the lookup.
try { if (typeof process !== 'undefined' && isTestProcess()) opsRoots(); } catch { /* resolved lazily */ }
