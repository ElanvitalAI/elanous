import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { formatMovePlan, hqMovePlan } from './move-plan.js';
import type { AllLoopEntry } from '../loops/registry.js';

const cron = [
  '*/5 * * * * cd /repo && bun bin/elanous.mjs loop tick',
  "*/6 * * * * hq-fence cron 'elanous loop tick'",
  "*/7 * * * * hq-fence cron 'elanous loop tick' && eln card intake-scan",
  "*/11 * * * * hq-fence cron 'bun scripts/steward.ts' && bun scripts/draft-cleanup.ts",
  '# */8 * * * * elanous loop tick',
  '*/9 * * * * /usr/bin/date +%s',
  '*/10 * * * * bun scripts/other-project.ts',
].join('\n') + '\n';
const result = (status: number | null, stdout = '', stderr = '') => ({ status, stdout, stderr });
const loop = (id: string, host?: string) => ({ id, title: id, kind: 'graph', enabled: true, registered: true, recentStatuses: [], ...(host ? { host } : {}) }) as AllLoopEntry;

test('four measurements list local elanous jobs, host-owned loops, remote identity and launchd without writes', () => {
  const commands: string[] = [];
  const plan = hqMovePlan('mac-mini', {
    localHost: () => 'mbp', hostFile: '/missing/hq-host',
    crontab: () => { commands.push('crontab -l'); return result(0, cron); },
    loops: (opts) => { commands.push('loop status --all'); expect(opts?.schedules?.length).toBe(6); return [loop('local', 'mbp'), loop('elsewhere', 'node-b'), loop('unowned')]; },
    ssh: (host, script) => { commands.push(`ssh ${host} ${script}`); return result(0, 'present\nmac-mini\n'); },
    launchctl: () => { commands.push('launchctl list com.elanous.nexus'); return result(0, 'service'); },
  });
  expect(plan.unfencedCron).toMatchObject({ status: 'measured', value: [{ command: 'cd /repo && bun bin/elanous.mjs loop tick' }, { command: "hq-fence cron 'elanous loop tick' && eln card intake-scan" }, { command: "hq-fence cron 'bun scripts/steward.ts' && bun scripts/draft-cleanup.ts" }] });
  expect(plan.hostLoops).toMatchObject({ status: 'measured', value: [{ id: 'local', host: 'mbp' }] });
  expect(plan.targetHost).toEqual({ status: 'measured', value: { exists: true, name: 'mac-mini' } });
  expect(plan.nexusLaunchd).toEqual({ status: 'measured', value: { present: true, measuredOn: 'local' } });
  expect(formatMovePlan(plan)).toContain('④ local launchd com.elanous.nexus:\n  present (measured on local machine)');
  expect(commands).toHaveLength(4);
  expect(commands[2]).toContain('if [ -f "$HOME/.elanous-hq/host" ]');
  expect(formatMovePlan(plan)).toContain('③ target ~/.elanous-hq/host:');
});

test('standalone bun scripts/draft-cleanup.ts is an unfenced HQ job without CLI or fence tokens', () => {
  const plan = hqMovePlan('mini', {
    localHost: () => 'mbp', hostFile: '/missing/hq-host',
    crontab: () => result(0, '*/5 * * * * bun scripts/draft-cleanup.ts\n*/6 * * * * /usr/bin/date +%s\n*/7 * * * * bun scripts/other-project.ts\n'),
    loops: () => [], ssh: () => result(0, 'absent\n'), launchctl: () => result(0),
  });
  expect(plan.unfencedCron).toEqual({ status: 'measured', value: [{
    raw: '*/5 * * * * bun scripts/draft-cleanup.ts', cron: '*/5 * * * *', command: 'bun scripts/draft-cleanup.ts',
  }] });
});

test('unrelated sibling after a fenced HQ command is not counted as unfenced HQ work', () => {
  const plan = hqMovePlan('mini', {
    localHost: () => 'mbp', hostFile: '/missing/hq-host',
    crontab: () => result(0, "*/5 * * * * hq-fence cron 'elanous loop tick' && /usr/bin/date +%s\n"),
    loops: () => [], ssh: () => result(0, 'absent\n'), launchctl: () => result(0),
  });
  expect(plan.unfencedCron).toEqual({ status: 'measured', value: [] });
});

