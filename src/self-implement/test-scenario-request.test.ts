import { describe, expect, test } from 'bun:test';
import { inspectTestScenarioDeclaration } from './goal-author.js';
import { requestTestScenario } from './test-scenario-request.js';

const REGISTRY = ['deliverable-verify'] as const;

/** ⛔⭐ 이 시험의 규율 — 「그 문자열이 있나」를 «묻지 않는다».
 *  ***저장소의 파서에게 직접 묻는다.*** 문자열만 세면 파서 계약이 바뀔 때 초록인 채로 거짓말한다
 *  (앞선 무인 시도가 「지표만 맞추는 테스트」로 리뷰에 반복 지적받은 그 자리다). */
const inspect = (sections: readonly string[]) => inspectTestScenarioDeclaration(sections.join('\n\n'));

describe('requestTestScenario — 저작이 «의뢰»해서 받는 시나리오', () => {
  test('기동 선언이 있으면 measured 로, 그리고 저장소 파서가 «문다»', () => {
    const result = requestTestScenario({
      launch: { port: 31415 },
      acceptanceCriteria: ['A 가 B 를 한다', 'C 는 그대로다'],
      registeredMethodologies: [...REGISTRY],
      commandSource: 'docs/goals/GOAL-x.md',
    });
    expect(result.liveStatus).toBe('measured');
    expect(result.deliverableType).toBe('deliverable-verify');
    const inspection = inspect(result.sections);
    expect(inspection.declaration.errors).toEqual([]);
    expect(inspection.declared).toBe(true);
    expect(inspection.extracted).toBe(true);
    expect(inspection.declaration.liveStatus).toBe('measured');
  });

  test('명령 출처 후보가 둘 이상이면 고르지 않고 후보와 unmeasured 사유를 낸다', () => {
    const result = requestTestScenario({
      launch: { port: 31415 },
      acceptanceCriteria: ['A 가 B 를 한다'],
      registeredMethodologies: [...REGISTRY],
      commandSourceCandidates: ['package.json:scripts.dev', 'Makefile:dev'],
    });
    expect(result.liveStatus).toBe('unmeasured');
    expect(result.reason).toBe('ambiguous-command-source');
    const inspection = inspect(result.sections);
    expect(inspection.declaration.errors).toEqual([]);
    expect(inspection.declaration.reason).toBe('ambiguous-command-source');
    expect(inspection.declaration.candidates).toEqual(['package.json:scripts.dev', 'Makefile:dev']);
  });

  test('explicit command source does not hide conflicting source candidates', () => {
    const result = requestTestScenario({
      launch: { entrypoint: 'bun run app' },
      acceptanceCriteria: ['works'],
      registeredMethodologies: ['deliverable-verify'],
      commandSource: 'package.json:scripts.dev',
      commandSourceCandidates: ['package.json:scripts.dev', 'Makefile:dev'],
    });
    expect(result.reason).toBe('ambiguous-command-source');
    expect(result.sections.join('\n')).toContain('package.json:scripts.dev, Makefile:dev');
    expect(result.sections.join('\n')).not.toContain('Port:` 또는 `Entrypoint:`');

    const withoutLaunch = requestTestScenario({
      launch: null,
      acceptanceCriteria: ['works'],
      registeredMethodologies: [],
      commandSourceCandidates: ['package.json:scripts.dev', 'Makefile:dev'],
    });
    expect(withoutLaunch.reason).toBe('ambiguous-command-source');
    expect(withoutLaunch.sections.join('\n')).toContain('package.json:scripts.dev, Makefile:dev');
  });

  test('blank explicit command source is treated as absent when a sole candidate exists', () => {
    const result = requestTestScenario({
      launch: { entrypoint: 'bun run app' },
      acceptanceCriteria: ['works'],
      registeredMethodologies: ['deliverable-verify'],
      commandSource: '   ',
      commandSourceCandidates: ['package.json:scripts.dev'],
    });
    expect(result.liveStatus).toBe('measured');
    expect(result.sections.join('\n')).toContain('package.json:scripts.dev');
  });

  test('legacy path source does not become an invalid file:key ambiguity candidate', () => {
    const result = requestTestScenario({
      launch: { entrypoint: 'bun run app' },
      acceptanceCriteria: ['works'],
      registeredMethodologies: ['deliverable-verify'],
      commandSource: 'g.md',
      commandSourceCandidates: ['package.json:scripts.dev'],
    });
    expect(result.reason).toBe('ambiguous-command-source');
    expect(result.sections.join('\n')).toContain('package.json:scripts.dev');
    expect(result.sections.join('\n')).toContain('g.md:explicit-command-source');
    expect(result.sections.join('\n')).toContain('원래 명시 출처(후보와 별도): `g.md`');
    expect(inspect(result.sections).declaration.errors).toEqual([]);
  });

  test('수용 기준이 «하나하나» U 층에 실린다 — 층을 문서에서 읽을 수 있어야 한다', () => {
    const result = requestTestScenario({
      launch: { port: 8080 },
      acceptanceCriteria: ['첫째 기준', '둘째 기준'],
      registeredMethodologies: [...REGISTRY],
      commandSource: 'g.md',
    });
    // ⛔⭐ 문서 «전체»에서 찾으면 기준이 U층 «밖»으로 옮겨져도 통과한다(리뷰 should-fix).
    //   ⇒ `### U.` 본문을 «경계로 잘라» 그 안에서 확인한다.
    const scenario = result.sections.find((section) => section.startsWith('## 검증 시나리오')) ?? '';
    const unitStart = scenario.indexOf('### U.');
    const unitEnd = scenario.indexOf('### I.');
    expect(unitStart).toBeGreaterThanOrEqual(0);
    expect(unitEnd).toBeGreaterThan(unitStart);
    const unitBody = scenario.slice(unitStart, unitEnd);
    expect(unitBody).toContain('첫째 기준');
    expect(unitBody).toContain('둘째 기준');
    // ⛔ 기준을 실었다고 파서 계약이 깨지면 안 된다 — 같은 문서를 파서에게 다시 묻는다.
    expect(inspect(result.sections).declaration.errors).toEqual([]);
  });

  test.each([
    ['선언이 없다', { launch: null, registeredMethodologies: [...REGISTRY], commandSource: 'g.md' }, 'no-launch-declaration'],
    ['방법론이 등록 안 됐다', { launch: { port: 1 }, registeredMethodologies: [], commandSource: 'g.md' }, 'no-methodology'],
    ['명령 출처가 없다', { launch: { port: 1 }, registeredMethodologies: [...REGISTRY] }, 'no-command-source'],
  ])('%s → unmeasured 이고 사유가 «이름»을 가진다', (_label, partial, expected) => {
    const result = requestTestScenario({ acceptanceCriteria: [], ...partial } as Parameters<typeof requestTestScenario>[0]);
    expect(result.liveStatus).toBe('unmeasured');
    expect(result.reason).toBe(expected);
    expect(result.deliverableType).toBe('unknown');
    const inspection = inspect(result.sections);
    expect(inspection.declaration.errors).toEqual([]);
    expect(inspection.declaration.liveStatus).toBe('unmeasured');
  });

  test('미측정 라이브 칸은 방법론·기동·눈을 «싣지 않는다» — 파서가 금지한다', () => {
    const result = requestTestScenario({ launch: null, acceptanceCriteria: [], registeredMethodologies: [...REGISTRY] });
    const live = result.sections.find((section) => section.startsWith('## L. 라이브')) ?? '';
    expect(live).not.toContain('- 방법론:');
    expect(live).not.toContain('- 기동:');
    expect(live).not.toContain('- 눈:');
    expect(inspect(result.sections).declaration.errors).toEqual([]);
  });

  test('집계는 «미실행»으로 시작한다 — 측정된 0 과 다른 값이다', () => {
    const result = requestTestScenario({ launch: { port: 3000 }, acceptanceCriteria: [], registeredMethodologies: [...REGISTRY], commandSource: 'g.md' });
    const aggregate = inspect(result.sections).declaration.aggregate;
    expect(aggregate).toBeDefined();
    expect(aggregate?.state).toBe('unexecuted');
    expect(aggregate?.green).toBe('unexecuted');
  });

  test('빈 명령 출처는 «준 것»이 아니다 — 공백만이면 measured 로 안 간다', () => {
    const result = requestTestScenario({ launch: { port: 1 }, acceptanceCriteria: [], registeredMethodologies: [...REGISTRY], commandSource: '   ' });
    expect(result.liveStatus).toBe('unmeasured');
    expect(result.reason).toBe('no-command-source');
  });
});

