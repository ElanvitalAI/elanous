// PTY 정체성 전파 SSOT 계약 테스트 (P0.5 · 2026-07-26)
//
// 근본 = 내부 문서 `DESIGN-instance-leader-and-default-test-2026-07-26` §1d·§4e:
// getCapturedEnv() 가 PTY env 베이스를 로그인 셸 스냅샷으로 갈아끼워 프로세스 런타임 정체성
// (ELANOUS_STATE_DIR 등)이 소실 → 격리된 elanous 의 PTY 가 조용히 prod 를 만졌다.
//
// ⚠️ **위양성 방지가 이 파일의 핵심 규율**: getCapturedEnv() 는 캡처 실패 시 process.env 로
// 폴백하는데, 그러면 정체성이 "저절로" 보존되어 allowlist 가 동작하지 않아도 통과한다.
// CI·헤드리스는 `$SHELL -l -i` 가 실패/타임아웃하기 쉬워 폴백이 잦다. 그래서 모든 합성 테스트는
// setCapturedEnvForTesting() 으로 캡처를 **고정**하고 capturedEnvAvailable() 을 함께 단언한다.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  capturedEnvAvailable,
  resetCapturedEnvForTesting,
  setCapturedEnvForTesting,
} from '../src/shell-env-bootstrap.js';
import {
  buildPtyEnv,
  establishExecutionOrigin,
  identityEnv,
  identityEnvKeys,
  blockedIdentityEnvCount,
  SYNTHESIZED_IDENTITY_ENV_KEYS,
} from '../src/agent/identity-env.js';
import { debug } from '../src/debug/log.js';
import type { LogSink } from '../src/mss/logging/sink.js';
import { getTestStateRoot, setTestStateRoot } from '../src/nexus/paths.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import { prodInstanceRoot } from '../src/instance/resolve.js';
import { resolveCurrentInstance } from '../src/instance/current.js';

afterEach(() => {
  resetCapturedEnvForTesting();
});

/** 로그인 셸 스냅샷 스텁 — ELANOUS_* 는 하나도 없다(실제 캡처와 동형). */
const CAPTURED = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: '/Users/j',
  SHELL: '/bin/zsh',
  ANTHROPIC_API_KEY: 'sk-ant-from-login-shell',
};

function captureStateDirSource(): { source: () => 'env' | 'fallback' | 'absent' | undefined; dispose: () => void } {
  let stateDirSource: 'env' | 'fallback' | 'absent' | undefined;
  const sink: LogSink = {
    name: 'identity-env-state-dir-source',
    emit: (record) => {
      if (record.category !== 'instance.identity' || record.event !== 'pty-env-propagated') return;
      stateDirSource = (record.data as { stateDirSource?: 'env' | 'fallback' | 'absent' }).stateDirSource;
    },
  };
  return { source: () => stateDirSource, dispose: debug.registerSink(sink) };
}

