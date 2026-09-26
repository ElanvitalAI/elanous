import { describe, expect, test } from 'bun:test';
import { resolveDataDir } from './config.js';

// 운영 우주의 가변 상태는 코드 옆이 아니라 ~/.elanous/data.
describe('resolveDataDir', () => {
  const home = '/home/u';
  const noGit = () => false;
  const withGit = () => true;
  test('installed copy (node_modules/elanous, no git above) → ~/.elanous/data', () => {
    expect(resolveDataDir('/home/u/.local/share/elanous/versions/1.0.0-abc/node_modules/elanous', { env: {}, home, instanceRoot: () => '/src/.elanous-test', hasGit: noGit }))
      .toBe('/home/u/.elanous/data');
  });
  test('explicit operating universe → ~/.elanous/data', () => {
    expect(resolveDataDir('/src/pilot', { env: {}, home, instanceRoot: () => '/home/u/.elanous', hasGit: withGit })).toBe('/home/u/.elanous/data');
  });
  test('any other worktree keeps its own data/', () => {
    expect(resolveDataDir('/tmp/wt', { env: {}, home, instanceRoot: () => '/src/.elanous-test', hasGit: withGit })).toBe('/tmp/wt/data');
    expect(resolveDataDir('/tmp/wt', { env: {}, home, instanceRoot: () => '/src/.elanous-test', hasGit: withGit })).toBe('/tmp/wt/data');
  });
  test('node_modules/elanous inside a git checkout is not an install', () => {
    expect(resolveDataDir('/src/app/node_modules/elanous', { env: {}, home, instanceRoot: () => '/src/.elanous-test', hasGit: withGit })).toBe('/src/app/node_modules/elanous/data');
  });
  test('ELANOUS_DATA_DIR wins', () => {
    expect(resolveDataDir('/src/pilot', { env: { ELANOUS_DATA_DIR: '/x/data' }, home, instanceRoot: () => '/src/.elanous-test', hasGit: withGit })).toBe('/x/data');
  });
});
