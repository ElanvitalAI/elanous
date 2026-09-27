import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readMachineProfile, writeMachineProfile } from '../roles/machine-profile.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { _setSystemGcloudPathsForTesting, gcloud, gcloudSearchPaths, registerRoleCommands, resolveRoleBucket, type RoleCliDeps, type RoleObjectRead } from './role-cli.js';
import { registerMachineCommands } from './machine-cli.js';
import type { RoleLeaseDoc } from '../roles/role-lease.js';
import { setUserConfigOverlay } from '../user-config.js';

function memory() {
  let doc: RoleLeaseDoc | undefined;
  let gen = 0;
  const read = (): RoleObjectRead => doc ? { kind: 'present', text: JSON.stringify(doc), gen: String(gen) } : { kind: 'absent' };
  const write: NonNullable<RoleCliDeps['write']> = (next, ifGen) => {
    if (ifGen !== String(gen)) return { kind: 'lost', detail: '412 PreconditionFailed' };
    doc = next;
    gen++;
    return { kind: 'won' };
  };
  return { read, write, get doc() { return doc; }, get gen() { return gen; } };
}

async function invoke(machine: string, command: string[], store: ReturnType<typeof memory>, overrides: RoleCliDeps = {}, noBucket = false, noRank = false) {
  const output: string[] = [], errors: string[] = [], codes: number[] = [];
  const program = new Command();
  registerRoleCommands(program, {
    me: machine, read: store.read, write: store.write,
    out: { log: (s) => output.push(s), error: (s) => errors.push(s) },
    setExitCode: (code) => codes.push(code), ...overrides,
  });
  await program.parseAsync(['node', 'elanous', 'role', ...command,
    ...(command[0] === 'watch' && !noRank ? ['--rank', machine === 'mbp' ? '1' : '2'] : []),
    ...(!noBucket && ['status', 'watch', 'claim', 'accept', 'handoff'].includes(command[0]!) ? ['--bucket', 'gs://test-roles'] : []),
  ]);
  return { code: codes.at(-1) ?? 0, output, errors };
}

