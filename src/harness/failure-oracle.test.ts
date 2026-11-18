// HARNESS-FAILURE-ORACLE-GEN — 순수 생성기 ⊕ 첫 구현 라운드 배선(shadow 무변화 · on 주입 · 예외 무차단).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAILURE_ORACLE_CELL_SIGNATURE,
  FAILURE_ORACLE_EVENT,
  FAILURE_ORACLE_GOAL_TARGET,
  FAILURE_ORACLE_MAX_PATHS,
  FAILURE_ORACLE_MAX_SECTION_CHARS,
  FAILURE_ORACLE_MAX_SKELETONS,
  FAILURE_ORACLE_SECTION_HEADER,
  FAILURE_ORACLE_SIGNATURE_CATEGORIES,
  FAILURE_SCENARIOS_BY_CATEGORY,
  failureOracleSectionForImplement,
  generateFailureSkeletons,
  missingCellSignature,
  renderFailureOracleSection,
  resolveFailureOracleMode,
  type FailureOracleImplementInput,
} from './failure-oracle.js';
import { featurePrompt, implementFailureOracleSection } from '../self-implement/seams.js';
import { buildUserConfig } from '../user-config.js';

type LogLine = { category: string; event: string; data: Record<string, unknown> };

function wired(overrides: Partial<FailureOracleImplementInput> = {}): { section: string | undefined; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const section = failureOracleSectionForImplement({
    firstRound: true,
    readMode: () => 'on',
    readInput: () => ({ paths: ['src/harness/run-ledger-store.ts'], declaredCategories: ['persistence'] }),
    runId: 'run-1',
    log: (category, event, data) => logs.push({ category, event, data }),
    ...overrides,
  });
  return { section, logs };
}

