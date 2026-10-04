import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGeneration } from '../../scripts/hq/standby-snapshot.js';
import { defaultPromoteRunner, formatPromote, promoteHq, promoteLockAcquire, promoteLockRelease, type PromoteRunner } from './promote.js';

function verifiedHostRunner(home: string): PromoteRunner {
  const { runner } = hostRunner();
  return { ...runner, run(host, script) {
    if (script.includes('standby-verify.ts')) return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, tiers: ['core', 'big'].map(tier => {
      const manifest = readFileSync(join(home, '.elanous-standby', tier, '20261004Z', 'MANIFEST.json'));
      return { tier, generation: '20261004Z', manifestSha256: createHash('sha256').update(manifest).digest('hex'),
        entries: JSON.parse(manifest.toString()).entries.length, checked: JSON.parse(manifest.toString()).entries.length };
    }) }) };
    return runner.run(host, script);
  } };
}

function hostRunner(holder: string | null = 'MacStudioB1') {
  const calls: string[] = [];
  const runner: PromoteRunner = {
    lease: () => ({ holder, generation: holder ? 7 : null, expired: !holder }),
    run(_host, script) {
      calls.push(script);
      if (script.includes('s.bind(("127.0.0.1", 31416))') && !script.includes('nexus run')) return { status: 0, stdout: 'port=31416 available\n', stderr: '' };
      if (script.includes('standby-verify.ts')) return { status: 0, stdout: JSON.stringify({ ok: true, tiers: [
        { tier: 'core', generation: '20261004Z', manifestSha256: 'a'.repeat(64), checked: 2, entries: 2 },
        { tier: 'big', generation: '20261004Z', manifestSha256: 'b'.repeat(64), checked: 1, entries: 1 },
      ] }), stderr: '' };
      return { status: 0, stdout: script.includes('hq promote --help') ? 'host=MacStudioB1'
        : script.includes('HQ_PROMOTE_CORE=') ? 'promotion files=3 bytes=12B'
        : script.includes("config['hq'] = hq") ? 'hq.hostName=MacStudioB1'
        : script.includes('nexus run') ? 'health=200 port=31416 pid=42 listener_pid=42'
        : script.includes('steward mode rescue') ? '{"mode":"rescue"}' : 'OK', stderr: '' };
    },
  };
  return { runner, calls };
}

test('dry-run reports six numbered steps and three preflights but never calls a write command', () => {
  const { runner, calls } = hostRunner();
  const result = promoteHq('node-b', false, runner);
  expect(result.ok).toBe(true);
  expect(result.lines.map(l => l.step[0]).filter(n => '①②③④⑤⑥'.includes(n))).toEqual(['①', '②', '③', '④', '⑤', '⑥']);
  expect(result.lines.filter(l => l.step.startsWith('preflight'))).toHaveLength(3);
  expect(result.lines.slice(4).map(l => l.status)).toEqual(['done', 'ready', 'ready', 'ready', 'ready']);
  expect(calls).toHaveLength(4); // three read-only preflights and MK's read-only checksum verifier
  expect(calls.every(s => !/HQ_PROMOTE_CORE=|mkdtemp|mode rescue|nexus run|os\.replace/.test(s))).toBe(true);
  expect(formatPromote(result)).toContain('dry-run');
  expect(formatPromote(result)).toContain('no writes');
});

test('SSH alias is resolved to the lease and host-local hq identity', () => {
  const { runner } = hostRunner('MacBookProM5');
  const mbp: PromoteRunner = { ...runner, run(host, script) {
    expect(host).toBe('mbp');
    if (script.includes('hq promote --help')) return { status: 0, stdout: 'host=MacBookProM5', stderr: '' };
    return runner.run(host, script);
  } };
  const result = promoteHq('mbp', false, mbp);
  expect(result.ok).toBe(true);
  expect(result.lines.find(line => line.step === '① lease')?.measurement).toContain('holder=MacBookProM5');
  expect(result.lines.find(line => line.step === '④ target hq config')?.command).toContain('HQ_PROMOTE_HOST=MacBookProM5');
});

