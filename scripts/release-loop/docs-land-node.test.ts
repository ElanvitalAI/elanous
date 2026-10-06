import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSeatRequests } from '../../src/seat-dispatch/seat-request-ledger.js';
import { add } from '../../src/release-loop/feature-store.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runDocsLand } from './docs-land-node.js';
import type { CommandRunner } from './node-verdict.js';

const scratch: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  delete process.env.ELANOUS_GRAPH_CONTEXT;
  delete process.env.ELANOUS_STATE_DIR;
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('docs-land records MK backlog after publish even on deploy failure; status comes from the checklist', () => {
  const state = join(tmpdir(), `release-docs-${Math.random().toString(36).slice(2)}`);
  const tree = join(state, 'tree');
  const root = join(tmpdir(), `release-docs-follow-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
  scratch.push(state, root);
  writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({
    version: '9.9.9', in: [{ sha: 'landed', title: 'Private title', docs: 'missing', kind: 'feat', line: 'Public line' }],
  }));
  writeFileSync(join(root, 'release/9.9.9/docs-follow-evidence.json'), JSON.stringify({
    items: [{ id: 'F1', sha: 'landed', exposure: { verdict: 'public', judge: 'MK', rubric: 'release/public/expose-rubric.yaml', verifiedAt: '2026-10-05T00:00:00Z' },
      docs: { location: 'https://docs.elanous.ai/9-9-9', publishedAt: '2026-10-05T00:00:00Z', verifiedAt: '2026-10-05T01:00:00Z' } },
      { id: 'F2', sha: 'landed', exposure: { verdict: 'public', judge: 'MK', rubric: 'release/public/expose-rubric.yaml', verifiedAt: '2026-10-05T00:00:00Z' } }],
  }));
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  add('9.9.9', { id: 'F1', title: 'Feature', status: 'green', updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'MK' }, '9.9.8', '9.9.9');
  add('9.9.9', { id: 'F2', title: 'Not ready', status: 'yellow', updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'MK' }, '9.9.8', '9.9.9');
  const outputs = { publish: { outcome: 'ok', tag: 'v9.9.9' }, docs: { branch: 'release-docs/9.9.9', worktree: tree } };
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs });
  let failDeploy = true;
  const run: CommandRunner = (command, args) => {
    if (command === 'bun' && args[0] === 'website/scripts/deploy-pages.ts' && failDeploy) return { status: 1, stdout: '', stderr: 'deployment refused' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '9.9.9', previousVersion: '9.9.8' },
    outputs: { ...outputs, publish: { outcome: 'fail', tag: 'v9.9.9' } } });
  expect(() => runDocsLand(run, root, root)).toThrow('publish must succeed before docs land');
  expect(listSeatRequests(root)).toEqual([]);
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs });
  const failed = runDocsLand(run, root, root);
  expect(failed).toMatchObject({ outcome: 'fail', summary: 'docs deploy failed: deployment refused',
    docsFollow: { pending: 1, unassessed: 0, ratio: 0, verdict: 'unmeasured' } });
  expect(JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8')).coverage)
    .toMatchObject([{ id: 'F1', docs: false, missing: ['docs', 'homepage', 'readme'] }]);
  expect(listSeatRequests(root, { seat: 'MK' })).toMatchObject([{ key: 'docs-follow:9.9.9:F1' }]);
  failDeploy = false;
  const result = runDocsLand(run, root, root);
  expect(result).toMatchObject({ outcome: 'ok', docsFollow: { pending: 1, unassessed: 0, ratio: 0 } });
  const report = JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8'));
  expect(report.coverage).toMatchObject([{ id: 'F1', docs: true, missing: ['homepage', 'readme'] }]);
  expect(listSeatRequests(root, { seat: 'MK' })).toHaveLength(1);
  expect(runDocsLand(run, root, root).docsFollow?.pending).toBe(1);
  expect(listSeatRequests(root, { seat: 'MK' })).toHaveLength(1);
});

test('deploy failure retains its original error when follow-up evidence cannot be read', () => {
  const state = join(tmpdir(), `release-docs-${Math.random().toString(36).slice(2)}`);
  const tree = join(state, 'tree');
  const root = join(tmpdir(), `release-docs-follow-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
  scratch.push(state, root);
  writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', in: [] }));
  writeFileSync(join(root, 'release/9.9.9/docs-follow-evidence.json'), 'invalid json');
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '9.9.9', previousVersion: '9.9.8' },
    outputs: { publish: { outcome: 'ok', tag: 'v9.9.9' }, docs: { branch: 'release-docs/9.9.9', worktree: tree } } });
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'bun' && args[0] === 'website/scripts/deploy-pages.ts') return { status: 1, stdout: '', stderr: 'deployment refused' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(runDocsLand(run, root, root)).toMatchObject({ outcome: 'fail', summary: 'docs deploy failed: deployment refused',
    docsFollow: expect.objectContaining({ pending: 0 }) });
  // 깨진 증거는 «증거 없음»으로 세어 보고서는 남는다(이 판엔 칸이 없어 대기열 0).
  expect(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8').length).toBeGreaterThan(0);
});

