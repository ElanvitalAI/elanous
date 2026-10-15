// GATE-WARM-BOOT-STAGES (0.2.30) — the shard json says where a Pod's boot went: prep start (the child container's
// PID 1), clone end (the source checkout done, the shard shell's first line), deps end and test start, in that order.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, gateShardShell, type GateRunner } from './gate-node';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';

const CUT = 'b'.repeat(40);
const BOOT = ['prep-start', 'clone-end', 'deps-end', 'test-start'] as const;
const dirs: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A fake `bun` (install · test:deterministic) and `timeout` for running the real shard shell on this machine. */
function fakeTools(bin: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
if [ "$1" = install ]; then echo "1 package installed [1ms]"; exit 0; fi
shift 2
files=(); out=
for a in "$@"; do case "$a" in --reporter-outfile=*) out="\${a#--reporter-outfile=}";; --*) ;; *) files+=("\${a#./}");; esac; done
{ echo '<testsuites>'; for f in "\${files[@]}"; do echo "<testsuite name=\\"$f\\" file=\\"$f\\"><testcase name=\\"works\\" file=\\"$f\\"></testcase></testsuite>"; done; echo '</testsuites>'; } > "$out"
echo "\${#files[@]} pass"; echo "0 fail"; echo "Ran \${#files[@]} tests across \${#files[@]} files."
`);
  writeFileSync(join(bin, 'timeout'), '#!/bin/bash\n[ "$1" = -k ] && shift 2\nshift\nexec "$@"\n');
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'timeout'), 0o755);
}

/** Run the real shard shell with a fixed container age (seconds since PID 1); returns the outbox. */
function runShell(shell: string, root: string, repo: string, podAge: number): string {
  const home = join(root, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home);
  const run = spawnSync('bash', ['-c', shell.replace(/^(pod_age|boot_age)=\$\(awk.*$/gm, (_m, v) => `${v}=${podAge}`)], {
    cwd: repo, encoding: 'utf8', timeout: 20_000, env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home },
  });
  expect(run.status).toBe(0);
  return join(home, 'outbox');
}

function setup() {
  const root = temp('gate-boot-');
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(repo, 'release'));
  writeFileSync(join(repo, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: [] }));
  fakeTools(join(root, 'bin'));
  return { root, repo };
}

test('the shard json carries prep start · clone end · deps end · test start from the real shell, in order', async () => {
  const { root, repo } = setup();
  const files = ['src/a.test.ts'];
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: cmd === 'rg' ? 1 : 0, output: '' };
  };
  const runner = createGateRunner(repo, undefined, command, async (o) => ({ exitCode: 0, artifactsDir: runShell(o.command[2]!, root, repo, 7), job: 'fake' }),
    new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1, stallSeconds: 0 });
  expect(result.rc).toBe(0);
  const stages = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8')).podStages as Record<string, number>;
  for (const stage of BOOT) expect(Number.isInteger(stages[stage])).toBe(true);
  const times = BOOT.map((stage) => stages[stage]!);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  // Prep start is the container's start: the given age before the shell's first line (± the second the shell straddled).
  expect(stages['clone-end']! - stages['prep-start']!).toBeGreaterThanOrEqual(7);
  expect(stages['clone-end']! - stages['prep-start']!).toBeLessThanOrEqual(8);
}, 30_000);

test('an unknown container age writes no prep start rather than a made-up one; the other three stay', () => {
  const { root, repo } = setup();
  const shell = gateShardShell({ parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 30, cachePrefix: '', installSlots: 0 });
  const stages = readFileSync(join(runShell(shell, root, repo, 0), 'stages.tsv'), 'utf8');
  expect(stages).not.toMatch(/\tprep-start$/m);
  for (const stage of BOOT.slice(1)) expect(stages).toMatch(new RegExp(`^\\d+\\t${stage}$`, 'm'));
}, 30_000);

test('clone-end and shell-start share the shell entry moment captured before the Pod age is read', () => {
  const shell = gateShardShell({ parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 30, cachePrefix: '', installSlots: 0 });
  const entry = shell.indexOf('shell_t=$(date +%s)');
  const age = shell.indexOf('boot_age=$(awk');
  expect(entry).toBeGreaterThanOrEqual(0);
  expect(entry).toBeLessThan(age);
  expect(shell).toContain('stage_at "$shell_t" clone-end');
  expect(shell).toContain('stage_at "$shell_t" shell-start');
  expect(shell).toContain('stage_at "$(( shell_t - boot_age ))" prep-start');
});

test('gate_end still reads the Pod age after the cache prefix and env baseline (deadline meaning unchanged)', () => {
  const shell = gateShardShell({ parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 30, cachePrefix: 'CACHE_PREFIX_MARK=1', installSlots: 0 });
  const prefix = shell.indexOf('CACHE_PREFIX_MARK=1');
  const age = shell.indexOf('pod_age=$(awk');
  const end = shell.indexOf('gate_end=$(');
  expect(prefix).toBeGreaterThanOrEqual(0);
  expect(age).toBeGreaterThan(prefix);
  expect(end).toBeGreaterThan(age);
});
