import { expect, test } from 'bun:test';
import { worktreeServeEntry } from './els-cli.js';

// 출처: OP P0 #133752 ① — mshq els 서버가 11-21 21:23 부터 옛 worktree els-api-ceo-channel(b2d3285f)에서
// 기동해 owner-unreachable·disk I/O error·database is locked 를 낸 사고 형태 그대로 잡는 감지기.
test('a serve entry inside a git worktree is detected; installed and bare-bun entries are not (#133752)', () => {
  expect(worktreeServeEntry('/Users/j/elanous-hq/worktrees/els-api-ceo-channel/bin/elanous')).toBeTrue();
  expect(worktreeServeEntry('/Users/j/elanous-hq/repo.git/worktrees/wt-x/dist/cli.js')).toBeTrue();
  expect(worktreeServeEntry('/Users/j/.local/share/elanous/current/node_modules/elanous/dist/cli.js')).toBeFalse();
  expect(worktreeServeEntry('/opt/homebrew/bin/bun')).toBeFalse();
  expect(worktreeServeEntry(undefined)).toBeFalse();
});