describe('establishExecutionOrigin', () => {
  test('명시 세션은 부모 키가 없을 때만 기록한다', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(establishExecutionOrigin(env, undefined, ' explicit-session ')).toBe('human-cli');
    expect(env.ELANOUS_ORIGIN_SESSION).toBe('explicit-session');
  });

  test.each(['', '   ', 'parent-session'])('부모가 설정한 세션 값 %j을 보존한다', (parentSession) => {
    const env: NodeJS.ProcessEnv = { ELANOUS_ORIGIN_SESSION: parentSession };

    establishExecutionOrigin(env, undefined, 'explicit-session');

    expect(env.ELANOUS_ORIGIN_SESSION).toBe(parentSession);
  });

  test('빈 명시 세션은 기록하지 않는다', () => {
    const env: NodeJS.ProcessEnv = {};

    establishExecutionOrigin(env, undefined, '   ');

    expect(env.ELANOUS_ORIGIN_SESSION).toBeUndefined();
  });

  test('인자 생략 human-cli 호출은 Claude 세션을 기록하지 않는다', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_SESSION_ID: 'claude-session' };

    expect(establishExecutionOrigin(env)).toBe('human-cli');
    expect(env.ELANOUS_ORIGIN_SESSION).toBeUndefined();
  });

  test('기존 origin 호출은 인자 생략 시 Claude 세션을 기록하지 않는다', () => {
    const env: NodeJS.ProcessEnv = {
      ELANOUS_ORIGIN_ROOT: 'external-agent',
      CLAUDE_CODE_SESSION_ID: 'claude-session',
    };

    expect(establishExecutionOrigin(env)).toBe('external-agent');
    expect(env.ELANOUS_ORIGIN_SESSION).toBeUndefined();
  });

  test('새 외부 에이전트 origin은 기존 Claude fallback을 기록한다', () => {
    const env: NodeJS.ProcessEnv = {
      AI_AGENT: 'claude-code',
      CLAUDE_CODE_SESSION_ID: 'claude-session',
    };

    expect(establishExecutionOrigin(env)).toBe('external-agent');
    expect(env.ELANOUS_ORIGIN_SESSION).toBe('claude-session');
  });

  test('명시 세션은 새 외부 에이전트 origin의 Claude fallback보다 우선한다', () => {
    const env: NodeJS.ProcessEnv = {
      AI_AGENT: 'claude-code',
      CLAUDE_CODE_SESSION_ID: 'claude-session',
    };

    establishExecutionOrigin(env, undefined, 'explicit-session');

    expect(env.ELANOUS_ORIGIN_SESSION).toBe('explicit-session');
  });
});

describe('identityEnv — 전파 allowlist (순수)', () => {
  test('정체성 마커는 전파된다', () => {
    const out = identityEnv({
      ELANOUS_STATE_DIR: '/repo/.elanous-test',
      ELANOUS_NEST_DEPTH: '2',
      ELANOUS_HARNESS_SPACE: 'self-implement',
      ELANOUS_HARNESS_SPACE_ID: 'pty-ssot',
      ELANOUS_RUN_ID: 'run_abc',
      ELANOUS_SESSION_ID: 'elanous-session-9',
    });
    expect(out).toEqual({
      ELANOUS_STATE_DIR: '/repo/.elanous-test',
      ELANOUS_NEST_DEPTH: '2',
      ELANOUS_HARNESS_SPACE: 'self-implement',
      ELANOUS_HARNESS_SPACE_ID: 'pty-ssot',
      ELANOUS_RUN_ID: 'run_abc',
      ELANOUS_SESSION_ID: 'elanous-session-9',
    });
  });

  test('shadow-root env 는 차단된다 (뿌리 우회 확산 방지)', () => {
    const out = identityEnv({
      ELANOUS_STATE_DIR: '/repo/.elanous-test',
      ELANOUS_HOME: '/elsewhere',
      ELANOUS_DIR: '/elsewhere',
      ELANOUS_NEXUS_DIR: '/elsewhere',
      ELANOUS_TASKS_DIR: '/elsewhere',
      ELANOUS_TASKS_DB: '/elsewhere/tasks.db',
    });
    expect(Object.keys(out)).toEqual(['ELANOUS_STATE_DIR']);
  });

  test('자격증명은 차단된다 (config 경유가 정본)', () => {
    const out = identityEnv({
      ELANOUS_STATE_DIR: '/repo/.elanous-test',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      OPENAI_API_KEY: 'sk-proj-xxx',
      ELANOUS_TELEGRAM_BOT_TOKEN: 'tok',
    });
    expect(Object.keys(out)).toEqual(['ELANOUS_STATE_DIR']);
  });

  test('PATH·셸 계보는 차단된다 (★F3 회귀 방지)', () => {
    const out = identityEnv({ PATH: '/shallow', HOME: '/x', SHELL: '/bin/sh' });
    expect(out).toEqual({});
  });

  test('행위 스위치는 전파하지 않는다 (동작 무변경 — 정체성이 아님)', () => {
    const out = identityEnv({
      ELANOUS_HARNESS_ROLE: 'executor',
      ELANOUS_HARNESS_BOUNDARY: '/repo/.worktrees/x',
      ELANOUS_HARNESS_DETACHED: '1',
    });
    expect(out).toEqual({});
  });

  test('빈 문자열·undefined 는 키 자체를 만들지 않는다 (captured 값 삭제 방지)', () => {
    const out = identityEnv({ ELANOUS_STATE_DIR: '', ELANOUS_RUN_ID: undefined });
    expect(out).toEqual({});
  });

  test('blockedIdentityEnvCount 는 shadow-root 만 센다', () => {
    expect(blockedIdentityEnvCount({ ELANOUS_HOME: '/a', ELANOUS_TASKS_DB: '/b' })).toBe(2);
    expect(blockedIdentityEnvCount({ ELANOUS_STATE_DIR: '/a' })).toBe(0);
  });
});

