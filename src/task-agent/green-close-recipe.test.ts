import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { parseGreenCloseEvidenceCommand, testAssertsProductionResult, verifyGreenCloseBoundary } from './green-close-recipe.js';

const graphPath = resolve(import.meta.dir, '../../graphs/work/green-close.yaml');
const sidecarPath = join(import.meta.dir, '../../graphs/work/recipes.yaml');
const MOCK_MAIN_SHA = 'a'.repeat(40);
const MOCK_MERGE_SHA = 'b'.repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('GREEN-CLOSE-RECIPE evidence safety', () => {
  test('C1c CELL-DONE and MAPREDUCE slices stay HOLD despite E1/E2/E3', () => {
    const base = { evidence: '', mainSha: 'a'.repeat(40), stateRoot: '/tmp', repoRoot: import.meta.dir,
      command: 'bun test src/task-agent/green-sweep.test.ts' };
    expect(verifyGreenCloseBoundary({ ...base, cellId: 'CELL-DONE-EVIDENCE-WIRING-DUPLICATES-FU',
      title: '- 완료 경계 코드: shared checker and normalized title\n- 완료 경계 실물: strict retitle and one card',
      paths: ['src/self-implement/goal-author.ts', 'src/release-loop/checklist.ts', 'src/cli/release-cli.ts', 'src/task-agent/task-hand.ts'],
      changedPaths: ['src/self-implement/goal-author.ts'],
    })).toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
    expect(verifyGreenCloseBoundary({ ...base, cellId: 'MAPREDUCE-FANOUT',
      title: '- 완료 경계 코드: live card and ledger binding\n- 완료 경계 실물: host graph run one item',
      paths: ['src/task-agent/map-reduce.ts', 'src/task-agent/map-run-ledger.ts', 'src/task-agent/map-host-adapter.ts', 'src/cli/tasks-cli.ts'],
      changedPaths: ['src/task-agent/map-host-adapter.ts', 'src/cli/tasks-cli.ts'],
    })).toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
  });
  test('only accepts bun test with repository-relative paths and bounded optional flags', () => {
    expect(parseGreenCloseEvidenceCommand('bun test src/a.test.ts -t focused --timeout 12000'))
      .toEqual({ ok: true, args: ['src/a.test.ts', '-t', 'focused', '--timeout', '12000'] });
    for (const command of [
      'bun -e process.exit(0)',
      'bun test src/a.test.ts | cat',
      'bun test src/a.test.ts; rm -rf .',
      'bun test src/a.test.ts > /tmp/out',
      'bun test ../outside.test.ts',
      'bun test /tmp/out.test.ts',
      'bun test --timeout nope src/a.test.ts',
      'bun test',
    ]) expect(parseGreenCloseEvidenceCommand(command)).toEqual({ ok: false });
  });

  test('requires an assertion in the same test block to consume a production call result', () => {
    const productionPaths = ['/repo/src/green-sweep.ts'];
    expect(testAssertsProductionResult(
      "import { decide } from './green-sweep.js'; test('call only', () => { decide(); });",
      '/repo/src/green-sweep.test.ts', productionPaths,
    )).toBe(false);
    expect(testAssertsProductionResult(
      "import { decide } from './green-sweep.js'; test('asserts call result', () => { expect(decide()).toEqual('green'); });",
      '/repo/src/green-sweep.test.ts', productionPaths,
    )).toBe(true);
    expect(testAssertsProductionResult(
      "import { decide } from './green-sweep.js'; test('asserts flowed value', () => { const decision = decide(); const verdict = decision.verdict; expect(verdict).toBe('green'); });",
      '/repo/src/green-sweep.test.ts', productionPaths,
    )).toBe(true);
    expect(testAssertsProductionResult(
      "import { decide } from './green-sweep.js'; test('other block assertion', () => { decide(); }); test('unrelated', () => { expect(true).toBe(true); });",
      '/repo/src/green-sweep.test.ts', productionPaths,
    )).toBe(false);
  });
});

function input(pr: number, evidenceCommand: string, withTest = true) {
  return {
    version: '0.2.37', cellId: 'GREEN-SWEEP-LIVE-WRITE', status: 'yellow',
    title: 'GREEN-SWEEP-LIVE-WRITE\n- 완료 경계 코드: production decision\n- 완료 경계 실물: isolated green-close fixture\n- 완료 경계 실물 검증: [{"kind":"graph-run","graphId":"fixture-live","runId":"fixture-green-1","nodeId":"done","assertion":{"path":"outcome","equals":"pass"}}]',
    mapRunId: 'map-fixture', cardId: 'card-fixture',
    paths: withTest ? ['src/task-agent/green-sweep.ts', 'src/task-agent/green-sweep.test.ts'] : ['src/task-agent/green-sweep.ts'],
    evidence: `완료 경계 증거 명령: ${evidenceCommand}`,
    candidates: [{ pr, mergeSha: MOCK_MERGE_SHA }], main: { sha: MOCK_MAIN_SHA, ref: 'origin/main' },
  };
}

