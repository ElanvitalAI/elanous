import { describe, expect, test } from 'bun:test';
import { configDirFollowingStateDir, resolveInstance } from '../src/instance/resolve.js';
import { renderWhere } from '../src/cli/where-cli.js';

const prod = '/tmp/elanous-prod';
const source = '/tmp/checkout/.elanous-test';

describe('instance selection without leader metadata', () => {
  test('explicit root precedes parent stamp and installed origin', () => {
    expect(resolveInstance({ prodRoot: prod, explicitFlagRoot: source, stampedStateDir: prod, installedCopy: true })).toMatchObject({ kind: 'test', root: source, layer: 'explicit-flag' });
    expect(resolveInstance({ prodRoot: prod, explicitFlagRoot: prod, installedCopy: false, treeTestRoot: source })).toMatchObject({ kind: 'prod', layer: 'explicit-flag' });
  });
  test('parent stamp precedes installed origin', () => {
    expect(resolveInstance({ prodRoot: prod, stampedStateDir: source, installedCopy: true })).toMatchObject({ kind: 'test', root: source, layer: 'parent-stamp' });
    expect(resolveInstance({ prodRoot: prod, stampedStateDir: prod, installedCopy: false })).toMatchObject({ kind: 'prod', layer: 'parent-stamp' });
  });
  test('installed origin operates and all other source trees isolate', () => {
    expect(resolveInstance({ prodRoot: prod, installedCopy: true, treeTestRoot: source })).toMatchObject({ kind: 'prod', layer: 'installed' });
    expect(resolveInstance({ prodRoot: prod, installedCopy: false, treeTestRoot: source })).toMatchObject({ kind: 'test', root: source, layer: 'tree-derived' });
  });
  test('state/config roots follow explicit isolation', () => {
    expect(configDirFollowingStateDir(undefined, source, prod)).toEqual({ dir: source, followed: true });
    expect(configDirFollowingStateDir(undefined, prod, prod)).toEqual({ dir: prod, followed: false });
  });
  test('where display names winning source without a leader field', () => {
    const r = resolveInstance({ prodRoot: prod, installedCopy: false, treeTestRoot: source });
    const text = renderWhere(r, { selfTree: '/tmp/checkout', configDir: source });
    expect(text).toContain('소스 트리(격리)');
    expect(text).not.toContain('리더 권위');
  });
});
