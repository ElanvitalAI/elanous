import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from './ledger.js';
import { acquireLockSync } from '../storage/file-lock.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('ledger retains expired records and persists owner-restricted changes in a 0600 file', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-ledger-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const row = { id: 'm1', kind: 'machine' as const, machine: 'host', name: 'host', owner: 'untrusted', attrs: {}, observedAt: 100, ttlMs: 50 };
  expect(ledger.register(row, 'member-a').owner).toBe('member-a');
  expect(ledger.list({}, 149)[0]).toMatchObject({ ageMs: 49, expired: false });
  expect(ledger.list({}, 150)[0]).toMatchObject({ ageMs: 50, expired: true });
  expect(ledger.list({}, 151)[0]).toMatchObject({ id: 'm1', ageMs: 51, expired: true });
  expect(new ResourceLedger(root).list({}, 151)).toHaveLength(1);
  expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
  expect(() => ledger.register(row, 'member-b')).toThrow('not-owner');
  expect(() => ledger.heartbeat('m1', 'member-b', {}, 200)).toThrow('not-owner');
  expect(() => ledger.delete('m1', 'member-b')).toThrow('not-owner');
  expect(ledger.list({}, 151)).toHaveLength(1);
  expect(ledger.heartbeat('m1', 'member-a', { load: 2 }, 200).attrs).toEqual({ load: 2 });
  expect(ledger.list({}, 201)[0]).toMatchObject({ ageMs: 1, expired: false });
  expect(readFileSync(ledger.path, 'utf8')).toContain('member-a');
  ledger.delete('m1', 'member-a');
  expect(ledger.list()).toEqual([]);
});

test('a zero-TTL record expires at registration time without being deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-ledger-zero-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  ledger.register({ id: 'zero', kind: 'machine', machine: 'host', name: 'host', owner: 'untrusted', attrs: {}, observedAt: 100, ttlMs: 0 }, 'member-a');
  expect(ledger.list({}, 100)[0]).toMatchObject({ ageMs: 0, expired: true });
  expect(ledger.list({}, 100)).toHaveLength(1);
});

test('warm worker lease is fenced across release, sanitize, and a later attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-lease-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  ledger.registerPodWorker({ workerId: 'worker-1', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 1000 }, 100);
  const first = ledger.acquirePodWorker({ machine: 'node-c', key, owner: 'gate', runId: 'r1', attemptId: 'a1', ttlMs: 100 }, 101);
  const generation = first.attrs.generation as number;
  const leaseId = first.attrs.leaseId as string;
  expect(generation).toBe(1);
  expect(() => ledger.register({ ...first, attrs: { ...first.attrs, state: 'idle' } }, 'host')).toThrow('pod-worker-requires-allocator');
  expect(() => ledger.heartbeat(first.id, 'host', { state: 'idle' }, 102)).toThrow('pod-worker-requires-allocator');
  expect(() => ledger.delete(first.id, 'host')).toThrow('pod-worker-requires-allocator');
  expect(ledger.list({ kind: 'pod-worker-lease' })[0]?.attrs.state).toBe('leased');
  expect(() => ledger.acquirePodWorker({ key, owner: 'other', runId: 'r2', attemptId: 'a2', ttlMs: 100 }, 102)).toThrow('no-warm-worker');
  expect(() => ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId: 'stale', generation, action: 'release' }, 103)).toThrow('stale-worker-lease');
  expect(ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId, generation, action: 'release' }, 103).attrs.state).toBe('sanitizing');
  expect(() => ledger.acquirePodWorker({ key, owner: 'other', runId: 'r2', attemptId: 'a2', ttlMs: 100 }, 104)).toThrow('no-warm-worker');
  expect(() => ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId, generation, action: 'sanitize' }, 105)).toThrow('not-owner');
  const clean = ledger.transitionPodWorker(first.id, { owner: 'host', leaseId, generation, action: 'sanitize' }, 105);
  expect(clean.attrs.state).toBe('idle');
  expect(clean.ttlMs).toBe(1000);
  const second = ledger.acquirePodWorker({ key, owner: 'other', runId: 'r2', attemptId: 'a2', ttlMs: 100 }, 106);
  expect(second.attrs.generation).toBe(2);
  expect(() => ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId, generation, action: 'renew' }, 107)).toThrow('stale-worker-lease');
  expect(() => ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId, generation,
    action: 'quarantine', reason: 'too-late' }, 107)).toThrow('stale-worker-lease');
  expect(() => ledger.registerPodWorker({ workerId: 'worker-1', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 1000 }, 107)).toThrow('worker-id-used');
});

