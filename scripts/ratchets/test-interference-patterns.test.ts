// TEST-INTERFERENCE-RATCHET — 시험 간섭 꼴 정적 래칫 (0.2.31 · 대표 승인)
// 스캐너·꼴 정의·표본 = scripts/ratchets/test-interference-patterns.ts 머리말.
//
// ⚠️ 이 시험은 저장소 «전수»를 본다 — 착지 게이트(`self gate --changed`)는 «바뀐 파일» 범위라 이 파일이
// 안 바뀐 PR 에선 안 돈다. 그래서 release/light-rc-always.txt(판 게이트의 항상 목록)에 올라 있다.
// 착지 단위로 막으려면 바뀐 시험 파일만 넘겨 부른다: `bun scripts/ratchets/test-interference-patterns.ts <files…>`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ALLOWLIST_PATH, UPDATE_COMMAND, formatViolation, judge, listTestFiles, parseAllowlist, renderAllowlist, scanFiles, scanSource,
  type InterferenceForm,
} from './test-interference-patterns';

// 전수 스캔은 실측 ≈3s(node-c · 시험 파일 ≈6,000) — 차가운 게이트 Pod 여유를 둔다.
setDefaultTimeout(120_000);

const forms = (src: string, file = 'fake/sample.test.ts') => scanSource(src, file).map((v) => v.form);

// ── 표본 넷을 «되돌린» 가짜 시험(수리 전 꼴) — 각각 걸려야 한다 ─────────────────────────────

/** #28517 e56d8c28 이전 test/nexus-kinds-daemon.test.ts — 본문 안 무거운 동적 import. */
const NEXUS_REVERTED = `
import { test, expect, beforeEach, afterEach } from 'bun:test';
let prevNexus: string | undefined;
beforeEach(() => { prevNexus = process.env.ELANOUS_NEXUS_DIR; process.env.ELANOUS_NEXUS_DIR = '/tmp/x'; });
afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
});
test('detachForTesting=true skips daemon by default', async () => {
  const { runNexus } = await import('../src/nexus/index.js');
  const handle = await runNexus({ detachForTesting: true });
  expect(handle).toBeDefined();
});
`;

/** #28514 수리 뒤 — import 는 beforeAll 로 데우고(헬퍼) 본문은 bootNexus. */
const NEXUS_FIXED = `
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { bootNexus, drainNexusBoots, warmNexusModule } from './helpers/nexus-boot-guard.js';
let prevNexus: string | undefined;
beforeEach(() => { prevNexus = process.env.ELANOUS_NEXUS_DIR; process.env.ELANOUS_NEXUS_DIR = '/tmp/x'; });
beforeAll(warmNexusModule, 120_000);
afterEach(async () => {
  await drainNexusBoots();
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
}, 60_000);
test('detachForTesting=true skips daemon by default', async () => {
  const handle = await bootNexus({ detachForTesting: true });
  expect(handle).toBeDefined();
});
`;

/** #28527 b5ca5041 이전 test/mission-capabilities/probe-context.test.ts — 본문 import ⊕ 비동기 본문 finally 만의 chdir 복원. */
const PROBE_REVERTED = `
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('capability probe authority context', () => {
  test('the loader sends authorityRoot to discovered tree-measuring providers', async () => {
    const cwdRoot = '/tmp/cwd';
    try {
      const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
      const { loadMissionBlueprint } = await import('../../src/mission-blueprints/loader.js');
      const priorCwd = process.cwd();
      process.chdir(cwdRoot);
      try {
        await discoverCapabilityProviders();
        expect(loadMissionBlueprint).toBeDefined();
      } finally {
        process.chdir(priorCwd);
      }
    } finally {
      roots.splice(0);
    }
  });
});
`;

/** #28527 수리 뒤 — 무거운 import 는 beforeAll · afterEach 가 cwd 를 복원. */
const PROBE_FIXED = `
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createInflightGuard } from '../helpers/inflight-test-guard.js';
const startCwd = process.cwd();
const guard = createInflightGuard();
beforeAll(async () => {
  const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
  await import('../../src/mission-blueprints/loader.js');
  await discoverCapabilityProviders();
}, 120_000);
afterEach(async () => {
  await guard.drain();
  if (process.cwd() !== startCwd) process.chdir(startCwd);
}, 60_000);
describe('capability probe authority context', () => {
  test('the loader sends authorityRoot', guard.track(async () => {
    const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
    const priorCwd = process.cwd();
    process.chdir('/tmp/cwd');
    try { await discoverCapabilityProviders(); } finally { process.chdir(priorCwd); }
  }), 30_000);
});
`;