describe('래칫 — 합성하는 키는 «전파 allowlist 에도» 있어야 한다', () => {
  // ⛔⭐⭐⭐ 2026-08-19 실물: `ELANOUS_STATE_DIR_SOURCE` 를 «합성»만 하고 allowlist 에 안 넣어서
  //   딱지가 ***한 홉만*** 살았다 ⇒ 손자가 「파생」을 「명시」로 읽었다 ⇒ 429 가 «네 번».
  //   ⇒ 사람이 매번 「둘 다 했나」를 기억하는 대신 ***이 테스트가 잡는다***.
  test('합성 키가 전부 IDENTITY_ENV_KEYS 안에 있다', () => {
    const allowlisted = new Set<string>(identityEnvKeys());
    const missing = SYNTHESIZED_IDENTITY_ENV_KEYS.filter((k) => !allowlisted.has(k));
    expect(missing).toEqual([]);
  });

  test('⛔ 래칫 자신이 «비어 있지» 않다 — 목록이 비면 위 단언은 «항상» 통과한다', () => {
    expect(SYNTHESIZED_IDENTITY_ENV_KEYS.length).toBeGreaterThan(0);
  });
});

describe('buildPtyEnv — 합성 순서 (캡처 고정 · 위양성 차단)', () => {
  test('전제조건: 캡처가 고정돼 실제 캡처로 인식된다', () => {
    setCapturedEnvForTesting(CAPTURED);
    // ★ 이 단언이 없으면 폴백 상태에서 아래 테스트들이 "잘못된 이유로" 통과한다.
    expect(capturedEnvAvailable()).toBe(true);
  });

  // ⭐⭐ 실제 재발 경로를 그대로 고정한다 (무인 리뷰 should-fix · 2026-07-28).
  //
  //   라이브 사고의 배선은 이랬다:
  //     nexus run --test → runPwaTest() → setTestStateRoot(dir)   ← **모듈 상태만**
  //     process.env.ELANOUS_STATE_DIR                                ← **비어 있다**
  //     ⇒ identityEnv() 가 빈 객체 → PTY 자식이 격리를 하나도 못 받고 prod 로 떴다.
  //
  //   ⛔ 해석 결과(kind:'test')를 **주입해서** 통과시키면 이 배선을 한 번도 안 탄다 —
  //      그게 #5814 가 뮤테이션 테스트까지 통과한 채 죽은 가드를 머지한 이유다.
  //      그래서 여기서는 **setTestStateRoot 만 세우고** 함수가 스스로 해석하게 둔다.
  test('★재발 경로 — setTestStateRoot 만 세워도 격리 뿌리가 자식에게 간다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const saved = getTestStateRoot();
    const root = '/repo/.elanous-test';
    try {
      setTestStateRoot(root);
      // env 에는 아무것도 없다 — 실제 데몬이 그 상태였다.
      const env = buildPtyEnv({}, {});
      expect(env.ELANOUS_STATE_DIR).toBe(root);
      // ⛔⭐⭐⭐ **그리고 「이 값이 «어디서 왔나»」도 같이 가야 한다**(`OBS-T114` · 2026-08-19).
      //   🚨 자식이 받는 것이 문자열 «하나»뿐이면 「사람이 명시로 격리했다」와
      //     「트리에서 «파생»돼 여기서 채워 넣었다」를 ***구분할 수 없다.***
      //   ⇒ 실물 사고: 쿼터 신호가 파생값을 「명시 격리」로 읽고 자기 우주를 봐서 전 계정 `unknown`,
      //     회전이 ***이미 100% 인 계정을 골라*** 429 로 죽었다(같은 골이 «세 번»).
      expect(env.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
    } finally {
      setTestStateRoot(saved ?? null);
    }
  });

  // ⛔⭐⭐⭐ **딱지가 «한 홉»만 살면 손자에서 「파생」이 「명시」로 둔갑한다**(2026-08-19 실측 · 429 4차).
  //   ⓐ allowlist 에 들어 있어야 «옮겨지고», ⓑ 값이 파생 뿌리면 «다시 붙여» 자기치유한다.
  test('★전파 — 딱지가 두 번째 홉에서도 살아남는다(allowlist ⊕ 자기치유)', () => {
    setCapturedEnvForTesting(CAPTURED);
    const saved = getTestStateRoot();
    const root = '/repo/.elanous-test';
    try {
      setTestStateRoot(root);
      // 1홉: 아무것도 없는 부모 → 뿌리 ⊕ 딱지가 «합성»된다
      const hop1 = buildPtyEnv({}, {});
      expect(hop1.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
      // 2홉: 그 env 를 «가진» 자식이 손자를 띄운다 — 딱지가 «그대로» 가야 한다
      const hop2 = buildPtyEnv({}, hop1 as NodeJS.ProcessEnv);
      expect(hop2.ELANOUS_STATE_DIR).toBe(root);
      expect(hop2.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
      // ⭐ 자기치유: 딱지가 «떨어진» env 로도 다시 붙는다(어느 홉에서 잃어도 복구된다)
      const stripped = { ...hop1 } as Record<string, string | undefined>;
      delete stripped.ELANOUS_STATE_DIR_SOURCE;
      expect(buildPtyEnv({}, stripped as NodeJS.ProcessEnv).ELANOUS_STATE_DIR_SOURCE).toBe('derived');

      // ⛔⭐⭐ **두 기전을 «가르는» 표본** — 자식 cwd 가 달라 파생 뿌리가 «다른» 경우.
      //   그러면 자기치유는 «안 돈다»(값이 이 우주의 뿌리와 다르므로) ⇒ ***오직 allowlist 만*** 딱지를 옮긴다.
      //   ⛔ 이 단언이 없으면 allowlist 를 «빼도» 자기치유가 가려서 테스트가 통과한다(실측: 그랬다).
      const otherRoot = '/another-tree/.elanous-test';
      const carried = buildPtyEnv({}, { ELANOUS_STATE_DIR: otherRoot, ELANOUS_STATE_DIR_SOURCE: 'derived' } as NodeJS.ProcessEnv);
      expect(carried.ELANOUS_STATE_DIR).toBe(otherRoot);
      expect(carried.ELANOUS_STATE_DIR_SOURCE).toBe('derived');
    } finally {
      setTestStateRoot(saved ?? null);
    }
  });

  // ⛔⭐ 대조 — 호출자가 «직접» 준 값에는 「파생」 딱지를 붙이지 않는다.
  test('★출처 대조 — 호출자가 명시한 뿌리에는 derived 딱지가 «안» 붙는다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv({ ELANOUS_STATE_DIR: '/repo/explicit-root' }, { ELANOUS_STATE_DIR: '/repo/explicit-root' });
    expect(env.ELANOUS_STATE_DIR).toBe('/repo/explicit-root');
    expect(env.ELANOUS_STATE_DIR_SOURCE).toBeUndefined();
  });

  // ⚠️ 대조는 "폴백이 임의값이 아니라 **리졸버가 정한 뿌리**"임을 고정한다.
  //    ⛔ "격리가 아니면 undefined" 로 쓰면 **이 테스트 자체가 틀린다** — 레포 트리에서
  //       돌리면 3층(비-리더 트리 파생)이 이미 test 라 폴백이 정상이다(실측: 그렇게 짰다가 실패).
  //       진짜 prod 대조는 리더 트리가 있어야 하고, 그건 테스트 환경이 못 만든다.
  test('★재발 경로 대조 — 폴백 값은 리졸버가 정한 뿌리와 같다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const saved = getTestStateRoot();
    try {
      setTestStateRoot(null);
      const resolved = resolveCurrentInstance();
      const env = buildPtyEnv({}, {});
      if (resolved.kind === 'test') expect(env.ELANOUS_STATE_DIR).toBe(resolved.root);
      else expect(env.ELANOUS_STATE_DIR).toBeUndefined();
    } finally {
      setTestStateRoot(saved ?? null);
    }
  });

  test('★F3 회귀 가드 — captured 의 PATH 가 보존된다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv({}, { PATH: '/shallow/parent/path', ELANOUS_STATE_DIR: '/repo/.elanous-test' });
    expect(env.PATH).toBe(CAPTURED.PATH);
  });

  test('본건 — 프로세스 정체성이 captured 위에 얹힌다 (PTY 격리 소실 봉합)', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv({}, { ELANOUS_STATE_DIR: '/repo/.elanous-test', ELANOUS_NEST_DEPTH: '3' });
    expect(env.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test');
    expect(env.ELANOUS_NEST_DEPTH).toBe('3');
  });

  test('origin 네 키는 고정된 로그인 셸 캡처 위에 실제 PTY 자식 env로 합성된다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv({}, {
      ELANOUS_ORIGIN_ROOT: 'external-agent',
      ELANOUS_ORIGIN_AGENT: 'codex',
      ELANOUS_ORIGIN_SESSION: 'agent-session',
      ELANOUS_CONTROLLER: 'run-parent',
    });
    expect(env).toMatchObject({
      ELANOUS_ORIGIN_ROOT: 'external-agent',
      ELANOUS_ORIGIN_AGENT: 'codex',
      ELANOUS_ORIGIN_SESSION: 'agent-session',
      ELANOUS_CONTROLLER: 'run-parent',
    });
  });

  test('셸 계보(자격증명 포함)는 captured 것이 그대로 살아남는다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv({}, { ELANOUS_STATE_DIR: '/repo/.elanous-test' });
    expect(env.ANTHROPIC_API_KEY).toBe(CAPTURED.ANTHROPIC_API_KEY);
    expect(env.HOME).toBe(CAPTURED.HOME);
  });

  test('callerEnv 가 최종 승자 (기존 호출자 동작 무변경)', () => {
    setCapturedEnvForTesting(CAPTURED);
    const env = buildPtyEnv(
      { TERM: 'xterm-ghostty', ELANOUS_STATE_DIR: '/caller/wins' },
      { ELANOUS_STATE_DIR: '/repo/.elanous-test' },
    );
    expect(env.TERM).toBe('xterm-ghostty');
    expect(env.ELANOUS_STATE_DIR).toBe('/caller/wins');
  });

  test('spawn 시점 평가 — 캡처 후에 바뀐 정체성이 반영된다 (얼어붙지 않는다)', () => {
    setCapturedEnvForTesting(CAPTURED);
    const first = buildPtyEnv({}, { ELANOUS_RUN_ID: 'run_1' });
    const second = buildPtyEnv({}, { ELANOUS_RUN_ID: 'run_2' });
    expect(first.ELANOUS_RUN_ID).toBe('run_1');
    expect(second.ELANOUS_RUN_ID).toBe('run_2');
  });

  test('해석된 격리 플래그를 폴백해 process.env 에 스탬프가 없어도 PTY 자식에 정확한 뿌리와 fallback 출처를 싣는다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const previous = process.env.ELANOUS_STATE_DIR;
    const captured = captureStateDirSource();
    delete process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir('/repo/.elanous-test-from-flag');
    try {
      const env = buildPtyEnv({}, {});
      expect(env.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test-from-flag');
      expect(captured.source()).toBe('fallback');
    } finally {
      captured.dispose();
      resetElanousConfigDir();
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });

  test('process.env 정체성은 해석된 격리 뿌리보다 우선하고 env 출처로 기록된다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const previous = process.env.ELANOUS_STATE_DIR;
    const captured = captureStateDirSource();
    process.env.ELANOUS_STATE_DIR = '/parent/stamp-wins';
    setElanousConfigDir('/repo/.elanous-test-from-flag');
    try {
      const env = buildPtyEnv({}, process.env);
      expect(env.ELANOUS_STATE_DIR).toBe('/parent/stamp-wins');
      expect(captured.source()).toBe('env');
    } finally {
      captured.dispose();
      resetElanousConfigDir();
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });

  test('callerEnv 가 폴백을 덮으면 정확한 caller 값과 env 출처를 기록한다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const previous = process.env.ELANOUS_STATE_DIR;
    const captured = captureStateDirSource();
    delete process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir('/repo/.elanous-test-from-flag');
    try {
      const env = buildPtyEnv({ ELANOUS_STATE_DIR: '/caller/wins' }, {});
      expect(env.ELANOUS_STATE_DIR).toBe('/caller/wins');
      expect(captured.source()).toBe('env');
    } finally {
      captured.dispose();
      resetElanousConfigDir();
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });

  test('해석된 운영 인스턴스는 뿌리를 강제하지 않아 captured 그대로다', () => {
    setCapturedEnvForTesting(CAPTURED);
    const previousRoot = getTestStateRoot();
    setTestStateRoot(null);
    setElanousConfigDir(prodInstanceRoot());
    try {
      const env = buildPtyEnv({}, {});
      expect(env).toEqual(CAPTURED);
    } finally {
      resetElanousConfigDir();
      if (previousRoot) setTestStateRoot(previousRoot);
    }
  });
});

