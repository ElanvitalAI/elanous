// FU5 — pwa-build node_modules precheck.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPwaBuildDeps, runPwaBuild } from '../../src/cli/pwa-build.ts';

function setupTree(opts: { includeNodeModules?: boolean; installedDeps?: string[]; declaredDeps?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'fu5-pwa-'));
  const dependencies = Object.fromEntries((opts.declaredDeps ?? []).map(d => [d, '^1.0.0']));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'apps-pwa-fixture', dependencies }));
  if (opts.includeNodeModules !== false) {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const dep of opts.installedDeps ?? []) {
      const target = join(root, 'node_modules', dep);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }));
    }
  }
  return root;
}

describe('checkPwaBuildDeps', () => {
  test('returns ok=false when node_modules dir is absent', () => {
    const root = setupTree({ includeNodeModules: false });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(false);
      expect(r.missing).toContain('<node_modules dir>');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('lists every required dep when node_modules is empty', () => {
    const root = setupTree({ installedDeps: [] });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(false);
      expect(r.missing).toContain('@dagrejs/dagre');
      expect(r.missing).toContain('next');
      expect(r.missing).toContain('react');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('flags @dagrejs/dagre missing when other deps are installed', () => {
    // Replicates the test-tree dogfood scenario: bun install ran but
    // @dagrejs/dagre got dropped (or the lockfile was edited).
    const root = setupTree({ installedDeps: ['next', 'react'] });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(false);
      expect(r.missing).toEqual(['@dagrejs/dagre']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('returns ok=true when every required dep is present', () => {
    const root = setupTree({
      installedDeps: ['@dagrejs/dagre', 'next', 'react'],
    });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(true);
      expect(r.missing).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('honours an injected existsFn for tests / dry-run', () => {
    const r = checkPwaBuildDeps('/no/such/path', () => false);
    expect(r.ok).toBe(false);
  });

  // 2026-07-11 — the required set is now derived from package.json
  // `dependencies`, not just the hardcoded core. This catches the real
  // dogfood miss: a declared dep NOT in the core list (remark-wiki-link)
  // that the old precheck sailed past into a cryptic webpack error.
  test('flags a declared dependency (not in the core list) when uninstalled', () => {
    const root = setupTree({
      declaredDeps: ['remark-wiki-link', '@xyflow/react'],
      installedDeps: ['@dagrejs/dagre', 'next', 'react'], // core present, declared ones missing
    });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(false);
      expect(r.missing).toContain('remark-wiki-link');
      expect(r.missing).toContain('@xyflow/react');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ok=true when every declared dep + core is installed', () => {
    const root = setupTree({
      declaredDeps: ['remark-wiki-link'],
      installedDeps: ['remark-wiki-link', '@dagrejs/dagre', 'next', 'react'],
    });
    try {
      const r = checkPwaBuildDeps(root);
      expect(r.ok).toBe(true);
      expect(r.missing).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('falls back to the core list when package.json is unreadable', () => {
    // node_modules exists + core installed, but package.json read throws.
    const root = setupTree({ installedDeps: ['@dagrejs/dagre', 'next', 'react'] });
    try {
      const r = checkPwaBuildDeps(root, existsSync, () => { throw new Error('unreadable'); });
      expect(r.ok).toBe(true); // core satisfied, no declared deps discoverable
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runPwaBuild precheck integration', () => {
  test('returns exit=1 before spawn when a missing dependency has no lockfile', async () => {
    const root = setupTree({ installedDeps: ['next', 'react'] });
    const errors: string[] = [];
    const logs: string[] = [];
    try {
      const res = await runPwaBuild({
        cwd: root,
        out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
        spawnFn: async () => {
          throw new Error('spawn should not run — precheck must short-circuit');
        },
      });
      expect(res.exitCode).toBe(1);
      const joined = errors.join('\n');
      expect(joined).toContain('bun.lock missing');
      expect(joined).toContain('bun install');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('spawns bun run build when every required dep is installed', async () => {
    const root = setupTree({ installedDeps: ['@dagrejs/dagre', 'next', 'react'] });
    let spawnCalled = false;
    try {
      const res = await runPwaBuild({
        cwd: root,
        out: { log: () => {}, error: () => {} },
        spawnFn: async (cmd, args, cwd) => {
          spawnCalled = true;
          expect(cmd).toBe('bun');
          expect(args).toEqual(['run', 'build']);
          expect(cwd).toBe(root);
          return 0;
        },
      });
      expect(spawnCalled).toBe(true);
      expect(res.exitCode).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
