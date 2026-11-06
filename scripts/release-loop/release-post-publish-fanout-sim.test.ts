import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';

const RELEASE = '0.3.1';
const DEV = '0.3.1-dev.0';
const NEXT_DEV = '0.3.2-dev.0';
const CUT = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const BUMPED_MAIN = 'c'.repeat(40);
const REPO = resolve(import.meta.dir, '../..');

function child(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    proc.once('error', reject);
    proc.once('close', (code) => resolvePromise({ exitCode: code ?? 2, stdout, stderr }));
  });
}

test('SIM-RELEASE-CHAIN: post-publish fan-out runs the graph CLIs concurrently, preserves both results at join, then enters verify', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-release-post-publish-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const docsScratch = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const docsWorktree = join(docsScratch, 'tree');
  const graph = join(REPO, 'graphs/release/release-loop.yaml');
  const bun = process.execPath;
  const trace = join(root, 'boundary-trace.jsonl');
  const mainVersion = join(root, 'main-version.txt');
  const docsLanded = join(root, 'docs-landed');
  const fakeGit = join(bin, 'git');
  const fakeBun = join(bin, 'bun');
  const preload = join(root, 'test-config-preload.ts');

  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(stateRoot, 'release', RELEASE), { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(docsWorktree, { recursive: true });
  writeFileSync(mainVersion, DEV);
  writeFileSync(join(stateRoot, 'release', RELEASE, 'manifest.json'), JSON.stringify({ version: RELEASE, in: [] }));
  writeFileSync(join(docsWorktree, 'release-notes.md'), 'simulated release notes\n');
  writeFileSync(preload, `import { setElanousConfigDir } from ${JSON.stringify(join(REPO, 'src/elanous-config-dir.ts'))};\nsetElanousConfigDir(process.env.SIM_RELEASE_CONFIG_ROOT!);\n`);

  // Only the external git/land/install/deploy/registry boundary is replaced. Both graph recipe CLIs and
  // their production node implementations are launched as child processes by the real release graph.
  writeFileSync(fakeGit, `#!/bin/sh
exec /usr/bin/env node ${JSON.stringify(join(root, 'fake-git.cjs'))} "$@"
`);
  writeFileSync(join(root, 'fake-git.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const trace = ${JSON.stringify(trace)};
const mainVersion = ${JSON.stringify(mainVersion)};
const docsLanded = ${JSON.stringify(docsLanded)};
const main = ${JSON.stringify(MAIN)};
const bumped = ${JSON.stringify(BUMPED_MAIN)};
const nodeId = process.env.ELANOUS_GRAPH_CONTEXT
  ? JSON.parse(fs.readFileSync(process.env.ELANOUS_GRAPH_CONTEXT, 'utf8')).nodeId
  : 'outside-graph';
function record(op) { fs.appendFileSync(trace, JSON.stringify({ op, nodeId, pid: process.pid, at: Date.now() }) + '\\n'); }
const op = args[0]; record(op === 'fetch' ? 'git-fetch-start' : 'git-' + op);
const output = (value) => process.stdout.write(value + '\\n');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (op === 'fetch') { sleep(260); record('git-fetch-end'); process.exit(0); }
if (op === 'cat-file') process.exit(fs.existsSync(docsLanded) ? 0 : 1);
if (op === 'rev-parse') { output(fs.readFileSync(mainVersion, 'utf8').trim() === ${JSON.stringify(NEXT_DEV)} ? bumped : main); process.exit(0); }
if (op === 'show') {
  if (args[1] === 'origin/main:package.json') { output(JSON.stringify({ version: fs.readFileSync(mainVersion, 'utf8').trim() })); process.exit(0); }
  if (args[1] === 'origin/main:release/next.md') { output('## Next\\n- Simulated release item\\n'); process.exit(0); }
  if (args[1] && args[1].endsWith(':release/next.md')) { output('## Next\\n- Simulated release item\\n'); process.exit(0); }
  process.exit(1);
}
if (op === 'worktree' && args[1] === 'add') {
  const target = args.at(-2);
  fs.mkdirSync(target, { recursive: true });
  if (args.includes('-b')) {
    for (const name of ['package.json', 'bun.lock', 'release/next.md']) {
      const from = path.join(${JSON.stringify(REPO)}, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')); pkg.version = fs.readFileSync(mainVersion, 'utf8').trim();
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\\n');
  }
  process.exit(0);
}
if (op === 'worktree' && args[1] === 'remove') { fs.rmSync(args.at(-1), { recursive: true, force: true }); process.exit(0); }
if (op === 'add' || op === 'commit' || op === 'remote') process.exit(0);
process.stderr.write('unexpected fake git: ' + args.join(' ') + '\\n'); process.exit(2);
`);
  writeFileSync(fakeBun, `#!/bin/sh
if [ "$1" = "scripts/release-loop/docs-land-node.ts" ] || [ "$1" = "scripts/release-loop/version-node.ts" ] || [ "$1" = "scripts/release-loop/verify-node.ts" ]; then
  exec ${JSON.stringify(bun)} --preload ${JSON.stringify(preload)} "$@"
fi
if [ "$1" = "bin/elanous.mjs" ] && [ "$2" = "pr" ] && [ "$3" = "land" ]; then
  case "$*" in *"version: ${NEXT_DEV}"*) echo ${JSON.stringify(NEXT_DEV)} > ${JSON.stringify(mainVersion)} ;; *) touch ${JSON.stringify(docsLanded)} ;; esac
  echo '✓ merge: #99999'
  exit 0
fi
if [ "$1" = "bin/elanous.mjs" ] && [ "$2" = "release" ] && [ "$3" = "verify" ]; then
  echo '{"ok":true,"notesPage":"ok"}'
  exit 0
fi
if [ "$1" = "install" ] || [ "$1" = "website/scripts/deploy-pages.ts" ]; then exit 0; fi
exec ${JSON.stringify(bun)} "$@"
`);
  chmodSync(fakeGit, 0o755);
  chmodSync(fakeBun, 0o755);

  const commands = new Map<string, string>();
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
    if (!contextPath) throw new Error('release graph command did not receive its context file');
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { nodeId: string; outputs: Record<string, unknown>; input: { version: string } };
    const nodeId = context.nodeId;
    commands.set(nodeId, command);
    if (nodeId === 'docs-land' || nodeId === 'version-dev-bump' || nodeId === 'verify') {
      if ((nodeId === 'docs-land' && command !== 'bun scripts/release-loop/docs-land-node.ts')
        || (nodeId === 'version-dev-bump' && command !== 'bun scripts/release-loop/version-node.ts dev-bump --json')
        || (nodeId === 'verify' && command !== 'bun scripts/release-loop/verify-node.ts')) {
        throw new Error(`unexpected ${nodeId} recipe command: ${command}`);
      }
      if (nodeId === 'verify') {
        expect(context.outputs['docs-land']).toMatchObject({ outcome: 'ok', summary: expect.stringContaining('docs landed and deployed') });
        expect(context.outputs['version-dev-bump']).toMatchObject({ outcome: 'ok', version: NEXT_DEV });
      }
      const env = { ...options.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home,
        ELANOUS_STATE_DIR: stateRoot, SIM_RELEASE_CONFIG_ROOT: configRoot, SIM_RELEASE_TRACE: trace };
      const result = await child(command, env, REPO);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }

    const result: Record<string, unknown> = { outcome: 'ok', nodeId };
    if (nodeId === 'version-release') Object.assign(result, { version: RELEASE, commit: CUT, branch: `release/${RELEASE}`, base: MAIN });
    if (nodeId === 'docs') Object.assign(result, { branch: `release-docs/${RELEASE}`, worktree: docsWorktree,
      notes: join(docsWorktree, 'release-notes.md') });
    if (nodeId === 'publish') Object.assign(result, { tag: `v${RELEASE}` });
    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
  };

  try {
    const result = await runGraph(graph, { input: { version: RELEASE, previousVersion: '0.3.0', branchCut: true },
      pinChildUniverse: true, deps: { root: stateRoot, runBash } });
    expect(result.status).toBe('done');
    expect(commands.get('docs-land')).toBe('bun scripts/release-loop/docs-land-node.ts');
    expect(commands.get('version-dev-bump')).toBe('bun scripts/release-loop/version-node.ts dev-bump --json');
    expect(commands.get('verify')).toBe('bun scripts/release-loop/verify-node.ts');

    const fanout = result.fanOuts?.['traffic-npm-published:ok'];
    expect(fanout?.branches['docs-land']).toMatchObject({ status: 'done', output: expect.stringContaining('docs landed and deployed') });
    expect(fanout?.branches['version-dev-bump']).toMatchObject({ status: 'done', output: expect.stringContaining(NEXT_DEV) });
    const join = result.nodes.find((node) => node.nodeId === 'release-post-publish-join');
    expect(join).toMatchObject({ ok: true });
    const verify = result.nodes.find((node) => node.nodeId === 'verify');
    expect(verify).toMatchObject({ ok: true });
    const fetches = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; nodeId: string; at: number });
    const interval = (nodeId: string) => {
      const start = fetches.find((event) => event.op === 'git-fetch-start' && event.nodeId === nodeId);
      const end = fetches.find((event) => event.op === 'git-fetch-end' && event.nodeId === nodeId);
      if (!start || !end) throw new Error(`missing child git boundary interval for ${nodeId}`);
      return { start: start.at, end: end.at };
    };
    const docsInterval = interval('docs-land');
    const bumpInterval = interval('version-dev-bump');
    expect(docsInterval.end).toBeGreaterThan(bumpInterval.start);
    expect(bumpInterval.end).toBeGreaterThan(docsInterval.start);
    expect(readFileSync(mainVersion, 'utf8').trim()).toBe(NEXT_DEV);
    expect(existsSync(docsLanded)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(docsScratch, { recursive: true, force: true });
  }
}, 20_000);
