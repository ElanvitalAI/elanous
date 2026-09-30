// Instance root coherence 가드 테스트 (Phase D2-핵심).

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkInstanceRootCoherence, assertInstanceRootCoherence, detectShadowRootEnvs, checkProdSpawnFootgun, warnProdSpawnFootgun } from './instance-root-coherence.js';
import { setElanousConfigDir, resetElanousConfigDir } from './elanous-config-dir.js';
import { resetEffectiveInstanceRoot, resolveInstance, setTreeDerivedTestForTesting, treeDerivedTestEnabled, treeDerivedRootFor } from './instance/resolve.js';
import { debug } from './debug/log.js';

const savedStateDir = process.env.ELANOUS_STATE_DIR;
const savedNestDepth = process.env.ELANOUS_NEST_DEPTH;
const savedShadow: Record<string, string | undefined> = {};
for (const e of ['ELANOUS_HOME', 'ELANOUS_DIR', 'ELANOUS_NEXUS_DIR', 'ELANOUS_TASKS_DIR', 'ELANOUS_TASKS_DB']) savedShadow[e] = process.env[e];

beforeEach(() => {
  resetEffectiveInstanceRoot();
});

afterEach(() => {
  setTreeDerivedTestForTesting(undefined);
  resetEffectiveInstanceRoot();
  resetElanousConfigDir();
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
  if (savedNestDepth === undefined) delete process.env.ELANOUS_NEST_DEPTH;
  else process.env.ELANOUS_NEST_DEPTH = savedNestDepth;
  for (const [e, v] of Object.entries(savedShadow)) {
    if (v === undefined) delete process.env[e];
    else process.env[e] = v;
  }
});

describe('tree-derived source universe', () => {
  test('legacy switch cannot disable source-tree isolation', () => {
    setTreeDerivedTestForTesting(false);
    expect(treeDerivedTestEnabled()).toBe(true);
    expect(treeDerivedRootFor(process.cwd())).toBe(join(process.cwd(), '.elanous-test'));
    expect(resolveInstance({ installedCopy: false })).toMatchObject({
      kind: 'test', root: join(process.cwd(), '.elanous-test'), layer: 'tree-derived',
    });
    expect(resolveInstance({ installedCopy: false, treeTestRoot: null })).toMatchObject({
      kind: 'test', root: join(process.cwd(), '.elanous-test'), layer: 'default',
    });
  });
});

describe('checkInstanceRootCoherence', () => {
  test('소스 트리 기본(양축 미설정) → 둘 다 파생 테스트 루트 → coherent', () => {
    resetElanousConfigDir();
    delete process.env.ELANOUS_STATE_DIR;
    const c = checkInstanceRootCoherence();
    const treeRoot = treeDerivedRootFor(process.cwd());
    if (treeRoot === null) throw new Error('This test requires a source tree');
    expect(c.configDir).toBe(treeRoot);
    expect(c.stateDir).toBe(treeRoot);
    expect(c.coherent).toBe(true);
  });

  test('--test 동형(양축 같은 뿌리) → coherent', () => {
    setElanousConfigDir('/tmp/repo/.elanous-test');
    process.env.ELANOUS_STATE_DIR = '/tmp/repo/.elanous-test';
    expect(checkInstanceRootCoherence().coherent).toBe(true);
  });

  // ⭐ **P3(#5479) 이 이 결함을 없앴다** — 종전 두 테스트는 *"한 축만 설정 → 갈라짐(2026-07-19 누출류)"*
  //    을 **기대값으로 박아** 두었는데, P3 이후 두 축이 `effectiveInstanceRoot` 한 함수로 수렴해
  //    **다른 축이 따라온다.** 그래서 그 단언들은 *고쳐진 결함이 그대로 있기를* 요구하고 있었다.
  //    ⇒ 새 불변식을 단언한다. 갈라짐 자체의 판정 로직은 아래 `assertInstanceRootCoherence` 가 주입으로 덮는다.
  test('⭐ ELANOUS_STATE_DIR 만 설정 → config-dir 이 **따라온다**(P3 이후 · 종전엔 divergent 를 기대했다)', () => {
    resetElanousConfigDir();
    process.env.ELANOUS_STATE_DIR = '/tmp/repo/.elanous-test';
    const c = checkInstanceRootCoherence();
    expect(c.stateDir).toBe('/tmp/repo/.elanous-test');
    expect(c.configDir).toBe('/tmp/repo/.elanous-test');   // ← 따라옴
    expect(c.coherent).toBe(true);
  });

  test('⭐ --config-dir 만 설정 → state-dir 이 **따라온다**(1층이 공통 뿌리)', () => {
    setElanousConfigDir('/tmp/repo/.elanous-test');
    delete process.env.ELANOUS_STATE_DIR;
    const c = checkInstanceRootCoherence();
    expect(c.configDir).toBe('/tmp/repo/.elanous-test');
    expect(c.stateDir).toBe('/tmp/repo/.elanous-test');
    expect(c.coherent).toBe(true);
  });
});

