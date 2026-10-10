import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { installHqFenceWrapper, renderHqFenceWrapper, repositoryWorktreeCdWarning, resolveHqFenceBun } from './fence-wrapper.js';
import { hqHeartbeat } from './hq.js';
import { fileLeaseStore, serializeLease } from './lease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'hq-fence-wrapper-')); roots.push(dir); return dir; }

test('installed entrypoint only, missing/broken symlink fails once with rc 1, never uses a repository worktree', () => {
  const dir = root();
  const alerts = join(dir, 'alerts');
  const entry = join(dir, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
  mkdirSync(join(dir, 'current', 'node_modules', 'elanous', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'absent'), entry);
  // The entry is gone, so the alert can only take the PATH fallback.
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${alerts}'\n`, { mode: 0o755 });
  const body = renderHqFenceWrapper({ entry, configDir: join(dir, 'config'), bun: process.execPath });
  expect(body).toContain(entry);
  expect(body).not.toContain('wt-ops-hq');
  expect(repositoryWorktreeCdWarning(body)).toBeUndefined();
  const path = join(dir, 'hq-fence'); writeFileSync(path, body, { mode: 0o755 });
  const result = spawnSync('/bin/sh', [path, 'cron', 'echo', 'ok'], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(1);
  expect(readFileSync(alerts, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('fence exit 0 (stub bun stands in for a lease skip) does not alert; nonzero alerts exactly once and keeps rc and installed cwd', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const alerts = join(dir, 'alerts');
  const calls = join(dir, 'calls');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  // One fake bun serves both calls: the fence (exits FAKE_RC) and the alert through the same entry (exits 0).
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\ncase "$*" in *"fence-wrapper alert"*) echo "$*" >> '${alerts}'; exit 0;; esac\npwd > '${calls}'\nexit "\${FAKE_RC:-0}"\n`, { mode: 0o755 });
  const body = renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, body, { mode: 0o755 });
  // cron PATH: bun is not on it — the wrapper must use the baked absolute path.
  const env = { ...process.env, PATH: `/usr/bin${delimiter}/bin`, FAKE_RC: '0' };
  const skipped = spawnSync('/bin/sh', [wrapper, 'cron', 'echo', 'skip'], { encoding: 'utf8', env });
  expect(skipped.status).toBe(0);
  expect(existsSync(alerts)).toBe(false);
  expect(readFileSync(calls, 'utf8').trim()).toBe(join(dir, 'package'));
  const failed = spawnSync('/bin/sh', [wrapper, 'cron', 'false'], { encoding: 'utf8', env: { ...env, FAKE_RC: '7' } });
  expect(failed.status).toBe(7);
  const alertCalls = readFileSync(alerts, 'utf8').trim().split('\n');
  expect(alertCalls).toHaveLength(1);
  expect(alertCalls[0]).toContain(entry);
});

// ── FENCE-LIGHT (0.2.23) ─────────────────────────────────────────────────────────────────────────────
// Every fixture lives in a temp dir: stub bun, temp HOME/config, a temp arbiter file — never ~/.elanous or a crontab.
const MACHINE = hostname().replace(/\.local$/, '');
/** A real GNU timeout for kill tests (Homebrew coreutils on macOS, /usr/bin on Linux); undefined = those tests skip. */
const REAL_TIMEOUT = (() => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v timeout || command -v gtimeout'], { encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' } });
  const p = r.stdout.trim().split('\n')[0];
  return r.status === 0 && p ? p : undefined;
})();

interface LightFixture {
  dir: string; home: string; configDir: string; wrapper: string; calls: string; payload: string; logFile: string; fakeBin: string;
  env: Record<string, string>;
  cache(line: string): void;
  local(state: Record<string, unknown>): void;
  run(role: string, ...cmd: string[]): ReturnType<typeof spawnSync>;
  bunCalls(): string[];
}
/** Installed-package layout + stub bun (records argv; CLI «fence» stub exits BUN_RC without running the payload). */
function lightFixture(opts: { watchdogs?: string; bunScript?: string } = {}): LightFixture {
  const dir = root();
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  const entry = join(pkg, 'bin', 'elanous.mjs'); writeFileSync(entry, 'entry');
  mkdirSync(join(pkg, 'scripts', 'hq'), { recursive: true });
  copyFileSync(join(import.meta.dir, '../../scripts/hq/hq-fence-wrapper.sh'), join(pkg, 'scripts', 'hq', 'hq-fence-wrapper.sh'));
  const home = join(dir, 'home'); mkdirSync(join(home, '.elanous-hq'), { recursive: true });
  writeFileSync(join(home, '.elanous-hq', 'host'), 'mbp\n');
  const configDir = join(dir, 'config'); mkdirSync(join(configDir, 'hq'), { recursive: true });
  const calls = join(dir, 'bun-calls');
  const bun = join(dir, 'bun');
  writeFileSync(bun, opts.bunScript ?? `#!/bin/sh\necho "$*" >> '${calls}'\nexit "\${BUN_RC:-0}"\n`, { mode: 0o755 });
  const logFile = join(dir, 'hq-fence.log');
  const wrapper = join(dir, 'hq-fence');
  writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir, bun, logFile }), { mode: 0o755 });
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`,
    HQ_FENCE_WATCHDOGS: opts.watchdogs ?? (REAL_TIMEOUT ?? '') };
  const fx: LightFixture = {
    dir, home, configDir, wrapper, calls, payload: join(dir, 'payload'), logFile, fakeBin, env,
    cache: line => writeFileSync(join(configDir, 'hq', 'lease-cache'), line),
    local: state => writeFileSync(join(configDir, 'hq', 'local.json'), `${JSON.stringify(state)}\n`),
    run: (role, ...cmd) => spawnSync('/bin/sh', [wrapper, role, ...cmd], { encoding: 'utf8', env: fx.env, timeout: 20_000 }),
    // argv after the installed entry path (always the first argument).
    bunCalls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => { expect(l.startsWith(`${entry} `)).toBe(true); return l.slice(entry.length + 1); }) : [],
  };
  return fx;
}
const nowS = () => Math.floor(Date.now() / 1000);
const freshLine = (gen = 2, host = 'mbp') => { const n = nowS(); return `${host} ${gen} ${n + 600} ${host} ${MACHINE} ${n}\n`; };

test.skipIf(!REAL_TIMEOUT)('FENCE-LIGHT fast path: a fresh «this host holds» cache runs the payload with no bun call and exports the generation', () => {
  const fx = lightFixture();
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  const result = fx.run('cron', `printf %s "$ELANOUS_HQ_GENERATION" > '${fx.payload}'`);
  expect(result.status, String(result.stderr)).toBe(0);
  expect(readFileSync(fx.payload, 'utf8')).toBe('2');
  expect(fx.bunCalls()).toEqual([]);
});

test.skipIf(!REAL_TIMEOUT)('SAFETY fail-closed: every unusable cache falls back to the installed CLI check and never runs the payload from the file', () => {
  const n = nowS();
  const cases: Array<[string, (fx: LightFixture) => void]> = [
    ['other holder', fx => fx.cache(`node-b 2 ${n + 600} mbp ${MACHINE} ${n}\n`)],
    ['other holder named by this host', fx => fx.cache(`node-b 2 ${n + 600} node-b ${MACHINE} ${n}\n`)],
    ['cache written on another host', fx => fx.cache(`mbp 2 ${n + 600} other ${MACHINE} ${n}\n`)],
    ['replicated from another machine', fx => fx.cache(`mbp 2 ${n + 600} mbp other-machine ${n}\n`)],
    ['expired', fx => fx.cache(`mbp 2 ${n - 1} mbp ${MACHINE} ${n - 60}\n`)],
    ['old observation with forged expiry', fx => fx.cache(`mbp 2 ${n + 100} mbp ${MACHINE} ${n - 700}\n`)],
    ['expiry beyond the 660s bound', fx => fx.cache(`mbp 2 ${n + 661} mbp ${MACHINE} ${n}\n`)],
    ['confirmed in the future', fx => fx.cache(`mbp 2 ${n + 600} mbp ${MACHINE} ${n + 120}\n`)],
    ['malformed expiry', fx => fx.cache(`mbp 2 soon mbp ${MACHINE} ${n}\n`)],
    ['generation zero', fx => fx.cache(`mbp 0 ${n + 600} mbp ${MACHINE} ${n}\n`)],
    ['extra field', fx => fx.cache(`mbp 2 ${n + 600} mbp ${MACHINE} ${n} extra\n`)],
    ['missing field', fx => fx.cache(`mbp 2 ${n + 600} mbp ${MACHINE}\n`)],
    ['empty file', fx => fx.cache('')],
    ['shell metacharacters', fx => fx.cache(`mbp;true 2 ${n + 600} mbp ${MACHINE} ${n}\n`)],
    ['symlinked cache', fx => { writeFileSync(join(fx.dir, 'elsewhere'), freshLine(2)); symlinkSync(join(fx.dir, 'elsewhere'), join(fx.configDir, 'hq', 'lease-cache')); }],
    ['unreadable cache', fx => { fx.cache(freshLine(2)); spawnSync('chmod', ['000', join(fx.configDir, 'hq', 'lease-cache')]); }],
    ['local.json names another generation', fx => { fx.cache(freshLine(2)); fx.local({ holder: 'mbp', generation: 3 }); }],
    ['local.json generation prefix (20 vs 2)', fx => { fx.cache(freshLine(2)); fx.local({ holder: 'mbp', generation: 20 }); }],
    ['local.json names another holder', fx => { fx.cache(freshLine(2)); fx.local({ holder: 'node-b', generation: 2 }); }],
    ['local.json missing', fx => { fx.cache(freshLine(2)); rmSync(join(fx.configDir, 'hq', 'local.json')); }],
    ['seen a newer generation', fx => { fx.cache(freshLine(2)); writeFileSync(join(fx.home, '.elanous-hq', 'seen-generation'), '3\n'); }],
    ['valid line followed by a garbage line', fx => fx.cache(`${freshLine(2)}node-b 9 0 x y 0\n`)],
    ['valid line followed by a blank line', fx => fx.cache(`${freshLine(2)}\n`)],
    ['valid line followed by unterminated garbage', fx => fx.cache(`${freshLine(2)}node-b 9`)],
    ['local.json followed by unterminated garbage', fx => { fx.cache(freshLine(2)); writeFileSync(join(fx.configDir, 'hq', 'local.json'), `${JSON.stringify({ holder: 'mbp', generation: 2 })}\n{"holder":"node-b"}`); }],
    ['no trailing newline', fx => fx.cache(freshLine(2).trimEnd())],
    ['leading-zero confirmedAt (octal would abort the shell)', fx => fx.cache(`mbp 2 ${n + 600} mbp ${MACHINE} 08\n`)],
    ['leading-zero expiresAt', fx => fx.cache(`mbp 2 0${n + 600} mbp ${MACHINE} ${n}\n`)],
    ['local.json nested holder only', fx => { fx.cache(freshLine(2)); fx.local({ holder: 'node-b', generation: 2, previous: { holder: 'mbp', generation: 2 } }); }],
    ['local.json holder not leading', fx => { fx.cache(freshLine(2)); fx.local({ note: { holder: 'mbp' }, holder: 'mbp', generation: 2 }); }],
    ['local.json released (no holder)', fx => { fx.cache(freshLine(2)); fx.local({ generation: 2 }); }],
    ['local.json two lines', fx => { fx.cache(freshLine(2)); writeFileSync(join(fx.configDir, 'hq', 'local.json'), `${JSON.stringify({ holder: 'mbp', generation: 2 })}\n{"holder":"node-b"}\n`); }],
    ['seen-generation with a leading zero', fx => { fx.cache(freshLine(2)); writeFileSync(join(fx.home, '.elanous-hq', 'seen-generation'), '02\n'); }],
    ['host identity file missing', fx => { fx.cache(freshLine(2)); rmSync(join(fx.home, '.elanous-hq', 'host')); }],
  ];
  for (const [name, arrange] of cases) {
    const fx = lightFixture();
    fx.local({ holder: 'mbp', generation: 2, confirmedAt: n, ttlSeconds: 1500 });
    arrange(fx);
    const result = fx.run('cron', `echo ran > '${fx.payload}'`);
    expect(result.status, `${name}: ${String(result.stderr)}`).toBe(0); // the stub CLI «skips» with rc 0
    expect(existsSync(fx.payload), name).toBe(false);
    const calls = fx.bunCalls();
    expect(calls, name).toHaveLength(1);
    expect(calls[0], name).toContain(`--config-dir ${fx.configDir} hq fence --role cron -- /bin/sh -c echo ran`);
  }
}, 120_000);

test('SAFETY no cache file: the wrapper is exactly today\'s CLI path (no watchdog, no light script)', () => {
  const fx = lightFixture();
  // A watchdog that would leave a trace if the light path ran at all.
  const trace = join(fx.dir, 'watchdog-trace');
  writeFileSync(join(fx.fakeBin, 'timeout'), `#!/bin/sh\necho "$*" >> '${trace}'\nshift 3\nexec "$@"\n`, { mode: 0o755 });
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  const ok = fx.run('cron', 'echo', 'hi');
  expect(ok.status).toBe(0);
  expect(fx.bunCalls()).toEqual([`--config-dir ${fx.configDir} hq fence --role cron -- /bin/sh -c echo hi`]);
  fx.env.BUN_RC = '7';
  const failed = fx.run('seat-loop', 'false');
  expect(failed.status).toBe(7);
  expect(fx.bunCalls().slice(1)).toEqual([
    `--config-dir ${fx.configDir} hq fence --role seat-loop -- /bin/sh -c false`,
    `--config-dir ${fx.configDir} hq fence-wrapper alert hq-fence: fence failed (rc=7, role=seat-loop)`,
  ]);
  expect(existsSync(trace)).toBe(false);
  // The only log line is the legacy alert failure (the stub bun fails the alert too) — nothing from the light fence.
  expect(readFileSync(fx.logFile, 'utf8').trim().split('\n')).toEqual([expect.stringContaining('owner alert failed: hq-fence: fence failed (rc=7, role=seat-loop)')]);
  // The rendered wrapper only gains the guarded source block; the legacy CLI line is unchanged.
  const body = readFileSync(fx.wrapper, 'utf8');
  expect(body).toContain('if [ -f "$CONFIG_DIR/hq/lease-cache" ] && [ -f scripts/hq/hq-fence-wrapper.sh ]; then');
  expect(body).toContain('"$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence --role "$ROLE" -- /bin/sh -c "$*"');
});

test('SAFETY no watchdog binary: a cache never unlocks an unbounded fast path — legacy CLI command with one evidence line', () => {
  const fx = lightFixture({ watchdogs: '' });
  // A PATH with only what the wrapper needs, and no timeout/gtimeout.
  for (const tool of ['dirname', 'date', 'hostname', 'mkdir']) {
    const src = ['/bin', '/usr/bin'].map(d => join(d, tool)).find(p => existsSync(p));
    if (src) symlinkSync(src, join(fx.fakeBin, tool));
  }
  fx.env.PATH = fx.fakeBin;
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  const result = fx.run('cron', `echo ran > '${fx.payload}'`);
  expect(result.status, String(result.stderr)).toBe(0);
  expect(existsSync(fx.payload)).toBe(false);
  expect(fx.bunCalls()).toHaveLength(1);
  expect(fx.bunCalls()[0]).toContain('hq fence --role cron --');
  expect(readFileSync(fx.logFile, 'utf8')).toContain('fence watchdog unavailable (role=cron)');
});

test('FENCE-LIGHT role limits: each role gets its default limit through the watchdog, unknown roles go to the CLI', () => {
  const fx = lightFixture({ watchdogs: '' });
  const limits = join(fx.dir, 'limits');
  writeFileSync(join(fx.fakeBin, 'timeout'), `#!/bin/sh\necho "$1 $2 $3" >> '${limits}'\nshift 3\nexec "$@"\n`, { mode: 0o755 });
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  const roles = { 'telegram-poller': 3600, cron: 900, 'seat-loop': 1800, 'release-run': 3600, conatus: 900, 'git-push': 120, 'ledger-cli': 120 };
  for (const role of Object.keys(roles)) expect(fx.run(role, 'true').status).toBe(0);
  expect(readFileSync(limits, 'utf8').trim().split('\n')).toEqual(Object.values(roles).map(l => `-k 5 ${l}`));
  expect(fx.bunCalls()).toEqual([]);
  expect(fx.run('not-a-role', 'true').status).toBe(0);
  expect(fx.bunCalls()).toEqual([`--config-dir ${fx.configDir} hq fence --role not-a-role -- /bin/sh -c true`]);
  expect(readFileSync(limits, 'utf8').trim().split('\n')).toHaveLength(7); // unknown role: unbounded legacy command
});

/** Fake `timeout` that checks the role limit was passed, then runs the real watchdog with a short limit. */
function shortWatchdog(fx: LightFixture, expectLimit: number): void {
  writeFileSync(join(fx.fakeBin, 'timeout'), `#!/bin/sh\n[ "$1 $2 $3" = "-k 5 ${expectLimit}" ] || [ "$3" = 20 ] || exit 99\nshift 3\nexec '${REAL_TIMEOUT}' -k 1 0.5 "$@"\n`, { mode: 0o755 });
  fx.env.HQ_FENCE_WATCHDOGS = '';
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(!REAL_TIMEOUT)('SAFETY time limit: an overrun kills only the fenced process group, leaves a log line, and spares unrelated processes', () => {
  const fx = lightFixture();
  shortWatchdog(fx, 120);
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  // An unrelated process with the very same command line, outside the fence.
  const bystander = Bun.spawn(['sleep', '30']);
  const pidFile = join(fx.dir, 'grandchild.pid');
  let grandchild = 0;
  try {
    const result = fx.run('git-push', `sleep 30 & echo $! > '${pidFile}'; wait`);
    grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(result.status, String(result.stderr)).toBe(124);
    expect(alive(grandchild)).toBe(false);
    expect(alive(bystander.pid)).toBe(true);
    expect(readFileSync(fx.logFile, 'utf8')).toContain('fence timeout role=git-push limit=120s rc=124 decision=run reason=fresh-holder');
    expect(String(result.stderr)).toContain('hq-fence: timeout role=git-push limit=120s rc=124');
    // The overrun is a failure: recorded for the LOOPCHECK streak and alerted, never the CLI fence.
    expect(fx.bunCalls()).toEqual([
      `--config-dir ${fx.configDir} hq fence-wrapper record git-push 124`,
      `--config-dir ${fx.configDir} hq fence-wrapper alert hq-fence: fence failed (rc=124, role=git-push)`,
    ]);
  } finally {
    bystander.kill('SIGKILL');
    if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});

test.skipIf(!REAL_TIMEOUT)('SAFETY time limit on the CLI path: a stale cache bounds the installed CLI and leaves timeout evidence', () => {
  const dir = root();
  const fx = lightFixture({ bunScript: `#!/bin/sh\necho "$*" >> '${join(dir, 'calls')}'\ncase "$*" in *'hq fence --role '*) sleep 30;; esac\n` });
  shortWatchdog(fx, 900);
  fx.local({ holder: 'mbp', generation: 2 });
  fx.cache(`mbp 2 ${nowS() - 1} mbp ${MACHINE} ${nowS() - 60}\n`);
  const result = fx.run('cron', 'true');
  expect(result.status, String(result.stderr)).toBe(124);
  expect(readFileSync(fx.logFile, 'utf8')).toContain('fence timeout role=cron limit=900s rc=124 decision=cli reason=stale');
  const calls = readFileSync(join(dir, 'calls'), 'utf8');
  expect(calls).toContain('hq fence --role cron');
  expect(calls).toContain('hq fence-wrapper record cron 124');
});

test.skipIf(!REAL_TIMEOUT)('FENCE-LIGHT outcome streak: the fast path records failures and resets a nonzero streak, and stays bun-free otherwise', () => {
  const fx = lightFixture();
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  expect(fx.run('cron', 'exit 3').status).toBe(3);
  expect(fx.bunCalls()).toEqual([
    `--config-dir ${fx.configDir} hq fence-wrapper record cron 3`,
    `--config-dir ${fx.configDir} hq fence-wrapper alert hq-fence: fence failed (rc=3, role=cron)`,
  ]);
  mkdirSync(join(fx.configDir, 'hq', 'fence-outcomes'), { recursive: true });
  writeFileSync(join(fx.configDir, 'hq', 'fence-outcomes', 'cron.json'), JSON.stringify({ consecutiveFailures: 1, lastRc: 3, lastAt: 'x' }));
  expect(fx.run('cron', 'true').status).toBe(0);
  expect(fx.bunCalls()[2]).toBe(`--config-dir ${fx.configDir} hq fence-wrapper record cron 0`);
  writeFileSync(join(fx.configDir, 'hq', 'fence-outcomes', 'cron.json'), JSON.stringify({ consecutiveFailures: 0, lastRc: 0, lastAt: 'x' }));
  expect(fx.run('cron', 'true').status).toBe(0);
  expect(fx.bunCalls()).toHaveLength(3);
});

test.skipIf(!REAL_TIMEOUT)('FENCE-LIGHT end to end: a real holder heartbeat writes the cache the shell reads; payload contract and missing command keep the CLI', () => {
  const fx = lightFixture();
  const now = nowS();
  const store = fileLeaseStore(join(fx.dir, 'arbiter', 'lease.json'), () => now);
  expect(store.cas(null, serializeLease({ holder: 'mbp', generation: 5, acquiredAt: now, renewedAt: now, ttlSeconds: 1500 }))).toBe(true);
  expect(hqHeartbeat({ config: { hostName: 'mbp' }, store, localPath: join(fx.configDir, 'hq', 'local.json'),
    hostPath: join(fx.home, '.elanous-hq', 'host'), seenPath: join(fx.home, '.elanous-hq', 'seen-generation'), now: () => now, log: () => {} }))
    .toEqual({ outcome: 'renewed', generation: 5 });
  expect(readFileSync(join(fx.configDir, 'hq', 'lease-cache'), 'utf8')).toBe(`mbp 5 ${now + 660} mbp ${MACHINE} ${now}\n`);
  const capture = join(fx.dir, 'capture');
  writeFileSync(capture, `#!/bin/sh\nprintf '%s\\n' "$ELANOUS_HQ_GENERATION" "$@" > '${fx.payload}'\n`, { mode: 0o755 });
  const result = fx.run('cron', capture, 'first', 'second');
  expect(result.status, String(result.stderr)).toBe(0);
  expect(readFileSync(fx.payload, 'utf8')).toBe('5\nfirst\nsecond\n');
  expect(fx.bunCalls()).toEqual([]);
  fx.env.BUN_RC = '2';
  expect(fx.run('cron').status).toBe(2); // no payload: the CLI owns the missing-command error
  expect(fx.bunCalls()[0]).toBe(`--config-dir ${fx.configDir} hq fence --role cron -- /bin/sh -c `);
});

test.skipIf(!REAL_TIMEOUT)('FENCE-LIGHT simulated day: 144 heartbeats × 6 fences — no hang, no CLI call', () => {
  const fx = lightFixture();
  writeFileSync(join(fx.fakeBin, 'date'), `#!/bin/sh\n[ "$1" = +%s ] && { echo "$SIM_NOW"; exit 0; }\nexec /bin/date "$@"\n`, { mode: 0o755 });
  const base = nowS();
  let tick = base;
  const store = fileLeaseStore(join(fx.dir, 'arbiter', 'lease.json'), () => tick);
  expect(store.cas(null, serializeLease({ holder: 'mbp', generation: 2, acquiredAt: base, renewedAt: base, ttlSeconds: 1500 }))).toBe(true);
  for (let interval = 0; interval < 144; interval++) {
    tick = base + interval * 600;
    expect(hqHeartbeat({ config: { hostName: 'mbp' }, store, localPath: join(fx.configDir, 'hq', 'local.json'),
      hostPath: join(fx.home, '.elanous-hq', 'host'), seenPath: join(fx.home, '.elanous-hq', 'seen-generation'), now: () => tick, log: () => {} }).outcome).toBe('renewed');
    for (let i = 0; i < 6; i++) {
      fx.env.SIM_NOW = String(tick + i * 100);
      const child = spawnSync('/bin/sh', [fx.wrapper, 'cron', 'true'], { encoding: 'utf8', env: fx.env, timeout: 5_000 });
      expect(child.status, `${interval}/${i}: ${child.stderr}`).toBe(0);
      expect(child.signal).toBeNull();
    }
  }
  expect(fx.bunCalls()).toEqual([]);
}, 60_000);

test.skipIf(!REAL_TIMEOUT)('FENCE-LIGHT judgement: one fast-path fence call < 50ms with zero bun spawns (median of 20)', () => {
  const fx = lightFixture();
  fx.local({ holder: 'mbp', generation: 2, confirmedAt: nowS(), ttlSeconds: 1500 });
  fx.cache(freshLine(2));
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    expect(fx.run('cron', 'true').status).toBe(0);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[10]!;
  console.info(`hq-fence fast path: min ${samples[0]!.toFixed(1)}ms · median ${median.toFixed(1)}ms · max ${samples[19]!.toFixed(1)}ms (spawn + wrapper + watchdog + true)`);
  // The gate asserts the capability (best of 20) so a loaded gate host does not flake; the median is reported.
  expect(samples[0]!).toBeLessThan(50);
  expect(fx.bunCalls()).toEqual([]);
});

test('dry-run leaves wrapper untouched; yes creates mode 0755, backs up original once', () => {
  const dir = root();
  const path = join(dir, 'bin', 'hq-fence'); mkdirSync(join(dir, 'bin'));
  writeFileSync(path, '#!/bin/sh\nold\n');
  const before = installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', false);
  expect(before.preview).toContain('-old');
  expect(before.preview).toContain('+new');
  expect(readFileSync(path, 'utf8')).toContain('old');
  expect(existsSync(join(dir, 'backups'))).toBe(false);
  const installed = installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', true, { now: () => new Date('2026-10-06T01:02:03Z') });
  expect(readFileSync(installed.backup!, 'utf8')).toContain('old');
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  expect(readFileSync(path, 'utf8')).toContain('new');
  expect(lstatSync(path).mode & 0o777).toBe(0o755);
});

test('isolated HOME: real installed entry, no elanous on PATH — a failing fence lands one owner alert through the entry', () => {
  const dir = root();
  const configDir = join(dir, '.elanous');
  const repoRoot = join(import.meta.dir, '../..');
  const repoEntry = join(repoRoot, 'bin', 'elanous.mjs');
  // ~/.local/share/elanous/current/node_modules/elanous -> this checkout, so the installed entry really exists.
  const pkg = join(dir, '.local', 'share', 'elanous', 'current', 'node_modules');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(repoRoot, join(pkg, 'elanous'));
  // bun only — its own directory may also hold an `elanous` shim, so link bun alone into a fresh directory.
  const bunOnly = join(dir, 'bun-only'); mkdirSync(bunOnly);
  symlinkSync(process.execPath, join(bunOnly, 'bun'));
  const path = `${bunOnly}${delimiter}/usr/bin${delimiter}/bin`;
  const env = { ...process.env, HOME: dir, PATH: path, ELANOUS_STATE_DIR: configDir };
  expect(spawnSync('/bin/sh', ['-c', 'command -v elanous'], { env, encoding: 'utf8' }).status).not.toBe(0);
  const args = [repoEntry, '--test', '--config-dir', configDir, 'hq', 'fence-wrapper', 'install'];
  const preview = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('hq-fence proposed:');
  expect(existsSync(join(configDir, 'bin', 'hq-fence'))).toBe(false);
  const installed = spawnSync(process.execPath, [...args, '--yes'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(installed.status, installed.stderr).toBe(0);
  const wrapper = join(configDir, 'bin', 'hq-fence');
  expect(lstatSync(wrapper).mode & 0o777).toBe(0o755);
  // An unknown role makes `hq fence` exit 1 — a real fence failure, not a lease skip.
  // The installed wrapper names bun by absolute path; run it under the bare cron PATH.
  expect(readFileSync(wrapper, 'utf8')).toContain(`BUN='${realpathSync(process.execPath)}'`);
  const cronEnv = { ...env, PATH: `/usr/bin${delimiter}/bin` };
  const hostDir = join(dir, '.elanous-hq'); mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, 'host'), 'mbp\n');
  mkdirSync(join(configDir, 'hq'), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const lease = fileLeaseStore(join(dir, 'arbiter', 'lease.json'), () => now);
  expect(lease.cas(null, serializeLease({ holder: 'mbp', generation: 4, acquiredAt: now, renewedAt: now, ttlSeconds: 1500 }))).toBe(true);
  expect(hqHeartbeat({ config: { hostName: 'mbp' }, store: lease, localPath: join(configDir, 'hq', 'local.json'),
    hostPath: join(hostDir, 'host'), seenPath: join(dir, 'seen-generation'), now: () => now, log: () => {} })).toEqual({ outcome: 'renewed', generation: 4 });
  const fast = spawnSync('/bin/sh', [wrapper, 'cron', 'printf %s "$ELANOUS_HQ_GENERATION"'],
    { env: cronEnv, encoding: 'utf8', timeout: 5_000 });
  expect(fast.status, fast.stderr).toBe(0);
  expect(fast.stdout).toBe('4');
  expect(existsSync(join(configDir, 'hq', 'fence-outcomes', 'cron.json'))).toBe(false); // no CLI
  // The legacy assertions below run with no cache file, i.e. on the unchanged CLI path (no network fixture here).
  rmSync(join(configDir, 'hq', 'lease-cache'));
  const result = spawnSync('/bin/sh', [wrapper, 'not-a-role', 'echo', 'hello'], { env: cronEnv, encoding: 'utf8', timeout: 120_000 });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).not.toContain('owner alert failed');
  const journal = join(configDir, 'seat-requests', 'requests.jsonl');
  const rows = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { seat: string; source: string });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ seat: 'TC', source: 'loop-checker' });
  // Falsifier: take the installed entry away — with no elanous on PATH the alert cannot land, so no new row.
  rmSync(join(pkg, 'elanous'));
  const gone = spawnSync('/bin/sh', [wrapper, 'not-a-role', 'echo', 'hello'], { env: cronEnv, encoding: 'utf8', timeout: 60_000 });
  expect(gone.status).toBe(1);
  expect(gone.stderr).toContain('owner alert failed');
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(1);
}, 300_000); // spawns the real CLI four times (each spawn has its own 60–120s cap)