/** #28527 이전 src/autopilot/build/integrity-gate.test.ts — 자식 bun 에 100ms 한도. */
const INTEGRITY_REVERTED = `
import { describe, expect, test } from 'bun:test';
import { defaultRunCmd } from './integrity-gate';
describe('integrity gate process-tree timeout cleanup', () => {
  test('timeout kills the tree', async () => {
    const running = defaultRunCmd(process.execPath, [fixture, 'direct', state.path], process.cwd(), 100);
    expect(await running).toBeDefined();
  }, 10_000);
});
`;

const INTEGRITY_FIXED = INTEGRITY_REVERTED
  .replace("process.cwd(), 100)", 'process.cwd(), TREE_TIMEOUT_MS)')
  .replace("import { defaultRunCmd } from './integrity-gate';", "import { defaultRunCmd } from './integrity-gate';\nconst TREE_TIMEOUT_MS = 1_500;");

/** #28527 이전 apps/pwa/src/components/workflows/WorkflowGraph.test.tsx — act 밖 맨몸 unmount ⊕ afterAll 이 window 를 걷는다. */
const PWA_REVERTED = `
import { afterAll, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
const globals = globalThis as { window?: unknown };
const previousWindow = globals.window;
globals.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
afterAll(() => { if (previousWindow === undefined) delete globals.window; else globals.window = previousWindow; });
test('editable graph history', async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(null as never); });
  renderer.unmount();
  listeners.clear(); // unmount outside act does not flush the effect cleanup
});
`;

const PWA_FIXED = PWA_REVERTED.replace('  renderer.unmount();\n', '  await act(async () => renderer.unmount());\n');

describe('표본 넷을 되돌린 가짜 시험은 걸린다', () => {
  const cases: [string, string, InterferenceForm][] = [
    ['nexus #28517', NEXUS_REVERTED, 'body-dynamic-import'],
    ['probe #28527 (import)', PROBE_REVERTED, 'body-dynamic-import'],
    ['probe #28527 (chdir)', PROBE_REVERTED, 'chdir-without-restore'],
    ['integrity #28527', INTEGRITY_REVERTED, 'short-child-timeout'],
    ['PWA WorkflowGraph #28527', PWA_REVERTED, 'bare-unmount-with-window'],
  ];
  for (const [name, src, form] of cases) {
    test(`${name} → ${form}`, () => {
      expect(forms(src, name.startsWith('PWA') ? 'fake/Graph.test.tsx' : 'fake/sample.test.ts')).toContain(form);
    });
  }
});

describe('수리된 꼴(정리 짝 있음)은 통과한다', () => {
  for (const [name, src] of [['nexus', NEXUS_FIXED], ['probe', PROBE_FIXED], ['integrity', INTEGRITY_FIXED], ['PWA', PWA_FIXED]] as const) {
    test(name, () => {
      expect(scanSource(src, name === 'PWA' ? 'fake/Graph.test.tsx' : 'fake/sample.test.ts').map(formatViolation)).toEqual([]);
    });
  }
});

