import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerDecisionsCommands } from './decisions-cli.js';
import { parseRailAllowed, raiseHitlArgs, runCatchUp, type CatchUpDeps } from './self-update-catch-up.js';
import { updateAllElsTabs, type UpdateSeatRow } from '../els/update-all.js';
import { runSeatControl } from './seat-control-cli.js';
import { runUpdateForInstallation } from './self-update.js';
import { renderUpdatePlist, renderUpdateUnits, updateCommand } from './update-auto.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);
const NEW12 = NEW.slice(0, 12);

/** Fake rig: only the decision/gate/HITL paths. git and run fail the call, so a test that unexpectedly reaches the install path fails instead of pretending it succeeded. */
function rig(opts: { installed?: string; rail?: boolean | 'throw'; desired?: string | null; daemon?: string | 'down'; noCommit?: boolean; channel?: string | null } = {}) {
  const dir = tmp('catchup-');
  const root = join(dir, 'root'); const stateDir = join(dir, 'state'); const checkout = join(dir, 'co');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  writeFileSync(join(checkout, 'scripts', 'install.sh'), '');
  const oldName = `0.2.15-${(opts.installed ?? OLD).slice(0, 12)}`;
  mkdirSync(join(root, 'versions', oldName, 'node_modules', 'elanous', 'bin'), { recursive: true });
  writeFileSync(join(root, 'versions', oldName, 'node_modules', 'elanous', 'bin', 'elanous.mjs'), '// entry\n');
  symlinkSync(`versions/${oldName}`, join(root, 'current'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.15', versionDir: `versions/${oldName}`, source: checkout, ...(opts.channel === null ? {} : { channel: opts.channel ?? 'dev' }), ...(opts.noCommit ? {} : { commit: (opts.installed ?? OLD).slice(0, 12) }) }));
  const calls: string[] = []; const raised: string[] = []; const handoffs: string[] = [];
  const st = { daemon: opts.daemon ?? (opts.installed ?? OLD) };
  const deps: CatchUpDeps = {
    cliRoot: checkout, installRoot: root, stateDir, host: 'host-a', now: () => new Date('2026-11-20T00:00:00Z'), packageVersion: () => '0.2.16-dev.0',
    desired: () => (opts.desired === null ? undefined : opts.desired ?? NEW),
    railAllowed: () => { if (opts.rail === 'throw') throw new Error('phase.py failed'); return opts.rail !== false; },
    out: { log: () => {}, error: () => {} }, alert: () => {}, os: 'darwin', uid: 501, allowLiveRestart: false,
    git: (_c, args) => { calls.push(`git ${args.join(' ')}`); return { status: 1, stdout: '', stderr: 'fake rig: no git' }; },
    run: (cmd) => { calls.push(`run ${cmd}`); return { status: 1, stderr: 'fake rig: no run' }; },
    restartEdgeRail: async () => { calls.push('restart'); return false; },
    verifyRestart: async () => (st.daemon === 'down' ? { ok: false } : { ok: true, daemonSha: st.daemon }),
    raiseHitl: (t) => { raised.push(t); },
    recordHandoff: (t) => { handoffs.push(t); },
  };
  const gateFile = join(stateDir, 'host-assign-gate.json');
  const gate = () => (JSON.parse(readFileSync(gateFile, 'utf8')) as { gate: string }).gate;
  const seed = (g: string) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(gateFile, JSON.stringify({ host: 'host-a', gate: g, sha: OLD })); };
  const setRecord = (commit: string) => writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.15', versionDir: `versions/${oldName}`, source: checkout, channel: 'dev', commit: commit.slice(0, 12) }));
  return { deps, calls, raised, handoffs, gate, seed, root, st, setRecord };
}

const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Real rig: a real git origin + clone (behind by one commit) containing the REAL scripts/install.sh; the install runs through installDevBuild -> bash install.sh into a temp prefix.
 *  Faked: restart + health probe only (and HOME is isolated for the installer). Nothing here writes install.json / current — only install.sh does. */
function realRig(o: { detach?: boolean; installerFails?: boolean; overlap?: 'same' | 'ancestor' | 'descendant' } = {}) {
  const dir = tmp('catchup-real-');
  const origin = join(dir, 'origin.git'); const work = join(dir, 'work'); const co = join(dir, 'co'); const home = join(dir, 'home'); const root = join(dir, 'root'); const stateDir = join(dir, 'state');
  mkdirSync(home, { recursive: true });
  for (const d of ['scripts/lib', 'bin', 'apps/pwa/out']) mkdirSync(join(work, d), { recursive: true });
  const repo = join(import.meta.dir, '..', '..');
  copyFileSync(join(repo, 'scripts', 'install.sh'), join(work, 'scripts', 'install.sh'));
  copyFileSync(join(repo, 'scripts', 'lib', 'pack-pwa-output.ts'), join(work, 'scripts', 'lib', 'pack-pwa-output.ts'));
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'elanous', version: '0.0.1-fx', bin: { elanous: './bin/elanous.mjs' } }));
  writeFileSync(join(work, 'bin', 'elanous.mjs'), '// build-one\n'); writeFileSync(join(work, 'apps', 'pwa', 'out', 'index.html'), '<html></html>\n');
  writeFileSync(join(work, '.gitignore'), 'local.cfg\nfoo\n');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(work, 'init', '-q', '-b', 'main'); sh(work, 'add', '-A', '-f'); sh(work, 'commit', '-qm', 'one'); sh(work, 'remote', 'add', 'origin', origin); sh(work, 'push', '-q', 'origin', 'main');
  const one = sh(work, 'rev-parse', 'HEAD');
  sh(dir, 'clone', '-q', origin, co);
  writeFileSync(join(work, 'bin', 'elanous.mjs'), '// build-two\n'); const trackInTwo = o.overlap ? { same: 'local.cfg', ancestor: 'foo', descendant: 'foo/baz' }[o.overlap] : undefined;
  if (trackInTwo) { mkdirSync(dirname(join(work, trackInTwo)), { recursive: true }); writeFileSync(join(work, trackInTwo), 'tracked-in-two\n'); sh(work, 'add', '-f', trackInTwo); }
  sh(work, 'commit', '-qam', 'two'); sh(work, 'push', '-q', 'origin', 'main');
  const two = sh(work, 'rev-parse', 'HEAD');
  if (o.detach) sh(co, 'checkout', '-q', '--detach', one);
  const calls: string[] = []; const raised: string[] = [];
  const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache'), ELANOUS_INSTALL_LANG: 'en', NODE_ENV: 'test' };
  const realRun: NonNullable<CatchUpDeps['run']> = (cmd, args, cwd) => {
    calls.push(`run ${cmd}`);
    if (o.installerFails && cmd === 'bash') return { status: 1, stderr: 'installer failed (test)' };
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  };
  // The host starts installed at commit one (installed by the real installer too), channel=dev.
  const first = spawnSync('bash', [join(co, 'scripts', 'install.sh'), '--no-modify-path', '--yes', '--prefix', root], { cwd: co, env, encoding: 'utf8' });
  if (first.status !== 0) throw new Error(`seed install failed: ${first.stderr}`);
  const rec = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(root, 'install.json'), JSON.stringify({ ...rec, channel: 'dev' }));
  if (o.detach) sh(co, 'checkout', '-q', '--detach', one);
  const st = { daemon: one };
  const installedCommit = () => (JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')) as { commit?: string }).commit ?? '';
  const deps: CatchUpDeps = {
    cliRoot: co, installRoot: root, stateDir, host: 'host-a', now: () => new Date('2026-11-20T00:00:00Z'),
    desired: () => two, railAllowed: () => true, out: { log: () => {}, error: () => {} }, alert: () => {}, os: 'darwin', uid: 501, allowLiveRestart: false,
    run: realRun,
    restartEdgeRail: async () => { calls.push('restart'); st.daemon = installedCommit(); return true; },
    verifyRestart: async () => ({ ok: true, daemonSha: st.daemon }),
    raiseHitl: (t) => { raised.push(t); }, recordHandoff: () => {},
  };
  const gate = () => (JSON.parse(readFileSync(join(stateDir, 'host-assign-gate.json'), 'utf8')) as { gate: string }).gate;
  return { deps, calls, raised, root, co, one, two, st, gate, installedCommit };
}