describe('generateFailureSkeletons — 범주 → 시나리오', () => {
  test('영속 파일은 영속 시나리오 여섯(서명 넷 먼저)을 그 파일 대상으로 낸다', () => {
    const result = generateFailureSkeletons({ paths: ['src/memory/session-store.ts'], declaredCategories: ['persistence'] });
    expect(result.skeletons.map((s) => s.scenario)).toEqual([...FAILURE_SCENARIOS_BY_CATEGORY.persistence]);
    expect(result.skeletons.every((s) => s.target === 'src/memory/session-store.ts')).toBe(true);
    expect(result.skeletons.map((s) => s.scenario)).toEqual(
      ['death-mid-write', 'concurrent-append', 'session-roundtrip', 'restart-recover', 'read-failure', 'write-failure']);
    for (const s of result.skeletons) {
      expect(s.title.trim()).not.toBe('');
      expect(s.given.trim()).not.toBe('');
      expect(s.when.trim()).not.toBe('');
      expect(s.then.trim()).not.toBe('');
    }
  });

  test('잠금 ⊕ 프로세스 간 = 합집합 · 중복 없음', () => {
    const result = generateFailureSkeletons({ paths: ['src/daemon/lock.ts'] });
    const ids = result.skeletons.map((s) => s.scenario);
    expect(ids).toEqual(['death-mid-write', 'concurrent-append', 'session-roundtrip', 'restart-recover', 'holder-dies']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.total).toBe(5);
  });

  test('위험 범주가 없으면 틀 0개', () => {
    const result = generateFailureSkeletons({ paths: ['src/tui/banner.tsx', 'docs/x.md'], declaredCategories: [] });
    expect(result.skeletons).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('경로에 안 묶인 선언 범주는 골 대상으로 · 경로가 이미 낸 범주는 다시 안 낸다', () => {
    const result = generateFailureSkeletons({ paths: ['src/harness/run-ledger-store.ts'], declaredCategories: ['persistence', 'locking'] });
    expect(result.skeletons.filter((s) => s.target === FAILURE_ORACLE_GOAL_TARGET).map((s) => s.scenario))
      .toEqual(['death-mid-write', 'concurrent-append', 'session-roundtrip', 'restart-recover', 'holder-dies']);
    expect(result.skeletons.filter((s) => s.scenario === 'read-failure')).toHaveLength(1);
  });

  test('모르는 범주는 버리고 센다', () => {
    const result = generateFailureSkeletons({ paths: [], declaredCategories: ['telepathy', 'SECURITY'] });
    expect(result.unknownCategories).toBe(1);
    expect(result.skeletons.map((s) => s.scenario)).toEqual(['read-failure']);
  });

  test('상한을 지키고 뺀 수를 센다', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/x/store-${i}.ts`);
    const result = generateFailureSkeletons({ paths });
    expect(result.skeletons).toHaveLength(FAILURE_ORACLE_MAX_SKELETONS);
    expect(result.total).toBe(60);
    expect(result.omitted).toBe(60 - FAILURE_ORACLE_MAX_SKELETONS);
  });

  test('거대한 파일 목록은 경로 상한까지만 살피고 뺀 경로 수를 센다', () => {
    const paths = Array.from({ length: FAILURE_ORACLE_MAX_PATHS + 50 }, (_, i) => `src/x/plain-${i}.ts`);
    const result = generateFailureSkeletons({ paths });
    expect(result.pathsOmitted).toBe(50);
    expect(result.skeletons).toEqual([]);
  });

  test('경로 상한 밖에서만 나온 범주는 (goal) 로 붙지 않고 omittedCategories 로 센다', () => {
    const paths = Array.from({ length: 250 }, (_, i) => (i === 229 ? 'src/x/lock.ts' : `src/x/plain-${i}.ts`));
    const result = generateFailureSkeletons({ paths });
    expect(result.skeletons.filter((s) => s.target === FAILURE_ORACLE_GOAL_TARGET)).toEqual([]);
    expect(result.skeletons.filter((s) => s.category === 'locking')).toEqual([]);
    expect(result.pathsOmitted).toBe(50);
    expect(result.omittedCategories).toEqual(['locking']);

    const { logs } = wired({ readInput: () => ({ paths }) });
    expect(logs[0]).toMatchObject({ event: 'computed', data: { reason: 'no-risk', pathsOmitted: 50, omittedCategories: ['locking'], skeletons: 0 } });
  });

  test('같은 입력이면 같은 출력(동시 라운드·재기동에도 공유 상태 없음)', () => {
    const input = { paths: ['src/daemon/lock.ts', 'src/memory/session-store.ts'], declaredCategories: ['security'] };
    expect(generateFailureSkeletons(input)).toEqual(generateFailureSkeletons(input));
  });
});

describe('renderFailureOracleSection — 글자 상한', () => {
  test('상한 안에서 자르고 생략 줄을 남긴다', () => {
    const { skeletons } = generateFailureSkeletons({ paths: Array.from({ length: 4 }, (_, i) => `src/x/store-${i}.ts`) }, 20);
    expect(skeletons).toHaveLength(20);
    const rendered = renderFailureOracleSection(skeletons);
    expect(rendered.text.length).toBeLessThanOrEqual(FAILURE_ORACLE_MAX_SECTION_CHARS);
    expect(rendered.text.startsWith(FAILURE_ORACLE_SECTION_HEADER)).toBe(true);
    expect(rendered.text).toContain('[read-failure]');
    expect(rendered.shown).toBeLessThan(skeletons.length);
    expect(rendered.text).toContain(`(+${skeletons.length - rendered.shown}개 생략)`);
  });

  test('안내문은 실제 범주만 이름 붙인다(보안만이면 «보안»)', () => {
    const { skeletons } = generateFailureSkeletons({ paths: ['src/auth/oauth.ts'] });
    const { text } = renderFailureOracleSection(skeletons);
    expect(text).toContain('바뀔 파일이 보안 경로다');
    expect(text).not.toContain('영속');
  });

  test('선언만 있는 범주는 «바뀔 파일» 이 아니라 «선언된 위험 범주» 로 말한다', () => {
    const declaredOnly = renderFailureOracleSection(generateFailureSkeletons({ paths: ['src/tui/banner.tsx'], declaredCategories: ['locking'] }).skeletons).text;
    expect(declaredOnly).toContain('골에 선언된 위험 범주: 잠금.');
    expect(declaredOnly).not.toContain('바뀔 파일이');

    const mixed = renderFailureOracleSection(generateFailureSkeletons({ paths: ['src/x/store.ts'], declaredCategories: ['locking'] }).skeletons).text;
    expect(mixed).toContain('바뀔 파일이 영속 경로다.');
    expect(mixed).toContain('골에 선언된 위험 범주: 잠금.');
    expect(mixed).not.toContain('바뀔 파일이 영속·잠금');
  });

  test('빈 목록 = 빈 절', () => {
    expect(renderFailureOracleSection([])).toEqual({ text: '', shown: 0 });
  });
});

describe('failureOracleSectionForImplement — 배선', () => {
  test('shadow 는 주입하지 않고 개수만 담은 이벤트를 남긴다(문면 없음)', () => {
    const { section, logs } = wired({ readMode: () => 'shadow' });
    expect(section).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ category: FAILURE_ORACLE_EVENT, event: 'computed',
      data: { runId: 'run-1', mode: 'shadow', reason: 'shadow', skeletons: 6, shown: 0, signatureMissing: [] } });
    const serialized = JSON.stringify(logs[0]!.data);
    expect(serialized).not.toContain('Given');
    expect(serialized).not.toContain('run-ledger-store');
  });

  test('on 은 첫 구현 라운드에만 주입한다', () => {
    const first = wired();
    expect(first.section).toContain(FAILURE_ORACLE_SECTION_HEADER);
    expect(first.section).toContain('[death-mid-write]');
    expect(first.logs[0]).toMatchObject({ event: 'injected', data: { mode: 'on', skeletons: 6, shown: 6, signatureMissing: [] } });

    let readInputCalls = 0;
    const rework = wired({ firstRound: false, readInput: () => { readInputCalls += 1; return { paths: ['src/x/store.ts'] }; } });
    expect(rework.section).toBeUndefined();
    expect(readInputCalls).toBe(0);
    expect(rework.logs).toEqual([{ category: FAILURE_ORACLE_EVENT, event: 'skipped', data: { runId: 'run-1', reason: 'not-first-round' } }]);
  });

  test('on 이어도 위험 범주가 없으면 주입 0 · 이유 no-risk', () => {
    const { section, logs } = wired({ readInput: () => ({ paths: ['src/tui/banner.tsx'], declaredCategories: [] }) });
    expect(section).toBeUndefined();
    expect(logs[0]).toMatchObject({ event: 'computed', data: { mode: 'on', reason: 'no-risk', skeletons: 0 } });
    expect(logs[0]!.data).not.toHaveProperty('signatureMissing');
  });

  test('생성 중 예외는 라운드를 막지 않는다 — error 이벤트 하나 · undefined', () => {
    for (const broken of [
      { readInput: () => { throw new TypeError('goal unreadable'); } },
      { readMode: () => { throw new RangeError('config unreadable'); } },
      { readInput: () => ({ paths: null as unknown as string[] }) },
    ] satisfies Partial<FailureOracleImplementInput>[]) {
      const { section, logs } = wired(broken);
      expect(section).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.event).toBe('error');
      expect(String(logs[0]!.data.error)).not.toContain('unreadable');
    }
  });

  test('로그 싱크가 던져도 결과는 그대로', () => {
    const section = failureOracleSectionForImplement({
      firstRound: true, readMode: () => 'on',
      readInput: () => ({ paths: ['src/x/store.ts'] }),
      log: () => { throw new Error('sink down'); },
    });
    expect(section).toContain(FAILURE_ORACLE_SECTION_HEADER);
  });
});

describe('featurePrompt — 주입 자리', () => {
  test('절이 없으면 종전과 같은 문면(zero behaviour change)', () => {
    expect(featurePrompt('무언가 구현', '/tmp/worktree', [], undefined)).toBe(featurePrompt('무언가 구현', '/tmp/worktree'));
    expect(featurePrompt('무언가 구현', '/tmp/worktree', undefined, [])).toBe(featurePrompt('무언가 구현', '/tmp/worktree'));
  });

  test('절은 구현 지시 묶음 안 · 완료 규칙보다 앞에 한 번', () => {
    const section = `${FAILURE_ORACLE_SECTION_HEADER}\n- [read-failure] x`;
    const prompt = featurePrompt('무언가 구현', '/tmp/worktree', undefined, [section]);
    expect(prompt.split(FAILURE_ORACLE_SECTION_HEADER)).toHaveLength(2);
    expect(prompt.indexOf(FAILURE_ORACLE_SECTION_HEADER)).toBeGreaterThan(prompt.indexOf('[self-implement]'));
    expect(prompt.indexOf(FAILURE_ORACLE_SECTION_HEADER)).toBeLessThan(prompt.indexOf('GOAL-COMPLETE 를 단독으로'));
  });
});

describe('harness.failureOracle flag', () => {
  test('생략·무효값 = shadow · on 만 on', () => {
    expect(resolveFailureOracleMode(undefined)).toBe('shadow');
    expect(resolveFailureOracleMode({ harness: {} })).toBe('shadow');
    expect(resolveFailureOracleMode({ harness: { failureOracle: 'live' } })).toBe('shadow');
    expect(resolveFailureOracleMode({ harness: { failureOracle: 'on' } })).toBe('on');
  });

  test('설정 파일 정규화: on 은 남고 그 밖은 칸이 없다', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-hfo-config-'));
    try {
      for (const [raw, expected] of [['on', 'on'], ['shadow', undefined], ['bogus', undefined], [undefined, undefined]] as const) {
        const path = join(root, 'config.json');
        writeFileSync(path, JSON.stringify({ harness: raw === undefined ? {} : { failureOracle: raw } }));
        const config = buildUserConfig(path);
        expect(config.harness?.failureOracle).toBe(expected);
        expect(resolveFailureOracleMode(config)).toBe(expected ?? 'shadow');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('implementFailureOracleSection — implement seam 배선(골 문서 → 범주 → 절)', () => {
  const goal = '## GOAL\n세션 저장소 고치기\n\n대상 경로: src/memory/session-store.ts · src/tui/banner.tsx';
  const run = (config: { harness?: { failureOracle?: 'shadow' | 'on' } }, firstRound: boolean) => {
    const logs: LogLine[] = [];
    const section = implementFailureOracleSection(goal, { firstRound, runId: 'run-seam' }, {
      readConfig: () => config, log: (category, event, data) => logs.push({ category, event, data }) });
    return { section, logs };
  };

  test('on · 첫 라운드 = 골의 대상 경로로 절을 만든다', () => {
    const { section, logs } = run({ harness: { failureOracle: 'on' } }, true);
    expect(section).toContain('`src/memory/session-store.ts`');
    expect(section).not.toContain('banner.tsx');
    expect(logs[0]).toMatchObject({ event: 'injected', data: { runId: 'run-seam', paths: 2, skeletons: 6, signatureMissing: [] } });
  });

  test('on · rework 라운드(roundContext 있음) = 주입 0 · skipped', () => {
    const { section, logs } = run({ harness: { failureOracle: 'on' } }, false);
    expect(section).toBeUndefined();
    expect(logs[0]).toMatchObject({ event: 'skipped', data: { reason: 'not-first-round' } });
  });

  test('기본(설정 없음) = shadow · 프롬프트 종전 그대로', () => {
    const { section, logs } = run({}, true);
    expect(section).toBeUndefined();
    expect(logs[0]).toMatchObject({ event: 'computed', data: { mode: 'shadow', skeletons: 6 } });
    expect(featurePrompt(goal, '/tmp/worktree', undefined, section ? [section] : undefined)).toBe(featurePrompt(goal, '/tmp/worktree'));
  });
});

// JUD-B 20261118-AM-REST-HOLD «죽음·동시 추가·세션 왕복·재기동 서명에 없음» — 칸 제목의 네 꼴을 칸 문면 그대로,
//   칸이 말한 세 범주(영속·잠금·프로세스 간) 각각에서 이름으로 잰다.
describe('칸 서명 — 죽음·동시 추가·세션 왕복·재기동', () => {
  const CELL_WORDS = ['죽음', '동시 추가', '세션 왕복', '재기동'] as const;
  // 범주 하나만 내는 경로(work-risk-router 낱말표: session/store · mutex · ipc).
  const CATEGORY_PATH = { persistence: 'src/x/session-store.ts', locking: 'src/x/mutex.ts', 'cross-process': 'src/x/ipc.ts' } as const;

  test('서명 = 칸 문면 순서의 네 꼴 · title 이 칸 낱말 그대로', () => {
    expect(FAILURE_ORACLE_CELL_SIGNATURE).toEqual(['death-mid-write', 'concurrent-append', 'session-roundtrip', 'restart-recover']);
    expect(FAILURE_ORACLE_SIGNATURE_CATEGORIES).toEqual(['persistence', 'locking', 'cross-process']);
    const titles = generateFailureSkeletons({ paths: [CATEGORY_PATH.locking] }).skeletons.slice(0, 4).map((s) => s.title);
    expect(titles).toEqual([...CELL_WORDS]);
  });

  for (const category of ['persistence', 'locking', 'cross-process'] as const) {
    test(`서명 ${category} — 경로 범주 틀의 앞 넷이 죽음·동시 추가·세션 왕복·재기동`, () => {
      const result = generateFailureSkeletons({ paths: [CATEGORY_PATH[category]] });
      expect(result.skeletons.every((s) => s.category === category)).toBe(true);
      expect(result.skeletons.slice(0, 4).map((s) => s.scenario)).toEqual([...FAILURE_ORACLE_CELL_SIGNATURE]);
      expect(missingCellSignature(result.skeletons, result.skeletons.length)).toEqual([]);
    });

    test(`서명 ${category} — 선언만 된 범주((goal) 대상)도 네 꼴을 낸다`, () => {
      const result = generateFailureSkeletons({ paths: [], declaredCategories: [category] });
      expect(result.skeletons.slice(0, 4).map((s) => [s.scenario, s.target])).toEqual(
        FAILURE_ORACLE_CELL_SIGNATURE.map((id) => [id, FAILURE_ORACLE_GOAL_TARGET]));
    });
  }

  const SIGNATURE_CASES = [
    ['death-mid-write', '죽음'], ['concurrent-append', '동시 추가'], ['session-roundtrip', '세션 왕복'], ['restart-recover', '재기동'],
  ] as const;
  for (const [scenario, word] of SIGNATURE_CASES) {
    test(`서명 «${word}»(${scenario}) — 영속·잠금·프로세스 간 경로 모두 첫 라운드 주입 절에 이름으로 실린다`, () => {
      for (const path of Object.values(CATEGORY_PATH)) {
        const { section, logs } = wired({ readInput: () => ({ paths: [path] }) });
        expect(section).toContain(`- [${scenario}] \`${path}\` ${word} — Given`);
        expect(logs[0]).toMatchObject({ event: 'injected', data: { signatureMissing: [] } });
        expect((logs[0]!.data.scenarios as Record<string, number>)[scenario]).toBe(1);
      }
    });
  }

  test('서명 누락은 이벤트에 이름으로 남는다 — 보안만이면 칸 생략', () => {
    const { skeletons } = generateFailureSkeletons({ paths: [CATEGORY_PATH.persistence] });
    expect(missingCellSignature(skeletons, 2)).toEqual(['session-roundtrip', 'restart-recover']);
    expect(missingCellSignature(generateFailureSkeletons({ paths: ['src/auth/oauth.ts'] }).skeletons, 0)).toBeUndefined();
    const security = wired({ readInput: () => ({ paths: ['src/auth/oauth.ts'] }) });
    expect(security.logs[0]!.event).toBe('injected');
    expect(security.logs[0]!.data).not.toHaveProperty('signatureMissing');
  });

  // Terra 리뷰 mustFix(#38368) — 누락은 «실제 실린 줄» 기준. 글자 상한·틀 수 상한에 잘린 서명 줄은 누락으로 센다.
  // 출처: FAILURE_ORACLE_MAX_SECTION_CHARS 보다 긴 경로 — 한 줄도 글자 상한 안에 못 든다.
  const HUGE_PATH = `src/x/${'a'.repeat(FAILURE_ORACLE_MAX_SECTION_CHARS)}/session-store.ts`;

  test('서명 누락 — 글자 상한에 한 줄도 못 실리면 on·shadow 모두 네 꼴 전부를 낸다', () => {
    for (const mode of ['on', 'shadow'] as const) {
      const { section, logs } = wired({ readMode: () => mode, readInput: () => ({ paths: [HUGE_PATH] }) });
      expect(section).toBeUndefined();
      expect(logs[0]).toMatchObject({ event: 'computed', data: { mode, skeletons: 6, shown: 0 } });
      expect(logs[0]!.data.signatureMissing).toEqual([...FAILURE_ORACLE_CELL_SIGNATURE]);
      expect(JSON.stringify(logs[0]!.data)).not.toContain('aaaa');
    }
  });

  test('서명 누락 — 틀 수 상한이 자른 서명 줄을 꼴 이름으로 낸다', () => {
    const lock = [CATEGORY_PATH.locking];
    const all = generateFailureSkeletons({ paths: lock }, Number.MAX_SAFE_INTEGER).skeletons;
    const capped = generateFailureSkeletons({ paths: lock }, 2);
    expect(capped.skeletons.map((s) => s.scenario)).toEqual(['death-mid-write', 'concurrent-append']);
    expect(missingCellSignature(all, capped.skeletons.length)).toEqual(['session-roundtrip', 'restart-recover']);

    // 세 영속 대상 = 18틀 · 틀 수 상한 12 → 셋째 대상의 서명 넷이 잘린다(대상 경로는 싣지 않고 꼴 이름만).
    const three = Array.from({ length: 3 }, (_, i) => `src/x/store-${i}.ts`);
    const full = generateFailureSkeletons({ paths: three }, Number.MAX_SAFE_INTEGER).skeletons;
    expect(full).toHaveLength(18);
    expect(missingCellSignature(full, FAILURE_ORACLE_MAX_SKELETONS)).toEqual([...FAILURE_ORACLE_CELL_SIGNATURE]);
  });

  test('서명 누락 — 상한에 잘린 배선 사건은 주입 절에 없는 서명 줄 수와 꼴마다 같다(on·shadow 같은 값)', () => {
    const three = Array.from({ length: 3 }, (_, i) => `src/x/store-${i}.ts`);
    const on = wired({ readInput: () => ({ paths: three }) });
    const shadow = wired({ readMode: () => 'shadow', readInput: () => ({ paths: three }) });
    const missing = on.logs[0]!.data.signatureMissing as string[];
    // 출처: #38368 Terra mustFix — 상한이 서명 줄을 하나 이상 잘라야 이 시험이 무언가를 잰다.
    expect(missing.length).toBeGreaterThan(0);
    for (const id of FAILURE_ORACLE_CELL_SIGNATURE) {
      const injectedLines = on.section!.split(`- [${id}] `).length - 1;
      expect(missing.filter((m) => m === id)).toHaveLength(three.length - injectedLines);
    }
    expect(shadow.logs[0]!.data.signatureMissing).toEqual(missing);
  });
});
