import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import { fetchNpmRegistry, runNpmPublish, type NpmPublishDeps } from './npm-publish-node.js';
import { readGraphContext, type GraphContext } from './node-verdict.js';

const VERSION = '0.2.6';
const TOKEN = 'fixture-secret-token-123';
function fixture(options: { archiveVersion?: string; publish?: { status: number; stdout: string; stderr: string }; visible?: boolean; wait?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-test-'));
  const tokenFile = join(root, 'secrets', 'npm-token');
  mkdirSync(join(root, 'secrets'));
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const context: GraphContext = { runId: 'run-npm-publish-test', input: { version: VERSION, previousVersion: '0.2.5', npmTokenFile: tokenFile, npmWaitMinutes: options.wait ?? 0 }, outputs: { publish: { outcome: 'ok' } } };
  const commands: string[] = [];
  const alerts: string[] = [];
  const logs: Array<[string, number]> = [];
  const spawnEvents: Array<{ version: string; durationMs: number; status: number | null; signal: NodeJS.Signals | null }> = [];
  let npmrc = '';
  let mode = 0;
  const deps: NpmPublishDeps = {
    stateDir: root,
    exec: (command, args, env) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version: options.archiveVersion ?? VERSION }), stderr: '' };
      npmrc = env?.NPM_CONFIG_USERCONFIG ?? '';
      mode = statSync(npmrc).mode & 0o777;
      expect(readFileSync(npmrc, 'utf8')).toBe(`//registry.npmjs.org/:_authToken=${TOKEN}\n`);
      return options.publish ?? { status: 0, stdout: `+ elanous@${VERSION}`, stderr: '' };
    },
    registry: async (url) => url.endsWith(`/${VERSION}`)
      ? { status: options.visible ? 200 : 404, body: options.visible ? { name: 'elanous', version: VERSION } : null }
      : { status: 200, body: { 'dist-tags': { latest: options.visible ? VERSION : '0.2.5' } } },
    sleep: async () => {},
    alert: (text) => { alerts.push(text); return true; },
    log: (v, minutes) => { logs.push([v, minutes]); },
    publishSpawn: (event) => { spawnEvents.push(event); },
  };
  return { root, context, deps, commands, alerts, logs, spawnEvents, get npmrc() { return npmrc; }, get mode() { return mode; } };
}

