import { afterEach, expect, test } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runGraph } from '../../src/graph-runner/runner.js';
import { saveMemory } from '../../src/memory.js';
import { assertIsolatedFeatureWorktree, assertNoNewCommit, outcomeForGraph } from './verbs/headless-goal-loop.js';
import { startAimockLocal } from '../../test/ux-sim/aimock-local.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const previousStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

test('headless goal-loop requires a document only for verb-make-doc', () => {
  expect(outcomeForGraph('verb-make-doc', true, [])).toBe('failed');
  expect(outcomeForGraph('verb-make-doc', true, ['docs/report.md'])).toBe('done');
  expect(outcomeForGraph('verb-verify', true, [])).toBe('done');
  expect(outcomeForGraph('verb-verify', false, [])).toBe('failed');
});

test('headless goal-loop evidence contract rejects a child commit', () => {
  const repository = mkdtempSync(join(tmpdir(), 'verb-headless-commit-'));
  roots.push(repository);
  execFileSync('git', ['init', '-b', 'work/evidence'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'UX rehearsal'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ux-rehearsal@example.invalid'], { cwd: repository, stdio: 'ignore' });
  writeFileSync(join(repository, 'README.md'), '# baseline\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repository, stdio: 'ignore' });
  const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  expect(() => assertNoNewCommit(repository, beforeHead)).not.toThrow();
  writeFileSync(join(repository, 'report.md'), '# report\n');
  execFileSync('git', ['add', 'report.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'child committed output'], { cwd: repository, stdio: 'ignore' });
  expect(() => assertNoNewCommit(repository, beforeHead)).toThrow('must leave changes uncommitted');
});

test('real verb-make-doc unit executes its headless goal-loop with AIMock and records a document draft', async () => {
  const session = await startAimockLocal((mock) => {
    mock.on({ hasToolResult: false }, {
      toolCalls: [{ id: 'write-research-report', name: 'Bash', arguments: JSON.stringify({
        command: "echo '# Research report' | tee docs/research-report.md",
      }) }],
    });
    mock.on({ hasToolResult: true }, {
      content: 'The document draft is written and the requested file is present.\nGOAL-COMPLETE',
    });
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'verb-make-doc-state-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'verb-make-doc-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'verb-make-doc-xdg-data-'));
  const homeRoot = mkdtempSync(join(projectRoot, 'home-'));
  const repository = join(projectRoot, 'repository');
  const target = join(projectRoot, 'worktree');
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousConfigDir = process.env.ELANOUS_CONFIG_DIR;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousStateDirSource = process.env.ELANOUS_STATE_DIR_SOURCE;
  roots.push(stateRoot, projectRoot, dataRoot);
  process.env.ELANOUS_STATE_DIR = stateRoot;
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.ELANOUS_CONFIG_DIR = join(projectRoot, 'host-config-sentinel');
  process.env.XDG_CONFIG_HOME = join(projectRoot, 'host-xdg-config-sentinel');
  process.env.ELANOUS_STATE_DIR_SOURCE = 'host-source-sentinel';
  saveMemory({
    id: 'ux-headless-fixture-memory', type: 'reference', name: 'Rehearsal report memory',
    description: 'A deterministic fixture for the headless document rehearsal.',
    body: 'When writing a research report, include a short findings section and cite the requested document path.',
    pinned: false,
  }, join(dataRoot, 'elanous', 'memory'));

  try {
    writeFileSync(join(stateRoot, 'recipes.yaml'), '{}\n');
    writeFileSync(join(stateRoot, 'config.json'), JSON.stringify({
      llm: { provider: 'local', model: 'aimock-rehearsal', baseUrl: `${session.mock.url}/v1` },
    }));
    mkdirSync(repository);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'UX rehearsal'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'ux-rehearsal@example.invalid'], { cwd: repository, stdio: 'ignore' });
    writeFileSync(join(repository, 'README.md'), '# Rehearsal target\n');
    writeFileSync(join(repository, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
    writeFileSync(join(repository, 'rehearsal.test.ts'), "import { expect, test } from 'bun:test';\ntest('rehearsal target gate passes', () => expect(true).toBe(true));\n");
    mkdirSync(join(repository, 'docs'));
    execFileSync('git', ['add', 'README.md', 'package.json', 'rehearsal.test.ts'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed rehearsal target'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    execFileSync('git', ['worktree', 'add', '-b', 'work/research-report', target], { cwd: repository, stdio: 'ignore' });
    mkdirSync(join(target, 'docs'), { recursive: true });
    expect(() => assertIsolatedFeatureWorktree(repository)).toThrow('separate linked Git worktree');
    expect(assertIsolatedFeatureWorktree(target)).toBe(realpathSync(target));
    writeFileSync(join(target, 'docs/preexisting.md'), '# Existing uncommitted edit\n');

    const graph = join(stateRoot, 'make-doc-rehearsal.yaml');
    writeFileSync(graph, `graph_id: ux-make-doc-rehearsal\nversion: 1\nentry_node: make-doc\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: make-doc\n    kind: subgraph\n    recipe: none\n    max_visits: 1\n    call: verb-make-doc@1\n    budget: { inner_steps: 16 }\n    contract: { inputs: [ask, context, prior], tools: worktree-write, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - from: make-doc\n    on: outcome\n    map: { done: done, rework: failed, needs-human: failed, failed: failed }\n`);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const bunShimDir = join(stateRoot, 'bin');
    const childEnvProbe = join(stateRoot, 'actual-headless-bun-child-env.json');
    const childEnvPreload = join(stateRoot, 'capture-headless-bun-env.mjs');
    mkdirSync(bunShimDir);
    const actualBunPath = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
    writeFileSync(childEnvPreload,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childEnvProbe)}, JSON.stringify(process.env));\n`);
    writeFileSync(join(bunShimDir, 'bun'), [
      '#!/bin/sh',
      `case "$*" in *headless-goal-loop.ts*) exec ${shellQuote(actualBunPath)} --preload ${shellQuote(childEnvPreload)} "$@" ;; esac`,
      `exec ${shellQuote(actualBunPath)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const runBash = async (body: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => {
      try {
        const env: NodeJS.ProcessEnv = {
          PATH: `${bunShimDir}:/usr/bin:/bin`,
          HOME: homeRoot,
          ELANOUS_STATE_DIR: stateRoot,
          XDG_DATA_HOME: dataRoot,
          ...(opts.env?.ELANOUS_GRAPH_CONTEXT ? { ELANOUS_GRAPH_CONTEXT: opts.env.ELANOUS_GRAPH_CONTEXT } : {}),
          ...(opts.env?.ELANOUS_GRAPH_DRY_RUN ? { ELANOUS_GRAPH_DRY_RUN: opts.env.ELANOUS_GRAPH_DRY_RUN } : {}),
          ...(opts.env?.ELANOUS_GRAPH_DIR ? { ELANOUS_GRAPH_DIR: opts.env.ELANOUS_GRAPH_DIR } : {}),
        };
        expect(env.HOME).toBe(homeRoot);
        expect(env.ELANOUS_STATE_DIR).toBe(stateRoot);
        expect(env.XDG_DATA_HOME).toBe(dataRoot);
        expect(env.ELANOUS_CONFIG_DIR).toBeUndefined();
        expect(env.ELANOUS_STATE_DIR_SOURCE).toBeUndefined();
        expect(env.XDG_CONFIG_HOME).toBeUndefined();
        const { stdout, stderr } = await execFileAsync('bash', ['-c', body], {
          cwd: opts.cwd ?? process.cwd(), env, encoding: 'utf8',
          timeout: opts.timeoutMs ?? 30_000,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const childError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
        return { stdout: String(childError.stdout ?? ''), stderr: String(childError.stderr ?? childError.message), exitCode: childError.status ?? 1 };
      }
    };

    const run = await runGraph(graph, { input: {
      ask: 'Write docs/research-report.md containing the requested research report.',
      context: { worktree: target, branch: 'work/research-report' },
      prior: null,
    }, deps: { root: stateRoot, runBash } });

    expect(run.status).toBe('done');
    expect(run.unitCalls).toHaveLength(1);
    expect(run.unitCalls?.[0]).toMatchObject({ unit: 'verb-make-doc', exit: 'done' });
    const parentOutput = run.nodes.find((node) => node.nodeId === 'make-doc')?.output;
    expect(parentOutput).toContain('docs/research-report.md');
    const parentEvidence = JSON.parse(String(parentOutput)).evidence as { 'document-drafts': string[]; 'terminal-status': unknown };
    expect(parentEvidence['document-drafts']).toEqual(['docs/research-report.md']);
    const changedFiles = (JSON.parse(String(parentOutput)).evidence as { 'changed-files': string[] })['changed-files'];
    expect(changedFiles).not.toContain('docs/preexisting.md');
    expect(changedFiles).toContain('docs/research-report.md');
    expect(parentOutput).toContain('"evidence"');
    expect(parentOutput).toContain('"terminal-status"');
    expect(readFileSync(join(target, 'docs/research-report.md'), 'utf8')).toContain('# Research report');
    const actualEnv = JSON.parse(readFileSync(childEnvProbe, 'utf8')) as NodeJS.ProcessEnv;
    expect(actualEnv.HOME).toBe(homeRoot);
    expect(actualEnv.ELANOUS_STATE_DIR).toBe(stateRoot);
    expect(actualEnv.XDG_DATA_HOME).toBe(dataRoot);
    expect(actualEnv.ELANOUS_CONFIG_DIR).toBeUndefined();
    expect(actualEnv.ELANOUS_STATE_DIR_SOURCE).toBeUndefined();
    expect(actualEnv.XDG_CONFIG_HOME).toBeUndefined();
    const requests = session.mock.getRequests();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    type JournalRequest = (typeof requests)[number];
    const firstUserMessage = (request: JournalRequest | undefined) =>
      (request?.body as { messages?: Array<{ role?: string; content?: unknown }> } | null)
        ?.messages?.find((message) => message.role === 'user')?.content;
    const screenContext = String(firstUserMessage(requests[0]));
    const memorySelection = String(firstUserMessage(requests[1]));
    expect(screenContext).toContain('=== 자식 화면 ===');
    expect(memorySelection).toContain('기억을 고르는 선택기');
    // After those two known preflight calls, the next provider call is the first implementation task.
    const firstTaskRequest = requests[2];
    const firstTaskUserMessage = String(firstUserMessage(firstTaskRequest));
    expect(firstTaskUserMessage).toContain('Write docs/research-report.md containing the requested research report.');
    expect(firstTaskUserMessage).toContain('[self-implement] 이 작업을 끝까지 구현하라.');
    expect(parentEvidence['terminal-status']).toMatchObject({ reached: true, timedOut: false });
    expect(typeof (parentEvidence['terminal-status'] as { changed?: unknown }).changed).toBe('boolean');
    expect(typeof (parentEvidence['terminal-status'] as { toolCalls?: unknown }).toolCalls).toBe('number');
  } finally {
    await session.close();
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    if (previousConfigDir === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = previousConfigDir;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    if (previousStateDirSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE;
    else process.env.ELANOUS_STATE_DIR_SOURCE = previousStateDirSource;
  }
}, 90_000);
