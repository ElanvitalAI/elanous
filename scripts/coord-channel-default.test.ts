import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('coordination watcher selects #27708 only from the unique last-channel heading and fails closed', () => {
  const manualPath = resolve(import.meta.dir, '../docs/manual/MANUAL-multi-agent-coordination-channel-2026-07-28.md');
  const manual = readFileSync(manualPath, 'utf8');
  expect(manual).toMatch(/^> ## .*마지막 채널 = \[PR #27708\]\(https:\/\/github\.com\/[^/]+\/elanous-agent\/pull\/27708\)/m);
  const fixture = mkdtempSync(resolve(tmpdir(), 'coord-channel-watch-'));
  const scriptDir = resolve(fixture, 'scripts');
  const fixtureManual = resolve(fixture, 'docs/manual/MANUAL-multi-agent-coordination-channel-2026-07-28.md');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(resolve(fixture, 'docs/manual'), { recursive: true });
  const script = resolve(scriptDir, 'coord-channel-watch.sh');
  copyFileSync(resolve(import.meta.dir, 'coord-channel-watch.sh'), script);
  copyFileSync(resolve(import.meta.dir, 'coord-tracks.json'), resolve(scriptDir, 'coord-tracks.json'));
  const { CH_PR: _old, ...baseEnv } = process.env;
  const run = (channel?: string) => spawnSync('bash', ['-x', script, 'status', '--track', 'TC'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...baseEnv, ...(channel ? { CH_PR: channel } : {}) },
  });
  try {
    writeFileSync(fixtureManual, manual);
    const defaultRun = run();
    expect(defaultRun.status).toBe(0);
    expect(defaultRun.stderr).toContain('PR_NUM=27708');

    writeFileSync(fixtureManual, manual.replace('마지막 채널 = [PR #27708]', '마지막 채널 = [PR #BROKEN]'));
    const brokenRun = run();
    expect(brokenRun.status).toBe(3);
    expect(brokenRun.stderr).toContain('채널 번호를 못 읽었다');

    writeFileSync(fixtureManual, manual.replace('/pull/27708)', '/pull/26146)'));
    const mismatchedRun = run();
    expect(mismatchedRun.status).toBe(3);

    const extraHeading = '\n> ## 마지막 채널 = [PR #26146](https://github.com/example-org/elanous-agent/pull/26146)\n';
    writeFileSync(fixtureManual, manual.replace('# MANUAL — 멀티 에이전트 조율 채널 감시', `# MANUAL — 멀티 에이전트 조율 채널 감시${extraHeading}`));
    const ambiguousRun = run();
    expect(ambiguousRun.status).toBe(3);

    const overrideRun = run('999999');
    expect(overrideRun.status).toBe(0);
    expect(overrideRun.stderr).toContain('PR_NUM=999999');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
