import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { releaseLoopConfig } from '../../../scripts/release-loop/unattended-release.js';
import { excludeGatePoolMembers } from './gate-pod-pool-policy.js';

const repo = resolve(import.meta.dir, '../../..');
const entry = join(repo, 'bin/elanous.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pod-admission-cli-'));
  const bin = join(root, 'bin');
  const temp = join(root, 'tmp');
  mkdirSync(bin);
  mkdirSync(temp);
  const state = join(root, 'jobs.json');
  const config = join(root, 'state');
  mkdirSync(config);
  writeFileSync(state, JSON.stringify({ applied: [], completed: [], measured: [], features: [] }));
  writeFileSync(join(config, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'pool-gate@192.0.2.4:1' } } }));
  const trafficSignal = join(root, 'traffic.json');
  // Missing traffic fails closed into SSH host-identity resolution, unavailable in the gate image.
  // This fixture targets local goal dispatch, not release-gate host exclusion.
  writeFileSync(trafficSignal, JSON.stringify({ global: 'green', podTarget: 0 }));
  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable('docker', `if (process.argv.includes('inspect')) console.log(process.argv.includes('{{index .Config.Labels "elanous.pod-skills"}}') ? process.env.TEST_SKILLS : process.env.TEST_HEAD);`);
  executable('gh', `if (process.argv.includes('token')) console.log('test-gh-token');`);
  executable('kubectl', `
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.TEST_JOBS;
const get = () => JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const output = (data) => console.log(JSON.stringify(data));
const name = args[args.indexOf('job') + 1];
if (args.includes('apply')) {
  const object = JSON.parse(readFileSync(0, 'utf8'));
  if (object.kind === 'Secret') {
    const state = get(); state.features.push(object.stringData.feature);
    writeFileSync(path, JSON.stringify(state));
  }
  if (object.kind === 'Job') {
    const state = get(); state.applied.push(object.metadata.name);
    state.annotations = { ...(state.annotations ?? {}), [object.metadata.name]: object.metadata.annotations ?? {} };
    writeFileSync(path, JSON.stringify(state));
  }
} else if (args.includes('deployment') && args.includes('coredns')) output({ spec: { replicas: 1 }, status: { readyReplicas: 1 } });
else if (args.includes('create') && args.includes('-f')) { try { readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
else if (args.includes('wait')) console.log('condition met');
else if (args.some((a) => a.startsWith('pod/elanous-dns-')) && args.includes('logs')) console.log('Name: kubernetes.default.svc.cluster.local\\nAddress: 10.43.0.1');
else if (args.some((a) => a.startsWith('pod/elanous-dns-')) && args.includes('get')) output({ status: { phase: 'Succeeded' } });
else if (args.some((a) => a.startsWith('pod/elanous-dns-'))) console.log('');
else if (args.includes('top')) process.exit(1); // no metrics-server: POD-ADMIT-BY-USAGE keeps limit reservations
else if (args.includes('nodes')) output({ items: [{ metadata: { name: 'node' }, status: { allocatable: { memory: '32Gi', cpu: '8' }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
else if (args.includes('jobs')) output({ items: get().applied.filter((n) => !get().completed.includes(n)).map((n) => ({ metadata: { name: n, labels: { 'elanous.substrate': 'pod' }, annotations: (get().annotations ?? {})[n] ?? {} } })) });
else if (args.includes('pods')) {
  const state = get(); state.measured.push(state.applied.length); writeFileSync(path, JSON.stringify(state));
  output({ items: state.applied.filter((n) => !state.completed.includes(n)).map((n) => ({ metadata: { namespace: 'elanous-test', name: n, labels: { 'elanous.substrate': 'pod', 'elanous.job': n } }, spec: { nodeName: 'node', containers: [{ resources: { requests: { memory: '4Gi' }, limits: { memory: '16Gi' } } }] }, status: { phase: 'Running' } })) });
}
else if (args.includes('get') && args.includes('job') && args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) process.exit(1);
else if (args.includes('get') && args.includes('job') && args.includes('jsonpath={.status.conditions[*].type}')) console.log(get().completed.includes(name) ? 'Complete' : '');
else if (args.includes('get') && args.includes('job') && args.includes('jsonpath={.metadata.uid}')) console.log('');
else if (args.includes('config')) console.log('fake');
`);
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const codex = join(root, 'codex');
  mkdirSync(join(xdg, 'elanous'), { recursive: true });
  mkdirSync(codex);
  mkdirSync(home);
  const token = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 24 * 3600 })).toString('base64url')}.x`;
  writeFileSync(join(codex, 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'test', refresh_token: '' } }));
  writeFileSync(join(xdg, 'elanous/auth.json'), JSON.stringify({ providers: { 'openai-codex:team': { codexHome: codex, tokens: { accessToken: token } } } }));
  const cleanEnv = {
    PATH: [bin, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home, XDG_CONFIG_HOME: xdg, TMPDIR: temp, NODE_ENV: '',
    ELANOUS_TRAFFIC_SIGNAL: trafficSignal,
  };
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: cleanEnv }).stdout.trim();
  // The child resolves Pod skills under the fixture HOME — the fake image label must carry that same digest.
  const digest = spawnSync('bun', ['-e', "import {podSkillsDigest,resolvePodSkills} from './src/task-orchestrator/surfaces/pod-skills.ts'; console.log(podSkillsDigest(resolvePodSkills().skills).digest)"],
    { cwd: repo, encoding: 'utf8', env: cleanEnv }).stdout.trim();
  // Gate command Pods inherit host-specific ELANOUS_*, Kubernetes and kube-context settings.
  // Build a child allowlist so an isolated CLI test cannot be redirected by its runner's environment.
  const env = {
    ...cleanEnv,
    ELANOUS_STATE_DIR: join(root, 'state'),
    TEST_JOBS: state, TEST_HEAD: head, TEST_SKILLS: digest, ELANOUS_POD_POOL: 'fake@127.0.0.1:3',
    ELANOUS_GROUNDING_URL: '', ELANOUS_RUN_ID: '',
    ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
    // L7e: without this the child CLI uses the host lease directory.
    ELANOUS_POD_LEASE_DIR: join(root, 'pod-leases'),
  };
  return { root, state, env, config };
}

test('isolated harness ask keeps local goal input off the Pod pool', async () => {
  const { root, state, env, config } = fixture();
  const goal = join(root, 'goal.md');
  writeFileSync(goal, 'First distinct goal');
  // Keep child diagnostics on disk so early gate-environment exits are actionable.
  const childStdout = join(root, 'child.stdout.log');
  const childStderr = join(root, 'child.stderr.log');
  const child = Bun.spawn(['bun', entry, '--config-dir', config, '--test=' + config, 'harness', 'ask', goal,
    '--substrate', 'pod', '--pod-pool', 'fake@127.0.0.1:3'], {
    cwd: repo, env, stdout: Bun.file(childStdout), stderr: Bun.file(childStderr),
  });
  const runs = join(config, 'self-dev-runs');
  try {
    let started = false;
    for (let i = 0; i < 400 && child.exitCode === null; i++) {
      try { started = readdirSync(runs).some((name) => name.endsWith('.json')); } catch { /* run not recorded yet */ }
      if (started) break;
      await Bun.sleep(50);
    }
    expect(env).not.toHaveProperty('ELANOUS_RESOURCE_LANE');
    expect(env).not.toHaveProperty('ELANOUS_RESOURCE_HOST');
    expect(env).not.toHaveProperty('ELANOUS_SUBSTRATE');
    expect(env).not.toHaveProperty('KUBECONFIG');
    if (!started && child.exitCode !== null) {
      throw new Error(`harness ask exited before writing self-dev-runs (exitCode=${child.exitCode})\nstdout:\n${readFileSync(childStdout, 'utf8')}\nstderr:\n${readFileSync(childStderr, 'utf8')}`);
    }
    expect(started).toBe(true);
    expect((JSON.parse(readFileSync(state, 'utf8')) as { applied: string[] }).applied).toHaveLength(0);
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('release gate policy reads gatePodPool from the explicit isolated config and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-gate-config-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ release: { loop: { gatePodPool: 'pool-gate@not-resolvable.invalid:1' } } }));
  try {
    const gatePool = releaseLoopConfig(configPath).gatePodPool;
    const result = excludeGatePoolMembers('fake@127.0.0.1:3', gatePool, { global: 'gate', podTarget: 0 }, 'fixture-local',
      (host) => host === 'not-resolvable.invalid' || host === '127.0.0.1' ? '10.0.0.7' : null);
    expect(result).toEqual({ active: true, gateHosts: ['not-resolvable.invalid'], reason: 'task-pod-pool-has-no-host-outside-release-gate-pool' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
