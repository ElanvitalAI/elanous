// 격리 실증(positive) — 전역 preload(bunfig.toml)가 ELANOUS_STATE_DIR 을 미설정 시 tmp 로
// 강제해 가드 없던 resolver 들이 운영(~/.elanous)이 아닌 격리 tmp 하위를 반환하는지 확인.
// PLAN 1-A 3층(계약) 계측.
//
// ⚠️ 순서 독립: resolver 는 env 를 call-time 에 읽으므로, 캐시 경로(sessionRoot 의
// testFallbackRoot 모듈-레벨 캐시 · src/session/index.ts:73)에 걸리지 않도록 각 테스트가
// 자기 ELANOUS_STATE_DIR 을 명시 세팅한다. ELANOUS_STATE_DIR 분기가 fallback 분기보다 먼저라
// 앞 테스트가 남긴 캐시와 무관하게 결정론적. afterEach 로 원복(다른 파일 무회귀).
import { setDefaultTimeout, describe, test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = join(import.meta.dir, '..');

function runPreloadFixture(env: Record<string, string | undefined>, body: string): { stdout: string; stderr: string; status: number | null } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'elanous-preload-fixture-'));
  const fixturePath = join(fixtureDir, 'fixture.test.ts');
  writeFileSync(fixturePath, body);
  try {
    const result = spawnSync('bun', ['test', fixturePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function readFixtureEnvironment(stdout: string): Record<string, string | undefined> {
  const match = stdout.match(/PRELOAD_ENV=(\{.*\})/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

const ORIG_STATE = process.env.ELANOUS_STATE_DIR;
const ORIG_SESS = process.env.ELANOUS_SESSION_ROOT;

describe('preload-isolation contract', () => {
  afterEach(() => {
    if (ORIG_STATE === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = ORIG_STATE;
    if (ORIG_SESS === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = ORIG_SESS;
  });

  test('preload set ELANOUS_STATE_DIR to an isolated tmp dir (not ~/.elanous)', () => {
    // 계약 자체 검증 — preload 가 process 진입 시 미설정→tmp 로 강제한 전역 값.
    const dir = process.env.ELANOUS_STATE_DIR ?? '';
    expect(dir).toContain(tmpdir());
    expect(dir).not.toContain(`${process.env.HOME}/.elanous`);
  });

  test('elanousStateRoot() resolves under an isolated tmp root, not prod ~/.elanous', async () => {
    const isolated = join(tmpdir(), 'elanous-test-smoke-state');
    process.env.ELANOUS_STATE_DIR = isolated;
    const { elanousStateRoot } = await import('../src/autopilot/state-paths.js');
    expect(elanousStateRoot()).toBe(isolated);
    expect(elanousStateRoot()).toContain(tmpdir());
  });

  test('sessionRoot() lands under an isolated tmp root, not prod ~/.elanous', async () => {
    // ELANOUS_STATE_DIR 명시 세팅 + ELANOUS_SESSION_ROOT 삭제 → sessionRoot 이 ELANOUS_STATE_DIR
    // 분기(join(dir,'sessions'))를 타고 testFallbackRoot 캐시에 닿지 않는다 → 순서 무관.
    const isolated = join(tmpdir(), 'elanous-test-smoke-state');
    process.env.ELANOUS_STATE_DIR = isolated;
    delete process.env.ELANOUS_SESSION_ROOT;
    const { sessionRoot } = await import('../src/session/index.js');
    expect(sessionRoot()).toBe(join(isolated, 'sessions'));
    expect(sessionRoot()).toContain(tmpdir());
  });

  test('harness-inherited child receives a fresh state dir, clears identity, and cannot write the parent ledger', () => {
    const parentStateDir = mkdtempSync(join(tmpdir(), 'elanous-parent-state-'));
    const fixture = `
      import { test } from 'bun:test';
      import { appendRunLedgerEntry } from ${JSON.stringify(join(REPO_ROOT, 'src/self-implement/run-ledger.ts'))};
      appendRunLedgerEntry({ runId: 'run-parent', event: 'fixture-write', data: {} });
      console.log('PRELOAD_ENV=' + JSON.stringify({
        stateDir: process.env.ELANOUS_STATE_DIR,
        stateDirSource: process.env.ELANOUS_STATE_DIR_SOURCE,
        runId: process.env.ELANOUS_RUN_ID,
        harnessSpace: process.env.ELANOUS_HARNESS_SPACE,
        harnessSpaceId: process.env.ELANOUS_HARNESS_SPACE_ID,
        controlInboxDir: process.env.ELANOUS_CONTROL_INBOX_DIR,
      }));
      test('fixture', () => {});
    `;
    try {
      const result = runPreloadFixture({
        ELANOUS_STATE_DIR: parentStateDir,
        ELANOUS_STATE_DIR_SOURCE: 'parent',
        ELANOUS_RUN_ID: 'run-parent',
        ELANOUS_HARNESS_SPACE: 'space-parent',
        ELANOUS_HARNESS_SPACE_ID: 'space-id-parent',
        ELANOUS_CONTROL_INBOX_DIR: join(parentStateDir, 'inbox'),
      }, fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFixtureEnvironment(result.stdout)).toEqual({
        stateDir: expect.any(String),
        stateDirSource: undefined,
        runId: undefined,
        harnessSpace: undefined,
        harnessSpaceId: undefined,
        controlInboxDir: undefined,
      });
      expect(readFixtureEnvironment(result.stdout).stateDir).not.toBe(parentStateDir);
      expect(existsSync(join(parentStateDir, 'run-ledger'))).toBe(false);
    } finally {
      rmSync(parentStateDir, { recursive: true, force: true });
    }
  });

  test('child without ELANOUS_RUN_ID preserves an explicitly supplied state directory', () => {
    const explicitStateDir = mkdtempSync(join(tmpdir(), 'elanous-explicit-state-'));
    const fixture = `
      import { test } from 'bun:test';
      console.log('PRELOAD_ENV=' + JSON.stringify({ stateDir: process.env.ELANOUS_STATE_DIR }));
      test('fixture', () => {});
    `;
    try {
      const result = runPreloadFixture({ ELANOUS_STATE_DIR: explicitStateDir, ELANOUS_RUN_ID: undefined }, fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFixtureEnvironment(result.stdout).stateDir).toBe(explicitStateDir);
    } finally {
      rmSync(explicitStateDir, { recursive: true, force: true });
    }
  });
});