describe('self-update --catch-up (real installer, real git; only restart + health faked)', () => {
  test('approved desired changing after the first read refuses before checkout or install', async () => {
    const r = realRig();
    let current = r.two;
    const res = await runCatchUp({ seat: 'TC', restart: false, expectedDesired: r.two }, {
      ...r.deps, desired: () => current, railAllowed: () => { current = 'e'.repeat(40); return true; },
    });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toContain('approved desired');
    expect(r.installedCommit()).toBe(r.one);
    expect(r.calls).not.toContain('run bash');
    expect(r.gate()).toBe('closed');
  }, 120_000);
  test('installer exit zero cannot claim an installed SHA other than the approved SHA', async () => {
    const r = realRig();
    const originalRun = r.deps.run!;
    const res = await runCatchUp({ seat: 'TC', restart: false, expectedDesired: r.two }, {
      ...r.deps, run: (cmd, args, cwd, options) => {
        const result = originalRun(cmd, args, cwd, options);
        if (cmd === 'bash' && result.status === 0) {
          const path = join(r.root, 'install.json');
          const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          writeFileSync(path, JSON.stringify({ ...record, commit: r.one }));
        }
        return result;
      },
    });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toContain('installed commit not confirmed against approved desired');
    expect(r.gate()).toBe('closed');
  }, 120_000);
  test.each([false, 'throw'] as const)('OP approval wait rechecks rail phase=%s before any install effect', async (after) => {
    const r = realRig();
    let rail = true; let checks = 0;
    const result = await runCatchUp({ seat: 'OP', restart: false }, {
      ...r.deps,
      railAllowed: () => { checks++; if (!rail && after === 'throw') throw new Error('phase read failed'); return rail; },
      approveOp: () => { rail = false; return true; },
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('rail not allowed');
    expect(checks).toBe(2);
    expect(r.installedCommit()).toBe(r.one);
    expect(r.gate()).toBe('closed');
  });
  test('OP approval continues through the real installer and pinned local migrate in one update-all path', async () => {
    const r = realRig();
    let approvals = 0;
    const denied = await runCatchUp({ seat: 'OP', restart: false }, { ...r.deps, approveOp: async () => { approvals++; return false; } });
    expect(denied.exitCode).toBe(1);
    expect(r.installedCommit()).toBe(r.one);
    let rows: UpdateSeatRow[] = [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same', build: { sha: r.one, source: 'installed' } }];
    const sent: string[] = [];
    let ticks = 0;
    const result = await updateAllElsTabs({
      sender: () => 'OP',
      prepare: async () => {
        const installed = await runCatchUp({ seat: 'OP', restart: false }, { ...r.deps, approveOp: async () => { approvals++; return true; } });
        if (installed.exitCode !== 0) throw new Error(installed.reason);
      },
      target: () => ({ desired: r.two, installed: r.installedCommit() }),
      list: async () => ({ hosts: [{ name: 'host-a', reach: 'local' }], panes: [{ address: 'host-a:w/t/TC', host: 'host-a', reach: 'local', seat: 'TC', state: 'working', cwd: '/seats/TC', pid: 10 }] }),
      seats: () => rows,
      migrate: (seat, expected) => runSeatControl(seat, 'migrate', { sender: () => 'OP', rows: () => rows,
        send: async (id) => { sent.push(id); return { status: 'success', reason: 'waiting' }; } }, expected),
      sleep: async () => { ticks++; rows = [{ id: 'tui:11', ownerPid: 11, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same', build: { sha: r.two, source: 'installed' } }]; },
      now: () => ticks * 1_000, timeoutMs: 2_000,
    });
    expect(result.ok).toBe(true);
    expect(result.rows[0]?.result).toBe('updated');
    expect(sent).toEqual(['tui:10']);
    expect(r.installedCommit()).toBe(r.two);
    expect(approvals).toBe(2);
  });
  test('behind: real install.sh installs desiredSha (content, record, current link — none written by the test), checkout restored to its branch, restart verified, gate opens', async () => {
    const r = realRig();
    const res = await runCatchUp({ seat: 'TC', restart: true }, r.deps);
    expect(res.reason).toContain('gate open');
    expect(res.exitCode).toBe(0);
    expect(r.installedCommit()).toBe(r.two);
    const rec = JSON.parse(readFileSync(join(r.root, 'install.json'), 'utf8')) as { versionDir: string; channel: string };
    expect(rec.channel).toBe('dev');
    expect(rec.versionDir).toBe(`versions/0.0.1-fx-${r.two.slice(0, 12)}`);
    expect(readlinkSync(join(r.root, 'current'))).toBe(rec.versionDir);
    expect(readFileSync(join(r.root, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'), 'utf8')).toBe('// build-two\n');
    expect(r.calls.filter((c) => c === 'run bash').length).toBe(1);
    expect(r.gate()).toBe('open');
    // the user's checkout is left exactly as found: same branch, same commit, clean
    expect(sh(r.co, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(sh(r.co, 'rev-parse', 'HEAD')).toBe(r.one);
    expect(sh(r.co, 'status', '--porcelain')).toBe('');
  }, 120_000);
  test.each([
    ['same path', 'same', 'local.cfg', (co: string) => writeFileSync(join(co, 'local.cfg'), 'LOCAL-SECRET-VALUE\n'), 'local.cfg'],
    ['desired tracks a file ABOVE an ignored local file (ignored foo/bar vs tracked foo)', 'ancestor', 'foo', (co: string) => { mkdirSync(join(co, 'foo')); writeFileSync(join(co, 'foo', 'bar'), 'LOCAL-SECRET-VALUE\n'); }, join('foo', 'bar')],
    ['desired tracks a file BELOW an ignored local file (ignored foo vs tracked foo/baz)', 'descendant', 'foo/baz', (co: string) => writeFileSync(join(co, 'foo'), 'LOCAL-SECRET-VALUE\n'), 'foo'],
  ] as const)('an IGNORED local path that collides with a desired-tracked path is never overwritten (%s): refused before any checkout, gate closed, exit 1, path (not content) reported', async (_name, overlap, quoted, plant, kept) => {
    const r = realRig({ overlap });
    plant(r.co);
    const logs: string[] = [];
    const res = await runCatchUp({ seat: 'TC', restart: true }, { ...r.deps, out: { log: (l) => logs.push(l), error: (l) => logs.push(l) } });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toContain(quoted);
    expect(logs.join('\n')).not.toContain('LOCAL-SECRET-VALUE');
    expect(readFileSync(join(r.co, kept), 'utf8')).toBe('LOCAL-SECRET-VALUE\n');
    expect(sh(r.co, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(sh(r.co, 'rev-parse', 'HEAD')).toBe(r.one);
    expect(r.installedCommit()).toBe(r.one);
    expect(r.calls).not.toContain('run bash');
    expect(r.gate()).toBe('closed');
  }, 120_000);
  test('desired changes during install/restart: the installed build is verified but the gate is NOT opened (exit 1, closed)', async () => {
    const r = realRig();
    let reads = 0;
    r.deps.desired = () => (reads++ === 0 ? r.two : 'e'.repeat(40));
    const res = await runCatchUp({ seat: 'TC', restart: true }, r.deps);
    expect(res.exitCode).toBe(1);
    expect(r.installedCommit()).toBe(r.two);
    expect(r.gate()).toBe('closed');
  }, 120_000);
  test('a detached checkout is restored to the same detached commit', async () => {
    const r = realRig({ detach: true });
    expect((await runCatchUp({ seat: 'TC', restart: true }, r.deps)).exitCode).toBe(0);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: r.co }).status).not.toBe(0);
    expect(sh(r.co, 'rev-parse', 'HEAD')).toBe(r.one);
  }, 120_000);
  test('installer failure: checkout still restored, install record untouched, gate closed', async () => {
    const r = realRig({ installerFails: true });
    const res = await runCatchUp({ seat: 'TC', restart: true }, r.deps);
    expect(res.exitCode).toBe(1);
    expect(sh(r.co, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(sh(r.co, 'rev-parse', 'HEAD')).toBe(r.one);
    expect(r.installedCommit()).toBe(r.one);
    expect(r.gate()).toBe('closed');
  }, 120_000);
  test('installed without restart, then a later run: record matches but the daemon is stale -> no second install; restart + verify opens the gate', async () => {
    const r = realRig();
    await runCatchUp({ seat: 'TC' }, r.deps);
    expect(r.installedCommit()).toBe(r.two);
    expect(r.gate()).toBe('closed');
    const res = await runCatchUp({ seat: 'TC', restart: true }, r.deps);
    expect(res.exitCode).toBe(0);
    expect(r.calls.filter((c) => c === 'run bash').length).toBe(1);
    expect(r.st.daemon).toBe(r.two);
    expect(r.gate()).toBe('open');
  }, 120_000);
});

describe('self-update --catch-up (decision, gate and HITL paths)', () => {
  test('a desired SHA changed after the SSH parent checked it is refused before install', async () => {
    const r = rig({ desired: NEW, installed: OLD });
    const result = await runCatchUp({ seat: 'TC', restart: false, expectedDesired: OLD }, r.deps);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('approved desired');
    expect(r.calls).toEqual([]);
    expect(r.gate()).toBe('closed');
  });
  test('the recorded gate file has the documented shape {host, gate, sha, at} (contract for the future consumer)', async () => {
    const r = rig({ rail: false });
    await runCatchUp({ seat: 'TC' }, r.deps);
    const rec = JSON.parse(readFileSync(join(r.deps.stateDir!, 'host-assign-gate.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(rec).sort()).toEqual(['at', 'gate', 'host', 'sha']);
    expect(rec).toMatchObject({ host: 'host-a', gate: 'closed', sha: NEW, at: '2026-11-20T00:00:00.000Z' });
  });
  test('unknown desired or installed sha closes a previously open gate', async () => {
    for (const o of [{ desired: null }, { noCommit: true }] as const) {
      const r = rig(o);
      r.seed('open');
      expect((await runCatchUp({ seat: 'TC', restart: true }, r.deps)).exitCode).toBe(2);
      expect(r.gate()).toBe('closed');
    }
  });
  test('desired changes while the host is being verified: the gate is NOT opened, stays closed, exit 1 (already-current path)', async () => {
    const r = rig({ installed: NEW, daemon: NEW });
    r.seed('open');
    let reads = 0;
    r.deps.desired = () => (reads++ === 0 ? NEW : 'f'.repeat(40));   // moved on after the first read
    const res = await runCatchUp({ seat: 'TC' }, r.deps);
    expect(res.exitCode).toBe(1);
    expect(r.gate()).toBe('closed');
  }, 30_000);
  test('an already open gate is closed BEFORE verification starts, and a throw during verification leaves it closed', async () => {
    const r = rig({ installed: NEW, daemon: NEW });
    r.seed('open');
    let seenDuringVerify = '';
    r.deps.verifyRestart = async () => { seenDuringVerify = r.gate(); return { ok: true, daemonSha: NEW }; };
    expect((await runCatchUp({ seat: 'TC' }, r.deps)).exitCode).toBe(0);
    expect(seenDuringVerify).toBe('closed');
    expect(r.gate()).toBe('open');                                   // reopened once, after the proof
    const crash = rig({ installed: NEW, daemon: NEW });
    crash.seed('open');
    crash.deps.verifyRestart = (() => { throw new Error('boom'); }) as unknown as NonNullable<CatchUpDeps['verifyRestart']>;
    await expect(runCatchUp({ seat: 'TC' }, crash.deps)).rejects.toThrow('boom');
    expect(crash.gate()).toBe('closed');
    const dry = rig({ installed: NEW, daemon: NEW });
    dry.seed('open');
    await runCatchUp({ seat: 'TC', dryRun: true }, dry.deps);
    expect(dry.gate()).toBe('open');                                 // dry run writes nothing
  }, 30_000);
  test('every refusal (no record, non-dev record, unknown seat, rollback/version) closes a previously open gate and installs nothing', async () => {
    const cases: Array<[string, (r: ReturnType<typeof rig>) => void, Parameters<typeof runCatchUp>[0]]> = [
      ['no record', (r) => rmSync(join(r.root, 'install.json')), { seat: 'TC' }],
      ['non-dev record', (r) => writeFileSync(join(r.root, 'install.json'), JSON.stringify({ version: '1', commit: OLD.slice(0, 12) })), { seat: 'TC' }],
      ['unreadable record', (r) => writeFileSync(join(r.root, 'install.json'), '{not json'), { seat: 'TC' }],
      ['unknown seat', () => {}, { seat: 'ZZ' }],
      ['rollback', () => {}, { seat: 'TC', rollback: true }],
      ['version', () => {}, { seat: 'TC', version: '1.2.3' }],
    ];
    for (const [name, mutate, options] of cases) {
      for (const viaDispatcher of [false, true]) {
        const r = rig(); mutate(r); r.seed('open');
        const res = viaDispatcher ? await runUpdateForInstallation({ ...options, catchUp: true }, { cliRoot: r.deps.cliRoot, checkout: r.deps }) : await runCatchUp(options, r.deps);
        expect([name, viaDispatcher, res.exitCode]).toEqual([name, viaDispatcher, 2]);
        expect([name, viaDispatcher, r.gate()]).toEqual([name, viaDispatcher, 'closed']);
        expect(r.calls).toEqual([]);
      }
    }
  }, 30_000); // 12 runs; exceeded Bun's 5s default on a loaded gate host
  test('--catch-up together with bare --auto is still catch-up: OP protection applies, the edge-rail installer is never called', async () => {
    const r = rig();
    let edgeRail = 0;
    const res = await runUpdateForInstallation({ catchUp: true, auto: true, seat: 'OP', restart: true }, { cliRoot: r.deps.cliRoot, checkout: { ...r.deps, installEdgeRail: async () => { edgeRail += 1; return { exitCode: 0, installedVersion: null, decision: null, restarted: false, reason: 'x' }; } } });
    expect(res.exitCode).toBe(0);
    expect(edgeRail).toBe(0);
    expect(r.raised.length).toBe(1);
    expect(r.gate()).toBe('closed');
    expect(r.calls).toEqual([]);
  });
  test('--catch-up + --auto on a non-dev install is refused, never an edge-rail update', async () => {
    const r = rig({ channel: null });
    const res = await runUpdateForInstallation({ catchUp: true, auto: true, seat: 'TC' }, { cliRoot: r.deps.cliRoot, checkout: r.deps });
    expect(res.exitCode).toBe(2);
    expect(res.reason).toContain('--catch-up');
    expect(r.calls).toEqual([]);
  });
  test.each([[false], ['throw']] as const)('OP seat behind, rail=%s: HITL + handoff raised once, nothing installed or restarted', async (rail) => {
    const r = rig({ rail });
    expect((await runCatchUp({ seat: 'OP', restart: true }, r.deps)).exitCode).toBe(0);
    expect(r.raised.length).toBe(1);
    expect(r.handoffs.length).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.gate()).toBe('closed');
    await runCatchUp({ seat: 'OP', restart: true }, r.deps);
    expect(r.raised.length).toBe(1);
  });
  test('HITL relapse: recovery clears the marker, so falling behind again at the SAME desired sha raises (and hands off) a new incident', async () => {
    const r = rig();
    await runCatchUp({ seat: 'OP' }, r.deps);
    expect(r.raised.length).toBe(1);
    r.setRecord(NEW); r.st.daemon = NEW;                       // recovered: record + running daemon at desired
    expect((await runCatchUp({ seat: 'OP' }, r.deps)).exitCode).toBe(0);
    expect(r.gate()).toBe('open');
    expect(r.raised.length).toBe(1);
    r.setRecord(OLD); r.st.daemon = OLD;                       // relapse, desired unchanged
    await runCatchUp({ seat: 'OP' }, r.deps);
    expect(r.raised.length).toBe(2);
    expect(r.handoffs.length).toBe(2);
    expect(r.gate()).toBe('closed');
  });
  test('handoff write failure still raises the decision; both are retried independently until each has succeeded once; exit is non-zero while incomplete', async () => {
    const r = rig();
    let handoffOk = false; let handoffCalls = 0;
    r.deps.recordHandoff = () => { handoffCalls += 1; if (!handoffOk) throw new Error('disk full'); };
    const first = await runCatchUp({ seat: 'OP' }, r.deps);
    expect(first.exitCode).toBe(1);
    expect(first.reason).toContain('handoff');
    expect(r.raised.length).toBe(1);                 // raise was NOT skipped by the handoff failure
    handoffOk = true;
    const second = await runCatchUp({ seat: 'OP' }, r.deps);
    expect(second.exitCode).toBe(0);
    expect([handoffCalls, r.raised.length]).toEqual([2, 1]);   // only the missing part was repeated
    expect((await runCatchUp({ seat: 'OP' }, r.deps)).exitCode).toBe(0);
    expect([handoffCalls, r.raised.length]).toEqual([2, 1]);
  });
  test('decisions raise failure (false or throw) still writes the handoff, exits non-zero, and retries only the raise', async () => {
    for (const fail of ['false', 'throw'] as const) {
      const r = rig();
      let ok = false; let tries = 0;
      r.deps.raiseHitl = () => { tries += 1; if (ok) return; if (fail === 'throw') throw new Error('cli down'); return false; };
      expect((await runCatchUp({ seat: 'OP' }, r.deps)).exitCode).toBe(1);
      expect(r.handoffs.length).toBe(1);
      ok = true;
      expect((await runCatchUp({ seat: 'OP' }, r.deps)).exitCode).toBe(0);
      expect([r.handoffs.length, tries]).toEqual([1, 2]);
    }
  });
  test('host lock: a second run while one holds it exits non-zero, closes the gate and touches nothing; the lock is released afterwards', async () => {
    const r = rig();
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((res) => { unblock = res; });
    let entered: () => void = () => {};
    const inside = new Promise<void>((res) => { entered = res; });
    const deps1 = { ...r.deps, raiseHitl: async (t: string) => { entered(); await blocked; r.raised.push(t); } };
    const first = runCatchUp({ seat: 'OP' }, deps1);
    await inside;
    r.seed('open');
    const second = await runCatchUp({ seat: 'TC', restart: true }, r.deps);
    expect(second.exitCode).toBe(1);
    expect(second.reason).toContain('lock');
    expect(r.gate()).toBe('closed');
    expect(r.calls).toEqual([]);
    unblock();
    expect((await first).exitCode).toBe(0);
    expect(existsSync(join(r.deps.stateDir!, 'host-catch-up.lock'))).toBe(false);
    expect((await runCatchUp({ seat: 'OP' }, r.deps)).exitCode).toBe(0);
  });
  test('host lock: a lock whose owner process is dead is reclaimed; one owned by a live process never is', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']);   // exited child: its pid is dead
    for (const [pid, expectRun] of [[dead.pid, true], [process.pid, false]] as const) {
      const r = rig({ rail: false });
      const lock = join(r.deps.stateDir!, 'host-catch-up.lock');
      mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), `${pid}.stale-token`);
      const res = await runCatchUp({ seat: 'TC' }, r.deps);
      expect(res.reason.includes('lock')).toBe(!expectRun);
      expect(res.exitCode).toBe(expectRun ? 0 : 1);
    }
  });
  test('HITL raise args satisfy the real decisions command contract (in-process command tree, isolated state dir: card persisted)', () => {
    const stateDir = tmp('catchup-dec-');
    const saved = { seat: process.env.ELANOUS_SEAT, agent: process.env.AI_AGENT };
    delete process.env.ELANOUS_SEAT; delete process.env.AI_AGENT;   // a seat env would route the card to OP mail instead of the ledger
    try {
      const lines: string[] = [];
      const program = new Command();
      registerDecisionsCommands(program, { humanTerminal: () => true, stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: (line) => lines.push(line) });
      program.parse([...raiseHitlArgs('OP', 'host-a not running desired'), '--json'], { from: 'user' });
      expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8')).toContain(JSON.parse(lines[0]!).id);
    } finally {
      if (saved.seat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = saved.seat;
      if (saved.agent === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = saved.agent;
    }
  });
  test('parseRailAllowed is fail-closed: only explicit true passes', () => {
    expect(parseRailAllowed('{"phase":"dev-normal","rules":{"rail":true}}')).toBe(true);
    expect(parseRailAllowed('{"rules":{"rail":false}}')).toBe(false);
    for (const bad of ['', 'not json', '{}', '{"rules":{}}', '{"rules":{"rail":"true"}}', '{"rules":{"rail":1}}']) expect(parseRailAllowed(bad)).toBe(false);
  });
});

describe('update --auto on --catch-up service shape', () => {
  test('plist = RunAtLoad + StartInterval (no 04:17 calendar); timer = boot + periodic', () => {
    expect(updateCommand({ seat: 'TC' }).slice(-6)).toEqual(['self-update', '--catch-up', '--seat', 'TC', '--restart', '--alert']);
    const plist = renderUpdatePlist(['x'], '/h', '/l', { seat: 'TC' });
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>StartInterval</key>');
    const t = renderUpdateUnits(['x'], '/h', { seat: 'TC' }).timer;
    expect(t).toContain('OnBootSec=1min\nOnUnitActiveSec=15min');
  });
});
