// ⛔⭐⭐⭐ held TUI 자식의 **PTY 정체성 전파** 회귀.
//
//   종전엔 `childPtyIdentityEnv` 가 **하니스 경로에만**(`headless-elanous-driver.ts`) 실렸다.
//   그래서 `--hold` 로 띄운 TUI 자식은 `ELANOUS_PTY_ID` 가 없어 `getCurrentPtyId()` 가
//   `undefined` 였고, **자기 정체성을 한 줄도 못 남겼다**(`[S]` 코퍼스 러너가 막힌 자리 · #5730).
//   ⚠️ 이것은 **전제**이지 pty↔session 결속 자체가 아니다 — 세션은 데몬이 소유한다(매뉴얼 §0a ⑶b).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { deriveChildController } from '../agent/identity-env.js';
import { establishElanousTuiIsolation, elanousTuiSpawnOptions, PREAMBLE_SYNC_BLOCK_ENV } from './elanous-tui-spawn.js';
import { PREAMBLE_SYNC_BLOCK_ENV as TURN_PREAMBLE_SEAM_ENV } from '../dashboard/turn-preamble.js';
import { buildPtyEnv } from '../agent/identity-env.js';
import { resetCapturedEnvForTesting, setCapturedEnvForTesting } from '../shell-env-bootstrap.js';

const base = {
  repoRoot: '/repo',
  cwd: '/w',
  configDir: '/c',
  stateDir: '/s',
  space: { inHarness: true as const, kind: 'self-implement' as const, id: 'space', runId: 'run-1' },
  requireIsolation: true,
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'elanous-tui-spawn-'));
}