test('ssh failure and unreadable local sources are 못 잼, while measured absence is not unknown', () => {
  const plan = hqMovePlan('mini', { localHost: () => 'mbp', crontab: () => result(2, '', 'permission denied'),
    ssh: () => result(255, '', 'ssh timeout'), launchctl: () => result(null, '', 'not available') });
  expect(plan.unfencedCron).toEqual({ status: '못 잼', reason: 'permission denied' });
  expect(plan.hostLoops).toEqual({ status: '못 잼', reason: 'permission denied' });
  expect(plan.targetHost).toEqual({ status: '못 잼', reason: 'ssh timeout' });
  expect(plan.nexusLaunchd.status).toBe('못 잼');
  expect(formatMovePlan(plan)).toContain('③ target ~/.elanous-hq/host: 못 잼 (ssh timeout)');
  const absent = hqMovePlan('mini', { localHost: () => 'mbp', crontab: () => result(1, '', 'no crontab for user'),
    loops: () => [], ssh: () => result(0, 'absent\n'), launchctl: () => result(113, '', 'Could not find service "com.elanous.nexus"') });
  expect(absent.unfencedCron).toEqual({ status: 'measured', value: [] });
  expect(absent.targetHost).toEqual({ status: 'measured', value: { exists: false, name: null } });
  expect(absent.nexusLaunchd).toEqual({ status: 'measured', value: { present: false, measuredOn: 'local' } });
  expect(() => hqMovePlan('-oProxyCommand=oops')).toThrow('invalid host');
  const brokenLoops = hqMovePlan('mini', { localHost: () => 'mbp', crontab: () => result(0, cron),
    loops: () => { throw new Error('loop registry unavailable'); }, ssh: () => result(0, 'absent\n'), launchctl: () => result(0) });
  expect(brokenLoops.unfencedCron.status).toBe('measured');
  expect(brokenLoops.hostLoops).toEqual({ status: '못 잼', reason: 'loop registry unavailable' });
  const invalidHostFile = join(mkdtempSync(join(tmpdir(), 'hq-move-invalid-')), 'host');
  try {
    writeFileSync(invalidHostFile, 'mbp\nother\n');
    const bad = hqMovePlan('mini', { hostFile: invalidHostFile, crontab: () => result(0, cron), loops: () => [],
      ssh: () => result(0, 'absent\n'), launchctl: () => result(0) });
    expect(bad.hostLoops).toEqual({ status: '못 잼', reason: 'invalid local HQ host file' });
    expect(bad.unfencedCron.status).toBe('measured');
    writeFileSync(invalidHostFile, 'mbp\n');
    const confirmed = hqMovePlan('mini', { hostFile: invalidHostFile, crontab: () => result(0, cron),
      loops: () => [loop('mine', 'mbp'), loop('other', 'node-b')],
      ssh: () => result(0, 'absent\n'), launchctl: () => result(0) });
    expect(confirmed.from).toBe('mbp');
    expect(confirmed.hostLoops).toMatchObject({ status: 'measured', value: [{ id: 'mine' }] });
  } finally { rmSync(join(invalidHostFile, '..'), { recursive: true, force: true }); }
});

test('missing local HQ identity is unknown, never the system hostname or an empty host-loop inventory', () => {
  const plan = hqMovePlan('mini', { hostFile: '/missing/hq-host', crontab: () => result(0, cron),
    loops: () => [loop('system', 'mbp')], ssh: () => result(0, 'absent\n'), launchctl: () => result(0) });
  expect(plan.from).toBeNull();
  expect(plan.hostLoops).toEqual({ status: '못 잼', reason: 'local HQ host identity not confirmed (~/.elanous-hq/host missing)' });
  expect(plan.unfencedCron.status).toBe('measured');
  expect(formatMovePlan(plan)).toContain('hq move-plan: 못 잼 → mini (read-only)');
  expect(formatMovePlan(plan)).toContain('② local host loops (loop status --all): 못 잼');
});

test('CLI --json reads fake crontab and ssh, and never invokes an install or remote write', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-move-plan-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'repo', 'graphs'), { recursive: true });
    const calls = join(root, 'calls');
    const fake = (name: string, script: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${calls}'\n${script}\n`, { mode: 0o755 });
    fake('crontab', `if [ "$1" = '-l' ]; then printf '%s\\n' '*/5 * * * * elanous card intake-scan'; else exit 9; fi`);
    fake('ssh', `printf 'present\\nmac-mini\\n'`);
    fake('launchctl', `printf 'service\\n'`);
    const cmd = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', 'hq', 'move-plan', '--to', 'mac-mini', '--json'],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: join(root, 'home'), PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
        ELANOUS_CONFIG_DIR: join(root, 'config'), ELANOUS_STATE_DIR: join(root, 'state') } });
    expect(cmd.status, cmd.stderr).toBe(0);
    expect(JSON.parse(cmd.stdout)).toMatchObject({ to: 'mac-mini', from: null,
      unfencedCron: { status: 'measured', value: [{ command: 'elanous card intake-scan' }] },
      hostLoops: { status: '못 잼', reason: 'local HQ host identity not confirmed (~/.elanous-hq/host missing)' },
      targetHost: { status: 'measured', value: { exists: true, name: 'mac-mini' } }, nexusLaunchd: { status: 'measured', value: { present: true, measuredOn: 'local' } } });
    const callsText = readFileSync(calls, 'utf8');
    expect(callsText.split('\n').filter(Boolean)).toHaveLength(3);
    expect(callsText).toContain('crontab -l\n');
    expect(callsText).toContain('ssh -o BatchMode=yes');
    expect(callsText).toContain('launchctl list com.elanous.nexus');
    expect(callsText).not.toMatch(/(?:crontab -(?!l\b)|ssh [^\n]*(?:mkdir|mv|rm|chmod|touch|tee|cat >)|launchctl [^\n]*(?:load|unload|bootout|bootstrap))/);
    expect(callsText).not.toContain('crontab -\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