test('broken evidence still leaves the report, with the landed feature counted as unassessed', () => {
  const { root } = followFixture();
  writeFileSync(join(root, 'release/9.9.9/docs-follow-evidence.json'), 'invalid json');
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (command === 'bun' && args[0] === 'website/scripts/deploy-pages.ts') return { status: 1, stdout: '', stderr: 'deployment refused' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(runDocsLand(run, root, root)).toMatchObject({ outcome: 'fail', summary: 'docs deploy failed: deployment refused' });
  // 증거가 깨지면 노출 판정이 없으니 «미판정(unassessed)»으로 남는다 — 보고서는 사라지지 않는다.
  const report = JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8'));
  expect(JSON.stringify(report.unassessed)).toContain('F1');
});

test('a deploy-tree cleanup failure does not hide the original deploy error', () => {
  const { root } = followFixture();
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (command === 'bun' && args[0] === 'website/scripts/deploy-pages.ts') return { status: 2, stdout: '', stderr: 'half deployed' };
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') return { status: 1, stdout: '', stderr: 'busy' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(() => runDocsLand(run, root, root)).toThrow('docs deploy incomplete (rc=2): half deployed');
});

function followFixture() {
  const state = join(tmpdir(), `release-docs-${Math.random().toString(36).slice(2)}`);
  const tree = join(state, 'tree');
  const root = join(tmpdir(), `release-docs-follow-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
  scratch.push(state, root);
  writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({
    version: '9.9.9', in: [{ sha: 'landed', title: 'Private title', docs: 'missing', kind: 'feat', line: 'Public line' }],
  }));
  writeFileSync(join(root, 'release/9.9.9/docs-follow-evidence.json'), JSON.stringify({ items: [{ id: 'F1', sha: 'landed', exposure: { verdict: 'public', judge: 'MK', rubric: 'release/public/expose-rubric.yaml', verifiedAt: '2026-10-05T00:00:00Z' },
    docs: { location: 'https://docs.elanous.ai/9-9-9', publishedAt: '2026-10-05T00:00:00Z', verifiedAt: '2026-10-05T01:00:00Z' } }] }));
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  add('9.9.9', { id: 'F1', title: 'Feature', status: 'green', updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'MK' }, '9.9.8', '9.9.9');
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '9.9.9', previousVersion: '9.9.8' },
    outputs: { publish: { outcome: 'ok', tag: 'v9.9.9' }, docs: { branch: 'release-docs/9.9.9', worktree: tree } } });
  return { root, tree };
}

test('a fetch failure after the landing still records the MK backlog and keeps the fetch error', () => {
  const { root } = followFixture();
  let fetches = 0;
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'fetch') { fetches += 1; return fetches === 1 ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'network down' }; }
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(() => runDocsLand(run, root, root)).toThrow('docs landing fetch failed: network down');
  expect(listSeatRequests(root, { seat: 'MK' })).toMatchObject([{ key: 'docs-follow:9.9.9:F1' }]);
});

test('a cleanup failure after a successful deploy records the backlog as deployed and keeps the cleanup error', () => {
  const { root } = followFixture();
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove' && !String(args[3] ?? '').includes('release-docs-deploy-')) return { status: 1, stdout: '', stderr: 'busy' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(() => runDocsLand(run, root, root)).toThrow('docs worktree cleanup failed: busy');
  expect(listSeatRequests(root, { seat: 'MK' })).toMatchObject([{ key: 'docs-follow:9.9.9:F1' }]);
  const report = JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8'));
  expect(report.coverage).toMatchObject([{ id: 'F1', docs: true }]);
});

test('a docs land failure (rc 1) after publish records the backlog', () => {
  const { root } = followFixture();
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'cat-file') return { status: 1, stdout: '', stderr: '' };
    if (command === 'bun' && args[1] === 'pr') return { status: 1, stdout: '', stderr: 'land refused' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(runDocsLand(run, root, root)).toMatchObject({ outcome: 'fail', summary: 'docs land failed: land refused' });
  expect(listSeatRequests(root, { seat: 'MK' })).toMatchObject([{ key: 'docs-follow:9.9.9:F1' }]);
});

test('evidence items that are not objects with an id count as no evidence', () => {
  const { root } = followFixture();
  writeFileSync(join(root, 'release/9.9.9/docs-follow-evidence.json'), JSON.stringify({ items: [null, 3, { noId: true }] }));
  const run: CommandRunner = (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (command === 'git' && args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (command === 'bun' && args[0] === 'website/scripts/deploy-pages.ts') return { status: 1, stdout: '', stderr: 'deployment refused' };
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(runDocsLand(run, root, root)).toMatchObject({ outcome: 'fail', summary: 'docs deploy failed: deployment refused' });
  expect(JSON.stringify(JSON.parse(readFileSync(join(root, 'release/9.9.9/docs-follow.json'), 'utf8')).unassessed)).toContain('F1');
});
