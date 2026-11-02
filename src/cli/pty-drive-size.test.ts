// ── 자식 PTY 화면 크기 계약 (대표 2026-08-02 · 기본 160×40) ──────────────────────
//
// ⛔ 종전엔 `pty-drive-cli.ts` 가 `cols:120, rows:30` 을 하드코딩해 레시피 기본을 덮었고
//    옵션도 없었다 ⇒ **하드코딩된 화면이 관측 상한**이었다(자식 화면보다 큰 렌더 블록을
//    맥락과 함께 볼 수 없다). 이 파일이 그 회귀를 막는다.

import { describe, expect, test } from 'bun:test';
import { elanousTuiSpawnOptions } from '../self-implement/elanous-tui-spawn.js';
import { buildDriveSpawnOptions } from './pty-drive-cli.js';

const base = {
  repoRoot: '/repo',
  cwd: '/repo/wt',
  configDir: '/iso/config',
  stateDir: '/iso/state',
  space: { kind: 'self-build' as const, id: 'test' },
  requireIsolation: true,
};

describe('elanousTuiSpawnOptions — 화면 크기 기본값', () => {
  test('⭐ 미지정이면 160×40 이다 (대표 지시)', () => {
    const o = elanousTuiSpawnOptions(base as never);
    expect(o.cols).toBe(160);
    expect(o.rows).toBe(40);
  });

  test('명시하면 그 값을 쓴다', () => {
    const o = elanousTuiSpawnOptions({ ...base, cols: 200, rows: 120 } as never);
    expect(o.cols).toBe(200);
    expect(o.rows).toBe(120);
  });

  test('한쪽만 명시해도 나머지는 기본을 지킨다', () => {
    expect(elanousTuiSpawnOptions({ ...base, rows: 90 } as never).cols).toBe(160);
    expect(elanousTuiSpawnOptions({ ...base, cols: 300 } as never).rows).toBe(40);
  });
});

