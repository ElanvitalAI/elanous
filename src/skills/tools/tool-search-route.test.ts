import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── 소환기 라우팅 불변식 · 소비자 전수 가드 (elanous review #5460 should-fix) ──
//
// tier-flip 은 라우터 지원 여부와 **무관하게** ToolSearch 를 주입한다(그게 맞다 —
// 소환기 없이 defer 하는 편이 더 나쁘다). 대신 위험은 반대편으로 옮겨간다:
// **deferred 를 만드는 새 소비자가 라우팅을 빠뜨리는 것**. 실제로 이번 수리 전
// daemon webterm 과 telegram/discord 가 **둘 다** 빠뜨리고 있었다.
//
// 그래서 여기서 못박는다: "이 스펙 목록이 무언가를 defer 한다면, 그 목록을 쓰는
// 서피스는 ToolSearch 를 라우팅한다." 새 소비자가 늘면 SURFACES 에 한 줄 추가하면
// 되고, defer 하는데 라우팅을 안 하면 테스트가 깨진다.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isToolSearchCall, routeToolSearch, TOOL_SEARCH_NAME } from './tool-search-route.js';
import { HYDRATED_TOOLS_KEY, takeHydratedTools } from './tool-search-spec.js';
import { splitDeferredToolSpecs } from '../../session-runtime/tier-flip.js';
import { buildAutonomousToolSpecs } from '../../agent/autonomous-tools.js';
import { toolSurface } from '../../boot/daemon-tools/index.js';


const repoRoot = join(import.meta.dir, '..', '..', '..');
const readSrc = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/** deferred 를 만드는 것으로 알려진 소비자들. `specs` 는 그 소비자가 프로바이더에
 *  넘기는 목록, `source` 는 dispatch 가 사는 파일. */
const SURFACES: { name: string; specs: () => readonly LLMToolSpec[]; source: string }[] = [
  {
    name: 'daemon webterm/ACP',
    specs: () => toolSurface('webterm').specs,
    source: 'src/boot/daemon-tools/index.ts',
  },
  {
    name: 'telegram/discord agent turn',
    specs: () => buildAutonomousToolSpecs(),
    source: 'src/agent/monad-agent-turn.ts',
  },
];

describe('소환기 라우팅 불변식 · 소비자 전수', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} — defer 하면 라우팅도 한다`, () => {
      const split = splitDeferredToolSpecs(surface.specs());
      // 전제: 이 소비자는 실제로 defer 한다(안 하면 가드 자체가 무의미해진 것).
      expect(split.deferred.length).toBeGreaterThan(0);
      expect(split.toolSearchInjected).toBe(true);
      // 결론: 그러니 dispatch 가 소환기를 받아야 한다.
      const src = readSrc(surface.source);
      expect(src).toContain('isToolSearchCall');
      expect(src).toContain('routeToolSearch');
    });
  }

  test('라우팅은 공용 헬퍼 단일 출처를 쓴다(서피스별 복붙 금지)', () => {
    for (const surface of SURFACES) {
      const src = readSrc(surface.source);
      // 자체 dispatchToolSearch 직접 호출은 풀 전달·관측을 빠뜨리기 쉽다.
      expect(src).not.toContain('dispatchToolSearch(');
    }
  });

  // SURFACES 는 수동 목록이라 "새 소비자가 목록 등재 자체를 빠뜨리는" 실패에
  // 눈이 없다. 그래서 defer 를 만드는 **스펙 빌더의 소비처**를 소스에서 역추적해
  // SURFACES 와 대조한다 — 새 소비처가 생기면 여기서 먼저 깨진다.
  test('defer 하는 스펙 빌더의 소비처는 전부 SURFACES 에 등재돼 있다', () => {
    const DEFERRING_BUILDERS = ['buildAutonomousToolSpecs', 'toolSurface'];
    const registered = new Set(SURFACES.map((s) => s.source));
    // 빌더 자신이 사는 파일 + dispatch 를 갖지 않는 재수출/테스트는 제외.
    const OWN_OR_EXEMPT = [
      'src/agent/autonomous-tools.ts',       // 빌더 정의처
      'src/boot/daemon-tools/index.ts',      // 빌더 정의처(=SURFACES 에도 있음)
    ];
    const grep = Bun.spawnSync({
      cmd: ['git', 'grep', '-l', '-E', DEFERRING_BUILDERS.join('|'), '--', 'src/'],
      cwd: repoRoot,
      stdout: 'pipe',
    });
    const files = grep.stdout.toString().trim().split('\n')
      .filter((f) => f && !f.endsWith('.test.ts') && !OWN_OR_EXEMPT.includes(f));
    const unregistered = files.filter((f) => {
      if (registered.has(f)) return false;
      const src = readSrc(f);
      // 라우팅 의무를 지는 건 **최종 거부를 소유한** 파일뿐이다. 이름을 그대로
      // 하위 surface.dispatch 로 넘기는 forwarder(daemon-runtime·nexus 등)는
      // 이미 그 서피스의 라우팅을 타므로 의무가 없다.
      const ownsTerminalRejection = /does not know tool|ToolSafetyError\(\s*'unavailable'/.test(src);
      if (!ownsTerminalRejection) return false;
      // 이미 공용 헬퍼를 쓰고 있으면 통과(SURFACES 등재는 권장이나 필수 아님).
      return !src.includes('isToolSearchCall');
    });
    expect(unregistered).toEqual([]);
  });
});

describe('routeToolSearch', () => {
  const pool: LLMToolSpec[] = [
    {
      name: 'Battleship',
      description: 'heavy autonomous tool',
      parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
    },
  ];

  test('풀 안의 툴을 스키마째 소환한다', () => {
    const r = routeToolSearch({ query: 'select:Battleship' }, pool, { surface: 'test' }) as {
      matched: string[]; content: string;
    };
    expect(r.matched).toEqual(['Battleship']);
    expect(r.content).toContain('"goal"');
  });

  test('빈 query 는 throw 가 아니라 {error} (모델이 재시도 가능)', () => {
    const r = routeToolSearch({ query: '  ' }, pool, { surface: 'test' }) as { error?: string };
    expect(r.error).toContain('query');
  });

  test('query 누락/비문자열도 throw 하지 않는다', () => {
    expect((routeToolSearch({}, pool, { surface: 'test' }) as { error?: string }).error).toBeDefined();
    expect((routeToolSearch({ query: 42 }, pool, { surface: 'test' }) as { error?: string }).error).toBeDefined();
  });

  test('풀 밖 이름은 unknown (권위적 allowlist)', () => {
    const r = routeToolSearch({ query: 'select:NotExposed' }, pool, { surface: 'test' }) as {
      matched: string[]; unknown: string[];
    };
    expect(r.matched).toEqual([]);
    expect(r.unknown).toEqual(['NotExposed']);
  });

  test('isToolSearchCall 은 정확히 소환기 이름에만 반응', () => {
    expect(isToolSearchCall(TOOL_SEARCH_NAME)).toBe(true);
    expect(isToolSearchCall('toolsearch')).toBe(false);
    expect(isToolSearchCall('SelfImplement')).toBe(false);
  });
});

// ── ⭐ 하이드레이션 → 호출가능 (F2 gap④ · 2026-07-26) ────────────────
// `<functions>{…}</functions>` 를 **텍스트로** 돌려주는 것만으론 툴이 호출가능해지지
// 않는다 — 프로바이더는 선언된 tools=[…] 안의 함수만 받는다. 그래서 모델이 소환 →
// 여전히 못 부름 → 같은 툴 재소환 → 포기하는 루프가 실측됐다(5회·하니스 2종).
// 소환 결과는 반드시 **스펙 자체**를 실어 보내야 하고, 툴 루프가 그걸 흡수해야 한다.
describe('하이드레이션 hand-off (gap④)', () => {
  const battleship: LLMToolSpec = {
    name: 'Battleship',
    description: 'heavy autonomous tool',
    parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
  };

  test('소환 결과가 스펙을 실어 보낸다(렌더 텍스트만이 아니라)', () => {
    const r = routeToolSearch({ query: 'select:Battleship' }, [battleship], { surface: 'test' }) as Record<string, unknown>;
    const hydrated = r[HYDRATED_TOOLS_KEY] as LLMToolSpec[] | undefined;
    expect(hydrated).toBeDefined();
    expect(hydrated!.map((s) => s.name)).toEqual(['Battleship']);
    // 스키마 본문까지 실려야 프로바이더에 선언 가능.
    expect(hydrated![0]!.parameters).toEqual(battleship.parameters);
  });

  test('takeHydratedTools 가 스펙을 꺼내고 **키를 제거**한다(문맥 이중과금 방지)', () => {
    const r = routeToolSearch({ query: 'select:Battleship' }, [battleship], { surface: 'test' }) as Record<string, unknown>;
    const lifted = takeHydratedTools(r);
    expect(lifted.map((s) => s.name)).toEqual(['Battleship']);
    // 두 번째 호출은 비어야 한다 = 키가 제거됐다.
    expect(takeHydratedTools(r)).toEqual([]);
    expect(HYDRATED_TOOLS_KEY in r).toBe(false);
    // 모델이 읽는 렌더 블록은 그대로 남는다.
    expect(String(r.content)).toContain('<functions>');
  });

  test('하이드레이션을 안 실은 결과엔 무해하다', () => {
    expect(takeHydratedTools({ ok: true })).toEqual([]);
    expect(takeHydratedTools(null)).toEqual([]);
    expect(takeHydratedTools('text')).toEqual([]);
  });

  // must-fix(elanous review #5461): 값이 배열이 아니어도 **키는 반드시 지운다**.
  // 안 그러면 malformed 예약키가 그대로 대화로 새어나간다(모델-비대상 배관).
  test('malformed 값이어도 예약키는 무조건 제거된다(누출 차단)', () => {
    for (const bad of ['not-an-array', 42, null, { nested: true }]) {
      const bag: Record<string, unknown> = { ok: true, [HYDRATED_TOOLS_KEY]: bad };
      expect(takeHydratedTools(bag)).toEqual([]);
      expect(HYDRATED_TOOLS_KEY in bag).toBe(false);
    }
  });

  // must-fix(elanous review #5461): name 문자열만 보면 빈 이름·parameters 없는
  // 객체가 프로바이더 선언에 주입된다 — 선언 가능한 shape 전체를 검증한다.
  test('선언 불가능한 항목은 걸러낸다(프로바이더에 쓰레기 선언 금지)', () => {
    const junk = {
      [HYDRATED_TOOLS_KEY]: [
        battleship,
        null,
        42,
        { description: 'no name', parameters: { type: 'object' } },  // name 없음
        { name: '', parameters: { type: 'object' } },                 // 빈 이름
        { name: '   ', parameters: { type: 'object' } },              // 공백뿐
        { name: 'NoParams' },                                         // parameters 없음
        { name: 'BadParams', parameters: 'nope' },                    // parameters 비객체
        { name: 'ArrParams', parameters: [] },                        // 배열
        { name: 'BadDesc', description: 7, parameters: { type: 'object' } },
      ],
    };
    expect(takeHydratedTools(junk).map((s) => s.name)).toEqual(['Battleship']);
  });

  test('소환 실패(unknown)면 실을 스펙도 없다', () => {
    const r = routeToolSearch({ query: 'select:NotExposed' }, [battleship], { surface: 'test' }) as Record<string, unknown>;
    expect(takeHydratedTools(r)).toEqual([]);
  });
});