describe('꼴별 경계 — 정리 짝', () => {
  test('env 를 바꾸고 afterEach 가 없으면 걸린다 · afterEach 복원 / finally 복원 / restore 헬퍼면 통과', () => {
    const bare = `import { test } from 'bun:test';\ntest('x', () => { process.env.FOO = '1'; });\n`;
    expect(forms(bare)).toEqual(['env-without-restore']);
    expect(forms(`import { afterEach, test } from 'bun:test';\nconst prev = process.env.FOO;\nafterEach(() => { process.env.FOO = prev; });\ntest('x', () => { process.env.FOO = '1'; });\n`)).toEqual([]);
    expect(forms(`import { test } from 'bun:test';\ntest('x', () => { const p = process.env.FOO; try { process.env.FOO = '1'; } finally { process.env.FOO = p; } });\n`)).toEqual([]);
    expect(forms(`import { test } from 'bun:test';\nconst restore = () => { delete process.env.FOO; };\ntest('x', () => { try { process.env.FOO = '1'; } finally { restore(); } });\n`)).toEqual([]);
    // bun:test 별칭으로 들여온 afterEach 도 짝이다.
    expect(forms(`import { afterEach as after, test } from 'bun:test';\nafter(() => { delete process.env.FOO; });\ntest('x', () => { process.env.FOO = '1'; });\n`)).toEqual([]);
  });

  test('chdir — 동기 함수 finally 복원은 짝 · 비동기 본문 finally 만이면 걸린다(시간초과면 afterEach 보다 늦다)', () => {
    expect(forms(`import { test } from 'bun:test';\ntest('x', () => { const p = process.cwd(); process.chdir('/tmp'); try { run(); } finally { process.chdir(p); } });\n`)).toEqual([]);
    expect(forms(`import { test } from 'bun:test';\ntest('x', async () => { const p = process.cwd(); process.chdir('/tmp'); try { await run(); } finally { process.chdir(p); } });\n`)).toEqual(['chdir-without-restore']);
    expect(forms(`import { test } from 'bun:test';\ntest('x', () => { process.chdir('/tmp'); });\n`)).toEqual(['chdir-without-restore']);
  });

  test('동적 import — 정적 import 로 이미 읽은 모듈 · beforeAll 로 데운 모듈 · mock.module 뒤 import 는 통과', () => {
    expect(forms(`import { test } from 'bun:test';\nimport { a } from './a.js';\ntest('x', async () => { await import('./a.ts'); });\n`)).toEqual([]);
    expect(forms(`import { test, mock } from 'bun:test';\ntest('x', async () => { mock.module('./dep', () => ({})); await import('./a.js'); });\n`)).toEqual([]);
    expect(forms(`import { test } from 'bun:test';\ntest('x', async () => { await import('node:fs'); });\n`)).toEqual([]);
  });

  test('자식 한도 — 1000ms 이상이거나 상수면 통과 · options.timeout 리터럴도 본다', () => {
    expect(forms(`import { test } from 'bun:test';\ntest('x', () => { run(process.execPath, ['-e', '1'], 1_500); });\n`)).toEqual([]);
    expect(forms(`import { test } from 'bun:test';\ntest('x', () => { spawnSync(process.execPath, ['-e', '1'], { timeout: 200 }); });\n`)).toEqual(['short-child-timeout']);
  });

  test('맨몸 unmount — window 를 안 만지는 파일은 대상이 아니다', () => {
    expect(forms(`import { test } from 'bun:test';\nimport { create } from 'react-test-renderer';\ntest('x', () => { const r = create(null as never); r.unmount(); });\n`, 'fake/a.test.tsx')).toEqual([]);
  });
});

describe('래칫 — 허용 목록', () => {
  test('개수가 늘면 그 파일·꼴이 새 위반 · 줄면 갱신 안내만', () => {
    const v = scanSource(PROBE_REVERTED, 'p.test.ts');
    const allow = parseAllowlist(renderAllowlist(v));
    expect(judge(v, allow).fresh).toEqual([]);
    const more = [...v, { ...v[0]!, line: 999 }];
    expect(judge(more, allow).fresh.length).toBeGreaterThan(0);
    const fewer = judge(v.slice(1), allow);
    expect(fewer.fresh).toEqual([]);
    expect(fewer.stale.length).toBe(1);
  });

  test('⭐ 저장소 전수 — 허용 목록 밖 새 위반 0 (시간·수를 함께 남긴다)', () => {
    const started = performance.now();
    const files = listTestFiles();
    const violations = scanFiles(files);
    const elapsedMs = Math.round(performance.now() - started);
    const result = judge(violations, parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8')));
    console.log(`[test-interference] scanned ${files.length} test files · sites ${violations.length} · new ${result.fresh.length} · shrank ${result.stale.length} · ${elapsedMs}ms`);
    if (result.stale.length) console.log(`[test-interference] 허용 목록이 줄었다 — 조여라: ${UPDATE_COMMAND}`);
    // ⛔ «아무것도 안 보고» 통과하지 않는다 — 시험 파일을 실제로 셌다.
    expect(files.length).toBeGreaterThan(1000);
    expect(result.fresh.map(formatViolation)).toEqual([]);
  });
});
