import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedDependencyStoreEntry } from './worktree.js';

test('shared store entry keeps the last segment named node_modules', () => {
  expect(sharedDependencyStoreEntry('node_modules')).toBe('node_modules');
  expect(sharedDependencyStoreEntry('apps/pwa/node_modules')).toBe(join('apps__pwa', 'node_modules'));
});

// 11-27 TA canaries: `next build` from the shared store failed with «Cannot find module 'styled-jsx/package.json'».
// A package resolves its siblings by walking up from its real path to a directory NAMED node_modules.
test('a package in the store resolves its sibling only under the node_modules-named layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'deps-store-entry-'));
  const seed = (store: string): string => {
    const next = join(root, store, 'next');
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, 'package.json'), '{"name":"next","version":"0.0.0","main":"index.js"}');
    writeFileSync(join(next, 'index.js'), 'module.exports = 1;\n');
    const sibling = join(root, store, 'styled-jsx');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'package.json'), '{"name":"styled-jsx","version":"0.0.0","main":"index.js"}');
    writeFileSync(join(sibling, 'index.js'), 'module.exports = 2;\n');
    return next;
  };
  try {
    const flat = seed('hash-a/apps__pwa__node_modules');
    expect(() => Bun.resolveSync('styled-jsx/package.json', flat)).toThrow();
    const nested = seed(join('hash-b', sharedDependencyStoreEntry('apps/pwa/node_modules')));
    expect(Bun.resolveSync('styled-jsx/package.json', nested)).toBe(join(root, 'hash-b', 'apps__pwa', 'node_modules', 'styled-jsx', 'package.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
