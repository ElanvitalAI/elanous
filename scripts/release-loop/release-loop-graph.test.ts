import { setDefaultTimeout, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import { decideGraphApproval, runGraph } from '../../src/graph-runner/runner.js';
import { runPrLand as realRunPrLand } from '../../src/cli/pr-cli.js';
import { ClaimsLedger } from '../../src/claims/claims-ledger.js';
import { addItem, setItem } from '../../src/release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { makePrManager, type CmdRunner } from '../../src/autopilot/pr-manager.js';
import { publicNotes, runPublish } from './publish-node.js';
import { runPrepare } from './prepare-node.js';
import { runUpgrade } from './upgrade-node.js';
import { runDocsLand } from './docs-land-node.js';
import { runVerify } from './verify-node.js';
import { runAutoApprove } from './auto-approve-node.js';
import { runVaultNote } from './vault-note-node.js';
import type { GraphContext } from './node-verdict.js';
import { afterEach as freezeIsolationAfterEach, beforeEach as freezeIsolationBeforeEach } from 'bun:test';
import { rmSync as freezeIsolationRm } from 'node:fs';
import { resetEffectiveInstanceRoot as freezeIsolationReset } from '../../src/instance/resolve.js';

// Both freeze authorities are isolated for every runPrLand here: the operational root (injected) and the
// local universe (ELANOUS_STATE_DIR) — these tests must never read or write the real ~/.elanous (FREEZE-HOSTMERGE).
let isolatedFreezeRoot = '';
let isolatedStateDirForFreeze = '';
let savedStateDirForFreeze: string | undefined;
freezeIsolationBeforeEach(() => {
  isolatedFreezeRoot = mkdtempSync(join(tmpdir(), 'pr-land-freeze-'));
  isolatedStateDirForFreeze = mkdtempSync(join(tmpdir(), 'pr-land-state-'));
  savedStateDirForFreeze = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = isolatedStateDirForFreeze;
  freezeIsolationReset();
});
freezeIsolationAfterEach(() => {
  if (savedStateDirForFreeze === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDirForFreeze;
  freezeIsolationReset();
  freezeIsolationRm(isolatedFreezeRoot, { recursive: true, force: true });
  freezeIsolationRm(isolatedStateDirForFreeze, { recursive: true, force: true });
});
const runPrLand: typeof realRunPrLand = (opts = {}, deps = {}) => realRunPrLand(opts, { prodFreezeRoot: isolatedFreezeRoot, ...deps });

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('release graph CLI dry-run previews automatic route without executing commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cli-dry-run-'));
  try {
    const run = spawnSync('bun', ['bin/elanous.mjs', '--test', 'graph', 'run', 'graphs/release/release-loop.yaml', '--dry-run', '--json', '--input', '{"version":"9.9.9","previousVersion":"0.2.3"}'], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: root },
    });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { status: string; path: string[]; executed: number; pending?: { nodeId: string; message: string } };
    expect(output.status).toBe('done');
    expect(output.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    expect(output.pending).toBeUndefined();
    expect(output.executed).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph dry-run previews automatic path without executing commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-graph-'));
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async () => { throw new Error('dry-run executed command'); } }, dryRun: true,
    });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    expect(state.pending).toBeUndefined();
    expect(state.executed).toBe(0);
    expect(state.nodes.every((node) => !node.executed)).toBe(true);
    const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: Array<{ from: string; map: Record<string, string> }> };
    expect(graph.edges.filter((e) => Object.values(e.map).includes('publish')).map((e) => e.from)).toEqual(['auto-approve', 'approve-publish']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cutoff routes through checklist-gate before the costly gate', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'checklist-gate')).toMatchObject({ kind: 'gate', recipe: 'cmd:checklist-gate', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'cutoff')?.map).toEqual({ ok: 'checklist-gate', fail: 'failed', error: 'failed' });
  expect(graph.edges.find((edge) => edge.from === 'checklist-gate')?.map).toEqual({ ok: 'gate', fail: 'failed', error: 'failed' });
  expect(recipes['checklist-gate']).toEqual({ command: 'bun scripts/release-loop/checklist-gate-node.ts', timeout_ms: 600000 });
});

test('public export check routes gate ok before pwa and failure to failed', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'export-check')).toMatchObject({ kind: 'gate', recipe: 'cmd:export-check', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'mac-smoke')).toMatchObject({ kind: 'gate', recipe: 'cmd:mac-smoke', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'gate')?.map).toEqual({ ok: 'mac-smoke', fail: 'failed', error: 'failed' });
  expect(graph.edges.find((edge) => edge.from === 'mac-smoke')?.map).toEqual({ ok: 'export-check', fail: 'export-check', error: 'export-check' });
  expect(recipes['mac-smoke']).toEqual({ command: 'bun scripts/release-loop/mac-smoke-node.ts', timeout_ms: 1_800_000 });
  expect(graph.edges.find((edge) => edge.from === 'export-check')?.map).toEqual({ ok: 'pwa', fail: 'failed', error: 'failed' });
  expect(recipes['export-check']).toEqual({ command: 'bun scripts/release-loop/export-check-node.ts', timeout_ms: 1_800_000 });
  const root = mkdtempSync(join(tmpdir(), 'release-export-failed-'));
  try {
    const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
      exitCode: body.includes('export-check-node.ts') ? 1 : 0,
      stdout: JSON.stringify(body.includes('export-check-node.ts') ? { outcome: 'fail', verdict: 'fail', summary: 'leak', step: 'export', tail: 'leak' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
    }) } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'failed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mac-smoke fail and error are warning-only: the graph continues to export-check and publishing', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  for (const outcome of ['fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-mac-smoke-failed-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
        exitCode: body.includes('mac-smoke-node.ts') ? outcome === 'fail' ? 1 : 2 : 0,
        stdout: JSON.stringify(body.includes('mac-smoke-node.ts') ? { outcome, verdict: 'fail', summary: '측정 불가' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
      }) } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('release notes-check gates approval with a recipe and failure routes', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'notes-check')).toMatchObject({ node_id: 'notes-check', kind: 'gate', recipe: 'cmd:notes-check', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'known-issues')).toMatchObject({ kind: 'agent', recipe: 'cmd:known-issues', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'docs')?.map).toEqual({ ok: 'known-issues', fail: 'failed', error: 'failed' });
  expect(graph.edges.find((edge) => edge.from === 'known-issues')?.map).toEqual({ ok: 'notes-check', fail: 'failed', error: 'failed' });
  expect(recipes['known-issues']).toEqual({ command: 'bun scripts/release-loop/known-issues-node.ts', timeout_ms: 600000 });
  expect(graph.edges.find((edge) => edge.from === 'notes-check')?.map).toEqual({ ok: 'auto-approve', fail: 'failed', error: 'failed' });
  expect(graph.nodes.find((node) => node.node_id === 'auto-approve')).toMatchObject({ kind: 'gate', recipe: 'cmd:auto-approve', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'approve-publish')).toMatchObject({ kind: 'hitl', recipe: 'approval:publish' });
  expect(graph.edges.find((edge) => edge.from === 'auto-approve')?.map).toEqual({ ok: 'publish', fail: 'approve-publish', error: 'approve-publish' });
  expect(graph.edges.find((edge) => edge.from === 'approve-publish')?.map).toEqual({ ok: 'publish', fail: 'failed' });
  expect(recipes['notes-check']).toEqual({ command: 'bun scripts/announce-loop/check-node.ts --json', timeout_ms: 600000 });
  expect(recipes['auto-approve']).toEqual({ command: 'bun scripts/release-loop/auto-approve-node.ts', timeout_ms: 600000 });
});

