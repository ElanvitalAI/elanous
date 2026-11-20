import { expect, test } from 'bun:test';
import { chmodSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHost, readHostLedger, reclaimStaleLock, recordHeartbeat, releaseLedgerLock, readLockToken } from './index.js';
import { fileURLToPath } from 'node:url';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = 1_000_000;

test('classifyHost: current / behind / unknown / stale and the stale boundary', () => {
  expect(classifyHost({ installedSha: A, lastHeartbeatMs: NOW }, A, NOW, 1000)).toBe('current');
  expect(classifyHost({ installedSha: A.toUpperCase(), lastHeartbeatMs: NOW }, A, NOW, 1000)).toBe('current');
  expect(classifyHost({ installedSha: A, lastHeartbeatMs: NOW }, B, NOW, 1000)).toBe('behind');
  expect(classifyHost({ installedSha: A, lastHeartbeatMs: NOW }, undefined, NOW, 1000)).toBe('unknown');
  expect(classifyHost({ installedSha: 'nope', lastHeartbeatMs: NOW }, A, NOW, 1000)).toBe('unknown');
  expect(classifyHost({ installedSha: A, lastHeartbeatMs: NOW - 1000 }, A, NOW, 1000)).toBe('current');
  expect(classifyHost({ installedSha: A, lastHeartbeatMs: NOW - 1001 }, A, NOW, 1000)).toBe('stale');
  expect(classifyHost({ installedSha: 'nope', lastHeartbeatMs: NOW - 5000 }, undefined, NOW, 1000)).toBe('stale');
});

test('recordHeartbeat writes atomically (no tmp left), keeps seat, updates in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  const path = join(dir, 'sub', 'host-registry.json');
  try {
    expect(readHostLedger(path)).toBeUndefined();
    recordHeartbeat('host-a', A, NOW, { path, seat: 'TC', channel: 'dev', desiredSha: B });
    const r = recordHeartbeat('host-a', B, NOW + 5, { path, desiredSha: B });
    expect(r).toMatchObject({ host: 'host-a', seat: 'TC', channel: 'dev', installedSha: B, state: 'current' });
    expect(Object.keys(readHostLedger(path)!.hosts)).toEqual(['host-a']);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['host-registry.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt ledger reads as undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    require('node:fs').writeFileSync(path, '{bad');
    expect(existsSync(path)).toBe(true);
    expect(readHostLedger(path)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordHeartbeat refuses to overwrite a corrupt / wrong-version / unreadable ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    for (const body of ['{bad', JSON.stringify({ version: 2, hosts: {} }), JSON.stringify({ version: 1, hosts: { x: { host: 3 } } }), JSON.stringify({ version: 1, hosts: [] })]) {
      writeFileSync(path, body);
      expect(() => recordHeartbeat('host-a', A, NOW, { path, channel: 'dev' })).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(body);
    }
    // directory in place of the file -> read error that is not ENOENT
    const dirPath = join(dir, 'asdir');
    mkdirSync(dirPath);
    expect(() => recordHeartbeat('host-a', A, NOW, { path: dirPath })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown channel is stored as unknown, not release; known channel is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    expect(recordHeartbeat('host-a', A, NOW, { path }).channel).toBe('unknown');
    expect(recordHeartbeat('host-b', A, NOW, { path, channel: 'release' }).channel).toBe('release');
    expect(recordHeartbeat('host-b', A, NOW + 1, { path }).channel).toBe('release');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readHostLedger drops malformed entries but keeps valid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    const good = { host: 'host-a', channel: 'dev', installedSha: A, lastHeartbeatMs: NOW, state: 'current' };
    writeFileSync(path, JSON.stringify({ version: 1, hosts: { 'host-a': good, bad: { host: 1 } } }));
    expect(Object.keys(readHostLedger(path)!.hosts)).toEqual(['host-a']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed write (injected rename failure, permission independent) keeps the ledger and leaves no tmp/lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    recordHeartbeat('host-a', A, NOW, { path, channel: 'dev' });
    const before = readFileSync(path, 'utf8');
    expect(() => recordHeartbeat('host-b', B, NOW, { path, renameImpl: () => { throw new Error('injected'); } })).toThrow('injected');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['l.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('special host names (__proto__, constructor) round-trip as plain keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    for (const h of ['__proto__', 'constructor', 'toString']) recordHeartbeat(h, A, NOW, { path, channel: 'dev' });
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).hosts).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    const again = readHostLedger(path)!;
    expect(Object.keys(again.hosts).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    recordHeartbeat('__proto__', B, NOW + 1, { path });
    expect(Object.keys(readHostLedger(path)!.hosts).length).toBe(3);
    expect(readHostLedger(path)!.hosts['__proto__']!.installedSha).toBe(B);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale-looking lock whose owner process is alive is never reclaimed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const lock = join(dir, 'l.json.lock');
    makeLock(lock, `${process.pid}.alive`, 120_000);
    expect(reclaimStaleLock(lock, `${process.pid}.alive`)).toBe(false);
    expect(readLockToken(lock)).toBe(`${process.pid}.alive`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent processes updating different hosts both survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    const mod = fileURLToPath(new URL('./index.js', import.meta.url).href.replace(/\.js$/, '.ts'));
    const script = join(dir, 'child.ts');
    writeFileSync(script, `import { recordHeartbeat } from ${JSON.stringify(mod)}; for (let i = 0; i < 25; i++) recordHeartbeat(process.argv[2]!, ${JSON.stringify(A)}, i, { path: ${JSON.stringify(path)}, channel: 'dev' });`);
    const procs = ['host-a', 'host-b', 'host-c'].map((h) => Bun.spawn([process.execPath, script, h], { stdout: 'ignore', stderr: 'pipe' }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0]);
    expect(Object.keys(readHostLedger(path)!.hosts).sort()).toEqual(['host-a', 'host-b', 'host-c']);
    expect(readdirSync(dir).sort()).toEqual(['child.ts', 'l.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeLock(path: string, token: string, ageMs: number): void {
  mkdirSync(path);
  writeFileSync(join(path, 'owner'), token);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

test('stale reclaim only deletes the lock whose token the reclaimer observed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const lock = join(dir, 'l.json.lock');
    makeLock(lock, '999999999.fresh', 0); // a fresh owner took over after the waiter observed T1
    expect(reclaimStaleLock(lock, '999999999.old')).toBe(false);
    expect(readLockToken(lock)).toBe('999999999.fresh');
    rmSync(lock, { recursive: true });
    makeLock(lock, '999999999.old', 60_000);
    expect(reclaimStaleLock(lock, '999999999.old')).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reclaim refuses a fresh lock even when the token matches; release only removes own token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const lock = join(dir, 'l.json.lock');
    makeLock(lock, '999999999.t1', 0);
    expect(reclaimStaleLock(lock, '999999999.t1')).toBe(false);
    releaseLedgerLock(lock, 'someone-else');
    expect(readLockToken(lock)).toBe('999999999.t1');
    releaseLedgerLock(lock, '999999999.t1');
    expect(existsSync(lock)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordHeartbeat takes over a stale lock left by a dead process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostreg-'));
  try {
    const path = join(dir, 'l.json');
    makeLock(`${path}.lock`, '999999999.dead', 120_000);
    recordHeartbeat('host-a', A, NOW, { path, channel: 'dev' });
    expect(Object.keys(readHostLedger(path)!.hosts)).toEqual(['host-a']);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
