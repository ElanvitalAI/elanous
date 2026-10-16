// POD-LIFECYCLE-STAGES — a gate shard Pod emits `pod.lifecycle stages` from the same values its pod-N.json carries.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, readGatePodLifecycle, type GateRunner } from './gate-node';
import { gatePodLifecycleEvent } from '../../src/task-orchestrator/surfaces/pod-lifecycle-stages.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { debug } from '../../src/debug/log.js';

const CUT = 'b'.repeat(40);
const dirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

function runShell(shell: string, root: string, repo: string, podAge: number): string {
  const home = join(root, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home);
  const run = spawnSync('bash', ['-c', shell.replace(/^(pod_age|boot_age)=\$\(awk.*$/gm, (_m, v) => `${v}=${podAge}`)], {
    cwd: repo, encoding: 'utf8', timeout: 20_000, env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home },
  });
  expect(run.status).toBe(0);
  return join(home, 'outbox');
}

async function sweep(podAge: number, podCommand?: Parameters<typeof createGateRunner>[3]) {
  const root = mkdtempSync(join(tmpdir(), 'gate-podlife-'));
  dirs.push(root);
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(repo, 'release'));
  writeFileSync(join(repo, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: [] }));
  fakeTools(join(root, 'bin'));
  const files = ['src/a.test.ts'];
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: cmd === 'rg' ? 1 : 0, output: '' };
  };
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  spies.push(spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => { events.push({ category, event, data: data as Record<string, unknown> }); }) as typeof debug.log));
  const runner = createGateRunner(repo, undefined, command, podCommand ?? (async (o) => ({ exitCode: 0, artifactsDir: runShell(o.command[2]!, root, repo, podAge), job: 'gate-fake-job' })),
    new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1, stallSeconds: 0 }).catch((error: unknown) => ({ rc: -1, error: String(error) }));
  const json = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8')) as { rc: number; host?: string; podStages: Record<string, number>; phaseTimes: Record<string, string> };
  return { result, json, lines: events.filter((e) => e.category === 'pod.lifecycle' && e.event === 'stages').map((e) => e.data) };
}

test('one line per shard Pod: the pod-0.json stage values, in ms, with the not-measured stages named', async () => {
  const { result, json, lines } = await sweep(7);
  expect(result.rc).toBe(0);
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  // The fake podCommand never places the Job on a member, so the shard json has no host — the line says null, not a guess.
  expect(json.host).toBeUndefined();
  expect(line).toMatchObject({ kind: 'gate', podJob: 'gate-fake-job', host: null, shard: 'pod-0', outcome: 'pass' });
  const stages = line.stages as Array<{ stage: string; start: number; end: number; clock: string }>;
  const s = json.podStages;
  expect(stages.find((x) => x.stage === 'clone')).toEqual({ stage: 'clone', start: s['prep-start']! * 1000, end: s['clone-end']! * 1000, clock: 'pod' });
  expect(stages.find((x) => x.stage === 'deps')).toEqual({ stage: 'deps', start: s['deps-start']! * 1000, end: s['deps-end']! * 1000, clock: 'pod' });
  expect(stages.find((x) => x.stage === 'test')).toEqual({ stage: 'test', start: s['test-start']! * 1000, end: s['test-end']! * 1000, clock: 'pod' });
  // A pool override reads no k8s Pod lifecycle — create/schedule are named missing, not 0 s; mirror/delete are never timed per Pod.
  expect(line.missing).toEqual(['create', 'schedule', 'mirror', 'delete']);
});

test('an unknown container age leaves clone missing (no prep-start) — the rest of the line still comes', async () => {
  const { json, lines } = await sweep(0);
  expect(json.podStages['prep-start']).toBeUndefined();
  expect(lines).toHaveLength(1);
  expect(lines[0]!.missing).toEqual(['create', 'schedule', 'clone', 'mirror', 'delete']);
  expect((lines[0]!.stages as Array<{ stage: string }>).map((x) => x.stage)).toEqual(['deps', 'test']);
});

test('a launch that throws before the Job returns emits no line — no Pod to describe (the shard json still records jobFailed)', async () => {
  const { result, json, lines } = await sweep(7, async () => { throw new Error('kubectl apply refused'); });
  expect(result.rc).not.toBe(0);   // the sweep itself fails closed (incomplete) — unchanged by this line
  expect((json as unknown as { jobFailed: boolean }).jobFailed).toBe(true);
  expect(lines).toEqual([]);
});

test('the k8s Pod read (readGatePodLifecycle) feeds create and schedule with its own times', () => {
  const kubectlJson = JSON.stringify({ items: [{ metadata: { creationTimestamp: '2026-10-16T00:00:03Z' }, status: {
    conditions: [{ type: 'PodScheduled', lastTransitionTime: '2026-10-16T00:00:05Z' }],
    containerStatuses: [{ name: 'child', state: { terminated: { startedAt: '2026-10-16T00:00:06Z', finishedAt: '2026-10-16T00:04:59Z' } } }] } }] });
  const event = gatePodLifecycleEvent({ shard: 'pod-0', phaseTimes: { poolPlaced: '2026-10-16T00:00:02.000Z' }, podLifecycle: readGatePodLifecycle(kubectlJson), outcome: 'pass' });
  expect(event.stages).toEqual([
    { stage: 'create', start: Date.parse('2026-10-16T00:00:02.000Z'), end: Date.parse('2026-10-16T00:00:03Z'), clock: 'mixed' },
    { stage: 'schedule', start: Date.parse('2026-10-16T00:00:03Z'), end: Date.parse('2026-10-16T00:00:05Z'), clock: 'k8s' },
  ]);
  expect(event.missing).toEqual(['clone', 'mirror', 'deps', 'test', 'delete']);
});
