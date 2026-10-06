import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decideAcquire, fileLeaseStore, parseLease, serializeLease, sshLeaseStore, type SshRunner } from './lease.js';
import { hqLease } from './hq.js';
import { transferHq, type TransferDeps } from './transfer.js';

function drill() {
  const dir = mkdtempSync(join(tmpdir(), 'hq-transfer-'));
  let now = 100;
  const store = fileLeaseStore(join(dir, 'arbiter', 'lease.json'), () => now);
  store.cas(null, serializeLease({ holder: 'MacBookProM5', generation: 7, acquiredAt: now, renewedAt: now, ttlSeconds: 1500 }));
  const calls: string[] = [];
  const fenceOutputs: { host: string; stdout: string; stderr: string }[] = [];
  const helper = join(dir, 'fence.ts');
  writeFileSync(helper, `import { hqFenceRun } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'hq.ts')).href)};
import { fileLeaseStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'lease.ts')).href)};
import { join } from 'node:path';
const root = process.env.HQ_TEST_ROOT!;
const host = process.env.HQ_TEST_HOST!;
if (process.argv[2] !== 'hq' || process.argv[3] !== 'fence' || process.argv[4] !== '--role' || process.argv[5] !== 'cron' || process.argv[6] !== '--') process.exit(90);
process.exit(hqFenceRun('cron', process.argv.slice(7), {
  config: { arbiter: 'local' }, store: fileLeaseStore(join(root, 'arbiter', 'lease.json'), () => 100),
  hostPath: join(root, host + '.host'), localPath: join(root, host + '.local'),
  seenPath: join(root, host + '.seen'), now: () => 100, log: () => {},
}));
`);
  for (const [host, name] of [['mbp', 'MacBookProM5'], ['node-b', 'MacStudioB1']]) writeFileSync(join(dir, `${host}.host`), `${name}\n`);
  const shim = join(dir, 'elanous');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`);
  chmodSync(shim, 0o700);
  const run: SshRunner = (host, script) => {
    calls.push(`${host} ${script}`);
    const name = host === 'mbp' ? 'MacBookProM5' : 'MacStudioB1';
    const current = store.read();
    const record = parseLease(current.raw);
    if (script.includes('python3 -')) return { status: 0, stdout: `${name}\n`, stderr: '' };
    if (script.includes('fence-audit --json')) return { status: 0, stdout: `*/10 * * * * elanous hq heartbeat\n* * * * * elanous hq fence --role cron -- echo ok\n---HQ-AUDIT---\n[]\n`, stderr: '' };
    if (script.startsWith('elanous hq fence --role cron --')) {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, HQ_TEST_ROOT: dir, HQ_TEST_HOST: host, ELANOUS_HQ_GENERATION: 'outer-stale' },
      });
      const output = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      fenceOutputs.push({ host, stdout: output.stdout, stderr: output.stderr });
      return output;
    }
    if (script.includes('lease release')) {
      const match = script.match(/--expected-holder '([^']+)' --expected-generation (\d+)/);
      if (!match) return { status: 2, stdout: '', stderr: 'missing release expectation' };
      const released = hqLease('release', {
        config: { hostName: name }, store,
        hostPath: join(dir, `${host}.host`), localPath: join(dir, `${host}.local`), seenPath: join(dir, `${host}.seen`), log: () => {},
      }, { expectedHolder: match[1], expectedGeneration: Number(match[2]) });
      return released.ok
        ? { status: 0, stdout: JSON.stringify(released), stderr: '' }
        : { status: 2, stdout: '', stderr: released.reason };
    }
    if (script.includes('lease acquire')) {
      const decision = decideAcquire(record, name, now);
      if (!decision.ok || !store.cas(current.raw, serializeLease(decision.next))) return { status: 2, stdout: '', stderr: 'refused' };
      return { status: 0, stdout: JSON.stringify({ ok: true, record: decision.next }), stderr: '' };
    }
    throw new Error(`unexpected: ${script}`);
  };
  let confirmations = 0;
  let promotions = 0;
  const deps: TransferDeps = {
    store, run, journalDir: join(dir, 'journal'),
    confirm: () => { confirmations++; return true; },
    promote: (host) => { promotions++; return { ok: true, host, apply: true, lines: [{ step: '⑤ nexus health', status: 'done', measurement: 'health=200', command: 'nexus' }] }; },
  };
  return { dir, store, calls, fenceOutputs, deps, get confirmations() { return confirmations; }, get promotions() { return promotions; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('one promote and one handback move lease, increase generation and switch cron fence with durable step records', () => {
  const f = drill();
  try {
    const promote = transferHq('promote', true, f.deps);
    expect(promote.ok, JSON.stringify(promote.steps)).toBe(true);
    expect(parseLease(f.store.read().raw)).toMatchObject({ holder: 'MacStudioB1', generation: 8 });
    expect(f.fenceOutputs.slice(0, 4).map(({ host, stdout }) => [host, stdout.trim()])).toEqual([
      ['mbp', 'HQ_FENCE_ALLOWED:7'], ['node-b', ''], ['mbp', ''], ['node-b', 'HQ_FENCE_ALLOWED:8'],
    ]);
    expect(f.fenceOutputs.filter(({ stdout }) => !stdout).every(({ stderr }) => stderr.includes('hq fence: skip'))).toBe(true);
    expect(promote.steps.find(s => s.step === '⑨ final fence')).toMatchObject({ status: 'done', measurement: 'source=skipped target=allowed generation=8' });
    expect(promote.steps.some(s => s.step === '⑧ promotion ⑤ nexus health' && s.status === 'done')).toBe(true);
    const rows = readFileSync(promote.journal!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.step)).toEqual(promote.steps.map(step => step.step));
    expect(rows.at(-1)).toMatchObject({ step: '⑨ final fence', status: 'done', direction: 'promote' });
    const handback = transferHq('handback', true, f.deps);
    expect(handback.ok, JSON.stringify(handback.steps)).toBe(true);
    expect(parseLease(f.store.read().raw)).toMatchObject({ holder: 'MacBookProM5', generation: 9 });
    expect(f.fenceOutputs.slice(4).map(({ host, stdout }) => [host, stdout.trim()])).toEqual([
      ['node-b', 'HQ_FENCE_ALLOWED:8'], ['mbp', ''], ['node-b', ''], ['mbp', 'HQ_FENCE_ALLOWED:9'],
    ]);
    expect(handback.steps.at(-1)).toMatchObject({ step: '⑨ final fence', measurement: 'source=skipped target=allowed generation=9' });
    expect(readFileSync(handback.journal!, 'utf8')).toContain('"direction":"handback"');
    expect(f.promotions).toBe(1);
    expect(f.confirmations).toBe(2);
  } finally { f.cleanup(); }
});

test('release CAS refuses a new generation acquired by the same host after the transfer precheck', () => {
  const f = drill();
  try {
    const run = f.deps.run;
    let raced = false;
    const result = transferHq('promote', true, { ...f.deps, run: (host, script, input) => {
      if (script.includes('lease release') && !raced) {
        raced = true;
        const local = { config: { hostName: 'MacBookProM5' }, store: f.store,
          hostPath: join(f.dir, 'mbp.host'), localPath: join(f.dir, 'mbp.local'), seenPath: join(f.dir, 'mbp.seen'), log: () => {} };
        expect(hqLease('release', local).ok).toBe(true);
        expect(hqLease('acquire', local).ok).toBe(true);
      }
      return run(host, script, input);
    } });
    expect(raced).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.steps.some(s => s.step === '⑥ release old lease' && s.status === 'failed')).toBe(true);
    expect(parseLease(f.store.read().raw)).toMatchObject({ holder: 'MacBookProM5', generation: 8, renewedAt: 100 });
    expect(f.calls.some(c => c.includes('lease acquire'))).toBe(false);
    expect(f.promotions).toBe(0);
    expect(readFileSync(result.journal!, 'utf8')).toContain('release old lease');
  } finally { f.cleanup(); }
});

test('release CAS retry refuses a newer lease written between remote read and write', () => {
  const f = drill();
  try {
    const cas = f.store.cas.bind(f.store);
    let raced = false;
    f.store.cas = (expected, next) => {
      if (!raced && parseLease(next)?.renewedAt === 0) {
        raced = true;
        const old = parseLease(f.store.read().raw)!;
        expect(cas(expected, serializeLease({ ...old, generation: old.generation + 1 }))).toBe(true);
      }
      return cas(expected, next);
    };
    const result = transferHq('promote', true, f.deps);
    expect(raced).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.steps.some(s => s.step === '⑥ release old lease' && s.status === 'failed')).toBe(true);
    expect(parseLease(f.store.read().raw)).toMatchObject({ holder: 'MacBookProM5', generation: 8, renewedAt: 100 });
    expect(f.calls.some(c => c.includes('lease acquire'))).toBe(false);
  } finally { f.cleanup(); }
});

test('release expectation survives the real remote arbiter CAS script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-remote-release-'));
  try {
    mkdirSync(join(dir, '.elanous-hq'));
    const remote: SshRunner = (_host, script, input) => {
      const r = spawnSync('bash', ['-c', script], { input: input ?? '', encoding: 'utf8', env: { ...process.env, HOME: dir } });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const store = sshLeaseStore('arbiter', remote);
    const old = serializeLease({ holder: 'MacBookProM5', generation: 7, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 });
    expect(store.cas(null, old)).toBe(true);
    const deps = { config: { hostName: 'MacBookProM5' }, store, hostPath: join(dir, 'host'),
      localPath: join(dir, 'local.json'), seenPath: join(dir, 'seen'), log: () => {} };
    const next = serializeLease({ holder: 'MacBookProM5', generation: 8, acquiredAt: 200, renewedAt: 200, ttlSeconds: 1500 });
    expect(store.cas(old, next)).toBe(true);
    const refused = hqLease('release', deps, { expectedHolder: 'MacBookProM5', expectedGeneration: 7 });
    expect(refused).toMatchObject({ ok: false, action: 'release' });
    expect(store.read().raw).toBe(next);
    const released = hqLease('release', deps, { expectedHolder: 'MacBookProM5', expectedGeneration: 8 });
    expect(released).toMatchObject({ ok: true, record: { holder: 'MacBookProM5', generation: 8, renewedAt: 0 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dry-run and denied confirmation do not release a lease or start promotion', () => {
  const f = drill();
  try {
    const preview = transferHq('promote', false, f.deps);
    expect(preview.ok).toBe(true);
    expect(preview.journal).toBeNull();
    expect(preview.steps.at(-1)?.status).toBe('ready');
    expect(f.confirmations).toBe(0);
    const denied = transferHq('promote', true, { ...f.deps, confirm: () => false });
    expect(denied.ok).toBe(false);
    expect(denied.steps.at(-1)).toMatchObject({ step: '⑤ human confirmation', status: 'failed' });
    expect(parseLease(f.store.read().raw)).toMatchObject({ holder: 'MacBookProM5', generation: 7 });
    expect(f.calls.some(c => /lease (release|acquire)/.test(c))).toBe(false);
    expect(f.promotions).toBe(0);
  } finally { f.cleanup(); }
});

test('unfenced cron and lease race fail closed before release; failed acquisition keeps old host fenced', () => {
  const f = drill();
  try {
    const unfenced = transferHq('promote', true, { ...f.deps, run: (host, script, input) => script.includes('fence-audit')
      ? { status: 0, stdout: `* * * * * elanous hq heartbeat\n---HQ-AUDIT---\n[{"raw":"unfenced"}]\n`, stderr: '' }
      : f.deps.run(host, script, input) });
    expect(unfenced.steps.at(-1)).toMatchObject({ step: '③ cron fence mbp', status: 'failed' });
    const changed = transferHq('promote', true, { ...f.deps, confirm: () => {
      const current = f.store.read();
      f.store.cas(current.raw, serializeLease({ ...parseLease(current.raw)!, generation: 8 }));
      return true;
    } });
    expect(changed.steps.at(-1)).toMatchObject({ step: '⑥ release old lease', status: 'failed' });
    expect(f.calls.some(c => c.includes('lease release'))).toBe(false);
  } finally { f.cleanup(); }
  const g = drill();
  try {
    const failed = transferHq('promote', true, { ...g.deps, run: (host, script, input) => script.includes('lease acquire')
      ? { status: 2, stdout: '', stderr: 'refused' } : g.deps.run(host, script, input) });
    expect(failed.ok).toBe(false);
    expect(failed.steps.at(-1)).toMatchObject({ step: 'halt', status: 'failed' });
    expect(failed.steps.some(s => s.step === '⑨ final fence')).toBe(false);
    expect(g.promotions).toBe(0);
    expect(readFileSync(failed.journal!, 'utf8')).toContain('refused');
  } finally { g.cleanup(); }
});