// ── 배선 회귀 (must-fix · self review #5472) ──────────────────────────────
//
// 위 테스트들은 buildPtyEnv() **단위 합성**만 본다. 그래서 registry 의 `buildPtyEnv` 호출을
// 되돌려 `getCapturedEnv()` 로 되돌려놔도 전부 통과한다 = 본 수정이 통째로 사라져도 green.
// 실제 spawn 직전 env 를 검증해 그 구멍을 막는다.
describe('배선 — registry resolveSpawnShape 가 실제로 정체성을 싣는다', () => {
  test('spawn 직전 env 에 정체성이 실려 있다 (배선 제거 시 실패)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    expect(capturedEnvAvailable()).toBe(true);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    try {
      const { resolveSpawnShape } = await import('../src/pty-shell/registry.js');
      const shape = resolveSpawnShape({ cmd: '/bin/zsh', workdir: '/tmp' } as never);
      expect(shape.env.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test');
      expect(shape.env.PATH).toBe(CAPTURED.PATH);        // ★F3 회귀 가드(배선 레벨)
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });

  test('caller overlay 가 정체성보다 우선한다 (배선 레벨)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    try {
      const { resolveSpawnShape } = await import('../src/pty-shell/registry.js');
      const shape = resolveSpawnShape({
        cmd: '/bin/zsh', workdir: '/tmp', env: { ELANOUS_STATE_DIR: '/caller/wins' },
      } as never);
      expect(shape.env.ELANOUS_STATE_DIR).toBe('/caller/wins');
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });
});