test('expired worker lease is not reused without fresh host registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-expiry-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-b', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'amd64' };
  ledger.registerPodWorker({ workerId: 'worker-2', machine: 'node-b', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 100 }, 100);
  const first = ledger.acquirePodWorker({ key, owner: 'gate', runId: 'r1', attemptId: 'a1', ttlMs: 10 }, 101);
  expect(() => ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId: first.attrs.leaseId as string,
    generation: first.attrs.generation as number, action: 'renew' }, 111)).toThrow('lease-expired');
  expect(() => ledger.acquirePodWorker({ key, owner: 'next', runId: 'r2', attemptId: 'a2', ttlMs: 10 }, 111)).toThrow('no-warm-worker');
  expect(() => ledger.registerPodWorker({ workerId: 'worker-2', machine: 'node-b', podUid: 'pod-uid-1', key, owner: 'other', ttlMs: 100 }, 112)).toThrow('worker-id-used');
  expect(() => ledger.registerPodWorker({ workerId: 'worker-2', machine: 'node-b', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 100 }, 112)).toThrow('worker-id-used');
  expect(ledger.registerPodWorker({ workerId: 'new-pod-uid', machine: 'node-b', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 100 }, 112).attrs.generation).toBe(0);
});

test('a mismatched shadow reply can quarantine its leased worker without making the Job result non-authoritative', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-quarantine-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  ledger.registerPodWorker({ workerId: 'worker-3', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 1000 }, 100);
  const lease = ledger.acquirePodWorker({ key, owner: 'gate', runId: 'run', attemptId: 'attempt', ttlMs: 100 }, 101);
  const quarantined = ledger.transitionPodWorker(lease.id, { owner: 'gate', leaseId: lease.attrs.leaseId as string,
    generation: lease.attrs.generation as number, action: 'quarantine', reason: 'shadow-result-mismatch' }, 102);
  expect(quarantined.attrs).toMatchObject({ state: 'quarantined', reason: 'shadow-result-mismatch' });
  expect(() => ledger.acquirePodWorker({ key, owner: 'next', runId: 'next', attemptId: 'next', ttlMs: 100 }, 103)).toThrow('no-warm-worker');
  expect(() => ledger.registerPodWorker({ workerId: 'worker-3', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 1000 }, 2000)).toThrow('worker-id-used');
});

test('late gate fallback can quarantine the just-sanitized generation before another lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-late-fence-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  ledger.registerPodWorker({ workerId: 'worker-late', machine: 'node-c', podUid: 'pod-late', key, owner: 'host', ttlMs: 1000 }, 100);
  const lease = ledger.acquirePodWorker({ key, owner: 'gate', runId: 'r1', attemptId: 'a1', ttlMs: 100 }, 101);
  const leaseId = lease.attrs.leaseId as string;
  const generation = lease.attrs.generation as number;
  ledger.transitionPodWorker(lease.id, { owner: 'gate', leaseId, generation, action: 'release' }, 102);
  ledger.transitionPodWorker(lease.id, { owner: 'host', leaseId, generation, action: 'sanitize' }, 103);
  const fenced = ledger.transitionPodWorker(lease.id, { owner: 'gate', leaseId, generation,
    action: 'quarantine', reason: 'adoption-timeout' }, 104);
  expect(fenced.attrs).toMatchObject({ state: 'quarantined', generation, reason: 'adoption-timeout' });
  expect(() => ledger.acquirePodWorker({ key, owner: 'other', runId: 'r2', attemptId: 'a2', ttlMs: 100 }, 105))
    .toThrow('no-warm-worker');
});