describe('assertInstanceRootCoherence', () => {
  test('coherent 면 조용히 통과(throw 안 함)', () => {
    resetElanousConfigDir();
    delete process.env.ELANOUS_STATE_DIR;
    expect(() => assertInstanceRootCoherence({ throwOnDivergence: true })).not.toThrow();
  });

  // ⚠️ divergence 는 P3 이후 **공개 API 로 재현 불가**(두 축이 한 함수로 수렴). 가드 로직을 지우지
  //    않으려면 축을 주입해야 한다 — 그래서 `readers` 를 쓴다. 프로덕션 경로는 인자 없이 부른다.
  const divergent = { configDir: () => '/tmp/a', stateDir: () => '/tmp/b' };

  test('divergent + warn-first(기본) → throw 안 함', () => {
    expect(() => assertInstanceRootCoherence({ readers: divergent })).not.toThrow();
  });

  test('divergent + throwOnDivergence → throw', () => {
    expect(() => assertInstanceRootCoherence({ throwOnDivergence: true, readers: divergent })).toThrow(/divergence/);
  });

  test('⭐ 실제 축으로는 갈라지지 않는다 — 한 축만 설정해도 따라온다(P3 불변식)', () => {
    setElanousConfigDir('/tmp/repo/.elanous-test');
    delete process.env.ELANOUS_STATE_DIR;
    expect(() => assertInstanceRootCoherence({ throwOnDivergence: true })).not.toThrow();
  });
});

describe('checkProdSpawnFootgun (backlog #1)', () => {
  // footgun = nested(depth>0) AND interactive(TTY) AND resolver-backed prod.
  // interactive 는 주입해 TTY 비의존 결정 테스트. 진리표 전 조합 확인.
  test('ELANOUS_STATE_DIR 비어도 3층 파생 격리 자식이면 prod 아님 (env predicate 회귀 방지)', () => {
    process.env.ELANOUS_NEST_DEPTH = '1';
    delete process.env.ELANOUS_STATE_DIR;
    setTreeDerivedTestForTesting(true);
    resetEffectiveInstanceRoot();
    const f = checkProdSpawnFootgun({ interactive: true });
    expect(f.prod).toBe(false);
    expect(f.footgun).toBe(false);
  });

  test('ELANOUS_STATE_DIR 가 운영 루트를 명시하면 prod (참 양성 유지)', () => {
    process.env.ELANOUS_NEST_DEPTH = '1';
    process.env.ELANOUS_STATE_DIR = join(homedir(), '.elanous');
    expect(checkProdSpawnFootgun({ interactive: true })).toEqual({ nested: true, interactive: true, prod: true, footgun: true });
  });

  test('nested + interactive + prod → footgun (유일한 참 조합)', () => {
    process.env.ELANOUS_NEST_DEPTH = '1';
    process.env.ELANOUS_STATE_DIR = join(homedir(), '.elanous');
    const f = checkProdSpawnFootgun({ interactive: true });
    expect(f).toEqual({ nested: true, interactive: true, prod: true, footgun: true });
  });

  test('nested + interactive 이지만 격리됨(ELANOUS_STATE_DIR 설정) → 침묵', () => {
    process.env.ELANOUS_NEST_DEPTH = '1';
    process.env.ELANOUS_STATE_DIR = '/tmp/repo/.elanous-test';
    const f = checkProdSpawnFootgun({ interactive: true });
    expect(f.prod).toBe(false);
    expect(f.footgun).toBe(false);
  });

  test('nested 아님(top-level) + interactive + prod → 침묵 (self-dev 직접실행 아님)', () => {
    delete process.env.ELANOUS_NEST_DEPTH; // depth 0
    delete process.env.ELANOUS_STATE_DIR;
    const f = checkProdSpawnFootgun({ interactive: true });
    expect(f.nested).toBe(false);
    expect(f.footgun).toBe(false);
  });

  test('nested + prod 이지만 non-interactive(데몬/harness 자식) → 침묵', () => {
    process.env.ELANOUS_NEST_DEPTH = '2';
    delete process.env.ELANOUS_STATE_DIR;
    const f = checkProdSpawnFootgun({ interactive: false });
    expect(f.interactive).toBe(false);
    expect(f.footgun).toBe(false);
  });

  test('depth 0 은 nested 아님(경계) — depth 1 부터 nested', () => {
    process.env.ELANOUS_NEST_DEPTH = '0';
    expect(checkProdSpawnFootgun({ interactive: true }).nested).toBe(false);
    process.env.ELANOUS_NEST_DEPTH = '1';
    expect(checkProdSpawnFootgun({ interactive: true }).nested).toBe(true);
  });
});