// ⭐⭐⭐ 무인 리뷰 must-fix — 레시피만 재면 **CLI 배선이 깨져도 통과한다**.
//    조립을 `buildDriveSpawnOptions` 로 뽑았으므로 이제 **실제로 도는 코드**를 탄다.
describe('buildDriveSpawnOptions — 두 경로의 화면 크기 배선', () => {
  const ctx = {
    cwd: '/repo/wt',
    space: { inHarness: true as const, kind: 'self-implement' as const, id: 'wt', runId: 'run-1' },
    configDir: '/iso/config',
    stateDir: '/iso/state',
  };

  test('⭐ elanous 경로 — 미지정이면 160×40', () => {
    const o = buildDriveSpawnOptions({ elanous: true } as never, ctx);
    expect([o.cols, o.rows]).toEqual([160, 40]);
  });

  test('⭐ elanous 경로 — 명시값이 그대로 간다', () => {
    const o = buildDriveSpawnOptions({ elanous: true, cols: 200, rows: 120 } as never, ctx);
    expect([o.cols, o.rows]).toEqual([200, 120]);
  });

  test('held owner may launch the latest-main TUI entry while its owner code stays on the caller CLI', () => {
    const previousOwner = process.env.ELANOUS_HOLD_OWNER;
    const previousEntry = process.env.ELANOUS_HOLD_TUI_REPO_ROOT;
    try {
      process.env.ELANOUS_HOLD_OWNER = '1';
      process.env.ELANOUS_HOLD_TUI_REPO_ROOT = '/latest-main/worktree';
      const options = buildDriveSpawnOptions({ elanous: true, hold: true } as never, ctx);
      expect(options.args?.[0]).toBe('/latest-main/worktree/bin/elanous.mjs');
    } finally {
      if (previousOwner === undefined) delete process.env.ELANOUS_HOLD_OWNER;
      else process.env.ELANOUS_HOLD_OWNER = previousOwner;
      if (previousEntry === undefined) delete process.env.ELANOUS_HOLD_TUI_REPO_ROOT;
      else process.env.ELANOUS_HOLD_TUI_REPO_ROOT = previousEntry;
    }
  });

  test('elanous 경로는 owner ELANOUS_STATE_DIR에서 control inbox를 해석한다', () => {
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const previousInboxDir = process.env.ELANOUS_CONTROL_INBOX_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = '/owner/state';
      delete process.env.ELANOUS_CONTROL_INBOX_DIR;
      const o = buildDriveSpawnOptions({ elanous: true } as never, {
        ...ctx,
        space: { inHarness: true as const, kind: 'self-implement' as const, id: 'dev-run-x', runId: 'run-1' },
        stateDir: '/child/state',
      });
      expect(o.env?.ELANOUS_CONTROL_INBOX_DIR).toBe('/owner/state/harness-screens/dev-run-x.inbox');
      expect(o.env?.ELANOUS_CONTROL_INBOX_DIR).not.toStartWith('/child/state');
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      if (previousInboxDir === undefined) delete process.env.ELANOUS_CONTROL_INBOX_DIR;
      else process.env.ELANOUS_CONTROL_INBOX_DIR = previousInboxDir;
    }
  });

  test('elanous 경로는 상속된 control inbox를 우선한다', () => {
    const previousInboxDir = process.env.ELANOUS_CONTROL_INBOX_DIR;
    try {
      process.env.ELANOUS_CONTROL_INBOX_DIR = '/abs/parent-inbox';
      const o = buildDriveSpawnOptions({ elanous: true } as never, ctx);
      expect(o.env?.ELANOUS_CONTROL_INBOX_DIR).toBe('/abs/parent-inbox');
    } finally {
      if (previousInboxDir === undefined) delete process.env.ELANOUS_CONTROL_INBOX_DIR;
      else process.env.ELANOUS_CONTROL_INBOX_DIR = previousInboxDir;
    }
  });

  test('⭐ 셸 경로 — 미지정이면 160×40', () => {
    const o = buildDriveSpawnOptions({ command: 'echo hi' } as never, ctx);
    expect([o.cols, o.rows]).toEqual([160, 40]);
    expect(o.cmd).toBe('bash');
    expect(o.env?.ELANOUS_CONTROL_INBOX_DIR).toBeUndefined();
  });

  test('⭐ 셸 경로 — 명시값이 그대로 간다', () => {
    const o = buildDriveSpawnOptions({ command: 'echo hi', cols: 90, rows: 24 } as never, ctx);
    expect([o.cols, o.rows]).toEqual([90, 24]);
  });

  // ⛔ 0 이나 음수는 PTY 로서 뜻이 없다 — 두 경로 **모두** 거부해야 한다(무인 리뷰 should-fix).
  //    종전 판은 0 을 허용하고 "두 경로가 같기만 하면 된다" 로 테스트해 그 결함을 정당화했다.
  test('0·음수·소수는 두 경로 모두 거부한다', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => buildDriveSpawnOptions({ elanous: true, cols: bad } as never, ctx)).toThrow();
      expect(() => buildDriveSpawnOptions({ command: 'x', rows: bad } as never, ctx)).toThrow();
    }
  });
});

// ⭐ CLI 파싱 → spec 전달 배선(무인 리뷰 should-fix) — 문자열 옵션이 숫자로 넘어가는가.
describe('dev CLI — --cols/--rows 가 spec 으로 전달된다', () => {
  test('문자열 옵션이 숫자로 파싱돼 elanous 스펙에 실린다', async () => {
    const { buildDevCliSpec } = await import('../self-dev/dev-cli.js');
    const spec = buildDevCliSpec({ text: 'x' } as never, { kind: 'self' } as never, { elanous: true, hold: true, cols: '200', rows: '120' } as never);
    expect((spec as { elanous?: { cols?: number; rows?: number } }).elanous?.cols).toBe(200);
    expect((spec as { elanous?: { cols?: number; rows?: number } }).elanous?.rows).toBe(120);
  });

  test('미지정이면 spec 에 키가 아예 없다 (기본은 아래층이 정한다)', async () => {
    const { buildDevCliSpec } = await import('../self-dev/dev-cli.js');
    const spec = buildDevCliSpec({ text: 'x' } as never, { kind: 'self' } as never, { elanous: true, hold: true } as never);
    expect('cols' in ((spec as { elanous?: object }).elanous ?? {})).toBe(false);
    expect('rows' in ((spec as { elanous?: object }).elanous ?? {})).toBe(false);
  });
});