function observeIsolationConfig(action: () => void): Array<{ category: string; event: string; data: Record<string, unknown> }> {
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    events.push({ category, event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    action();
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
  return events;
}

describe('establishElanousTuiIsolation — config materialization', () => {
  test('빈 config 디렉터리에는 주입한 원천의 test-safe 사본을 만들고 created를 관측한다', () => {
    const root = tempDir();
    const source = tempDir();
    writeFileSync(join(source, 'config.json'), JSON.stringify({ telegram: { botToken: 'production-token' }, discord: { enabled: true } }));
    try {
      let isolation: ReturnType<typeof establishElanousTuiIsolation> | undefined;
      const events = observeIsolationConfig(() => { isolation = establishElanousTuiIsolation({ root, sourceConfigDir: source }); });
      const configPath = join(root, 'config.json');
      const canonicalRoot = realpathSync(root);
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
      expect(isolation).toMatchObject({ configDir: canonicalRoot, stateDir: canonicalRoot });
      expect(existsSync(configPath)).toBe(true);
      expect(config.telegram.enabled).toBe(false);
      expect(config.discord.enabled).toBe(false);
      expect(events).toContainEqual({ category: 'pty.drive', event: 'isolation-config-materialized', data: { configDir: canonicalRoot, outcome: 'created' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('사전 준비된 config는 보존하고 existing을 관측한다', () => {
    const root = tempDir();
    const source = tempDir();
    const configDir = root;
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, '{"preserved":true}');
    try {
      const events = observeIsolationConfig(() => establishElanousTuiIsolation({ root, sourceConfigDir: source }));
      expect(readFileSync(configPath, 'utf8')).toBe('{"preserved":true}');
      expect(events).toContainEqual({ category: 'pty.drive', event: 'isolation-config-materialized', data: { configDir: realpathSync(configDir), outcome: 'existing' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('callerStateDir가 공통 뿌리 아래에 있으면 물질화 전에 거부하고 호출자 파일을 만들지 않는다', () => {
    const root = tempDir();
    const callerStateDir = join(root, 'state');
    const source = tempDir();
    writeFileSync(join(source, 'config.json'), JSON.stringify({ telegram: { botToken: 'production-token' } }));
    try {
      mkdirSync(callerStateDir);
      expect(() => establishElanousTuiIsolation({ root, callerStateDir, sourceConfigDir: source })).toThrow('isolated root');
      expect(existsSync(join(callerStateDir, 'config.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('원천 동기화 실패를 failed로 남기고 격리는 계속 수립한다', () => {
    const root = tempDir();
    const missingSource = join(root, 'missing-source');
    try {
      const events = observeIsolationConfig(() => {
        const isolation = establishElanousTuiIsolation({ root, sourceConfigDir: missingSource });
        expect(isolation.configDir).toBe(realpathSync(root));
        expect(isolation.stateDir).toBe(realpathSync(root));
      });
      expect(events).toContainEqual(expect.objectContaining({
        category: 'pty.drive',
        event: 'isolation-config-materialized',
        data: expect.objectContaining({ configDir: realpathSync(root), outcome: 'failed' }),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('공통 뿌리를 config argv와 state 환경에 같은 값으로 전달한다', () => {
    const root = tempDir();
    try {
      const isolation = establishElanousTuiIsolation({ root });
      const recipe = elanousTuiSpawnOptions({ ...base, ...isolation });
      const env = recipe.env as Record<string, string>;
      expect(recipe.args).toEqual(['/repo/bin/elanous.mjs', '--config-dir', isolation.configDir, '--test-state-dir', isolation.stateDir]);
      expect(env.ELANOUS_STATE_DIR).toBe(isolation.configDir);
      expect(isolation.stateDir).toBe(isolation.configDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('명시 뿌리는 dispose 뒤에도 호출자 소유로 남긴다', () => {
    const root = tempDir();
    try {
      const isolation = establishElanousTuiIsolation({ root });
      isolation.dispose();
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('암묵 뿌리는 dispose가 소유하여 제거한다', () => {
    const isolation = establishElanousTuiIsolation({});
    isolation.dispose();
    expect(existsSync(isolation.configDir)).toBe(false);
  });
});

describe('elanousTuiSpawnOptions — 자식 PTY 정체성', () => {
  test('부모 PTY를 외부 에이전트보다 먼저 제어자로 유도한다', () => {
    expect(deriveChildController({ ELANOUS_PTY_ID: 'pty_parent', ELANOUS_ORIGIN_AGENT: 'claude-code' }, 42)).toBe('pty:pty_parent');
  });

  test('외부 에이전트와 pid fallback으로 제어자를 유도한다', () => {
    expect(deriveChildController({ ELANOUS_ORIGIN_AGENT: 'claude-code' }, 42)).toBe('agent:claude-code');
    expect(deriveChildController({}, 42)).toBe('pid:42');
  });

  test('기본 제어자와 제어 통로를 자식 env에 주입한다', () => {
    const env = elanousTuiSpawnOptions(base).env as Record<string, string>;
    expect(env.ELANOUS_CONTROLLER).not.toBe('');
    expect(env.ELANOUS_CONTROL_CHANNELS).toBe('pty,inbox');
  });

  test('명시 제어자가 유도값보다 우선한다', () => {
    const env = elanousTuiSpawnOptions({ ...base, controller: 'harness:run-1' }).env as Record<string, string>;
    expect(env.ELANOUS_CONTROLLER).toBe('harness:run-1');
  });

  test('제어자 주입을 관측한다', () => {
    const events = observeIsolationConfig(() => elanousTuiSpawnOptions({ ...base, controller: 'harness:run-1' }));
    expect(events).toContainEqual({
      category: 'self-implement.elanous-tui-spawn',
      event: 'controller',
      data: { controller: 'harness:run-1', channels: 'pty,inbox' },
    });
  });

  test('ptyId 를 주면 자식 env 에 ELANOUS_PTY_ID 로 실린다', () => {
    const env = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' }).env as Record<string, string>;
    expect(env.ELANOUS_PTY_ID).toBe('pty_abcdef01');
  });

  test('ptyId 를 안 주면 정체성 키를 만들지 않는다 (빈 경로)', () => {
    const env = elanousTuiSpawnOptions(base).env as Record<string, string>;
    expect(env.ELANOUS_PTY_ID).toBeUndefined();
  });

  test('부모가 해석한 제어 inbox 절대 경로를 자식 env에 그대로 전달한다', () => {
    const env = elanousTuiSpawnOptions({ ...base, controlInboxDir: '/parent-state/harness-screens/space.inbox' }).env as Record<string, string>;
    expect(env.ELANOUS_CONTROL_INBOX_DIR).toBe('/parent-state/harness-screens/space.inbox');
  });

  test('격리 계약은 그대로다 — 정체성 추가가 state/config 전파를 밀어내지 않는다', () => {
    const opts = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' });
    const env = opts.env as Record<string, string>;
    expect(env.ELANOUS_STATE_DIR).toBe('/s');
    expect(env.ELANOUS_PARENT_SELF_DEV_RUNS_DIR).toBeDefined();
    expect(opts.args).toContain('--config-dir');
  });

  test('부모가 준 ELANOUS_DEBUG_LEVEL을 명시적으로 자식 env에 전파한다', () => {
    const original = process.env.ELANOUS_DEBUG_LEVEL;
    try {
      process.env.ELANOUS_DEBUG_LEVEL = 'diag';
      const env = elanousTuiSpawnOptions(base).env as Record<string, string>;
      expect(env.ELANOUS_DEBUG_LEVEL).toBe('diag');
      expect(env.ELANOUS_STATE_DIR).toBe('/s');
    } finally {
      if (original === undefined) delete process.env.ELANOUS_DEBUG_LEVEL;
      else process.env.ELANOUS_DEBUG_LEVEL = original;
    }
  });

  test('부모가 ELANOUS_DEBUG_LEVEL을 주지 않으면 자식 env에 키를 만들지 않는다', () => {
    const original = process.env.ELANOUS_DEBUG_LEVEL;
    try {
      delete process.env.ELANOUS_DEBUG_LEVEL;
      const env = elanousTuiSpawnOptions(base).env as Record<string, string>;
      expect('ELANOUS_DEBUG_LEVEL' in env).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_DEBUG_LEVEL;
      else process.env.ELANOUS_DEBUG_LEVEL = original;
    }
  });
});

// ⛔⭐⭐⭐ 경계에서 «묻는 길»이 이 경로에도 열렸는지 — 위 정체성 회귀와 «같은 형태»의 결손이었다.
//
//   📏 2026-08-07 라이브 실측: `dev --elanous --hold` 로 띄운 자식이 `bunx` 로 거부돼
//      `harness.boundary/main-tree-reject` 는 났는데, 같은 우주에 `request-received` 가 «0» 이었다.
//      요청 채널이 `seams.ts`·`headless-elanous-driver.ts`(self-implement 경로)에만 실려 있었기 때문이다.
//   ⇒ 거부는 나는데 «물을 길이 없던» 것이다(RFC-child-boundary-hitl 의 「한 경로에만 배선」).
describe('elanousTuiSpawnOptions — 경계 요청 우편함', () => {
  test('ptyId 를 주면 자식 env 에 요청 우편함 경로가 실린다', () => {
    const env = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' }).env as Record<string, string>;
    expect(typeof env.ELANOUS_HARNESS_BOUNDARY_REQUESTS).toBe('string');
    expect(env.ELANOUS_HARNESS_BOUNDARY_REQUESTS.endsWith('.jsonl')).toBe(true);
  });

  test('같은 ptyId 는 같은 경로로, 다른 ptyId 는 다른 경로로 간다 (자식마다 갈린다)', () => {
    const a = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' }).env as Record<string, string>;
    const again = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' }).env as Record<string, string>;
    const b = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_beefcafe' }).env as Record<string, string>;
    expect(a.ELANOUS_HARNESS_BOUNDARY_REQUESTS).toBe(again.ELANOUS_HARNESS_BOUNDARY_REQUESTS);
    expect(a.ELANOUS_HARNESS_BOUNDARY_REQUESTS).not.toBe(b.ELANOUS_HARNESS_BOUNDARY_REQUESTS);
  });

  test('ptyId 가 없으면 우편함 키를 만들지 않는다 (fail-open · 종전과 동일)', () => {
    const env = elanousTuiSpawnOptions(base).env as Record<string, string>;
    expect('ELANOUS_HARNESS_BOUNDARY_REQUESTS' in env).toBe(false);
  });

  test('우편함 추가가 기존 전파를 밀어내지 않는다 (경계·공간·격리 그대로)', () => {
    const env = elanousTuiSpawnOptions({ ...base, ptyId: 'pty_abcdef01' }).env as Record<string, string>;
    expect(env.ELANOUS_HARNESS_BOUNDARY).toBe('/w');
    expect(env.ELANOUS_STATE_DIR).toBe('/s');
    expect(env.ELANOUS_PTY_ID).toBe('pty_abcdef01');
  });
});

describe('elanousTuiSpawnOptions — 시험 지연 seam env 전달(TUI-TYPING-LAG-OBS-2)', () => {
  const saved = process.env[PREAMBLE_SYNC_BLOCK_ENV];
  const withSeam = (value: string | undefined, action: () => void): void => {
    if (value === undefined) delete process.env[PREAMBLE_SYNC_BLOCK_ENV];
    else process.env[PREAMBLE_SYNC_BLOCK_ENV] = value;
    try { action(); } finally {
      if (saved === undefined) delete process.env[PREAMBLE_SYNC_BLOCK_ENV];
      else process.env[PREAMBLE_SYNC_BLOCK_ENV] = saved;
    }
  };

  test('이름은 turn-preamble 의 seam 과 같은 값이다', () => {
    expect(PREAMBLE_SYNC_BLOCK_ENV).toBe(TURN_PREAMBLE_SEAM_ENV);
  });

  test('격리 자식이면 부모의 seam env 를 자식 env 에 싣고 관측한다', () => {
    withSeam('300', () => {
      let env: Record<string, string> | undefined;
      const events = observeIsolationConfig(() => { env = elanousTuiSpawnOptions(base).env; });
      expect(env?.[PREAMBLE_SYNC_BLOCK_ENV]).toBe('300');
      expect(events).toContainEqual({ category: 'self-implement.elanous-tui-spawn', event: 'test-seam-env', data: { name: PREAMBLE_SYNC_BLOCK_ENV, value: '300' } });
    });
  });

  // 실제 자식 env = registry 가 쓰는 buildPtyEnv 합성 결과. 로그인 셸 캡처본에 변수가 있어도 새면 안 된다.
  const childEnv = (opts: Parameters<typeof elanousTuiSpawnOptions>[0]): Record<string, string> => {
    const start = elanousTuiSpawnOptions(opts);
    setCapturedEnvForTesting({ PATH: '/usr/bin:/bin', [PREAMBLE_SYNC_BLOCK_ENV]: '999' });
    try { return buildPtyEnv(start.env ?? {}, process.env, { unset: start.unsetEnv }); } finally { resetCapturedEnvForTesting(); }
  };

  test('격리 자식의 실제 env 는 부모 값을 쓴다(캡처본 값이 아니라)', () => {
    withSeam('300', () => {
      expect(childEnv(base)[PREAMBLE_SYNC_BLOCK_ENV]).toBe('300');
    });
  });

  test('반증 — 격리 아닌 자식의 실제 env 에는 없다(캡처본에 있어도)', () => {
    withSeam('300', () => {
      const opts = { ...base, configDir: undefined, stateDir: undefined, requireIsolation: false };
      expect(elanousTuiSpawnOptions(opts).env?.[PREAMBLE_SYNC_BLOCK_ENV]).toBeUndefined();
      expect(childEnv(opts)[PREAMBLE_SYNC_BLOCK_ENV]).toBeUndefined();
    });
  });

  test('부모에 seam env 가 없으면 실제 자식 env 에도 없다(캡처본에 있어도)', () => {
    withSeam(undefined, () => {
      expect(elanousTuiSpawnOptions(base).env?.[PREAMBLE_SYNC_BLOCK_ENV]).toBeUndefined();
      expect(childEnv(base)[PREAMBLE_SYNC_BLOCK_ENV]).toBeUndefined();
    });
  });
});