describe('detectShadowRootEnvs (Phase F)', () => {
  test('shadow-root env 미설정 → 빈 목록', () => {
    for (const e of ['ELANOUS_HOME', 'ELANOUS_DIR', 'ELANOUS_NEXUS_DIR', 'ELANOUS_TASKS_DIR', 'ELANOUS_TASKS_DB']) delete process.env[e];
    expect(detectShadowRootEnvs()).toEqual([]);
  });

  test('ELANOUS_TASKS_DB 설정(config-dir 우회 footgun) → 감지', () => {
    for (const e of ['ELANOUS_HOME', 'ELANOUS_DIR', 'ELANOUS_NEXUS_DIR', 'ELANOUS_TASKS_DIR', 'ELANOUS_TASKS_DB']) delete process.env[e];
    process.env.ELANOUS_TASKS_DB = '/tmp/rogue/tasks.db';
    expect(detectShadowRootEnvs()).toEqual([{ name: 'ELANOUS_TASKS_DB', value: '/tmp/rogue/tasks.db' }]);
  });

  test('shadow env 설정돼도 assert 는 throw 안 함(warn-first)', () => {
    resetElanousConfigDir();
    delete process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_HOME = '/tmp/shadow';
    expect(() => assertInstanceRootCoherence()).not.toThrow();
  });
});

describe('warnProdSpawnFootgun — emit 게이팅(P3·2026-07-26)', () => {
  // 실제 debug.registerSink 로 debug.log record 를 캡처(mock.module 없이·logs.db StoreSink 와 동일 경로) +
  //   process.stderr.write 원본 메서드 저장·복원. emit 별로 log/stderr 두 채널이 옳게 게이팅되는지 직접 검증.
  function withCapture(fn: () => void): { logs: { category: string; event: string; data?: Record<string, unknown> }[]; stderr: string } {
    const logs: { category: string; event: string; data?: Record<string, unknown> }[] = [];
    const off = debug.registerSink({ name: 'p3-test-capture', emit: (rec) => {
      logs.push({ category: rec.category, event: rec.event, ...(rec.data && typeof rec.data === 'object' ? { data: rec.data as Record<string, unknown> } : {}) });
    } });
    const origWrite = process.stderr.write;   // 원본 메서드 저장(bound wrapper 아님 — 전역 오염 방지)
    let stderr = '';
    process.stderr.write = ((s: string | Uint8Array) => { stderr += String(s); return true; }) as typeof process.stderr.write;
    try { fn(); } finally { process.stderr.write = origWrite; off(); }
    return { logs, stderr };
  }
  const footgunEnv = (): void => { process.env.ELANOUS_NEST_DEPTH = '1'; process.env.ELANOUS_STATE_DIR = join(homedir(), '.elanous'); };
  const hasFootgunLog = (logs: { category: string; event: string }[]): boolean =>
    logs.some((r) => r.category === 'instance.identity' && r.event === 'prod-spawn-footgun');

  test("emit:'log' → debug.log 발생(logs.db 도달 관문)·stderr 억제", () => {
    footgunEnv();
    const { logs, stderr } = withCapture(() => { warnProdSpawnFootgun({ interactive: true, emit: 'log' }); });
    expect(hasFootgunLog(logs)).toBe(true);   // sink(=logs.db StoreSink 동형)가 record 를 받음 = 도달 실증
    const record = logs.find((r) => r.category === 'instance.identity' && r.event === 'prod-spawn-footgun');
    expect(record?.data).toMatchObject({ kind: 'prod', root: join(homedir(), '.elanous'), layer: 'parent-stamp', why: '부모 스탬프 ELANOUS_STATE_DIR' });
    expect(typeof record?.data?.root).toBe('string');
    expect(stderr).toBe('');
  });

  test("emit:'stderr' → stderr 발생·debug.log 억제", () => {
    footgunEnv();
    const { logs, stderr } = withCapture(() => {
      const f = warnProdSpawnFootgun({ interactive: true, emit: 'stderr' });
      expect(f.footgun).toBe(true);
    });
    expect(stderr).toContain('[instance]');
    expect(hasFootgunLog(logs)).toBe(false);
  });

  test("emit 기본('both') → debug.log·stderr 양쪽 발생(무회귀)", () => {
    footgunEnv();
    const { logs, stderr } = withCapture(() => { warnProdSpawnFootgun({ interactive: true }); });
    expect(hasFootgunLog(logs)).toBe(true);
    expect(stderr).toContain('[instance]');
  });

  test('자식 depth 경고는 --test 처방 대신 현재 우주와 리졸버 근거를 보인다', () => {
    process.env.ELANOUS_NEST_DEPTH = '2';
    process.env.ELANOUS_STATE_DIR = join(homedir(), '.elanous');
    const { stderr } = withCapture(() => { warnProdSpawnFootgun({ interactive: true, emit: 'stderr' }); });
    expect(stderr).not.toContain('--test 를 붙이세요');
    expect(stderr).toContain('현재 우주: prod');
    expect(stderr).toContain('layer=parent-stamp');
  });

  test('footgun 아니면(비인터랙티브) 양쪽 무출력', () => {
    footgunEnv();
    const { logs, stderr } = withCapture(() => {
      const f = warnProdSpawnFootgun({ interactive: false, emit: 'both' });
      expect(f.footgun).toBe(false);
    });
    expect(stderr).toBe('');
    expect(hasFootgunLog(logs)).toBe(false);
  });
});