test('a timeout fence blocks only its worker, quarantines late replies, and retains ambiguous leases', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-timeout-fence-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  const firstId = 'worker-timeout';
  const secondId = 'worker-sibling';
  ledger.registerPodWorker({ workerId: firstId, machine: 'node-c', podUid: 'pod-timeout', key, owner: 'host', ttlMs: 10_000 }, 100);
  ledger.registerPodWorker({ workerId: secondId, machine: 'node-b', podUid: 'pod-sibling', key, owner: 'host', ttlMs: 10_000 }, 100);
  const first = ledger.acquirePodWorker({ key, owner: 'gate', runId: 'late-run', attemptId: 'late-attempt', ttlMs: 30_000 }, 101);
  const leaseId = first.attrs.leaseId as string;
  const generation = first.attrs.generation as number;
  const fenced = ledger.fenceTimedOutPodWorker(`pod-worker-lease:${firstId}`,
    { owner: 'gate', runId: 'late-run', attemptId: 'late-attempt', fenceMs: 150 }, 102);
  expect(fenced.attrs).toMatchObject({ state: 'timeout-fenced', leaseId, generation, timeoutFenceUntil: 252 });
  expect(() => ledger.acquirePodWorker({ machine: 'node-c', key, owner: 'next', runId: 'next-run', attemptId: 'next-attempt', ttlMs: 100 }, 103))
    .toThrow('no-warm-worker');
  const sibling = ledger.acquirePodWorker({ key, owner: 'next', runId: 'next-run', attemptId: 'next-attempt', ttlMs: 100 }, 104);
  expect(sibling.name).toBe(secondId);
  const quarantined = ledger.transitionPodWorker(first.id, { owner: 'gate', leaseId, generation, action: 'quarantine', reason: 'late-response' }, 105);
  expect(quarantined.attrs).toMatchObject({ state: 'quarantined', generation, reason: 'late-response' });

  const unansweredRoot = mkdtempSync(join(tmpdir(), 'elanous-worker-timeout-expiry-'));
  roots.push(unansweredRoot);
  const unanswered = new ResourceLedger(unansweredRoot);
  unanswered.registerPodWorker({ workerId: firstId, machine: 'node-c', podUid: 'pod-idle', key, owner: 'host', ttlMs: 10_000 }, 100);
  unanswered.fenceTimedOutPodWorker(`pod-worker-lease:${firstId}`,
    { owner: 'gate', runId: 'no-response-run', attemptId: 'no-response-attempt', fenceMs: 150 }, 102);
  const returned = unanswered.acquirePodWorker({ key, owner: 'next', runId: 'next-run', attemptId: 'next-attempt', ttlMs: 100 }, 252);
  expect(returned.name).toBe(firstId);
  expect(returned.attrs).toMatchObject({ state: 'leased', generation: 1 });

  const lostReplyRoot = mkdtempSync(join(tmpdir(), 'elanous-worker-timeout-lost-reply-'));
  roots.push(lostReplyRoot);
  const lostReply = new ResourceLedger(lostReplyRoot);
  lostReply.registerPodWorker({ workerId: firstId, machine: 'node-c', podUid: 'pod-ambiguous', key, owner: 'host', ttlMs: 10_000 }, 100);
  const ambiguous = lostReply.acquirePodWorker({ key, owner: 'gate', runId: 'ambiguous-run', attemptId: 'ambiguous-attempt', ttlMs: 30_000 }, 101);
  lostReply.fenceTimedOutPodWorker(`pod-worker-lease:${firstId}`,
    { owner: 'gate', runId: 'ambiguous-run', attemptId: 'ambiguous-attempt', fenceMs: 150 }, 102);
  expect(() => lostReply.acquirePodWorker({ key, owner: 'next', runId: 'next-run', attemptId: 'next-attempt', ttlMs: 100 }, 252))
    .toThrow('no-warm-worker');
  expect(lostReply.list({ name: firstId })[0]?.attrs).toMatchObject({
    state: 'timeout-fenced', leaseId: ambiguous.attrs.leaseId, generation: ambiguous.attrs.generation,
  });
});