function testDeps(mergedPrs: Set<number>) {
  const root = mkdtempSync(join(tmpdir(), 'green-close-recipe-'));
  roots.push(root);
  mkdirSync(join(root, 'state', 'graph-runs', 'fixture-live'), { recursive: true });
  writeFileSync(join(root, 'state', 'graph-runs', 'fixture-live', 'fixture-green-1.json'), JSON.stringify({
    graphId: 'fixture-live', runId: 'fixture-green-1', status: 'done',
    input: { cellId: 'GREEN-SWEEP-LIVE-WRITE', mainSha: MOCK_MAIN_SHA },
    nodes: [{ nodeId: 'done', ok: true, exit: 0, output: { outcome: 'pass' } }],
  }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const git = join(bin, 'git');
  writeFileSync(git, `#!/bin/sh\nprintf 'git %s\\n' "$*" >> "$MOCK_TOOL_LOG"\ncase "$*" in\n  *"worktree add --detach "*) /bin/mkdir -p "$6"; exit 0 ;;\n  *"worktree remove --force "*) /bin/rm -rf "$6"; exit 0 ;;\n  *"status --porcelain"*) exit 0 ;;\n  *"branch --show-current"*) printf 'main\\n'; exit 0 ;;\n  *"rev-parse"*) printf '%s\\n' "$MOCK_MAIN_SHA"; exit 0 ;;\n  *"merge-base --is-ancestor"*) exit 0 ;;\n  *"diff --name-only"*) printf 'src/task-agent/green-sweep.ts\\n'; exit 0 ;;\n  *) echo "unexpected git call: $*" >&2; exit 91 ;;\nesac\n`);
  chmodSync(git, 0o755);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$MOCK_TOOL_LOG"\n[ "$1" = pr ] && [ "$2" = view ] || exit 90\ncase "$3" in\n${[...mergedPrs].map((pr) => `  ${pr}) printf '{"state":"MERGED","mergeCommit":{"oid":"%s"}}\\n' "$MOCK_MERGE_SHA" ;;`).join('\n')}\n  *) printf '{"state":"CLOSED","mergeCommit":null}\\n' ;;\nesac\n`);
  chmodSync(gh, 0o755);
  const bun = join(bin, 'bun');
  writeFileSync(bun, `#!/bin/sh\nprintf 'bun %s\\n' "$*" >> "$MOCK_TOOL_LOG"\nif [ "$1" = "-e" ]; then exec "$BUN_REAL" "$@"; fi\nif [ "$1" = install ]; then exit 0; fi\nif [ "$1" = test ]; then printf 'mocked nested test pass\\n'; exit 0; fi\necho "unexpected bun call: $*" >&2; exit 92\n`);
  chmodSync(bun, 0o755);
  const eln = join(bin, 'eln');
  writeFileSync(eln, `#!/bin/sh\nprintf 'eln %s\\n' "$*" >> "$MOCK_TOOL_LOG"\necho 'unexpected installed eln invocation' >&2\nexit 93\n`);
  chmodSync(eln, 0o755);
  const toolLog = join(root, 'tool-calls.log');
  return {
    root: join(root, 'state'),
    runBash: async (body: string, options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const child = Bun.spawnSync(['/bin/bash', '-c', body], {
        cwd: options.cwd,
        env: { ...options.env, PATH: bin, BUN_REAL: process.execPath, MOCK_TOOL_LOG: toolLog,
          MOCK_MAIN_SHA, MOCK_MERGE_SHA },
        stdout: 'pipe', stderr: 'pipe',
      });
      return { stdout: new TextDecoder().decode(child.stdout), stderr: new TextDecoder().decode(child.stderr), exitCode: child.exitCode };
    },
  };
}

describe('GREEN-CLOSE-RECIPE graph contract', () => {
  test('declares deterministic E1/E2/E3, a mock-test branch, and one result row', () => {
    const source = readFileSync(graphPath, 'utf8');
    const parsed = parseGraphTemplateYaml(source, graphPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.template).toMatchObject({ graphId: 'green-close', entryNode: 'e1', terminalNodes: ['done', 'failed'] });
    const doc = parseYaml(source) as { nodes: Array<{ node_id: string; recipe: string }>; edges: Array<{ from: string; map?: Record<string, string> }> };
    const recipes = parseYaml(readFileSync(sidecarPath, 'utf8')) as Record<string, { command?: string }>;
    for (const node of ['e1', 'e2', 'e3', 'produce', 'boundary', 'make-test', 'result']) {
      const entry = doc.nodes.find((candidate) => candidate.node_id === node);
      expect(entry, `node ${node}`).toBeDefined();
      expect(entry!.recipe).toMatch(/^cmd:/);
      expect(recipes[entry!.recipe.slice(4)]?.command).toBeTruthy();
    }
    expect(doc.edges.find((edge) => edge.from === 'e3')?.map).toMatchObject({ pass: 'produce', missing: 'make-test', hold: 'result' });
    expect(doc.edges.find((edge) => edge.from === 'produce')?.map).toMatchObject({ pass: 'boundary', hold: 'result' });
    expect(doc.edges.find((edge) => edge.from === 'boundary')?.map).toMatchObject({ pass: 'result', hold: 'result' });
    expect(doc.edges.find((edge) => edge.from === 'make-test')?.map).toMatchObject({ 'mock-pr': 'result' });
  });

  test('runs exact E1 merge ancestry and E2 command, proves the production test entry, and emits green-candidate row', async () => {
    const command = 'bun test src/task-agent/green-sweep.test.ts';
    const item = input(73111, command);
    const deps = testDeps(new Set([73111]));
    const run = await runGraph(graphPath, { input: item, quiet: true, deps });
    expect(run.status).toBe('done');
    expect(run.path, JSON.stringify(run.nodes)).toEqual(['e1', 'e2', 'e3', 'produce', 'boundary', 'result', 'done']);
    const proofRef = `boundary-proofs/${item.cellId}/${run.runId}.json`;
    expect(verifyGreenCloseBoundary({ title: item.title, evidence: item.evidence, paths: item.paths,
      changedPaths: ['src/task-agent/green-sweep.ts'], cellId: item.cellId, mainSha: item.main.sha,
      stateRoot: deps.root, repoRoot: resolve(import.meta.dir, '../..'), command,
      mapRunId: item.mapRunId, cardId: item.cardId, graphRunId: run.runId, proofRef })).toMatchObject({ outcome: 'pass' });
    const proofPath = join(deps.root, proofRef);
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    proof.mappingHash = '0'.repeat(64);
    writeFileSync(proofPath, JSON.stringify(proof));
    expect(verifyGreenCloseBoundary({ title: item.title, evidence: item.evidence, paths: item.paths,
      changedPaths: ['src/task-agent/green-sweep.ts'], cellId: item.cellId, mainSha: item.main.sha,
      stateRoot: deps.root, repoRoot: resolve(import.meta.dir, '../..'), command,
      mapRunId: item.mapRunId, cardId: item.cardId, graphRunId: run.runId, proofRef })).toMatchObject({ outcome: 'hold' });
    const row = JSON.parse(run.nodes.find((node) => node.nodeId === 'result')?.output as string);
    expect(row).toMatchObject({ outcome: 'ok', cellId: 'GREEN-SWEEP-LIVE-WRITE', version: '0.2.37', kind: 'green-candidate',
      pr: 73111, e3: { verdict: 'pass' }, exitCode: 0 });
    expect(row.mergeSha).toBe(MOCK_MERGE_SHA);
    const toolCalls = readFileSync(join(deps.root, '..', 'tool-calls.log'), 'utf8');
    expect(toolCalls).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(toolCalls).toContain('bun test src/task-agent/green-sweep.test.ts');
    expect(toolCalls).not.toContain('eln ');
  }, 120_000);

  test('holds a code-only PR when the production assertion passes but live boundary proof is missing', async () => {
    const item = input(73114, 'bun test src/task-agent/green-sweep.test.ts');
    item.title = item.title.replace(/^.*완료 경계 실물 검증:.*\n?/m, '');
    item.evidence = '완료 경계 증거 명령: bun test src/task-agent/green-sweep.test.ts';
    const run = await runGraph(graphPath, { input: item, quiet: true, deps: testDeps(new Set([73114])) });
    expect(run.path).toEqual(['e1', 'e2', 'e3', 'produce', 'result', 'done']);
    const row = JSON.parse(run.nodes.find((node) => node.nodeId === 'result')?.output as string);
    expect(row).toMatchObject({ kind: 'hold', reason: 'boundary-unproven' });
  }, 120_000);

  test('routes an E1 failure to a hold result without running the evidence command', async () => {
    const run = await runGraph(graphPath, { input: input(73112, 'bun -e "process.exit(0)"'), quiet: true, deps: testDeps(new Set()) });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['e1', 'result', 'done']);
    const row = JSON.parse(run.nodes.find((node) => node.nodeId === 'result')?.output as string);
    expect(row).toMatchObject({ kind: 'hold', pr: 73112, reason: 'pr-not-merged' });
    expect(row.command).toBeUndefined();
  });

  test('holds an arbitrary shell evidence command instead of executing it', async () => {
    const run = await runGraph(graphPath, { input: input(73113, 'bun -e "process.exit(0)"', false), quiet: true, deps: testDeps(new Set([73113])) });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['e1', 'e2', 'result', 'done']);
    const row = JSON.parse(run.nodes.find((node) => node.nodeId === 'result')?.output as string);
    expect(row).toMatchObject({ kind: 'hold', pr: 73113, reason: 'e2-command-not-allowed', command: 'bun -e "process.exit(0)"' });
  });
});