describe('requestTestScenario — 리뷰 must-fix 수리(2026-08-20)', () => {
  test('Entrypoint «만» 선언해도 measured 다 — 파서가 둘 중 하나만 있어도 선언을 인정한다', () => {
    const result = requestTestScenario({
      launch: { entrypoint: 'bun run start' },
      acceptanceCriteria: ['A'],
      registeredMethodologies: [...REGISTRY],
      commandSource: 'g.md',
    });
    expect(result.liveStatus).toBe('measured');
    expect(result.reason).toBeUndefined();
    const inspection = inspect(result.sections);
    expect(inspection.declaration.errors).toEqual([]);
    expect(inspection.declaration.liveStatus).toBe('measured');
  });

  test('⛔ Port 가 없으면 주소를 «지어내지 않는다» — 엔트리포인트를 그대로 말한다', () => {
    const result = requestTestScenario({
      launch: { entrypoint: 'bun run start' },
      acceptanceCriteria: [],
      registeredMethodologies: [...REGISTRY],
      commandSource: 'g.md',
    });
    const live = result.sections.find((section) => section.startsWith('## L. 라이브')) ?? '';
    expect(live).toContain('bun run start');
    expect(live).not.toContain('http://127.0.0.1');
  });

  test('공백뿐인 Entrypoint 는 «준 것»이 아니다', () => {
    const result = requestTestScenario({
      launch: { entrypoint: '   ' },
      acceptanceCriteria: [],
      registeredMethodologies: [...REGISTRY],
      commandSource: 'g.md',
    });
    expect(result.liveStatus).toBe('unmeasured');
    expect(result.reason).toBe('no-launch-declaration');
  });
});