test('a legacy idle row with a whitespace Pod UID cannot be leased', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-blank-uid-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  ledger.registerPodWorker({ workerId: 'blank-uid', machine: 'node-c', podUid: 'first-uid', key, owner: 'host', ttlMs: 30_000 });
  const rows = JSON.parse(readFileSync(ledger.path, 'utf8')) as Array<{ attrs: Record<string, unknown> }>;
  rows[0]!.attrs.podUid = '   ';
  writeFileSync(ledger.path, JSON.stringify(rows));
  expect(() => ledger.acquirePodWorker({ machine: 'node-c', key, owner: 'gate', runId: 'run', attemptId: 'attempt', ttlMs: 1000 }))
    .toThrow('no-warm-worker');
});

test('separate processes cannot claim the same idle worker while the ledger lock is contested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-processes-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  ledger.registerPodWorker({ workerId: 'worker-4', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 30_000 });
  const script = join(root, 'claim.ts');
  writeFileSync(script, `import { ResourceLedger } from ${JSON.stringify(new URL('./ledger.ts', import.meta.url).pathname)};
const store = new ResourceLedger(process.argv[2]);
try { const row = store.acquirePodWorker({ key: ${JSON.stringify(key)}, owner: process.argv[3], runId: process.argv[3], attemptId: 'attempt', ttlMs: 1000 });
  console.log(JSON.stringify({ ok: true, leaseId: row.attrs.leaseId })); }
catch (error) { console.log(JSON.stringify({ ok: false, reason: error.message })); }`);
  const release = acquireLockSync(`${ledger.path}.lock`);
  const children = ['gate-a', 'gate-b'].map(owner => Bun.spawn(['bun', script, root, owner], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    await Bun.sleep(100);
    expect(children.every(child => child.exitCode === null)).toBe(true);
  } finally { release(); }
  const results = await Promise.all(children.map(async child => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe('');
    return JSON.parse(stdout) as { ok: boolean; leaseId?: string; reason?: string };
  }));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => result.reason === 'no-warm-worker')).toHaveLength(1);
});

test('a lock wait beyond TTL cannot acquire or renew using the pre-lock clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-worker-lock-clock-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock-a', architecture: 'arm64' };
  const script = join(root, 'locked-operation.ts');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { ResourceLedger } from ${JSON.stringify(new URL('./ledger.ts', import.meta.url).pathname)};
const store = new ResourceLedger(process.argv[2]);
writeFileSync(process.argv[2] + '/ready-' + process.argv[3], 'attempting');
try {
  if (process.argv[3] === 'acquire') store.acquirePodWorker({ key: ${JSON.stringify(key)}, owner: 'gate', runId: 'run', attemptId: 'attempt', ttlMs: 500 });
  else store.transitionPodWorker(process.argv[4], { owner: 'gate', leaseId: process.argv[5], generation: Number(process.argv[6]), action: 'renew', ttlMs: 500 });
  console.log('unexpected-success');
} catch (error) { console.log(error.message); }`);
  const afterWait = async (args: string[]): Promise<string> => {
    const release = acquireLockSync(`${ledger.path}.lock`);
    const child = Bun.spawn(['bun', script, root, ...args], { stdout: 'pipe', stderr: 'pipe' });
    try {
      for (let i = 0; i < 100 && !existsSync(join(root, `ready-${args[0]}`)); i++) await Bun.sleep(10);
      expect(existsSync(join(root, `ready-${args[0]}`))).toBe(true);
      await Bun.sleep(700);
      expect(child.exitCode).toBeNull();
    } finally { release(); }
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe('');
    return stdout.trim();
  };
  ledger.registerPodWorker({ workerId: 'worker-acquire', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 500 });
  expect(await afterWait(['acquire'])).toBe('no-warm-worker');
  ledger.registerPodWorker({ workerId: 'worker-renew', machine: 'node-c', podUid: 'pod-uid-1', key, owner: 'host', ttlMs: 500 });
  const lease = ledger.acquirePodWorker({ key, owner: 'gate', runId: 'run', attemptId: 'attempt', ttlMs: 500 });
  expect(await afterWait(['renew', lease.id, String(lease.attrs.leaseId), String(lease.attrs.generation)])).toBe('lease-expired');
});