test('npm publish follows GitHub publication and failure continues to docs land', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>; edges: Array<{ from: string; map: Record<string, string> }> };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'npm-publish')).toMatchObject({ kind: 'git', recipe: 'cmd:npm-publish', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'publish')?.map).toEqual({ ok: 'npm-publish', fail: 'failed', error: 'failed' });
  expect(graph.edges.find((edge) => edge.from === 'npm-publish')?.map).toEqual({ ok: 'docs-land', fail: 'docs-land', error: 'docs-land' });
  expect(recipes['npm-publish']).toEqual({ command: 'bun scripts/release-loop/npm-publish-node.ts', timeout_ms: 4_500_000 });
  expect(recipes['npm-publish']?.timeout_ms).toBeGreaterThan(40 * 60_000 + 2 * 300_000 + 83 * 15_000);
  const root = mkdtempSync(join(tmpdir(), 'release-npm-failure-'));
  try {
    const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
      exitCode: body.includes('npm-publish-node.ts') ? 1 : 0,
      stdout: JSON.stringify(body.includes('npm-publish-node.ts') ? { outcome: 'fail', verdict: 'fail', summary: 'E401' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
    }) } });
    expect(state.status).toBe('done');
    expect(state.path.slice(-8)).toEqual(['npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'npm-publish')?.output))).toMatchObject({ outcome: 'fail', summary: 'E401' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('published graph vault-note recipe renders the cutoff manifest and keeps the route to ops-upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-vault-graph-'));
  const vault = join(root, 'vault');
  const version = '0.2.14';
  const cut = 'a'.repeat(40);
  try {
    const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; recipe?: string }>; edges: Array<{ from: string; map: Record<string, string> }> };
    const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string }>;
    expect(graph.nodes.find((node) => node.node_id === 'vault-note')?.recipe).toBe('cmd:vault-note');
    expect(recipes['vault-note']?.command).toBe('bun scripts/release-loop/vault-note-node.ts');
    // The vault note always continues to the release story, which then always continues to ops-upgrade (#24052).
    expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'release-story', fail: 'release-story', error: 'release-story' });
    expect(graph.edges.find((edge) => edge.from === 'release-story')?.map).toEqual({ ok: 'ops-upgrade', fail: 'ops-upgrade', error: 'ops-upgrade' });
    const dir = join(root, 'release', version);
    mkdirSync(join(dir, 'prepared'), { recursive: true });
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ version, tag: `v${version}`, sourceCommit: cut, publishedAt: '2026-10-05T09:00:00Z', publicRepo: 'ElanvitalAI/elanous' }));
    writeFileSync(join(dir, 'prepared', 'notes-draft.md'), '# Release\n- Change\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: cut }, in: [
      { sha: 'c'.repeat(40), title: '하니스 "검증" 개선', prNumber: 1, line: '하니스 "검증" 개선' },
      { sha: '', title: '지식 교훈 축적', line: '지식 교훈 축적' },
    ] }));
    expect(runVaultNote({ input: { version, previousVersion: '0.2.13' }, outputs: { verify: { outcome: 'ok' } } },
      { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
    const content = readFileSync(join(vault, '40. Project/엘라누스 릴리스/0.x/0.2/엘라누스 v0.2.14 (2026-10-05).md'), 'utf8');
    expect(content).toContain('### 하니스 (1건)\n\n- 하니스 "검증" 개선 (#1)');
    expect(content).toContain('### 지식·교훈 (1건)\n\n- 지식 교훈 축적');
    expect(yaml(content.split('---\n')[1]!)).toMatchObject({ title: '엘라누스 v0.2.14 — 하니스 "검증" 개선 · 지식 교훈 축적' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ops-upgrade runs after verify and a failed host does not undo publication or dev bump', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>; edges: Array<{ from: string; map: Record<string, string> }> };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'ops-upgrade')).toMatchObject({ kind: 'agent', recipe: 'cmd:ops-upgrade', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'verify')?.map).toEqual({ ok: 'vault-note', fail: 'failed', error: 'failed' });
  expect(graph.edges.find((edge) => edge.from === 'ops-upgrade')?.map).toEqual({ ok: 'version-dev-bump', fail: 'version-dev-bump', error: 'version-dev-bump' });
  expect(recipes['ops-upgrade']).toEqual({ command: 'bun scripts/release-loop/ops-upgrade-node.ts', timeout_ms: 1_200_000 });
  const root = mkdtempSync(join(tmpdir(), 'release-ops-failed-'));
  try {
    const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
      exitCode: body.includes('ops-upgrade-node.ts') ? 1 : 0,
      stdout: JSON.stringify(body.includes('ops-upgrade-node.ts')
        ? { outcome: 'fail', verdict: 'fail', hosts: [{ host: 'node-b', ok: false, before: '9.9.8', after: '', error: '공급원에 판 없음 (404)' }] }
        : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
    }) } });
    expect(state.status).toBe('done');
    expect(state.path.slice(-9)).toEqual(['publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'ops-upgrade')?.output))).toMatchObject({ outcome: 'fail', hosts: [{ host: 'node-b', ok: false }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release story follows vault note and every outcome continues to ops upgrade', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'release-story')).toMatchObject({ kind: 'gate', recipe: 'cmd:release-story', max_visits: 1 });
  expect(recipes['release-story']).toEqual({ command: 'bun scripts/release-story/draft.ts --graph', timeout_ms: 600000 });
  expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'release-story', fail: 'release-story', error: 'release-story' });
  expect(graph.edges.find((edge) => edge.from === 'release-story')?.map).toEqual({ ok: 'ops-upgrade', fail: 'ops-upgrade', error: 'ops-upgrade' });
  for (const outcome of ['ok', 'fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-story-route-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
        exitCode: body.includes('release-story/draft.ts') ? outcome === 'ok' ? 0 : outcome === 'fail' ? 1 : 2 : 0,
        stdout: JSON.stringify(body.includes('release-story/draft.ts') ? { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: 'injected story result' } : { outcome: 'ok', verdict: 'pass' }) + '\n', stderr: '',
      }) } });
      expect(state.status).toBe('done');
      expect(state.path.slice(-5)).toEqual(['vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('0.2.14 published graph executes the real story recipe into the isolated release directory and MK inbox once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-story-published-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const version = '0.2.14';
  const story = join(root, 'release', version, 'story');
  const requests = join(root, 'seat-requests', 'requests.jsonl');
  try {
    const checklistDir = join(root, 'release', version);
    mkdirSync(checklistDir, { recursive: true });
    setElanousConfigDir(root);
    addItem(version, { id: 'STORY_214', title: 'New reading mode — details' });
    setItem(version, 'STORY_214', { status: 'green' }, 'MK');
    const ledger = new ClaimsLedger({ stateDir: root });
    ledger.add({ id: 'EXPORT_214', claim: 'New export mode is available.', audience: 'personal', owner: 'MK' });
    ledger.verify('EXPORT_214', { value: 'yes', command: 'bun measure-export.ts', measuredAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
    ledger.link('EXPORT_214', { cell: 'STORY_214', version });
    // 실제 release/next.md 는 판 올림마다 비워진다 — 시험은 자기 판 노트 픽스처를 쓴다.
    const nextFixture = join(root, 'next.md');
    writeFileSync(nextFixture, '# next\n\n## User\n\n- A new public guide shows how to attach a coding session to an elanous seat.\n');
    const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      if (body.includes('release-story/draft.ts')) {
        const child = spawnSync(process.execPath, [join(import.meta.dir, '../release-story/draft.ts'), '--graph'], {
          cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root, ELANOUS_RELEASE_NEXT_PATH: nextFixture },
        });
        return { exitCode: child.status ?? 2, stdout: child.stdout, stderr: child.stderr };
      }
      return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    };
    for (let i = 0; i < 2; i++) {
      const state = await runGraph(graphPath, { input: { version, previousVersion: '0.2.13' }, deps: { root, runBash } });
      expect(state.status).toBe('done');
      expect(state.path.slice(-5)).toEqual(['vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
      expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'release-story')?.output))).toMatchObject({ outcome: 'ok', status: 'drafted' });
    }
    const announcement = readFileSync(join(story, 'announcement.md'), 'utf8');
    expect(announcement).toContain(version);
    const next = readFileSync(nextFixture, 'utf8');
    const selected = next.split(/\r?\n/).find((line) => /^- (?:feat — )?A new public guide/.test(line))?.replace(/^- (?:feat — )?/, '');
    expect(selected).toBeDefined();
    expect(announcement).toContain(`새 종류 후보: ${selected}\n- 출처: release/next.md\n- 재측정: 확인 명령 없음 — 게시 전 확인`);
    expect(announcement).not.toContain('재측정: bun measure-export.ts');
    expect(announcement).toContain('New export mode is available.');
    expect(announcement).toContain('CMO 게시 판단');
    expect(readFileSync(join(story, 'site-news.md'), 'utf8')).toContain(version);
    expect(readFileSync(join(story, 'manual-candidates.md'), 'utf8')).toContain('STORY_214 · New reading mode · 매뉴얼 언급 없음');
    const rows = readFileSync(requests, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `release-story:${version}`, seat: 'MK', source: 'release-story', version,
      status: 'pending', text: `${version} 공지 초안 준비됨: ${story}` });
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('graph recipes carry start notices and measured long-node timeouts', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; notify?: string; max_visits: number }> };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { timeout_ms?: number; command?: string; approval?: string }>;
  for (const node of graph.nodes) expect(node.max_visits).toBe(1);
  expect(graph.nodes.filter((node) => node.notify === 'start').map((node) => node.node_id)).toEqual(['gate', 'pwa', 'prepare']);
  expect(recipes.gate?.timeout_ms).toBe(14_400_000);
  expect(recipes.pwa?.timeout_ms).toBe(1_800_000);
  expect(recipes.prepare?.timeout_ms).toBe(1_800_000);
  expect(recipes.publish?.approval).toContain('되돌릴 수 없다');
  expect(recipes['publish-command']?.command).toContain('publish-node.ts');
});