test('gcloud search skips an earlier non-executable file in PATH', () => {
  _setSystemGcloudPathsForTesting([]); // 진짜 gcloud 가 /opt/homebrew 에 있는 맥에서도 가짜를 쓰게
  const dir = mkdtempSync(join(tmpdir(), 'elanous-gcloud-search-'));
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  try {
    const front = join(dir, 'front'), back = join(dir, 'back');
    mkdirSync(front);
    mkdirSync(back);
    const blocked = join(front, 'gcloud');
    const runnable = join(back, 'gcloud');
    writeFileSync(blocked, '#!/bin/sh\nexit 1\n');
    writeFileSync(runnable, '#!/bin/sh\nexit 0\n');
    chmodSync(blocked, 0o644);
    chmodSync(runnable, 0o755);
    process.env.HOME = dir;
    process.env.PATH = `${front}:${back}`;
    expect(gcloudSearchPaths().slice(-2)).toEqual([blocked, runnable]);
    expect(gcloud()).toBe(runnable);
    process.env.PATH = `${front}:${dir}:${back}`;
    expect(gcloud()).toBe(runnable);
    process.env.PATH = front;
    expect(gcloud()).toBeNull();
  } finally {
    _setSystemGcloudPathsForTesting(null);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bucket precedence and missing configuration fail closed with exit 2', async () => {
  const previous = process.env.ELANOUS_BACKUP_BUCKET;
  delete process.env.ELANOUS_BACKUP_BUCKET;
  setUserConfigOverlay(cfg => ({ ...cfg, raw: { ...cfg.raw, roles: {} } }));
  try {
    const missing = await invoke('node', ['status', '--json'], memory(), {
      read: () => { throw new Error('missing bucket must not read'); },
    }, true);
    expect(missing.code).toBe(2);
    expect(missing.output[0]).toContain('roles.bucket');
    expect(missing.output[0]).not.toContain('pearlplaygroud');
    const claim = await invoke('node', ['claim'], memory(), {}, true);
    expect(claim.code).toBe(2);
    expect(claim.errors[0]).toContain('roles.bucket');
    expect(() => resolveRoleBucket()).toThrow('roles.bucket 을 설정하라');
    process.env.ELANOUS_BACKUP_BUCKET = 'gs://env-bucket';
    expect(resolveRoleBucket()).toBe('gs://env-bucket');
    expect(resolveRoleBucket('gs://option-bucket')).toBe('gs://option-bucket');
    delete process.env.ELANOUS_BACKUP_BUCKET;
    setUserConfigOverlay(cfg => ({ ...cfg, raw: { ...cfg.raw, roles: { bucket: 'gs://configured-bucket' } } }));
    expect(resolveRoleBucket()).toBe('gs://configured-bucket');
  } finally {
    setUserConfigOverlay(null);
    if (previous === undefined) delete process.env.ELANOUS_BACKUP_BUCKET;
    else process.env.ELANOUS_BACKUP_BUCKET = previous;
  }
});

describe('role CLI two-machine CAS handoff', () => {
  test('mbp claim → handoff → node-b accept, success only after mbp reads held', async () => {
    const store = memory();
    expect((await invoke('mbp', ['claim'], store)).code).toBe(0);
    const claimGen = store.doc!.generation;
    let reads = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b'], store, {
      read: () => { reads++; return store.read(); },
      sleep: async () => {
        const accepted = await invoke('node-b', ['accept'], store);
        expect(accepted.code).toBe(0);
        expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held' });
      },
    });
    expect(result.code).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 3 · accepted']);
    expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held', generation: claimGen + 2 });
  });

  test('no acceptance within 1 second returns nonzero and reverts to mbp held', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    let time = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b', '--timeout', '1'], store, {
      now: () => time,
      sleep: async () => { time += 1_000; },
    });
    expect(result.code).toBe(1);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 3 · timeout-reverted']);
    expect(store.doc).toMatchObject({ holder: 'mbp', state: 'held', generation: 3 });
  });

  test('handoff timeout begins after the pending CAS, not while the CAS is still in flight', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    let time = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b', '--timeout', '1'], store, {
      now: () => time,
      write: (doc, ifGen, bucket) => {
        if (doc.state === 'handing-off') time += 1_000;
        return store.write(doc, ifGen, bucket);
      },
      sleep: async () => { expect((await invoke('node-b', ['accept'], store)).code).toBe(0); },
    });
    expect(result.code).toBe(0);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 3 · accepted']);
    expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held', generation: 3 });
  });

  test('timeout after unreadable polling still CAS-reverts the last confirmed pending lease', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    let time = 0, reads = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b', '--timeout', '1'], store, {
      now: () => time,
      read: () => {
        reads++;
        return reads > 2 ? { kind: 'unmeasured', why: 'temporary read failure' } : store.read();
      },
      sleep: async () => { time += 1_000; },
    });
    expect(result.code).toBe(1);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 3 · timeout-reverted']);
    expect(store.doc).toMatchObject({ holder: 'mbp', state: 'held' });
  });

  test('acceptance observed only after the deadline is nonzero and never reported as completed', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    let time = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b', '--timeout', '1'], store, {
      now: () => time,
      sleep: async () => {
        time += 1_000;
        expect((await invoke('node-b', ['accept'], store)).code).toBe(0);
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 3 · revert-failed']);
    expect(store.doc).toMatchObject({ holder: 'node-b', generation: 3, state: 'held' });
  });

  test('node-b cannot hand off a lease held by mbp; document unchanged', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    const before = store.doc;
    const result = await invoke('node-b', ['handoff', '--to', 'mbp'], store);
    expect(result.code).not.toBe(0);
    expect(store.doc).toEqual(before);
    expect(store.gen).toBe(1);
  });

  test('CAS conflict on revert fails closed without overwriting an intervening write', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    let time = 0;
    const result = await invoke('mbp', ['handoff', '--to', 'node-b', '--timeout', '1'], store, {
      now: () => time,
      sleep: async () => { time += 1_000; },
      write: (doc, ifGen, bucket) => doc.state === 'held' && doc.holder === 'mbp' && doc.generation > 1
        ? { kind: 'lost', detail: '412 PreconditionFailed' } : store.write(doc, ifGen, bucket),
    });
    expect(result.code).toBe(1);
    expect(result.output).toEqual(['handoff: mbp → node-b · gen 2 · revert-failed']);
    expect(store.doc).toMatchObject({ holder: 'node-b', state: 'handing-off' });
  });

  test('watch uses profile control rank unless --rank overrides; no seat cannot claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-watch-profile-'));
    try {
      const store = memory();
      const deps = { root };
      expect((await invoke('node', ['watch', '--once'], store, deps, false, true)).output[0]).toContain('watch: observe');
      expect(store.doc).toBeUndefined();
      writeMachineProfile({ id: 'node', duties: ['compute'], seats: { control: { rank: 1 } } }, root);
      expect((await invoke('node', ['watch', '--once'], store, deps, false, true)).output[0]).toContain('watch: claim');
      expect(store.doc?.holder).toBe('node');
      const separate = memory();
      expect((await invoke('node', ['watch', '--once', '--rank', '1'], separate, { root }, false, true)).output[0]).toContain('watch: claim');
      const invalid = await invoke('node', ['watch', '--once', '--rank', '100'], memory(), { root }, false, true);
      expect(invalid.code).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('running watch reloads profile rank each tick after machine set --clear-seats; explicit --rank still overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-watch-rank-change-'));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const machine = new Command();
      registerMachineCommands(machine, root);
      const set = async (args: string[]) => machine.parseAsync(['node', 'elanous', 'machine', 'set', ...args]);
      await set(['--id', 'node', '--seat', 'control:2']);
      for (const scenario of ['absent', 'stalled'] as const) {
        const store = memory();
        if (scenario === 'stalled') store.write({ holder: 'other', state: 'held', generation: 1, renewedAt: 0 }, '0', 'bucket');
        const output: string[] = [], errors: string[] = [], codes: number[] = [];
        let sleeps = 0, writes = 0;
        const program = new Command();
        registerRoleCommands(program, { me: 'node', root, read: store.read,
          write: (doc, gen, bucket) => { writes++; return store.write(doc, gen, bucket); },
          sleep: async () => {
            sleeps++;
            if (sleeps === 2) await set(['--clear-seats']);
            if (sleeps === 10) throw new Error('stop watch');
          },
          out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
          setExitCode: (code) => codes.push(code),
        });
        await program.parseAsync(['node', 'elanous', 'role', 'watch', '--takeover-ticks', '3', '--bucket', 'gs://test-roles']);
        expect(codes).toEqual([1]);
        expect(errors).toEqual(['role: stop watch']);
        expect(output).toHaveLength(10);
        expect(output.every(line => line.startsWith('watch: observe'))).toBe(true);
        expect(writes).toBe(0);
        expect(store.doc?.holder).toBe(scenario === 'absent' ? undefined : 'other');
        await set(['--seat', 'control:2']);
      }
      await set(['--clear-seats']);
      const explicit = await invoke('node', ['watch', '--once', '--rank', '1'], memory(), { root }, false, true);
      expect(explicit.output[0]).toContain('watch: claim');
    } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
  });

  test('running watch stops before claim when machine set changes id and rank together', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-watch-id-change-'));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const machine = new Command();
      registerMachineCommands(machine, root);
      const set = async (args: string[]) => machine.parseAsync(['node', 'elanous', 'machine', 'set', ...args]);
      for (const explicit of [false, true]) {
        await set(['--id', 'node-a', '--seat', 'control:2']);
        const store = memory();
        const output: string[] = [], errors: string[] = [], codes: number[] = [];
        let writes = 0, reads = 0, sleeps = 0;
        const program = new Command();
        registerRoleCommands(program, { root,
          read: () => { reads++; return store.read(); },
          write: (doc, gen, bucket) => { writes++; return store.write(doc, gen, bucket); },
          sleep: async () => {
            if (++sleeps === 1) await set(['--id', 'node-b', '--seat', 'control:1']);
            if (sleeps > 3) throw new Error('watch did not stop after id change');
          },
          out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
          setExitCode: (code) => codes.push(code),
        });
        await program.parseAsync(['node', 'elanous', 'role', 'watch', '--takeover-ticks', '3', '--bucket', 'gs://test-roles',
          ...(explicit ? ['--rank', '1'] : [])]);
        expect(codes).toEqual([1]);
        expect(errors).toEqual(['role: machine id changed during watch: node-a → node-b']);
        expect(reads).toBe(1);
        expect(writes).toBe(explicit ? 1 : 0);
        expect(store.doc?.holder).toBe(explicit ? 'node-a' : undefined);
        expect(output).toHaveLength(1);
      }
    } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
  });

  test('watch does not write when machine set changes id during lease read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-watch-read-id-change-'));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const machine = new Command();
      registerMachineCommands(machine, root);
      await machine.parseAsync(['node', 'elanous', 'machine', 'set', '--id', 'node-a', '--seat', 'control:1']);
      let writes = 0;
      const errors: string[] = [], codes: number[] = [];
      const program = new Command();
      registerRoleCommands(program, { root,
        read: async () => {
          await machine.parseAsync(['node', 'elanous', 'machine', 'set', '--id', 'node-b', '--seat', 'control:1']);
          return { kind: 'absent' };
        },
        write: () => { writes++; return { kind: 'won' }; },
        out: { log: () => {}, error: (line) => errors.push(line) },
        setExitCode: (code) => codes.push(code),
      });
      await program.parseAsync(['node', 'elanous', 'role', 'watch', '--once', '--bucket', 'gs://test-roles']);
      expect(codes).toEqual([1]);
      expect(errors).toEqual(['role: machine id changed during watch: node-a → node-b']);
      expect(writes).toBe(0);
    } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
  });

  test('joined role watch rejects a conflicting profile id before reading or writing a lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-watch-joined-'));
    try {
      mkdirSync(join(root, 'control'));
      writeFileSync(join(root, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'node-b', token: 'a'.repeat(64) }), { mode: 0o600 });
      writeFileSync(join(root, 'control', 'machine.json'), JSON.stringify({ id: 'demo', duties: ['compute'], seats: { control: { rank: 1 } } }));
      const output: string[] = [], errors: string[] = [], codes: number[] = [];
      let reads = 0;
      const program = new Command();
      registerRoleCommands(program, { root, read: () => { reads++; return { kind: 'absent' }; },
        out: { log: (line) => output.push(line), error: (line) => errors.push(line) }, setExitCode: (code) => codes.push(code) });
      await program.parseAsync(['node', 'elanous', 'role', 'watch', '--once', '--bucket', 'gs://test-roles']);
      expect(codes).toEqual([1]);
      expect(errors).toEqual(['role: machine id demo differs from joined machine node-b']);
      expect(output).toEqual([]);
      expect(reads).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('role set-machine changes only id and preserves profile duties and seats', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-set-machine-'));
    try {
      writeMachineProfile({ id: 'node-a', duties: ['edge'], seats: { control: { rank: 3 } } }, root);
      expect((await invoke('node-a', ['set-machine', 'node-b'], memory(), { root })).code).toBe(0);
      expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: ['edge'], seats: { control: { rank: 3 } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('watch --once claims, renews, accepts and validates options without sleeping', async () => {
    const store = memory();
    const noSleep = async () => { throw new Error('watch --once must not sleep'); };
    const claim = await invoke('mbp', ['watch', '--once'], store, { sleep: noSleep });
    expect(claim.code).toBe(0);
    expect(claim.output[0]).toContain('watch: claim');
    const renew = await invoke('mbp', ['watch', '--once'], store, { sleep: noSleep });
    expect(renew.output[0]).toContain('watch: renew');
    expect(store.doc).toMatchObject({ holder: 'mbp', generation: 2 });
    expect((await invoke('node-b', ['watch', '--once'], store, { sleep: noSleep })).output[0]).toContain('watch: observe');
    expect((await invoke('mbp', ['watch', '--once', '--takeover-ticks', '0'], store)).code).toBe(1);
    let unsafeReads = 0;
    const unsafe = await invoke('node-b', ['watch', '--interval', '60', '--takeover-ticks', '1', '--once'], store, {
      read: () => { unsafeReads++; return store.read(); },
    });
    expect(unsafe.code).toBe(1);
    expect(unsafe.errors).toEqual(['role: takeover-ticks must be at least 2 (one missed renewal can precede a live holder)']);
    expect(unsafeReads).toBe(0);
    expect(store.doc).toMatchObject({ holder: 'mbp', generation: 2 });
    store.write({ holder: 'node-b', from: 'mbp', state: 'handing-off', generation: 3, renewedAt: 1 }, String(store.gen), 'bucket');
    expect((await invoke('node-b', ['watch', '--once'], store, { sleep: noSleep })).output[0]).toContain('watch: accept');
    expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held' });
  });

  test('60-second primary cannot be preempted by a 1-second observer interval', async () => {
    const store = memory();
    expect((await invoke('mbp', ['watch', '--once'], store)).code).toBe(0);
    let reads = 0;
    const fast = await invoke('node-b', ['watch', '--interval', '1', '--takeover-ticks', '5', '--once'], store, {
      read: () => { reads++; return store.read(); },
    });
    expect(fast.code).toBe(1);
    expect(fast.errors).toEqual(['role: interval must be 60 seconds on every machine (shared renewal and takeover cadence)']);
    expect(reads).toBe(0);
    expect(store.doc).toMatchObject({ holder: 'mbp', generation: 1 });
    expect((await invoke('node-b', ['watch', '--interval', '60', '--once'], store)).output[0]).toContain('watch: observe');
  });

  test('watch reports CAS rejection without claiming the lease', async () => {
    const store = memory();
    await invoke('mbp', ['claim'], store);
    const result = await invoke('mbp', ['watch', '--once'], store, {
      write: () => ({ kind: 'lost', detail: '412' }),
    });
    expect(result.output[0]).toContain('watch: cas-rejected');
    expect(store.doc).toMatchObject({ holder: 'mbp', generation: 1 });
  });

  test('status JSON distinguishes absent, unreadable and held without accessing production', async () => {
    const store = memory();
    expect((await invoke('mbp', ['status', '--json'], store)).output).toEqual(['{"absent":true}']);
    expect((await invoke('mbp', ['status', '--json'], store, { read: () => ({ kind: 'unmeasured', why: 'permission denied' }) })).output)
      .toEqual(['{"unmeasured":"permission denied"}']);
    expect((await invoke('mbp', ['status', '--json'], store, { read: () => ({ kind: 'present', text: '{', gen: '1' }) })).output)
      .toEqual(['{"unmeasured":"invalid lease JSON"}']);
    expect((await invoke('mbp', ['status', '--json'], store, { read: () => { throw new Error('offline'); } })).output)
      .toEqual(['{"unmeasured":"offline"}']);
    await invoke('mbp', ['claim'], store);
    expect((await invoke('mbp', ['status', '--json'], store)).output).toEqual(['{"holder":"mbp","generation":1,"state":"held"}']);
    expect((await invoke('node-b', ['accept'], store)).code).not.toBe(0);
  });
});
