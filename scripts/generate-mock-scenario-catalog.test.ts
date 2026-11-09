import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { buildMockScenarioCatalog, renderMockScenarioCatalog } from './generate-mock-scenario-catalog.js';
import { parseMockScenarioCatalog } from '../src/ux-sim/mock-scenario-catalog.js';

const repoRoot = resolve(import.meta.dir, '..');
const generatedPath = resolve(repoRoot, 'src/ux-sim/mock-scenario-catalog.json');
test('mock scenario fragments validate schema, unique IDs, and deterministic output', () => {
  const generated = renderMockScenarioCatalog(repoRoot);
  expect(renderMockScenarioCatalog(repoRoot)).toBe(generated);
  expect(parseMockScenarioCatalog(buildMockScenarioCatalog(repoRoot))).toEqual(JSON.parse(generated));
  expect(existsSync(generatedPath)).toBe(false);
  const check = spawnSync('bun', ['scripts/generate-mock-scenario-catalog.ts', '--check'], { cwd: repoRoot, encoding: 'utf8' });
  expect(check.status).toBe(0);
  expect(check.stdout).toContain('pass schema, duplicate-ID, and deterministic-output checks');
});

test('independent fragment branches merge without conflicts and preserve deterministic ordering', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mock-scenario-fragments-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  const put = (path: string, value: unknown) => {
    const target = join(repo, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  const base = 'catalog/ux-sim/mock-scenario-catalog-fragments';
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Catalog test');
    git('config', 'user.email', 'catalog-test@example.invalid');
    put(`${base}/metadata.json`, {
      version: 2, deviceCatalogVersion: 1,
      runEvidence: { scope: 'test', runId: 'test', event: { category: 'test', name: 'done' }, persistence: 'test', artifact: 'test' },
      discovery: { trackedRoot: 'test', candidateRoots: ['test'], limits: 'test' },
      candidateAudit: { source: 'test', baseCommit: 'test', sourceRows: 1, existingPaths: 0, excludedPaths: 0 },
    });
    put(`${base}/source-exclusions/00010--baseline.json`, { path: 'test/baseline', reason: 'baseline fixture' });
    put(`${base}/omission-required-paths/00010--baseline.json`, 'test/baseline');
    for (const collection of ['catalog-additions', 'candidates', 'devices', 'omission-missing-paths', 'scenarios', 'source-modules']) mkdirSync(join(repo, base, collection), { recursive: true });
    git('add', '.'); git('commit', '-qm', 'base fragments');
    const baseCommit = git('rev-parse', 'HEAD').trim();
    git('checkout', '-qb', 'fragment-a');
    put(`${base}/world-events/00010--event-a.json`, { id: 'event-a', name: 'A', description: 'A event' });
    git('add', '.'); git('commit', '-qm', 'add event A');
    git('checkout', '-q', baseCommit, '-b', 'fragment-b');
    put(`${base}/world-events/00010--event-b.json`, { id: 'event-b', name: 'B', description: 'B event' });
    git('add', '.'); git('commit', '-qm', 'add event B');
    expect(() => git('merge', '--no-edit', 'fragment-a')).not.toThrow();
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
    const catalog = buildMockScenarioCatalog(repo) as { worldEvents: Array<{ id: string }> };
    expect(catalog.worldEvents.map(({ id }) => id)).toEqual(['event-a', 'event-b']);
    expect(renderMockScenarioCatalog(repo)).toBe(renderMockScenarioCatalog(repo));
    put(`${base}/world-events/00030--duplicate.json`, { id: 'event-a', name: 'Duplicate', description: 'Duplicate ID' });
    expect(() => buildMockScenarioCatalog(repo)).toThrow('duplicate id: event-a');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