test('visible package is already published: no npm publish and no token file read', async () => {
  const f = fixture({ visible: true });
  try {
    rmSync(join(f.root, 'secrets', 'npm-token'));
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'already-published' });
    expect(f.commands.map((x) => x.split(' ')[0])).toEqual(['tar']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('visible version waits for matching latest tag without republishing', async () => {
  const f = fixture({ wait: 1 });
  let checks = 0;
  const intervals: number[] = [];
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 200, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: ++checks >= 3 ? VERSION : '0.2.5' } } };
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'already-published' });
    expect(intervals).toEqual([30_000]);
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('visible version with stale latest tag fails after the wait without republishing or staging alert', async () => {
  const f = fixture({ wait: 1 });
  const intervals: number[] = [];
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 200, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: '0.2.5' } } };
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    const result = await runNpmPublish(f.context, f.deps);
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(result.summary).toContain('dist-tags.latest did not reach');
    expect(intervals).toEqual([30_000, 30_000]);
    expect(f.commands).toHaveLength(1);
    expect(f.alerts).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('archive package/version mismatch fails before publishing', async () => {
  const f = fixture({ archiveVersion: '0.2.5' });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('published version becomes visible with latest tag and removes 0600 npmrc', async () => {
  const f = fixture();
  let polls = 0;
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: polls++ > 1 ? 200 : 404, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: polls > 2 ? VERSION : '0.2.5' } } };
  f.context.input.npmWaitMinutes = 1;
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'published' });
    expect(f.commands[1]).toBe(`npm publish ${join(f.root, 'release', VERSION, 'prepared', 'dist', 'elanous.tgz')} --ignore-scripts --tag latest --access public --logs-dir ${join(f.root, 'graph-runs', 'release-loop', 'run-npm-publish-test.json.contexts', 'npm-publish')}`);
    expect(f.spawnEvents).toHaveLength(1);
    expect(f.spawnEvents[0]).toMatchObject({ version: VERSION, status: 0, signal: null });
    expect(f.spawnEvents[0]?.durationMs).toBeGreaterThan(0);
    expect(f.mode).toBe(0o600);
    expect(existsSync(f.npmrc)).toBe(false);
    const logDir = f.commands[1].split(' --logs-dir ')[1];
    expect(existsSync(logDir)).toBe(true);
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(f.alerts).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('E409 previously staged reports human action, logs and alerts once without republishing', async () => {
  const f = fixture({ publish: { status: 1, stdout: '', stderr: `npm ERR! code E409 Cannot publish over previously staged version "${VERSION}"` } });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support', summary: 'npm 스테이징 — 레지스트리에 아직 없음' });
    expect(f.commands.filter((command) => command.startsWith('npm publish'))).toHaveLength(1);
    expect(f.alerts).toEqual([`npm ${VERSION} 가 스테이징에 멈춤 — 계정 소유자 확인 필요`]);
    expect(f.logs).toEqual([[VERSION, 0]]);
    expect(existsSync(f.npmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('successful publish that never appears is staged and waits in 30s intervals', async () => {
  const f = fixture({ wait: 1 });
  const intervals: number[] = [];
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support' });
    expect(intervals).toEqual([30_000, 30_000]);
    expect(f.logs).toEqual([[VERSION, 1]]);
    expect(f.alerts).toHaveLength(1);
    expect(existsSync(f.npmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('default registry wait lasts 40 minutes before staging report', async () => {
  const f = fixture();
  delete f.context.input.npmWaitMinutes;
  let waitedMs = 0;
  let polls = 0;
  f.deps.sleep = async (ms) => { expect(ms).toBe(30_000); waitedMs += ms; };
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? (polls++, { status: 404, body: null })
    : { status: 200, body: { 'dist-tags': { latest: '0.2.5' } } };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support' });
    expect(waitedMs).toBe(40 * 60_000);
    expect(polls).toBe(82);
    expect(f.logs).toEqual([[VERSION, 40]]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wait override cannot outlive the node recipe', async () => {
  const f = fixture({ wait: 41 });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: input.npmWaitMinutes must be between 0 and 40' });
    expect(f.commands).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('registry network failure is distinguished from publish failure', async () => {
  const f = fixture();
  f.deps.registry = async () => { throw new Error('network unavailable'); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: npm registry fetch failed (/elanous/0.2.6): network unavailable' });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('registry version HTTP failure includes the requested endpoint', async () => {
  const f = fixture();
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 503, body: null }
    : { status: 200, body: { 'dist-tags': { latest: '0.2.5' } } };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({
      outcome: 'fail',
      summary: `npm ${VERSION} failed: npm registry version lookup failed (503; /elanous/${VERSION})`,
    });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('registry tags HTTP failure includes the requested endpoint', async () => {
  const f = fixture();
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 404, body: null }
    : { status: 503, body: null };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({
      outcome: 'fail',
      summary: `npm ${VERSION} failed: npm registry tags lookup failed (503; /elanous)`,
    });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('registry timeout during response body read reports endpoint using a real local HTTP response', async () => {
  const f = fixture();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"name":');
    setTimeout(() => response.end('"elanous"}'), 50);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  f.deps.registry = (url) => fetchNpmRegistry(`http://127.0.0.1:${port}${new URL(url).pathname}`, 10);
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: npm registry fetch timeout after 10ms (/elanous/0.2.6)' });
    expect(f.commands).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('registry error text mentioning timeout is not misreported as the fixed fetch timeout', async () => {
  const f = fixture();
  f.deps.registry = async () => { throw Object.assign(new Error('upstream connection timeout'), { name: 'TimeoutError' }); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: npm registry fetch failed (/elanous/0.2.6): upstream connection timeout' });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unattributed graph context still publishes and gets an isolated fallback log directory', async () => {
  const f = fixture();
  delete f.context.runId;
  const previousContext = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: f.context.input, outputs: f.context.outputs });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible' });
    const logDir = f.commands[1].split(' --logs-dir ')[1];
    expect(logDir).toBe(join(f.root, 'release', VERSION, 'npm-publish'));
    expect(existsSync(logDir)).toBe(true);
  } finally {
    if (previousContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previousContext;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('graph-runner context selects that run output directory for npm logs', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-graph-run-'));
  const graph = join(root, 'graph.yaml');
  const priorContext = process.env.ELANOUS_GRAPH_CONTEXT;
  writeFileSync(join(root, 'recipes.yaml'), `publish:\n  command: 'printf publish-output'\nnpm-publish:\n  command: 'printf npm-output'\n`);
  writeFileSync(graph, `graph_id: release-loop-test
version: 1
entry_node: publish
terminal_nodes: [done, failed]
nodes:
  - { node_id: publish, kind: agent, recipe: 'cmd:publish', max_visits: 1 }
  - { node_id: npm-publish, kind: agent, recipe: 'cmd:npm-publish', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - from: publish
    on: outcome
    map: { ok: npm-publish, fail: failed }
  - from: npm-publish
    on: outcome
    map: { ok: done, fail: failed }
`);
  const contextPaths: string[] = [];
  try {
    const state = await runGraph(graph, { runId: 'runner-created-npm-run', input: { ...f.context.input }, deps: {
      root,
      runBash: async (_body, options) => {
        const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextPath) throw new Error('graph context path missing');
        contextPaths.push(contextPath);
        return { stdout: JSON.stringify({ outcome: 'ok' }), stderr: '', exitCode: 0 };
      },
    } });
    expect(state.status).toBe('done');
    expect(contextPaths).toHaveLength(2);
    const contextPath = contextPaths[1]!;
    process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
    const context = readGraphContext();
    expect(context.runId).toBe('runner-created-npm-run');
    expect(await runNpmPublish(context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible' });
    const expectedLogs = join(dirname(contextPath), 'npm-publish');
    expect(f.commands[1]).toContain(`--logs-dir ${expectedLogs}`);
    expect(existsSync(expectedLogs)).toBe(true);
  } finally {
    if (priorContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = priorContext;
    rmSync(root, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

const npmAndNode = spawnSync('sh', ['-c', 'command -v npm && command -v node'], { encoding: 'utf8' });
const hasNpmAndNode = npmAndNode.status === 0;
const realNpmPath = npmAndNode.stdout.split('\n')[0]?.trim() ?? '';
const realNodePath = npmAndNode.stdout.split('\n')[1]?.trim() ?? '';

test.skipIf(!hasNpmAndNode)('graph-runner npm-publish process writes npm debug logs under its run output directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-graph-process-'));
  const stateRoot = join(root, 'state');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const bin = join(root, 'bin');
  const graphId = 'npm-publish-logs-dir-probe';
  const runId = 'npm-publish-logs-dir-probe';
  const version = '9.9.99-rc.0';
  const repoRoot = join(import.meta.dir, '../..');
  const graph = join(root, 'graph.yaml');
  const recipes = join(root, 'recipes.yaml');
  const preload = join(root, 'registry-preload.mjs');
  const requests = join(root, 'registry-requests.txt');
  const wrapperRecord = join(root, 'npm-wrapper-record.txt');
  const wrapperArgs = join(root, 'npm-wrapper-args.txt');
  const archiveRoot = join(root, 'archive');
  const archive = join(stateRoot, 'release', version, 'prepared', 'dist', 'elanous.tgz');
  const explicitToken = 'isolated-test-token-only';
  const realNpm = realNpmPath;
  const tokenFile = join(stateRoot, 'secrets', 'npm-token');
  const expectedLogDir = join(stateRoot, 'graph-runs', graphId, `${runId}.json.contexts`, 'npm-publish');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    mkdirSync(join(stateRoot, 'secrets'), { recursive: true });
    mkdirSync(join(home, '.elanous', 'secrets'), { recursive: true });
    mkdirSync(temp, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(archiveRoot, 'package'), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(tokenFile, `${explicitToken}\n`, { mode: 0o600 });
    writeFileSync(join(home, '.elanous', 'secrets', 'npm-token'), 'fallback-token-must-not-be-used\n', { mode: 0o600 });
    writeFileSync(join(archiveRoot, 'package', 'package.json'), JSON.stringify({ name: 'elanous', version }));
    const tar = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, 'package'], { encoding: 'utf8', timeout: 10_000 });
    if (tar.status !== 0) throw new Error(`measurement unavailable: could not create npm archive (${tar.stderr})`);

    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const version = ${JSON.stringify(version)};
const requests = process.env.ELANOUS_TEST_REGISTRY_REQUESTS;
globalThis.fetch = async (input) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (url.origin !== 'https://registry.npmjs.org') throw new Error('unexpected network origin: ' + url.origin);
  appendFileSync(requests, url.pathname + '\\n');
  if (url.pathname === '/elanous/' + version) return new Response(null, { status: 404 });
  if (url.pathname === '/elanous') return Response.json({ name: 'elanous', 'dist-tags': { next: '0.0.0' } });
  return new Response(null, { status: 404 });
};
`);
    const wrapper = join(bin, 'npm');
    writeFileSync(wrapper, `#!/bin/bash
original_args=("$@")
printf '%s\\n' "\${original_args[@]}" > "$TEST_WRAPPER_ARGS"
if [[ "\${original_args[0]-}" != "publish" ]]; then exit 91; fi
archive="\${original_args[1]-}"
log_dir=""
for ((i = 0; i < \${#original_args[@]}; i++)); do
  if [[ "\${original_args[i]}" == "--logs-dir" ]]; then log_dir="\${original_args[i + 1]-}"; fi
done
[[ "$archive" == "$TEST_ARCHIVE" ]] || exit 92
[[ "$log_dir" == "$TEST_EXPECTED_LOG_DIR" ]] || exit 93
[[ "$HOME" == "$TEST_HOME" ]] || exit 94
case "$NPM_CONFIG_USERCONFIG" in "$TEST_TMP"/release-npmrc-*/npmrc) ;; *) exit 95 ;; esac
[[ "$(/bin/cat "$NPM_CONFIG_USERCONFIG")" == "//registry.npmjs.org/:_authToken=$TEST_EXPECTED_TOKEN" ]] || exit 96
printf '%s\\n%s\\n' "$log_dir" "$NPM_CONFIG_USERCONFIG" > "$TEST_WRAPPER_RECORD"
exec "$TEST_REAL_NPM" "\${original_args[@]}" --dry-run --offline --registry http://127.0.0.1:1
`);
    chmodSync(wrapper, 0o755);

    const npmCommand = `${quote(process.execPath)} --preload ${quote(preload)} ${quote(join(import.meta.dir, 'npm-publish-node.ts'))}`;
    const publishCommand = `${quote(process.execPath)} -e ${quote('console.log(JSON.stringify({ outcome: "ok" }))')}`;
    writeFileSync(recipes, `publish:\n  command: ${JSON.stringify(publishCommand)}\nnpm-publish:\n  command: ${JSON.stringify(npmCommand)}\n  timeout_ms: 45000\n`);
    writeFileSync(graph, `graph_id: ${graphId}\nversion: 1\nentry_node: publish\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: publish, kind: agent, recipe: 'cmd:publish', max_visits: 1 }\n  - { node_id: npm-publish, kind: agent, recipe: 'cmd:npm-publish', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - from: publish\n    on: outcome\n    map: { ok: npm-publish, fail: failed }\n  - from: npm-publish\n    on: outcome\n    map: { ok: done, fail: failed }\n`);

    const safePath = [bin, dirname(process.execPath), dirname(realNodePath), '/usr/bin', '/bin'].join(delimiter);
    const state = await runGraph(graph, {
      runId,
      pinChildUniverse: true,
      input: { version, previousVersion: '9.9.98', npmTokenFile: tokenFile, npmWaitMinutes: 0 },
      deps: {
        root: stateRoot,
        runBash: async (body, options) => {
          const child = spawnSync('/bin/bash', ['-c', body], {
            cwd: options?.cwd ?? repoRoot,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
              ...options?.env,
              HOME: home,
              TMPDIR: temp,
              PATH: safePath,
              NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1',
              ELANOUS_TEST_REGISTRY_REQUESTS: requests,
              TEST_ARCHIVE: archive,
              TEST_EXPECTED_LOG_DIR: expectedLogDir,
              TEST_HOME: home,
              TEST_TMP: temp,
              TEST_EXPECTED_TOKEN: explicitToken,
              TEST_REAL_NPM: realNpm,
              TEST_WRAPPER_RECORD: wrapperRecord,
              TEST_WRAPPER_ARGS: wrapperArgs,
            },
          });
          return { exitCode: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? String(child.error ?? '') };
        },
      },
    });

    expect(state.status).toBe('done');
    expect(String(state.nodes.find((entry) => entry.nodeId === 'npm-publish')?.output)).toContain('staged-not-visible');
    const wrapperLines = readFileSync(wrapperRecord, 'utf8').trim().split('\n');
    expect(wrapperLines[0]).toBe(expectedLogDir);
    expect(wrapperLines[1]?.startsWith(join(temp, 'release-npmrc-'))).toBe(true);
    expect(readFileSync(wrapperArgs, 'utf8').trim().split('\n')).toEqual([
      'publish', archive, '--ignore-scripts', '--tag', 'next', '--access', 'public', '--logs-dir', expectedLogDir,
    ]);
    const debugLogs = readdirSync(expectedLogDir).filter((name) => name.endsWith('-debug-0.log'));
    expect(debugLogs.length).toBeGreaterThan(0);
    expect(readFileSync(join(expectedLogDir, debugLogs[0]!), 'utf8')).toContain('verbose cli');
    const registryRequests = readFileSync(requests, 'utf8').trim().split('\n');
    expect(registryRequests).toContain(`/elanous/${version}`);
    expect(registryRequests).toContain('/elanous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test('publish spawn telemetry records duration and termination signal', async () => {
  const f = fixture();
  f.deps.exec = (command) => command === 'tar'
    ? { status: 0, stdout: JSON.stringify({ name: 'elanous', version: VERSION }), stderr: '' }
    : { status: null, stdout: '', stderr: 'terminated', durationMs: 1234, signal: 'SIGTERM' };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail' });
    expect(f.spawnEvents).toEqual([{ version: VERSION, durationMs: 1234, status: null, signal: 'SIGTERM' }]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test.skipIf(!hasNpmAndNode)('real npm publish --dry-run honors logs-dir and writes its debug log', () => {
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-log-test-'));
  const logDir = join(root, 'npm-logs');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'npm-publish-log-test', version: '1.0.0' }));
  writeFileSync(join(root, 'npmrc'), '', { mode: 0o600 });
  try {
    // Real npm cold starts can exceed 15s on remote workers; the dead-port registry also guards accidental network access.
    const result = spawnSync('npm', ['publish', root, '--ignore-scripts', '--dry-run', '--offline', '--logs-dir', logDir, '--registry', 'http://127.0.0.1:1'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NPM_CONFIG_USERCONFIG: join(root, 'npmrc') } });
    expect(result.status).toBe(0);
    expect(readdirSync(logDir).some((name) => name.endsWith('-debug-0.log'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('E401 and thrown command errors fail without disclosing token, cleaning npmrc', async () => {
  const f = fixture({ publish: { status: 1, stdout: TOKEN, stderr: `E401 unauthorized ${TOKEN}` } });
  try {
    const result = await runNpmPublish(f.context, f.deps);
    expect(result.outcome).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(existsSync(f.npmrc)).toBe(false);
    expect(f.alerts).toEqual([]);
    let thrownNpmrc = '';
    f.deps.exec = (command, args, env) => {
      if (command === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version: VERSION }), stderr: '' };
      thrownNpmrc = env?.NPM_CONFIG_USERCONFIG ?? '';
      expect(existsSync(thrownNpmrc)).toBe(true);
      throw new Error(`spawn failed: ${TOKEN}`);
    };
    expect(JSON.stringify(await runNpmPublish(f.context, f.deps))).not.toContain(TOKEN);
    expect(existsSync(thrownNpmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('REL3: a resume in another universe publishes the archive prepare built and the production-root token', async () => {
  const f = fixture();
  const other = mkdtempSync(join(tmpdir(), 'npm-publish-other-universe-'));
  const prod = mkdtempSync(join(tmpdir(), 'npm-publish-prod-root-'));
  mkdirSync(join(prod, 'secrets'));
  writeFileSync(join(prod, 'secrets', 'npm-token'), `${TOKEN}\n`, { mode: 0o600 });
  const archive = join(f.root, 'release', VERSION, 'prepared', 'dist', 'elanous.tgz');
  const context: GraphContext = { runId: 'run-npm-publish-resume-test', input: { version: VERSION, previousVersion: '0.2.5', npmWaitMinutes: 0 },
    outputs: { publish: { outcome: 'ok' }, prepare: { outcome: 'ok', candidate: archive } } };
  try {
    const result = await runNpmPublish(context, { ...f.deps, stateDir: other, productionRoot: prod });
    expect(f.commands[0]).toBe(`tar -xOzf ${archive} package/package.json`);
    expect(f.commands.some((c) => c.startsWith(`npm publish ${archive} `))).toBe(true);
    expect(result.outcome).toBe('ok');
  } finally { rmSync(other, { recursive: true, force: true }); rmSync(prod, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test('RELEASE-REHEARSAL-RC: a prerelease publishes to dist-tag next and waits for next, never latest', async () => {
  const f = fixture({ archiveVersion: '0.2.18-rc.0' });
  f.context.input.version = '0.2.18-rc.0';
  let polls = 0;
  f.deps.registry = async (url) => url.endsWith('/0.2.18-rc.0')
    ? { status: polls++ > 0 ? 200 : 404, body: { name: 'elanous', version: '0.2.18-rc.0' } }
    : { status: 200, body: { 'dist-tags': { latest: '0.2.17', next: polls > 1 ? '0.2.18-rc.0' : '0.2.17' } } };
  f.context.input.npmWaitMinutes = 1;
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'published', summary: 'npm 0.2.18-rc.0 visible with next tag' });
    expect(f.commands[1]).toContain('--tag next');
    expect(f.commands.join('\n')).not.toContain('--tag latest');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
