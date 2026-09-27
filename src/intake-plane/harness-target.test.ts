import { expect, test } from 'bun:test';
import { resolveDaemonHarnessTarget } from './harness-target.js';

const cwd = '/not-a-repo';
const repo = '/configured-repo';
const gitPaths = new Set([repo]);
const isGitRepo = (path: string) => gitPaths.has(path);

test('without a configured repository, non-git cwd is rejected with the config hint', () => {
  expect(resolveDaemonHarnessTarget({ cwd, isGitRepo })).toEqual({
    ok: false,
    reason: `하니스 대상 저장소가 없습니다 — \`elanous config set harness.defaultRepo <저장소 경로>\` 로 정하세요 (지금 폴더: ${cwd} 는 git 저장소가 아닙니다)`,
  });
});

test('without configuration, git cwd remains the target', () => {
  expect(resolveDaemonHarnessTarget({ cwd: repo, isGitRepo })).toEqual({ ok: true, repo, source: 'cwd' });
});

test('configured git repository takes precedence over non-git cwd', () => {
  expect(resolveDaemonHarnessTarget({ configured: repo, cwd, isGitRepo })).toEqual({ ok: true, repo, source: 'config' });
});

test('configured non-git directory rejects rather than silently using a git cwd', () => {
  expect(resolveDaemonHarnessTarget({ configured: cwd, cwd: repo, isGitRepo })).toMatchObject({ ok: false });
});