// ── 배선 회귀 · 나머지 두 지점 (self review #5472 round 3) ──────────────────
//
// registry 는 위에서 덮었으나 PreviewTerminal(직접 spawn)·spawnCodingAgent 는 배선을 되돌려도
// 통과했다. 두 곳 모두 "실제 spawn 에 넘어가는 env"를 주입 seam 으로 가로채 단언한다.
describe('배선 — PreviewTerminal 직접 spawn 이 정체성을 싣는다', () => {
  test('명시 env 없는 기본 경로 (buildPtyEnv 우회 시 실패)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    let seen: Record<string, string> | undefined;
    try {
      const { PreviewTerminal } = await import('../src/preview/terminal.js');
      const pt = new PreviewTerminal(
        { cols: 80, rows: 24, cwd: '/tmp', shell: '/bin/zsh' } as never,
        ((_f: string, _a: string[], o: { env: Record<string, string> }) => {
          seen = o.env;
          return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 1 };
        }) as never,
      );
      // start() 는 fake PTY 라 master fd 해석에서 던진다 — env 합성은 그 前에 끝나므로
      // 여기서 검증하려는 계약(“spawn 에 넘어간 env”)에는 영향이 없다.
      try { pt.start(); } catch { /* fake pty — 이후 단계는 이 테스트 관심 밖 */ }
      expect(seen?.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test');
      expect(seen?.PATH).toBe(CAPTURED.PATH);   // ★F3 회귀 가드(배선 레벨)
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });

  test('명시 env 경로도 정체성+captured 를 유지한다 (merge 통일)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    let seen: Record<string, string> | undefined;
    try {
      const { PreviewTerminal } = await import('../src/preview/terminal.js');
      const pt = new PreviewTerminal(
        { cols: 80, rows: 24, cwd: '/tmp', shell: '/bin/zsh', env: { ELANOUS_REMOTE_HOST: 'box' } } as never,
        ((_f: string, _a: string[], o: { env: Record<string, string> }) => {
          seen = o.env;
          return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 1 };
        }) as never,
      );
      try { pt.start(); } catch { /* fake pty — 위와 동일 */ }
      expect(seen?.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test');
      expect(seen?.ELANOUS_REMOTE_HOST).toBe('box');
      // ★의미론 정정 — 종전 '통째 대체'에서는 PATH 조차 없었다(잠복 결함). 이제 merge.
      expect(seen?.PATH).toBe(CAPTURED.PATH);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });
});