test('short hq.hostName is accepted only when lease holder matches that exact identity', () => {
  const { runner } = hostRunner('node-b');
  const short: PromoteRunner = { ...runner, run(host, script) {
    if (script.includes('hq promote --help')) return { status: 0, stdout: 'host=node-b', stderr: '' };
    return runner.run(host, script);
  } };
  const valid = promoteHq('node-b', false, short);
  expect(valid.ok).toBe(true);
  expect(valid.lines.find(line => line.step === '④ target hq config')?.command).toContain('HQ_PROMOTE_HOST=node-b');
  const mismatch = promoteHq('node-b', false, { ...short, lease: () => ({ holder: 'MacStudioB1', generation: 7, expired: false }) });
  expect(mismatch.ok).toBe(false);
  expect(mismatch.lines.at(-1)).toMatchObject({ step: '① lease', status: 'failed' });
});

test('lease missing or held by another host stops at ① without copying or starting nexus', () => {
  for (const holder of [null, 'MacBookProM5']) {
    const { runner, calls } = hostRunner(holder);
    const result = promoteHq('node-b', true, runner);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toMatchObject({ step: '① lease', status: 'failed' });
    expect(calls).toHaveLength(3);
  }
});

test('apply executes ordered steps, confirms values and stops when checksum verification fails', () => {
  const { runner, calls } = hostRunner();
  const result = promoteHq('node-b', true, runner);
  expect(result.ok).toBe(true);
  expect(result.lines.slice(3).map(l => l.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  expect(calls.slice(3)[0]).toContain('standby-verify.ts');
  expect(calls.slice(3)[1]).toContain('s.bind(("127.0.0.1", 31416))');
  expect(calls.slice(3)[2]).toContain('HQ_PROMOTE_CORE=20261004Z HQ_PROMOTE_BIG=20261004Z');
  expect(calls.slice(3)[3]).toContain("config['hq'] = hq");
  expect(calls.slice(3)[4]).toContain('--no-mcp');
  expect(calls.slice(3)[5]).toContain('steward mode rescue');
  const broken: PromoteRunner = { ...runner, run(host, script) {
    if (script.includes('standby-verify.ts')) return { status: 0, stdout: '{"ok":false,"tiers":[]}', stderr: '' };
    return runner.run(host, script);
  } };
  const failed = promoteHq('node-b', true, broken);
  expect(failed.lines.at(-1)).toMatchObject({ step: '② standby checksums', status: 'failed' });
  expect(failed.lines.some(l => l.step.startsWith('③'))).toBe(false);
});

test('lease changing after checksum halts before copy', () => {
  const { runner, calls } = hostRunner();
  let reads = 0;
  const changed: PromoteRunner = { ...runner, lease: () => {
    reads++;
    return { holder: reads >= 2 ? 'MacBookProM5' : 'MacStudioB1', generation: reads >= 2 ? 8 : 7, expired: false };
  } };
  const result = promoteHq('node-b', true, changed);
  expect(result.ok).toBe(false);
  expect(result.lines.at(-1)).toMatchObject({ step: '③ copy to promotion universe', status: 'failed' });
  expect(result.lines.at(-1)?.measurement).toContain('lease changed');
  expect(calls).toHaveLength(4);
});

test('failed preflight is reported and blocks apply before checksum and mutations', () => {
  const { runner, calls } = hostRunner();
  const broken: PromoteRunner = { ...runner, run(host, script) {
    if (script.includes('mcp list')) { calls.push(script); return { status: 1, stdout: '', stderr: 'MCP unavailable' }; }
    return runner.run(host, script);
  } };
  const result = promoteHq('node-b', true, broken);
  expect(result.ok).toBe(false);
  expect(result.lines.find(l => l.step === 'preflight MCP list')).toMatchObject({ status: 'failed', measurement: 'MCP unavailable' });
  expect(result.lines.at(-1)?.step).toBe('① lease');
  expect(calls).toHaveLength(3);
});

test('host config mismatch and unhealthy nexus fail closed', () => {
  const { runner, calls } = hostRunner();
  const wrongHost: PromoteRunner = { ...runner, run(host, script) {
    if (script.includes('hq promote --help')) { calls.push(script); return { status: 0, stdout: 'host=MacBookProM5', stderr: '' }; }
    return runner.run(host, script);
  } };
  const preflight = promoteHq('node-b', true, wrongHost);
  expect(preflight.ok).toBe(false);
  expect(preflight.lines.find(l => l.step === 'preflight installed hq')?.status).toBe('failed');
  expect(calls).toHaveLength(3);
  const unhealthy: PromoteRunner = { ...runner, run(host, script) {
    if (script.includes('nexus run')) return { status: 0, stdout: 'health=503 port=31416', stderr: '' };
    return runner.run(host, script);
  } };
  const failed = promoteHq('node-b', true, unhealthy);
  expect(failed.ok).toBe(false);
  expect(failed.lines.at(-1)).toMatchObject({ step: '⑤ nexus health', status: 'failed' });
  expect(failed.lines.some(l => l.step.startsWith('⑥'))).toBe(false);
});

test('copy pins the verified generations even after latest changes and replaces stale HQ files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-copy-'));
  try {
    const standby = join(dir, '.elanous-standby');
    for (const tier of ['core', 'big']) {
      for (const generation of ['20261004Z', '20261005Z']) {
        const root = join(standby, tier, generation);
        mkdirSync(root, { recursive: true });
        const files = tier === 'core'
          ? { 'release/features.sqlite': generation, 'config.json': JSON.stringify({ theme: generation }) }
          : { 'knowledge.db': generation };
        for (const [name, data] of Object.entries(files)) {
          mkdirSync(join(root, name, '..'), { recursive: true });
          writeFileSync(join(root, name), data);
        }
        const entries = Object.entries(files).map(([path, data]) => ({ path, sha256: createHash('sha256').update(data).digest('hex') }));
        writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify({ tier, generation, entries }));
        writeFileSync(join(root, 'SHA256SUMS'), entries.map(e => `${e.sha256}  ${e.path}`).join('\n') + '\n');
      }
      symlinkSync('20261004Z', join(standby, tier, 'latest'));
    }
    mkdirSync(join(dir, '.elanous'));
    writeFileSync(join(dir, '.elanous', 'config.json'), 'live sentinel');
    const target = join(dir, '.elanous-hqstate');
    mkdirSync(target);
    writeFileSync(join(target, 'obsolete.db'), 'old generation');
    const runner = verifiedHostRunner(dir);
    let copy = '';
    const capture: PromoteRunner = { ...runner, run(host, script) {
      if (script.includes('HQ_PROMOTE_CORE=')) {
        copy = script;
        for (const tier of ['core', 'big']) {
          unlinkSync(join(standby, tier, 'latest'));
          symlinkSync('20261005Z', join(standby, tier, 'latest'));
        }
        return { status: 0, stdout: 'promotion files=3 bytes=12B', stderr: '' };
      }
      return runner.run(host, script);
    } };
    expect(promoteHq('node-b', true, capture).ok).toBe(true);
    const runCopy = () => spawnSync('bash', ['-c', copy], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    let actual = runCopy();
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.stdout).toMatch(/promotion files=\d+ bytes=\d+B/);
    expect(readFileSync(join(target, 'release/features.sqlite'), 'utf8')).toBe('20261004Z');
    expect(readFileSync(join(target, 'knowledge.db'), 'utf8')).toBe('20261004Z');
    expect(existsSync(join(target, 'obsolete.db'))).toBe(false);
    writeFileSync(join(target, 'obsolete.db'), 'new stale file');
    actual = runCopy();
    expect(actual.status, actual.stderr).toBe(0);
    expect(existsSync(join(target, 'obsolete.db'))).toBe(false);
    expect(readFileSync(join(dir, '.elanous', 'config.json'), 'utf8')).toBe('live sentinel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('copy refuses changed snapshot contents without replacing the previous HQ universe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-tamper-'));
  try {
    const target = join(dir, '.elanous-hqstate');
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel'), 'keep');
    for (const tier of ['core', 'big']) {
      const root = join(dir, '.elanous-standby', tier, '20261004Z');
      mkdirSync(root, { recursive: true });
      const name = tier === 'core' ? 'release/features.sqlite' : 'knowledge.db';
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), 'modified after verification');
      writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify({ tier, generation: '20261004Z', entries: [
        { path: name, sha256: createHash('sha256').update('verified bytes').digest('hex') },
      ] }));
    }
    const runner = verifiedHostRunner(dir);
    let script = '';
    const capture: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes('HQ_PROMOTE_CORE=')) { script = command; return { status: 0, stdout: 'promotion files=2 bytes=20B', stderr: '' }; }
      return runner.run(host, command);
    } };
    expect(promoteHq('node-b', true, capture).ok).toBe(true);
    const actual = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    expect(actual.status).not.toBe(0);
    expect(actual.stderr).toContain('checksum changed during copy');
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('copy rejects a file and MANIFEST.json changed together after ②, preserving the old universe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-manifest-race-'));
  try {
    const target = join(dir, '.elanous-hqstate');
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel'), 'keep');
    for (const tier of ['core', 'big']) {
      const root = join(dir, '.elanous-standby', tier, '20261004Z');
      mkdirSync(root, { recursive: true });
      const files = tier === 'core' ? { 'release/features.sqlite': 'original', 'config.json': '{}' } : { 'knowledge.db': 'original' };
      const entries = Object.entries(files).map(([path, text]) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
        return { path, sha256: createHash('sha256').update(text).digest('hex') };
      });
      writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify({ tier, generation: '20261004Z', entries }));
    }
    const runner = verifiedHostRunner(dir);
    const capture: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes('HQ_PROMOTE_CORE=')) {
        const root = join(dir, '.elanous-standby', 'core', '20261004Z');
        const manifestPath = join(root, 'MANIFEST.json');
        const changed = JSON.parse(readFileSync(manifestPath, 'utf8'));
        writeFileSync(join(root, 'config.json'), '{"unverified":true}');
        changed.entries.find((entry: { path: string }) => entry.path === 'config.json').sha256 = createHash('sha256').update('{"unverified":true}').digest('hex');
        writeFileSync(manifestPath, JSON.stringify(changed));
        const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      }
      return runner.run(host, command);
    } };
    const result = promoteHq('node-b', true, capture);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toMatchObject({ step: '③ copy to promotion universe', status: 'failed' });
    expect(result.lines.at(-1)?.measurement).toContain('verified manifest changed: core');
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
    expect(existsSync(join(target, 'config.json'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('occupied or unreadable promotion port stops before replacing the existing universe', () => {
  for (const failure of ['port=31416 occupied', 'permission denied']) {
    const dir = mkdtempSync(join(tmpdir(), 'hq-promote-precopy-'));
    try {
      const target = join(dir, '.elanous-hqstate');
      mkdirSync(target);
      writeFileSync(join(target, 'sentinel'), 'previous universe');
      const { runner, calls } = hostRunner();
      const guarded: PromoteRunner = { ...runner, run(host, script) {
        if (script.includes('s.bind(("127.0.0.1", 31416))') && !script.includes('nexus run')) {
          calls.push(script);
          return { status: 1, stdout: '', stderr: failure };
        }
        return runner.run(host, script);
      } };
      const result = promoteHq('node-b', true, guarded);
      expect(result.ok).toBe(false);
      expect(result.lines.at(-1)).toMatchObject({ step: '③ copy to promotion universe', status: 'failed' });
      expect(result.lines.at(-1)?.measurement).toContain(failure);
      expect(calls.some(s => s.includes('HQ_PROMOTE_CORE='))).toBe(false);
      expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('previous universe');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('nexus health refuses an already occupied port even when that listener returns 200', () => {
  const { runner } = hostRunner();
  let script = '';
  const capture: PromoteRunner = { ...runner, run(host, command) {
    if (command.includes('nexus run')) { script = command; return { status: 0, stdout: 'health=200 port=31416 pid=42 listener_pid=42', stderr: '' }; }
    return runner.run(host, command);
  } };
  expect(promoteHq('node-b', true, capture).ok).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-port-'));
  try {
    const lsof = join(dir, 'lsof');
    const curl = join(dir, 'curl');
    const elanous = join(dir, 'elanous');
    writeFileSync(lsof, '#!/bin/sh\ncase "$*" in *-iTCP:31416*) echo 44444;; *) echo "$PPID";; esac\n');
    writeFileSync(curl, '#!/bin/sh\necho 200\n');
    writeFileSync(elanous, '#!/bin/sh\nprintf started >> "$HOME/started"\n');
    for (const file of [lsof, curl, elanous]) chmodSync(file, 0o700);
    const actual = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
    expect(actual.status).not.toBe(0);
    expect(actual.stderr).toContain('port=31416 occupied or unreadable');
    expect(existsSync(join(dir, 'started'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lsof silently returning 1 on every port fails the control listener before replacing HQ state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-lsof-silent-'));
  try {
    const lsof = join(dir, 'lsof');
    writeFileSync(lsof, '#!/bin/sh\nexit 1\n');
    chmodSync(lsof, 0o700);
    const { runner, calls } = hostRunner();
    const remote: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes('s.bind(("127.0.0.1", 31416))') && !command.includes('nexus run')) {
        calls.push(command);
        const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      }
      return runner.run(host, command);
    } };
    const result = promoteHq('node-b', true, remote);
    expect(result.lines.at(-1)).toMatchObject({ step: '③ copy to promotion universe', status: 'failed' });
    expect(result.lines.at(-1)?.measurement).toContain('lsof control listener unreadable');
    expect(calls.some(s => s.includes('HQ_PROMOTE_CORE='))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lsof exit 1 with an error never starts nexus, even if socket bind would succeed', () => {
  const { runner } = hostRunner();
  let script = '';
  const capture: PromoteRunner = { ...runner, run(host, command) {
    if (command.includes('nexus run')) { script = command; return { status: 0, stdout: 'health=200 port=31416 pid=42 listener_pid=42', stderr: '' }; }
    return runner.run(host, command);
  } };
  expect(promoteHq('node-b', true, capture).ok).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-lsof-error-'));
  try {
    mkdirSync(join(dir, '.elanous-hqstate'));
    const lsof = join(dir, 'lsof');
    const elanous = join(dir, 'elanous');
    writeFileSync(lsof, '#!/bin/sh\necho "permission denied" >&2\nexit 1\n');
    writeFileSync(elanous, '#!/bin/sh\necho started > "$HOME/started"\n');
    for (const file of [lsof, elanous]) chmodSync(file, 0o700);
    const actual = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
    expect(actual.status).not.toBe(0);
    expect(actual.stderr).toContain('lsof control listener unreadable: permission denied');
    expect(existsSync(join(dir, 'started'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unhealthy response and timeout terminate the new nexus and release the port', () => {
  const { runner } = hostRunner();
  let script = '';
  const capture: PromoteRunner = { ...runner, run(host, command) {
    if (command.includes('nexus run')) { script = command; return { status: 0, stdout: 'health=200 port=31416 pid=42 listener_pid=42', stderr: '' }; }
    return runner.run(host, command);
  } };
  expect(promoteHq('node-b', true, capture).ok).toBe(true);
  for (const response of ['503', 'timeout']) {
    const dir = mkdtempSync(join(tmpdir(), 'hq-promote-health-fail-'));
    try {
      mkdirSync(join(dir, '.elanous-hqstate'));
      writeFileSync(join(dir, 'lsof'), '#!/bin/sh\ncase "$*" in *-iTCP:31416*) if [ -f "$HOME/nexus-pid" ] && kill -0 "$(cat "$HOME/nexus-pid")" 2>/dev/null; then cat "$HOME/nexus-pid"; else exit 1; fi;; *) echo "$PPID";; esac\n');
      writeFileSync(join(dir, 'elanous'), '#!/bin/sh\necho $$ > "$HOME/nexus-pid"\nexec /usr/bin/sleep 60\n');
      writeFileSync(join(dir, 'curl'), response === 'timeout' ? '#!/bin/sh\nexit 28\n' : '#!/bin/sh\necho 503\n');
      writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n/usr/bin/sleep 0.01\n');
      for (const name of ['lsof', 'elanous', 'curl', 'sleep']) chmodSync(join(dir, name), 0o700);
      const actual = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
      expect(actual.status, actual.stderr).toBe(1);
      expect(actual.stderr).toContain('nexus stopped port=31416 released');
      const pid = Number(readFileSync(join(dir, 'nexus-pid'), 'utf8').trim());
      expect(() => process.kill(pid, 0)).toThrow();
      expect(actual.stderr).toContain(response === 'timeout' ? 'health=000' : 'health=503');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a surviving new process cannot claim an existing process health=200 after launch', () => {
  const { runner } = hostRunner();
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-race-'));
  try {
    mkdirSync(join(dir, '.elanous-hqstate'));
    const lsof = join(dir, 'lsof');
    const elanous = join(dir, 'elanous');
    const curl = join(dir, 'curl');
    writeFileSync(lsof, '#!/bin/sh\ncase "$*" in *-iTCP:31416*) if [ ! -f "$HOME/probed" ]; then touch "$HOME/probed"; exit 1; fi; echo 44444;; *) echo "$PPID";; esac\n');
    writeFileSync(elanous, '#!/bin/sh\nprintf started > "$HOME/started"\nsleep 3\n');
    writeFileSync(curl, '#!/bin/sh\nprintf 200\n');
    for (const file of [lsof, elanous, curl]) chmodSync(file, 0o700);
    const capture: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes('nexus run')) {
        const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` }, timeout: 40_000 });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      }
      return runner.run(host, command);
    } };
    const result = promoteHq('node-b', true, capture);
    expect(existsSync(join(dir, 'started')), result.lines.at(-1)?.measurement).toBe(true);
    expect(result.lines.at(-1)).toMatchObject({ step: '⑤ nexus health', status: 'failed' });
    expect(result.lines.some(line => line.step.startsWith('⑥'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nexus health accepts only a 200 from the spawned listener PID', () => {
  const { runner } = hostRunner();
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-owner-'));
  try {
    mkdirSync(join(dir, '.elanous-hqstate'));
    const lsof = join(dir, 'lsof');
    const elanous = join(dir, 'elanous');
    const curl = join(dir, 'curl');
    writeFileSync(lsof, '#!/bin/sh\ncase "$*" in *-iTCP:31416*) if [ ! -f "$HOME/probed" ]; then touch "$HOME/probed"; exit 1; fi; cat "$HOME/nexus-pid";; *) echo "$PPID";; esac\n');
    writeFileSync(elanous, '#!/bin/sh\necho $$ > "$HOME/nexus-pid"\nsleep 3\n');
    writeFileSync(curl, '#!/bin/sh\nprintf 200\n');
    for (const file of [lsof, elanous, curl]) chmodSync(file, 0o700);
    const capture: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes('nexus run')) {
        const res = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` }, timeout: 40_000 });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      }
      return runner.run(host, command);
    } };
    const result = promoteHq('node-b', true, capture);
    expect(result.ok, result.lines.at(-1)?.measurement).toBe(true);
    expect(result.lines.find(line => line.step === '⑤ nexus health')?.measurement).toMatch(/health=200 port=31416 pid=\d+ listener_pid=\d+/);
    expect(result.lines.at(-1)?.step).toBe('⑥ steward rescue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('target hq update executes against a temporary home, leaving live config untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-script-'));
  try {
    mkdirSync(join(dir, '.elanous-hqcfg'));
    mkdirSync(join(dir, '.elanous-hqstate'));
    mkdirSync(join(dir, '.elanous'));
    writeFileSync(join(dir, '.elanous-hqcfg', 'config.json'), JSON.stringify({ hq: { hostName: 'MacStudioB1', arbiter: 'cloud-vm' } }));
    writeFileSync(join(dir, '.elanous-hqstate', 'config.json'), JSON.stringify({ theme: 'blue', hq: { hostName: 'mbp' } }));
    writeFileSync(join(dir, '.elanous', 'config.json'), 'live sentinel');
    const { runner } = hostRunner();
    let script = '';
    const capture: PromoteRunner = { ...runner, run(host, command) {
      if (command.includes("config['hq'] = hq")) { script = command; return { status: 0, stdout: 'hq.hostName=MacStudioB1', stderr: '' }; }
      return runner.run(host, command);
    } };
    expect(promoteHq('node-b', true, capture).ok).toBe(true);
    const actual = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.stdout.trim()).toBe('hq.hostName=MacStudioB1');
    expect(JSON.parse(readFileSync(join(dir, '.elanous-hqstate', 'config.json'), 'utf8'))).toEqual({ theme: 'blue', hq: { hostName: 'MacStudioB1', arbiter: 'cloud-vm' } });
    expect(statSync(join(dir, '.elanous-hqstate', 'config.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.elanous', 'config.json'), 'utf8')).toBe('live sentinel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MK checksum verification runs against a real generated standby snapshot before any copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-verify-'));
  try {
    const source = join(dir, 'source');
    const standby = join(dir, '.elanous-standby');
    mkdirSync(source);
    writeFileSync(join(source, 'config.json'), JSON.stringify({ theme: 'blue' }));
    const now = new Date();
    const generation = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const core = join(standby, 'core', generation);
    buildGeneration({ root: source, out: core, tier: 'core', host: 'mbp', now });
    symlinkSync(generation, join(standby, 'core', 'latest'));
    const big = join(standby, 'big', generation);
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, 'knowledge.db'), 'big snapshot');
    const digest = createHash('sha256').update('big snapshot').digest('hex');
    writeFileSync(join(big, 'SHA256SUMS'), `${digest}  knowledge.db\n`);
    writeFileSync(join(big, 'MANIFEST.json'), JSON.stringify({ tier: 'big', host: 'mbp', generation, createdAt: now.toISOString(), entries: [{ path: 'knowledge.db', sha256: digest }] }));
    symlinkSync(generation, join(standby, 'big', 'latest'));
    const { runner } = hostRunner();
    const actual: PromoteRunner = { ...runner, run(host, script) {
      if (script.includes('standby-verify.ts')) {
        const command = script.replace('cd "$HOME/.local/share/elanous/current/node_modules/elanous"', `cd '${join(import.meta.dir, '../..')}'`);
        const res = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: dir }, timeout: 60_000 });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      }
      return runner.run(host, script);
    } };
    expect(promoteHq('node-b', false, actual).lines.find(line => line.step.startsWith('②'))).toMatchObject({ status: 'done' });
    const next = '20261005Z';
    mkdirSync(join(standby, 'core', next));
    unlinkSync(join(standby, 'core', 'latest'));
    symlinkSync(next, join(standby, 'core', 'latest'));
    const pinned = await import('../../scripts/hq/standby-verify.js');
    const stillVerified = await pinned.verifyStandby({ root: standby, tiers: ['core'], generations: { core: generation } });
    expect(stillVerified.ok).toBe(true);
    writeFileSync(join(standby, 'core', generation, 'config.json'), 'damaged');
    unlinkSync(join(standby, 'core', 'latest'));
    symlinkSync(generation, join(standby, 'core', 'latest'));
    const failed = promoteHq('node-b', false, actual);
    expect(failed.ok).toBe(false);
    expect(failed.lines.at(-1)).toMatchObject({ step: '② standby checksums', status: 'failed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test('real CLI routes a dry-run to a fake host executable without invoking remote writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-cli-'));
  try {
    const fake = join(dir, 'ssh');
    const log = join(dir, 'commands');
    const configDir = join(dir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ hq: { arbiter: 'cloud-vm' } }));
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HQ_FAKE_LOG"\ncase "$*" in\n *'date +%s && echo ----'*) printf '1000000\\n----\\n{"holder":"MacStudioB1","generation":7,"acquiredAt":999000,"renewedAt":999999,"ttlSeconds":1500}\\n';;\n *'standby-verify.ts'*) printf '%s\\n' '{"ok":true,"tiers":[{"tier":"core","generation":"core-gen","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checked":1,"entries":1},{"tier":"big","generation":"big-gen","manifestSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","checked":1,"entries":1}]}';;\n *'hq promote --help'*) echo host=MacStudioB1;;\n *) echo OK;;\nesac\n`);
    chmodSync(fake, 0o700);
    const cli = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, 'hq', 'promote', '--to', 'node-b', '--json'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, HQ_FAKE_LOG: log },
    });
    expect(cli.status, cli.stderr).toBe(0);
    const report = JSON.parse(cli.stdout.trim().split('\n').at(-1)!);
    expect(report.lines.map((line: { step: string }) => line.step[0]).filter((step: string) => '①②③④⑤⑥'.includes(step)))
      .toEqual(['①', '②', '③', '④', '⑤', '⑥']);
    expect(readFileSync(log, 'utf8')).not.toMatch(/HQ_PROMOTE_CORE=|mkdtemp|nexus run|steward mode rescue/);
    expect(report.apply).toBe(false);
    const absent = join(dir, 'absent');
    writeFileSync(fake, readFileSync(fake, 'utf8').replace('"holder":"MacStudioB1"', '"holder":"MacBookProM5"'));
    const denied = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, 'hq', 'promote', '--to', 'node-b', '--apply', '--json'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, HQ_FAKE_LOG: absent },
    });
    expect(denied.status).toBe(1);
    expect(JSON.parse(denied.stdout.trim().split('\n').at(-1)!).lines.at(-1)).toMatchObject({ step: '① lease', status: 'failed' });
    expect(readFileSync(absent, 'utf8')).not.toMatch(/HQ_PROMOTE_CORE=|mkdtemp|nexus run|steward mode rescue/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test('default SSH runner retains shell quotes and newlines in the remote script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-remote-bash-'));
  const oldPath = process.env.PATH;
  try {
    const ssh = join(dir, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\nshift 3\nexec sh -c "$1"\n');
    chmodSync(ssh, 0o700);
    process.env.PATH = `${dir}:${oldPath}`;
    const result = defaultPromoteRunner().run('node-b', `printf '%s\\n' 'quoted value'\nprintf '%s\\n' second`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('quoted value\nsecond\n');
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test('host is data, not shell syntax', () => {
  const { runner, calls } = hostRunner();
  expect(() => promoteHq('node-b; touch /tmp/unsafe', true, runner)).toThrow('invalid host');
  expect(calls).toHaveLength(0);
});

test('a second --apply on the same host is refused before copy, and a finished apply releases the host lock', () => {
  const { runner, calls } = hostRunner();
  expect(promoteHq('node-b', true, runner).ok).toBe(true);
  expect(calls.at(-1)).toBe(promoteLockRelease);
  expect(calls.some(c => c.startsWith(promoteLockAcquire))).toBe(true);
  const held: PromoteRunner = { ...runner, run(host, script) {
    if (script.startsWith(promoteLockAcquire)) return { status: 1, stdout: '', stderr: 'promote lock held: 4242 2026-10-04T10:00:00Z' };
    return runner.run(host, script);
  } };
  calls.length = 0;
  const refused = promoteHq('node-b', true, held);
  expect(refused.ok).toBe(false);
  expect(refused.lines.at(-1)).toMatchObject({ step: '③ copy to promotion universe', status: 'failed' });
  expect(refused.lines.at(-1)?.measurement).toContain('promote lock held');
  expect(calls.some(c => c.includes('HQ_PROMOTE_CORE='))).toBe(false);
  expect(calls).not.toContain(promoteLockRelease); // the other apply still owns it
});

test('the host lock is exclusive in a real shell until released', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-lock-'));
  try {
    const sh = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    expect(sh(promoteLockAcquire).status).toBe(0);
    const second = sh(promoteLockAcquire);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('promote lock held:');
    expect(sh(promoteLockRelease).status).toBe(0);
    expect(sh(promoteLockAcquire).status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed health check also stops grandchildren of the new nexus', () => {
  const { runner } = hostRunner();
  let script = '';
  const capture: PromoteRunner = { ...runner, run(host, command) {
    if (command.includes('nexus run')) { script = command; return { status: 0, stdout: 'health=200 port=31416 pid=42 listener_pid=42', stderr: '' }; }
    return runner.run(host, command);
  } };
  expect(promoteHq('node-b', true, capture).ok).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'hq-promote-tree-'));
  let grandchild = 0;
  try {
    mkdirSync(join(dir, '.elanous-hqstate'));
    writeFileSync(join(dir, 'lsof'), '#!/bin/sh\ncase "$*" in *-iTCP:31416*) exit 1;; *) echo "$PPID";; esac\n');
    writeFileSync(join(dir, 'elanous'), '#!/bin/sh\n( /bin/sleep 60 & echo $! > "$HOME/grandchild-pid"; wait ) &\nexec /bin/sleep 60\n');
    writeFileSync(join(dir, 'curl'), '#!/bin/sh\necho 503\n');
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n/bin/sleep 0.05\n');
    for (const name of ['lsof', 'elanous', 'curl', 'sleep']) chmodSync(join(dir, name), 0o700);
    const actual = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
    expect(actual.status, actual.stderr).toBe(1);
    grandchild = Number(readFileSync(join(dir, 'grandchild-pid'), 'utf8').trim());
    expect(grandchild).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(grandchild, 0); spawnSync('/bin/sleep', ['0.05']); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  } finally {
    if (grandchild > 0) { try { process.kill(grandchild); } catch { /* already gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