test('missing role alerts once and exits 2 instead of a silent shell abort', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const alerts = join(dir, 'alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\ncase "$*" in *"fence-wrapper alert"*) echo "$*" >> '${alerts}'; exit 0;; esac\nexit 9\n`, { mode: 0o755 });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') }), { mode: 0o755 });
  const result = spawnSync('/bin/sh', [wrapper], { encoding: 'utf8', env: { ...process.env, PATH: `/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(2);
  expect(readFileSync(alerts, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('entry present but its alert fails: report on stderr, never fall back to PATH elanous', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const pathAlerts = join(dir, 'path-alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\nexit 5\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${pathAlerts}'\n`, { mode: 0o755 });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') }), { mode: 0o755 });
  const result = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(5);
  expect(result.stderr).toContain('owner alert failed');
  expect(existsSync(pathAlerts)).toBe(false);
});

test('a dangling symlink at the wrapper path is refused, not silently replaced', () => {
  const dir = root();
  mkdirSync(join(dir, 'bin'));
  symlinkSync(join(dir, 'nowhere'), join(dir, 'bin', 'hq-fence'));
  expect(() => installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', true)).toThrow('non-regular');
});

test('audit detection warns only for wrapper worktree cd, not installed build cd', () => {
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq || exit 1')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /home/ubuntu/repo.worktrees/wt-ops-hq && bun entry')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /home/ubuntu/.local/share/elanous/current/node_modules/elanous && bun entry')).toBeUndefined();
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq # fence tree')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq#x')).toContain('warning');
  // Known limit: a worktree path assembled from a variable is not detected.
  expect(repositoryWorktreeCdWarning('WT=/Users/x/wt-ops-hq\ncd "$WT"')).toBeUndefined();
});