describe('배선 — spawnCodingAgent 가 정체성을 싣는다', () => {
  test('registry.spawn 에 넘어가는 env 에 정체성이 있다 (buildPtyEnv 우회 시 실패)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    let seen: Record<string, string> | undefined;
    try {
      const { spawnCodingAgent } = await import('../src/terminal/coding-agent.js');
      spawnCodingAgent(
        { brand: 'claude-code', cwd: '/tmp' } as never,
        {
          registry: {
            spawn: (spec: { env?: Record<string, string> }) => {
              seen = spec.env;
              return { id: 't1', title: 't', state: 'running' };
            },
          },
        } as never,
      );
      expect(seen?.ELANOUS_STATE_DIR).toBe('/repo/.elanous-test');
      expect(seen?.PATH).toBe(CAPTURED.PATH);   // ★F3 회귀 가드(배선 레벨)
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });
});

// ── 배선 회귀 · webterm (self review #5472 round 4) ─────────────────────────
//
// webterm 은 자기가 합성하지 않고 registry(startPty)에 위임한다(이중 합성·관측 중복 제거).
// 그래서 "registry 로 넘어가는 env 가 overlay 여야 한다"가 계약이다 — 전체 env dict 를 넘기면
// registry 에서 caller overlay 로 취급돼 **정체성을 덮어 지운다**. 그 계약을 고정한다.
describe('배선 — webterm 은 registry 에 overlay 만 위임한다', () => {
  test('startPty 에 넘기는 env 가 overlay 다 (전체 env 를 넘기면 정체성이 덮인다)', async () => {
    setCapturedEnvForTesting(CAPTURED);
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/repo/.elanous-test';
    let seen: Record<string, string> | undefined;
    try {
      const { createRegistryBackend } = await import('../src/nexus/webterm/pty.js');
      createRegistryBackend({ shell: '/bin/zsh', cwd: '/tmp' }, {
        startPty: ((o: { env?: Record<string, string> }) => {
          seen = o.env;
          return { id: 'p1', write() {}, resize() {}, kill() {} };
        }) as never,
        onPtyEvent: (() => () => {}) as never,
      });
      // overlay 만 — captured 스냅샷 키(PATH/HOME)가 섞여 있으면 registry 에서 정체성을 덮는다.
      expect(seen?.PATH).toBeUndefined();
      expect(seen?.HOME).toBeUndefined();
      expect(seen?.ELANOUS_STATE_DIR).toBeUndefined();
      expect(seen?.TERM).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });
});

// ── 정적 ratchet (self review #5472 round 4) ────────────────────────────────
//
// 런타임 관측(instance.identity pty-env-propagated)은 "무엇이 전파됐나"를 잡지만, **새 spawn
// 지점이 헬퍼를 아예 안 거치는 것**은 못 잡는다. 지형 조사에서 "명시 전파" 손패치가 5회
// 재발명된 전례가 있어(설계 §1g) 정적 게이트가 필요하다.
// getCapturedEnv() 직접 호출은 아래 allowlist 밖에서 금지 — 새 PTY 경로는 buildPtyEnv 를 쓸 것.
describe('ratchet — getCapturedEnv() 직접 호출은 SSOT 밖에서 금지', () => {
  const ALLOWED = new Set([
    'src/shell-env-bootstrap.ts',   // 정의부
    'src/shell-env-bootstrap-warm.test.ts', // 정의부 시험 — 예열(warmCapturedEnv)이 채운 캐시를 정의부 함수로 읽는다(#22671)
    'src/agent/identity-env.ts',    // SSOT 합성자 — 유일한 정당 소비자
    'src/preview/terminal.ts',      // 기본값(CLAUDE_CODE_NO_FLICKER) 조회 전용 · 합성 아님
  ]);

  test('허용 목록 밖에서 getCapturedEnv 를 직접 쓰지 않는다', async () => {
    const { execFileSync } = await import('node:child_process');
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-l', 'getCapturedEnv', '--', 'src/'], { encoding: 'utf8' });
    } catch { /* 매치 0 → git grep exit 1 */ }
    const offenders = out.split('\n').map((l) => l.trim()).filter(Boolean).filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});

// 09-26 실측: agent-mission 이 호출자 env 에서 OPENAI_API_KEY 를 지웠는데 로그인 셸 캡처본에서 되살아나
// codex 자식이 구독 대신 API 키로 붙었다(401) — 과금 경로 스크럽이 조용히 뚫린 결함.
describe('buildPtyEnv unset — 지운 키는 캡처본에서도 지운다', () => {
  test('캡처본에만 있는 키가 unset 이면 결과에 없다 · 목록에 없는 캡처 키는 그대로', () => {
    setCapturedEnvForTesting({ ...CAPTURED, OPENAI_API_KEY: 'sk-captured', OTHER: 'keep' });
    expect(capturedEnvAvailable()).toBe(true);
    const env = buildPtyEnv({ TERM: 'xterm' }, {}, { unset: ['OPENAI_API_KEY'] });
    expect(Object.hasOwn(env, 'OPENAI_API_KEY')).toBe(false);
    expect(env.OTHER).toBe('keep');
    // 대조군: unset 없이는 되살아난다(이 시험이 무는 이유)
    expect(buildPtyEnv({ TERM: 'xterm' }, {}).OPENAI_API_KEY).toBe('sk-captured');
  });

  test('호출자가 같은 키를 «명시»했으면 호출자 값이 이긴다', () => {
    setCapturedEnvForTesting({ ...CAPTURED, OPENAI_API_KEY: 'sk-captured' });
    expect(buildPtyEnv({ OPENAI_API_KEY: 'sk-explicit' }, {}, { unset: ['OPENAI_API_KEY'] }).OPENAI_API_KEY).toBe('sk-explicit');
  });
});