test('measured graph decision publishes without human approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-auto-wiring-'));
  const repo = join(root, 'repo');
  const out = join(root, 'release', '0.2.5', 'prepared');
  const dist = join(out, 'dist');
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  try {
    mkdirSync(repo);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(dist, `install-${i}`), 'fixture');
    const fake = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      commands.push(body);
      if (body.includes('auto-approve-node.ts')) {
        const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as GraphContext;
        const result = runAutoApprove(context, { instanceRoot: root, repo });
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(result) + '\n', stderr: '' };
      }
      const fields = body.includes('gate-node.ts') ? { introduced: [] } : body.includes('prepare-node.ts') ? { out }
        : body.includes('docs-node.ts') ? { notes: join(root, 'notes.md') } : {};
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', ...fields }) + '\n', stderr: '' };
    };
    const state = await runGraph(graph, { input: { version: '0.2.5', previousVersion: '0.2.4' }, deps: { root, runBash: fake } });
    expect(state.status).toBe('done');
    expect(state.path).toContain('auto-approve');
    expect(state.path).not.toContain('approve-publish');
    expect(state.nodes.find((n) => n.nodeId === 'auto-approve')?.output).toContain('release-loop metrics');
    expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(true);
    expect(readFileSync(join(root, 'release', '0.2.5', 'auto-approval.md'), 'utf8')).toContain('| 8 | installation files |');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real graph commands stop at approval before publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-approval-'));
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({ exitCode: body.includes('auto-approve-node.ts') ? 1 : 0, stdout: body.includes('auto-approve-node.ts') ? '{"outcome":"fail","verdict":"fail","summary":"unmeasured"}\n' : '{"outcome":"ok","verdict":"pass","summary":"fake"}\n', stderr: '' }) },
    });
    expect(state.status).toBe('awaiting-approval');
    expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'approve-publish']);
    expect(state.pending?.nodeId).toBe('approve-publish');
    expect(state.executed).toBe(14);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real checklist gate stops the graph before the costly gate when a red item exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-checklist-failure-'));
  const ledger = join(root, '.elanous');
  const dir = join(ledger, 'release', '9.9.9');
  const commands: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ version: '9.9.9', released: '', dev: '', items: [{ id: 'K13', title: 'Block release', status: 'red', updatedAt: new Date().toISOString(), updatedBy: 'TC' }], history: [] }));
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body, opts) => {
        commands.push(body);
        if (body.includes('checklist-gate-node.ts')) {
          const run = spawnSync(process.execPath, [join(import.meta.dir, 'checklist-gate-node.ts')], {
            cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, HOME: root, ELANOUS_STATE_DIR: ledger },
          });
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        }
        return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'failed']);
    expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'checklist-gate')?.output))).toMatchObject({ outcome: 'fail', red: ['K13'] });
    expect(commands).toHaveLength(3);
    expect(commands.some((command) => command.includes('/gate-node.ts') && !command.includes('checklist-gate-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate regression routes to failed before preparing or publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-regression-'));
  const commands: string[] = [];
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => {
        commands.push(body);
        return body.includes('/gate-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"new regression"}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fake"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'cutoff', 'checklist-gate', 'gate', 'failed']);
    expect(commands).toHaveLength(4);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('notes-check failure routes to failed without requesting approval or publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-failure-'));
  const commands: string[] = [];
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => {
        commands.push(body);
        return body.includes('announce-loop/check-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","findings":[{"rule":"B11"}]}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path.slice(-4)).toEqual(['docs', 'known-issues', 'notes-check', 'failed']);
    expect(commands.at(-1)).toContain('check-node.ts');
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual docs output reaches the real notes checker and B11 blocks approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-wiring-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const notes = join(root, 'release/public/docs/releases/9.9.9.md');
  const page = join(root, 'release/public/docs/guide.md');
  const commands: string[] = [];
  const approvals: string[] = [];
  try {
    mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
    mkdirSync(join(root, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(join(root, 'website'), { recursive: true });
    writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', in: [] }));
    writeFileSync(join(root, 'website/pages.json'), JSON.stringify({ pages: [] }));
    writeFileSync(page, '🟡 on main — next release');
    const state = await runGraph(graph, {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, log: (event) => { if (event === 'approval-pending') approvals.push(event); }, runBash: async (body, opts) => {
        commands.push(body);
        if (!body.includes('docs-node.ts') && !body.includes('announce-loop/check-node.ts')) {
          return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
        }
        if (body.includes('docs-node.ts')) {
          const run = spawnSync(process.execPath, [join(import.meta.dir, 'docs-node.ts'), '--version', '9.9.9', '--base', root, '--json'], {
            cwd: root, encoding: 'utf8', env: { ...opts.env, ELANOUS_GRAPH_CONTEXT: '', ELANOUS_STATE_DIR: root },
          });
          expect(run.status).toBe(0);
          writeFileSync(notes, `${readFileSync(notes, 'utf8')}내부 제목\n`);
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        }
        const run = spawnSync(process.execPath, [join(import.meta.dir, '../announce-loop/check-node.ts'), '--json'], {
          cwd: root, encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root },
        });
        return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
      } },
    });
    const docs = JSON.parse(String(state.nodes.find((node) => node.nodeId === 'docs')?.output));
    const checked = JSON.parse(String(state.nodes.find((node) => node.nodeId === 'notes-check')?.output));
    expect(docs).toMatchObject({ outcome: 'ok', notes, flipped: [page] });
    expect(checked).toMatchObject({ ok: false, outcome: 'fail', checked: { files: 2 }, findings: [{ rule: 'B11', file: notes, text: '내부 제목' }] });
    expect(state.status).toBe('failed');
    expect(state.path.slice(-4)).toEqual(['docs', 'known-issues', 'notes-check', 'failed']);
    expect(state.pending).toBeUndefined();
    expect(approvals).toEqual([]);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval resumes through publish, docs land, verify and dev bump with fake runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  const fake = async (body: string) => {
    commands.push(body);
    const node = body.includes('version-node.ts release') ? 'version-release' : body.includes('prepare-node.ts') ? 'prepare'
      : body.includes('docs-node.ts') ? 'docs' : body.includes('publish-node.ts') ? 'publish' : 'other';
    const fields = node === 'version-release' ? { commit: 'a'.repeat(40) } : node === 'prepare'
      ? { commit: 'a'.repeat(40), candidate: join(root, 'elanous.tgz'), out: join(root, 'prepared') }
      : node === 'docs' ? { branch: 'release-docs/9.9.9', worktree: join(root, 'docs-tree') }
      : node === 'publish' ? { tag: 'v9.9.9' } : {};
    return { exitCode: body.includes('auto-approve-node.ts') ? 1 : 0, stdout: JSON.stringify({ outcome: body.includes('auto-approve-node.ts') ? 'fail' : 'ok', verdict: body.includes('auto-approve-node.ts') ? 'fail' : 'pass', summary: node, ...fields }) + '\n', stderr: '' };
  };
  try {
    const first = await runGraph(graph, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: fake } });
    expect(first.status).toBe('awaiting-approval');
    expect(commands).toHaveLength(14);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fake-approver', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, runBash: fake } });
    expect(resumed.status).toBe('done');
    expect(resumed.path.slice(-10)).toEqual(['approve-publish', 'publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump', 'done']);
    expect(commands).toHaveLength(22); // + vault-note and release-story
    expect(commands.at(-8)).toContain('publish-node.ts');
    expect(commands.at(-7)).toContain('npm-publish-node.ts');
    expect(commands.at(-1)).toContain('version-node.ts dev-bump');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real node entrypoints pass commit, candidate and worktree through graph contexts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-real-wiring-'));
  const bin = join(root, 'bin');
  const sha = 'a'.repeat(40);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const calls = join(root, 'calls');
  const originalState = process.env.ELANOUS_STATE_DIR;
  try {
    mkdirSync(bin);
    writeFileSync(calls, '');
    const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.RELEASE_WIRING_ROOT;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, 'calls'), tool + ' ' + args.join(' ') + '\\n');
const sha = 'a'.repeat(40);
if (tool === 'git') {
  if (args[0] === 'rev-parse') console.log(args.includes('v0.2.3^{commit}') ? 'b'.repeat(40) : fs.existsSync(path.join(root,'dev-bump.done')) ? 'd'.repeat(40) : fs.existsSync(path.join(root,'release.done')) ? sha : 'c'.repeat(40));
  else if (args[0] === 'show') {
    if (args[1] === 'origin/main:package.json') console.log(JSON.stringify({version:fs.existsSync(path.join(root,'dev-bump.done')) ? '0.2.5-dev.0' : fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0'}));
    else if (args[1].endsWith(':website/pages.json')) console.log(JSON.stringify({pages:[{id:'using-elanous/tasks-and-intake', source:'release/public/docs/tasks-and-intake.md'}]}));
    else console.log('# 0.2.4\\n\\n[Tasks and intake](tasks-and-intake.md)');
  } else if (args[0] === 'worktree' && args[1] === 'add') {
    const tree = args.includes('--detach') ? args[args.indexOf('--detach') + 1] : args[4];
    fs.mkdirSync(path.join(tree,'release/public/docs/releases'),{recursive:true});
    fs.mkdirSync(path.join(tree,'website'),{recursive:true});
    fs.writeFileSync(path.join(tree,'website/pages.json'),JSON.stringify({pages:[]}));
    if (fs.existsSync(path.join(tree,'release/public/docs/releases/0.2.4.md'))) process.exit(1);
    fs.writeFileSync(path.join(tree,'package.json'),JSON.stringify({name:'fixture',version:fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0'},null,2)+'\\n');
    fs.writeFileSync(path.join(tree,'bun.lock'),JSON.stringify({workspaces:{'':{name:'fixture',version:fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0',dependencies:{}}}}));
  } else if (args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args.at(-1),{recursive:true,force:true});
  else if (!['fetch','add','commit','push'].includes(args[0])) process.exit(1);
} else if (tool === 'bun') {
  if (args.includes('prepare')) {
    const out = args[args.indexOf('--out')+1];
    if (args[args.indexOf('--source')+1] !== sha || args[args.indexOf('--notes-from')+1] !== 'b'.repeat(40)) process.exit(1);
    fs.mkdirSync(path.join(out,'dist'),{recursive:true});
    fs.writeFileSync(path.join(out,'dist/elanous.tgz'),'candidate');
    fs.writeFileSync(path.join(root,'release/0.2.4/manifest.json'),JSON.stringify({version:'0.2.4',in:[{sha:'a',title:'Release change',kind:'feat',line:'Release change'}]}));
    console.log(JSON.stringify({manifest:{version:'0.2.4',sourceCommit:sha,distDir:path.join(out,'dist')}}));
  } else if (args.includes('publish')) {
    if (!fs.existsSync(path.join(args[args.indexOf('--dir')+1],'dist/elanous.tgz'))) process.exit(1);
    if (!fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8').includes('https://docs.elanous.ai/using-elanous/tasks-and-intake')) process.exit(1);
    console.log(JSON.stringify({ok:true,published:true,tag:'v0.2.4'}));
  } else if (args.includes('verify')) console.log(JSON.stringify({ok:true,notesPage:'ok'}));
  else if (args.includes('land')) {
    if (args.includes('--commit-message')) fs.writeFileSync(path.join(root,args[args.indexOf('--commit-message')+1] === 'release: 0.2.4' ? 'release.done' : 'dev-bump.done'),'yes');
    console.log('✓ find: NONE\\n✓ upsert-ready: https://github.com/example/repo/pull/42 (새 PR)\\n✓ merge: squash https://github.com/example/repo/pull/42');
  }
  else if (args[0] !== 'install' && !args.some((arg) => arg.endsWith('deploy-pages.ts'))) process.exit(1);
} else if (tool === 'bash') console.log('ubuntu:24.04 [upgrade] verdict ok\\ndebian:12 [upgrade] verdict ok');
`;
    for (const tool of ['git', 'bun', 'bash']) {
      writeFileSync(join(bin, tool), fixture);
      chmodSync(join(bin, tool), 0o755);
    }
    process.env.ELANOUS_STATE_DIR = root;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_WIRING_ROOT: root, ELANOUS_STATE_DIR: root };
    const real = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      if (body.includes('node-verdict.ts') || body.includes('gate-node.ts') || body.includes('export-check-node.ts')) {
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'isolated costly check' }) + '\n', stderr: '' };
      }
      const run = spawnSync(process.execPath, [join(import.meta.dir, '../..', body.slice(4).split(' ')[0]!), ...body.slice(4).split(' ').slice(1)], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: opts.env?.ELANOUS_GRAPH_CONTEXT },
      });
      return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
    };
    const first = await runGraph(graph, { input: { version: '0.2.4', previousVersion: '0.2.3' }, deps: { root, runBash: real } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path.slice(-2)).toEqual(['auto-approve', 'approve-publish']);
    expect(first.pending?.message).toContain('v0.2.4');
    expect(first.nodes.find((node) => node.nodeId === 'notes-check')?.ok).toBe(true);
    const outputs = Object.fromEntries(first.nodes.map((node) => [node.nodeId, JSON.parse(String(node.output).trim().split('\n').at(-1)!)]));
    expect(outputs['version-release'].commit).toBe(sha);
    expect(outputs.prepare.commit).toBe(sha);
    expect(outputs.prepare.candidate).toEndWith('dist/elanous.tgz');
    expect(outputs.docs.worktree).toEndWith('/tree');
    expect(JSON.parse(String(first.nodes.find((node) => node.nodeId === 'notes-check')?.output))).toMatchObject({ ok: true, checked: { files: 1 + outputs.docs.flipped.length } });
    expect(readFileSync(join(outputs.docs.worktree, 'release/public/docs/releases/0.2.4.md'), 'utf8')).toMatch(/^# 0\.2\.4\n\n## Behavior changes\n\n- Release change\n/);
    expect(JSON.parse(readFileSync(join(outputs.docs.worktree, 'website/pages.json'), 'utf8')).pages).toContainEqual(expect.objectContaining({ id: 'releases/0.2.4' }));
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fixture-approver', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, runBash: real } });
    expect(resumed.status).toBe('done');
    const transcript = readFileSync(calls, 'utf8');
    expect(transcript).toContain('pr land --commit-message release: 0.2.4');
    expect(transcript).toContain('pr land --commit-message version: 0.2.5-dev.0');
    expect(transcript).toContain(`--candidate ${outputs.prepare.candidate}`);
    expect(transcript).toContain(`--cwd ${outputs.docs.worktree}`);
    expect(transcript).toContain('pr land --cwd');
    expect(transcript).toContain('release publish');
    const published = JSON.parse(String(resumed.nodes.find((node) => node.nodeId === 'publish')?.output).trim().split('\n').at(-1)!);
    expect(published.tag).toBe('v0.2.4');
    expect(transcript).toContain('release verify --version 0.2.4');
    expect(resumed.nodes.find((node) => node.nodeId === 'prepare')?.executed).toBe(true);
    const missing = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: sha }, prepare: { outcome: 'ok', commit: sha } } };
    const badContext = join(root, 'missing-context.json');
    writeFileSync(badContext, JSON.stringify(missing));
    const rejected = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejected.status).toBe(2);
    expect(JSON.parse(rejected.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare.candidate required');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', candidate: outputs.prepare.candidate } } }));
    const rejectedCommit = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedCommit.status).toBe(2);
    expect(JSON.parse(rejectedCommit.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare.commit required');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', commit: sha, candidate: join(root, 'absent.tgz') } } }));
    const rejectedCandidate = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedCandidate.status).toBe(2);
    expect(JSON.parse(rejectedCandidate.stdout.trim().split('\n').at(-1)!).summary).toContain('candidate missing');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', commit: 'c'.repeat(40), candidate: outputs.prepare.candidate } } }));
    const rejectedMismatch = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedMismatch.status).toBe(2);
    expect(JSON.parse(rejectedMismatch.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare commit differs from release commit');
    const beforeMissingTree = readFileSync(calls, 'utf8');
    writeFileSync(badContext, JSON.stringify({ input: missing.input, outputs: { publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' } } }));
    const rejectedTree = spawnSync(process.execPath, [join(import.meta.dir, 'docs-land-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedTree.status).toBe(2);
    expect(JSON.parse(rejectedTree.stdout.trim().split('\n').at(-1)!).summary).toContain('docs.worktree required');
    expect(readFileSync(calls, 'utf8')).toBe(beforeMissingTree);
  } finally {
    if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = originalState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish uses docs branch notes and page slugs when prerequisites pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-success-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: Array<[string, string[]]> = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok', out: root, commit: 'a'.repeat(40) }, upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    const result = runPublish((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'git') return { status: 0, stderr: '', stdout: args[1]?.endsWith('pages.json') ? JSON.stringify({ pages: [{ id: 'using-elanous/tasks-and-intake', source: 'release/public/docs/tasks-and-intake.md' }] }) : '# 0.2.4\n\n[Tasks and intake](tasks-and-intake.md)\n' };
      const notes = readFileSync(args[args.indexOf('--notes-file') + 1]!, 'utf8');
      expect(notes).toContain('https://docs.elanous.ai/using-elanous/tasks-and-intake');
      expect(notes).not.toContain('.md)');
      return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, published: true, tag: 'v0.2.4' }) };
    });
    expect(result.outcome).toBe('ok');
    expect(result.tag).toBe('v0.2.4');
    expect(calls.map(([cmd]) => cmd)).toEqual(['git', 'git', 'bun']);
    expect(calls.at(-1)?.[1]).toContain('--yes');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('any failed prerequisite refuses publish without calling the release command', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    for (const failed of ['gate', 'prepare', 'upgrade']) {
      const outputs: Record<string, unknown> = Object.fromEntries(['gate', 'prepare', 'upgrade', 'pwa', 'tui', 'docs'].map((node) => [node, { outcome: node === failed ? 'fail' : 'ok' }]));
      outputs['approve-publish'] = { outcome: 'approved' };
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
      const result = runPublish(() => { throw new Error('release publish was called'); });
      expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
      expect(result.summary).toContain(failed);
    }
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish accepts measured automatic approval but refuses incomplete metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-auto-publish-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const repo = join(root, 'repo');
    const out = join(root, 'release', '0.2.5', 'prepared');
    mkdirSync(join(out, 'dist'), { recursive: true });
    mkdirSync(repo);
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(out, 'dist', `install-${i}`), 'fixture');
    const input = { version: '0.2.5', previousVersion: '0.2.4' };
    const outputs: GraphContext['outputs'] = {
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok', introduced: [] }, pwa: { outcome: 'ok' },
      prepare: { outcome: 'ok', commit: 'a'.repeat(40), out }, upgrade: { outcome: 'ok' },
      tui: { outcome: 'ok' }, 'notes-check': { outcome: 'ok' },
      docs: { outcome: 'ok', notes: join(root, 'notes.md'), branch: 'release-docs/0.2.5' },
    };
    const approval = runAutoApprove({ input, outputs }, { instanceRoot: root, repo });
    expect(approval).toMatchObject({ outcome: 'ok', decidedBy: 'release-loop metrics' });
    const metrics = approval.metrics;
    expect(metrics.some((metric) => metric.name === 'mac-smoke')).toBe(true);
    const publish = (approvalOutput: Record<string, unknown>, run: Parameters<typeof runPublish>[0]) => {
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input, outputs: { ...outputs, 'auto-approve': approvalOutput } });
      return runPublish(run);
    };
    const run = (cmd: string, args: string[]) => ({ status: 0, stderr: '', stdout: cmd === 'git'
      ? args[1]?.endsWith('pages.json') ? '{"pages":[]}' : '# 0.2.5\n\nBody\n'
      : '{"ok":true,"published":true,"tag":"v0.2.5"}' });
    expect(publish(approval, run).outcome).toBe('ok');
    expect(publish({ ...approval, metrics: [...metrics, { name: 'mac-smoke', value: 'warn', verdict: 'pass' }] }, run).outcome).toBe('ok');
    const warningOnlyRow = metrics.find((metric) => metric.name === 'mac-smoke');
    expect(warningOnlyRow).toBeDefined();
    expect(publish({ ...approval, metrics: [...metrics, { ...warningOnlyRow!, name: 'tui-regress', value: 'warn' }] }, run).outcome).toBe('ok');
    for (const incomplete of [
      metrics.filter((metric) => metric.name !== 'installation files'),
      metrics.map((metric) => metric.name === 'installation files' ? { ...metric, verdict: 'unmeasured' as const } : metric),
    ]) {
      let calls = 0;
      const result = publish({ ...approval, metrics: incomplete }, (cmd, args) => {
        calls++;
        return run(cmd, args);
      });
      expect(result.outcome).toBe('fail');
      expect(calls).toBe(0);
    }
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('publish cannot report a tag that differs from the release CLI result', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' },
      prepare: { outcome: 'ok', commit: 'a'.repeat(40), out: '/tmp/prepared' }, upgrade: { outcome: 'ok' },
      tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    const run = (cmd: string, args: string[]) => ({ status: 0, stderr: '', stdout: cmd === 'git'
      ? args[1]?.endsWith('pages.json') ? JSON.stringify({ pages: [] }) : '# 0.2.4\n\nBody\n'
      : JSON.stringify({ ok: true, published: true, tag: 'v0.2.5' }) });
    expect(() => runPublish(run)).toThrow('tag mismatch');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish refuses mismatched prepared commit without reading notes or calling release publish', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) },
      gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok', commit: 'b'.repeat(40), out: '/tmp/prepared' },
      upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    expect(() => runPublish(() => { throw new Error('release publish was called'); })).toThrow('prepare commit differs from release commit');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('wrapper exit conventions distinguish failed command from incomplete run', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    const failed = runPrepare((command) => command === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' } : { status: 1, stdout: '{"ok":false,"error":"build failed"}', stderr: '' });
    expect(failed).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(() => runPrepare((command) => command === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' } : { status: 2, stdout: '', stderr: '' })).toThrow('prepare incomplete');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish refuses failed upgrade before running any release command', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  let calls = 0;
  try {
    const file = join(root, 'context.json');
    writeFileSync(file, JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok' }, upgrade: { outcome: 'fail' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } }));
    process.env.ELANOUS_GRAPH_CONTEXT = file;
    const result = runPublish(() => { calls++; return { status: 0, stdout: '', stderr: '' }; });
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(result.summary).toContain('upgrade');
    expect(calls).toBe(0);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('prepare uses prior tag commit and release commit from graph context', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    const sha = 'a'.repeat(40);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { outcome: 'ok', commit: sha }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' } } });
    const result = runPrepare((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return cmd === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
        : { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.4', sourceCommit: sha, distDir: join(args[args.indexOf('--out') + 1]!, 'dist') } }), stderr: '' };
    });
    expect(result.outcome).toBe('ok');
    expect(result.commit).toBe(sha);
    expect(calls[0]).toBe('git rev-parse --verify v0.2.3^{commit}');
    expect(calls[1]).toContain(`--source ${sha} --notes-from ${'b'.repeat(40)}`);
    expect(calls[1]).toContain('--out ');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('graph docs refuses a missing upgrade output without generating documentation', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-missing-upgrade-'));
  const notes = join(root, 'release/public/docs/releases/9.9.9.md');
  try {
    mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
    mkdirSync(join(root, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(join(root, 'website'), { recursive: true });
    writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', in: [] }));
    writeFileSync(join(root, 'website/pages.json'), JSON.stringify({ pages: [] }));
    const graphContext = JSON.stringify({ input: { version: '9.9.9', previousVersion: '0.2.3', base: root }, outputs: { 'approve-publish': { outcome: 'approved' },
      gate: { outcome: 'ok' }, prepare: { outcome: 'ok' }, tui: { outcome: 'ok' },
    } });
    const run = spawnSync(process.execPath, [join(import.meta.dir, 'docs-node.ts'), '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: graphContext, ELANOUS_STATE_DIR: root },
    });
    expect(run.status).toBe(1);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
    expect(result.summary).toContain('upgrade did not pass');
    expect(readFileSync(join(root, 'website/pages.json'), 'utf8')).toBe('{"pages":[]}');
    expect(() => readFileSync(notes, 'utf8')).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('upgrade reports stderr-only failure reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-upgrade-stderr-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const candidate = join(root, 'elanous.tgz');
    writeFileSync(candidate, 'fake');
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      prepare: { outcome: 'ok', candidate, commit: 'a'.repeat(40) }, 'version-release': { outcome: 'ok', commit: 'a'.repeat(40) },
    } });
    const result = runUpgrade(() => ({ status: 2, stdout: '', stderr: 'candidate archive cannot be opened\n' }));
    expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
    expect(result.summary).toBe('upgrade failed (rc=2): candidate archive cannot be opened');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('upgrade rejects incomplete verdict even on successful shell exit', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-upgrade-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const candidate = join(root, 'elanous.tgz');
    writeFileSync(candidate, 'fake');
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { prepare: { outcome: 'ok', candidate, commit: 'a'.repeat(40) }, 'version-release': { outcome: 'ok', commit: 'a'.repeat(40) } } });
    const result = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04 [upgrade] verdict ok\n', stderr: '' }));
    expect(result.outcome).toBe('fail');
    expect(result.summary).toContain('upgrade failed');
    const complete = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict ok\ndebian:12  [upgrade] verdict ok\n', stderr: '' }));
    expect(complete.outcome).toBe('ok');
    // 0.2.4: the check script appends `from= to=` after the verdict word.
    const suffixed = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict ok from=0.2.3 to=«0.2.4 0b373c7»\ndebian:12  [upgrade] verdict ok from=0.2.3 to=«0.2.4 0b373c7»\n', stderr: '' }));
    expect(suffixed.outcome).toBe('ok');
    const notOk = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict okay\ndebian:12  [upgrade] verdict ok\n', stderr: '' }));
    expect(notOk.outcome).not.toBe('ok');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('docs land requires publish; after merge deploy precedes cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { publish: { outcome: 'fail', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runDocsLand(() => { throw new Error('called before publish'); })).toThrow('publish must succeed');
    context.outputs.publish.outcome = 'ok';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    mkdirSync(join(root, 'tree'));
    const result = runDocsLand((cmd, args, cwd) => {
      calls.push(`${cmd} ${args.join(' ')} @ ${cwd ?? '.'}`);
      if (cmd === 'git' && args[0] === 'cat-file') return { status: 1, stdout: '', stderr: '' };   // 노트가 아직 main 에 없다
      return { status: 0, stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'a'.repeat(40) : cmd === 'bun' && args.includes('land') ? '✓ find: NONE\n✓ upsert-ready: https://github.com/example/pull/1 (새 PR)\n✓ merge: squash https://github.com/example/pull/1' : '', stderr: '' };
    });
    expect(result.outcome).toBe('ok');
    context.outputs.publish.tag = 'v0.2.5';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runDocsLand(() => { throw new Error('land called for wrong tag'); })).toThrow('published tag/version mismatch');
    expect(calls.slice(0, 8).map((s) => s.split(' ')[0])).toEqual(['git', 'git', 'bun', 'git', 'git', 'git', 'bun', 'bun']);
    expect(calls[0]).toContain('fetch origin main');
    expect(calls[1]).toContain('cat-file -e origin/main:release/public/docs/releases/0.2.4.md');
    expect(calls[2]).toContain(`--cwd ${join(root, 'tree')}`);
    expect(calls[3]).toContain('fetch origin main');
    expect(calls[5]).toContain(`worktree add --detach`);
    expect(calls[5]).toContain('a'.repeat(40));
    expect(calls[6]).toContain('install --frozen-lockfile');
    expect(calls[7]).toContain('deploy-pages.ts --remote node-b --yes @ ');
    expect(calls[7]).toContain('/release-docs-deploy-');
    expect(calls.at(-1)).toContain('worktree remove --force');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('pr land creates a missing docs PR before merging it', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const url = 'https://github.com/example/repo/pull/42';
  const cwd = '/tmp/release-docs-fixture/tree';
  const run: CmdRunner = (command, args) => {
    if (command === 'gh' && args[0] === 'pr') {
      calls.push(`gh ${args.slice(0, 2).join(' ')}`);
      if (args[1] === 'list') return { ok: true, out: '' };
      if (args[1] === 'create') {
        expect(args).toContain('--head');
        expect(args).toContain('release-docs/0.2.4');
        expect(args).toContain('--base');
        expect(args).toContain('main');
        return { ok: true, out: url };
      }
      if (args[1] === 'merge') return { ok: true, out: '' };
      if (args[1] === 'view') return { ok: false, out: '' };
    }
    if (command === 'git' && args.includes('push')) calls.push('git push');
    return { ok: true, out: command === 'git' && args.includes('rev-list') ? '1' : command === 'git' && args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/example/repo.git' : '' };
  };
  const code = await runPrLand({ cwd }, {
    manager: makePrManager(run), currentBranch: () => 'release-docs/0.2.4', resolveBase: () => 'origin/main',
    run,
    listUnfinishedRuns: () => [], listOpenPrs: () => [], isInteractive: () => false,
    queryRunningRuns: () => ({ entries: [] }) as never,
    runTypecheckGate: () => true, runIsolationGate: () => true, runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true, runDaemonPortGate: () => true, runPublicLeakGate: () => 0,
    runTestInterferenceGate: async () => 0, runAndroidGate: () => true, runIosGate: () => true, runPwaGate: () => true,
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  expect(code).toBe(0);
  expect(calls).toEqual(['gh pr list', 'git push', 'gh pr list', 'gh pr create', 'gh pr merge', 'gh pr view']);
  expect(lines.some((line) => line.includes('✓ upsert-ready:') && line.includes('(새 PR)'))).toBe(true);
  expect(lines.some((line) => line.includes('✓ merge: squash'))).toBe(true);
});

test('docs land refuses an upsert-only response without merge and never deploys', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': { outcome: 'approved' },
      publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') },
    } });
    mkdirSync(join(root, 'tree'));
    expect(() => runDocsLand((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'cat-file') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '✓ upsert-ready: https://github.com/example/pull/1 (새 PR)', stderr: '' };
    })).toThrow('docs land incomplete');
    expect(calls.filter((c) => c.startsWith('bun '))).toEqual([`bun bin/elanous.mjs pr land --cwd ${join(root, 'tree')}`]);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('verify requires deployed docs and a live release notes page', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'docs-land': { outcome: 'fail' }, publish: { outcome: 'ok', tag: 'v0.2.4' } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runVerify(() => { throw new Error('called before deploy'); })).toThrow('docs must land');
    context.outputs['docs-land'].outcome = 'ok';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'missing' }), stderr: '' })).outcome).toBe('fail');
    expect(runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'ok' }), stderr: '' })).outcome).toBe('ok');
    context.outputs.publish.tag = 'v0.2.5';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runVerify(() => { throw new Error('verify called for wrong tag'); })).toThrow('published tag/version mismatch');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish body resolves flat markdown links through pages slug', () => {
  const pages = { pages: [{ id: 'using-elanous/tasks-and-intake', source: 'release/public/docs/tasks-and-intake.md' }] };
  const body = publicNotes('# 0.2.4\n\n[Tasks and intake](tasks-and-intake.md)\n', pages);
  expect(body).toContain('[Tasks and intake](https://docs.elanous.ai/using-elanous/tasks-and-intake)');
  expect(body).not.toContain('.md)');
  expect(body).not.toContain('# 0.2.4');
});


test('publish refuses when approve-publish did not approve, without calling any command', () => {
  const calls: string[] = [];
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    for (const approval of [undefined, { outcome: 'rejected' }, null]) {
      const outputs: Record<string, unknown> = Object.fromEntries(['gate', 'prepare', 'upgrade', 'pwa', 'tui', 'docs'].map((node) => [node, { outcome: 'ok' }]));
      if (approval !== undefined) outputs['approve-publish'] = approval;
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
      const result = runPublish((cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; });
      expect(result.outcome).toBe('fail');
      expect(result.summary).toContain('approve-publish');
    }
    expect(calls).toEqual([]);
  } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
});


test('docs land retry: notes already on main → skip pr land and resume at deploy', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: {
      publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') } } });
    const result = runDocsLand((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { status: 0, stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'b'.repeat(40) : '', stderr: '' };   // cat-file 0 = 이미 main 에 있다 · 워크트리는 앞 판이 지웠다
    });
    expect(result.outcome).toBe('ok');
    expect(calls.some((c) => c.includes('pr land'))).toBe(false);
    expect(calls.some((c) => c.includes('deploy-pages.ts --remote node-b --yes'))).toBe(true);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});