test('wrapper names bun by absolute path only — no bare `bun ` call — and refuses a relative bun', () => {
  const body = renderHqFenceWrapper({ entry: '/x/bin/elanous.mjs', configDir: '/cfg', bun: '/opt/bun/bin/bun' });
  expect(body).toContain("BUN='/opt/bun/bin/bun'");
  // Command position only: comments and quoted text (messages) may mention bun.
  const code = body.split('\n').map(line => line.replace(/#.*$/, '').replace(/"[^"]*"|'[^']*'/g, '""'));
  expect(code.some(line => /(^|[;|&(]|then|else|do)\s*bun\s/.test(line))).toBe(false);
  expect(() => renderHqFenceWrapper({ entry: '/x', configDir: '/cfg', bun: 'bun' })).toThrow('absolute');
});

test('resolveHqFenceBun: bun process uses execPath; otherwise the install-time lookup; never a relative name', () => {
  expect(resolveHqFenceBun({ isBun: true, execPath: process.execPath })).toBe(realpathSync(process.execPath));
  expect(resolveHqFenceBun({ isBun: false, lookup: () => `${process.execPath}\n` })).toBe(realpathSync(process.execPath));
  expect(() => resolveHqFenceBun({ isBun: false, lookup: () => '' })).toThrow('absolute bun');
  expect(() => resolveHqFenceBun({ isBun: false, lookup: () => 'bun' })).toThrow('absolute bun');
});

test('bun path missing under cron PATH: exit 127, the log line is always written, and the alert still lands via an absolute fallback bun', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const log = join(dir, 'logs', 'hq-fence.log');
  const wrapper = join(dir, 'hq-fence');
  writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(dir, 'gone', 'bun'), logFile: log }), { mode: 0o755 });
  // No fallback bun under this HOME and a PATH elanous that must NOT be used: exactly one log line.
  const pathAlerts = join(dir, 'path-alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${pathAlerts}'\n`, { mode: 0o755 });
  const bare = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { HOME: dir, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(bare.status).toBe(127);
  expect(existsSync(pathAlerts)).toBe(false);
  const first = readFileSync(log, 'utf8').trim().split('\n');
  expect(first).toHaveLength(1);
  expect(first[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ bun missing or not executable: .*\(rc=127\)$/);
  // A bun at $HOME/.bun/bin (absolute, not PATH) delivers the alert; the bun-missing line is still logged.
  const alerts = join(dir, 'alerts');
  mkdirSync(join(dir, '.bun', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.bun', 'bin', 'bun'), `#!/bin/sh\necho "$*" >> '${alerts}'\n`, { mode: 0o755 });
  rmSync(log);
  const fallback = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { HOME: dir, PATH: `/usr/bin${delimiter}/bin` } });
  expect(fallback.status).toBe(127);
  expect(readFileSync(alerts, 'utf8')).toContain('fence-wrapper alert hq-fence: bun missing or not executable');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
});
