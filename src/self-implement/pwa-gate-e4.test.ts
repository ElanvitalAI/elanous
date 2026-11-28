import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prOwnChangedFiles } from './seams.js';
import { runDependencyChangeGate } from './dependency-change-gate.js';

// Synthetic git universe; the gate and real git/cache are exercised, but build/tsc processes are deliberately simulated.
test('E4: synced main lock is excluded; own PWA changes miss, hit, then lock key moves', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-gate-e4-'));
  const repo = join(root, 'repo');
  const cache = join(root, 'cache');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const file = (path: string, text: string) => { const p = join(repo, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); };
  const commands: string[] = [];
  const run = (command: string, args: readonly string[]) => { commands.push([command, ...args].join(' ')); return { status: 0, stdout: 'synthetic success' }; };
  const event = () => {
    const delta = prOwnChangedFiles(repo);
    if (!delta.files) throw new Error(delta.reason);
    return { delta: delta.files, gate: runDependencyChangeGate({ cwd: repo, changedFiles: delta.files, cacheDir: cache, run }) };
  };
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e4@example.invalid'); git('config', 'user.name', 'E4');
    file('.gitignore', 'node_modules/\n'); file('bun.lock', 'lock-0\n'); file('package.json', '{}'); file('tsconfig.json', '{}');
    file('apps/pwa/page.tsx', 'export default 1;\n'); file('src/cli/pwa-build.ts', ''); commit('base');
    git('checkout', '-qb', 'feature'); file('docs/feature.md', 'own\n'); commit('own feature');
    git('checkout', '-q', 'main'); file('bun.lock', 'lock-main\n'); commit('main lock update');
    git('checkout', '-q', 'feature'); git('merge', '-q', '--no-edit', 'main');
    // Minimal marker to cross the production dependency-presence check; no real Next build is claimed.
    file('node_modules/next/package.json', '{}');
    const synced = event();
    expect(synced.delta).toContain('docs/feature.md'); expect(synced.delta).not.toContain('bun.lock');
    expect(synced.gate.ran).toBe(false); expect(commands).toEqual([]);
    file('apps/pwa/page.tsx', 'export default 2;\n');
    const first = event(); expect(first.gate.pwaBuildCache).toBe('miss'); expect(first.gate.passed).toBe(true);
    expect(commands).toEqual(['bun bin/elanous.mjs --test nexus build']);
    const second = event(); expect(second.gate.pwaBuildCache).toBe('hit'); expect(second.gate.pwaBuildCacheKey).toBe(first.gate.pwaBuildCacheKey);
    expect(commands).toHaveLength(1);
    file('bun.lock', 'lock-own\n');
    const third = event(); expect(third.delta).toContain('bun.lock'); expect(third.gate.pwaBuildCache).toBe('miss');
    expect(third.gate.pwaBuildCacheKey).not.toBe(first.gate.pwaBuildCacheKey);
    expect(commands).toEqual(['bun bin/elanous.mjs --test nexus build', 'bunx tsc --noEmit -p tsconfig.json', 'bun bin/elanous.mjs --test nexus build']);
    console.log(JSON.stringify({ universe: 'synthetic-git-simulated-build', synced: synced.delta, first: first.gate.pwaBuildCache, second: second.gate.pwaBuildCache, lockChange: third.gate.pwaBuildCache, keysDiffer: first.gate.pwaBuildCacheKey !== third.gate.pwaBuildCacheKey, commands }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
