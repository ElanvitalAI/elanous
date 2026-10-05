import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../../..');
const entry = join(repo, 'bin/elanous.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pod-admission-cli-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const state = join(root, 'jobs.json');
  writeFileSync(state, JSON.stringify({ applied: [], completed: [], measured: [], features: [] }));
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
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  // The child resolves Pod skills under the fixture HOME — the fake image label must carry that same digest.
  const digest = spawnSync('bun', ['-e', `import {podSkillsDigest,resolvePodSkills} from './src/task-orchestrator/surfaces/pod-skills.ts'; console.log(podSkillsDigest(resolvePodSkills().skills).digest)`], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, NODE_ENV: '' } }).stdout.trim();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: xdg,
    ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_CONFIG_DIR: join(root, 'config'),
    TEST_JOBS: state, TEST_HEAD: head, TEST_SKILLS: digest, ELANOUS_POD_POOL: 'fake:3',
    ELANOUS_GROUNDING_URL: '', ELANOUS_RUN_ID: '', NODE_ENV: '',
    // L7e: the child CLI runs with NODE_ENV cleared, so without this it took leases in the REAL host lease dir
    // (`$TMPDIR/elanous-pod-leases-<uid>/fake_` — counted against live node-b slots · 10-03 19:26 26/20).
    ELANOUS_POD_LEASE_DIR: join(root, 'pod-leases'),
  };
  return { root, state, env };
}

test('independent harness ask/say and self CLI dispatch run real kubectl apply only when lease permits', async () => {
  const { root, state, env } = fixture();
  const goal = join(root, 'goal.md');
  writeFileSync(goal, 'First distinct goal');
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const snapshot = () => JSON.parse(readFileSync(state, 'utf8')) as { applied: string[]; completed: string[]; measured: number[]; features: string[] };
  const applied = () => snapshot().applied;
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 600 && !predicate(); i++) await Bun.sleep(50);
    if (!predicate()) {
      const exits = await Promise.all(children.map(async (child) => ({ pid: child.pid, exit: child.exitCode,
        stderr: child.exitCode === null || typeof child.stderr === 'number' ? null : await new Response(child.stderr).text() })));
      throw new Error(`pod CLI did not reach expected state: ${JSON.stringify({ state: snapshot(), exits })}`);
    }
  };
  const run = (args: string[]) => {
    const child = Bun.spawn(['bun', entry, '--test', ...args], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    return child;
  };
  try {
    // No named child provider: since PODPROVIDER (#24183) a Pod honours only openai-codex/grok, so the old `anthropic` dodge exits 2.
    run(['harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'fake:3']);
    await wait(() => applied().length === 1);
    run(['harness', 'say', 'Second distinct goal', '--substrate', 'pod', '--pod-pool', 'fake:3']);
    await wait(() => applied().length === 2);
    const measurementsBeforeThird = snapshot().measured.length;
    run(['self', 'orchestrate', 'Third distinct goal', '--substrate', 'pod', '--pod-pool', 'fake:3', '--pod-account', 'team', '--no-supervise']);
    await wait(() => snapshot().measured.length > measurementsBeforeThird);
    await Bun.sleep(500);
    expect(applied()).toHaveLength(2);
    const before = snapshot();
    expect(before.measured).toContain(2);
    before.completed.push(before.applied[0]!);
    writeFileSync(state, JSON.stringify(before));
    await wait(() => applied().length === 3);
    expect(new Set(applied()).size).toBe(3);
    expect(snapshot().features.map((text) => text.split('\n')[0])).toEqual([
      'First distinct goal', 'Second distinct goal', 'Third distinct goal',
    ]);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
