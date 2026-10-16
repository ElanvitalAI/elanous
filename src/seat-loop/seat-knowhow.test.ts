import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TOP_K,
  SEAT_PACK_TOTAL_BUDGET_CHARS,
  loadSeatPack,
  parseKnowhowItems,
  selectTopK,
  splitKnowhow,
} from './seat-knowhow.js';

const SEAT = 'OP';

const SAMPLE = `# OP 노하우

서두 — 카드 아님.

## K-OP-001 운영 판 사다리 (2026-09-01)

- 상황: 판이 막힌다.
- 신호: 빨강 칸.
- 원인: 병목.
### 처방: 사다리를 탄다
- 재는 명령: elanous release checklist status
- 기대: 초록.
- 유효 조건: 판이 있을 때.
- 검증: 2026-09-01 참 (OP)
- 출처: 회의 · 상태: active · 종류: playbook

## K-OP-002 검증 못잼 카드 (2026-09-02)

- 재는 명령: bun test src/seat-loop/
- 검증: 2026-09-02 못잼
- 출처: 상태: unproven

## K-OP-003 반감기 지난 카드 (2026-09-10)

- 재는 명령: rg -n roleLlm src/self-dev/dev-cli.ts
- 검증: 2026-09-10 참 (OP)
- 출처: 상태: active

## K-OP-038 뒤집힌 카드 (2026-08-14)

- 재는 명령: elanous config get llm.fallbackChain
- 검증: 2026-08-14 참 (OP)
- 출처: 상태: contradicted

## K-OP-004 최근 검증 거짓 카드 (2026-09-15)

- 재는 명령: elanous provider
- 검증: 2026-09-15 거짓 (OP)
- 출처: 상태: active

## K-OP-005 상태 없는 카드 (2026-09-15)

- 재는 명령: elanous usage
- 검증: 2026-09-15 참 (OP)
- 출처: 회의

## K-OP-006 검증 없는 카드 (2026-09-16)

- 재는 명령: elanous config get roleLlm
- 출처: 상태: active
`;

const NOW = new Date('2026-10-11T00:00:00Z');

function cardId(item: { text: string }): string | undefined {
  return item.text.match(/^## (K-[^\s]+)/)?.[1];
}

function virtualRead(charter: string, knowhow: string) {
  return (path: string) => {
    if (path.endsWith(`roles/${SEAT}.md`)) return charter;
    if (path.endsWith(`roles/${SEAT}/KNOWHOW.md`)) return knowhow;
    throw new Error(`unexpected read: ${path}`);
  };
}

describe('parseKnowhowItems — v2 카드 파싱', () => {
  test('헤더·칸·상태·종류·검증을 읽는다', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    expect(items.length).toBe(7);
    const first = items[0]!;
    expect(cardId(first)).toBe('K-OP-001');
    expect(first.text.startsWith('## K-OP-001 운영 판 사다리 (2026-09-01)')).toBe(true);
    expect(first.kind).toBe('playbook');
    expect(first.status).toBe('active');
    expect(first.verified).toBe(true);
    expect(first.verifiedAt?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(first.text).toContain('### 처방: 사다리를 탄다');
    const unproven = items[1]!;
    expect(unproven.status).toBe('unproven');
    expect(unproven.verified).toBe(null);
  });

  test('상태 없는 카드를 active로 가정하지 않는다 — 빈 상태로 둔다 (must-fix 1)', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    const noStatus = items.find((i) => cardId(i) === 'K-OP-005')!;
    expect(noStatus.status).toBe('');
    const falsified = items.find((i) => cardId(i) === 'K-OP-004')!;
    expect(falsified.status).toBe('active');
    expect(falsified.verified).toBe(false);
    expect(falsified.verifiedAt?.toISOString().slice(0, 10)).toBe('2026-09-15');
  });
});

describe('splitKnowhow — 사실/참고/드랍 가르기', () => {
  test('반감기 지남 → 참고 · contradicted → 싣지 않음', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    const { facts, refs, dropped } = splitKnowhow(items, NOW);
    expect(facts.map(cardId)).toEqual(['K-OP-001']);
    expect(refs.map(cardId)).toEqual(['K-OP-002', 'K-OP-003']);
    expect(dropped).toBe(4);
  });

  test('fact 반감기(14일) 밖이면 사실이 아니다', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    const fresh = splitKnowhow(items, new Date('2026-09-20T00:00:00Z'));
    expect(fresh.facts.map(cardId)).toEqual(['K-OP-001', 'K-OP-003']);
  });

  test('최근 검증 거짓 ⊕ 상태 미선언 ⊕ 검증 미선언 카드는 어느 블록에도 싣지 않는다 (must-fix 1)', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    const { facts, refs, dropped } = splitKnowhow(items, NOW);
    const injected = [...facts, ...refs].map(cardId);
    expect(injected).not.toContain('K-OP-004');
    expect(injected).not.toContain('K-OP-005');
    expect(injected).not.toContain('K-OP-006');
    expect(dropped).toBe(4);
  });

  test('알 수 없는 상태는 참고에도 싣지 않는다', () => {
    const cards = parseKnowhowItems(`## K-OP-101 초안\n\n- 검증: 2026-10-10 참 (OP)\n- 출처: 상태: draft\n\n## K-OP-102 검증불가\n\n- 검증: 2026-10-10 못잼\n- 출처: 상태: unverifiable`, SEAT);
    const result = splitKnowhow(cards, NOW);
    expect(result.facts).toEqual([]);
    expect(result.refs.map(cardId)).toEqual(['K-OP-102']);
    expect(result.dropped).toBe(1);
  });

  test('미래 검증일은 무기한 case도 사실로 싣지 않는다', () => {
    const cards = parseKnowhowItems(`## K-OP-103 미래 카드\n\n- 종류: case\n- 검증: 2026-10-12 참 (OP)\n- 출처: 상태: active`, SEAT);
    const result = splitKnowhow(cards, NOW);
    expect(result.facts).toEqual([]);
    expect(result.refs).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  test('달력에 없는 검증일은 정규화하지 않고 드랍한다', () => {
    const cards = parseKnowhowItems(`## K-OP-104 없는 날짜\n\n- 검증: 2026-09-31 참 (OP)\n- 출처: 상태: active`, SEAT);
    expect(cards[0]!.verifiedAt).toBeNull();
    const result = splitKnowhow(cards, NOW);
    expect(result.facts).toEqual([]);
    expect(result.refs).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  test('뒤에 나온 잘못된 검증 줄이 앞선 참을 무효화한다', () => {
    const cards = parseKnowhowItems(`## K-OP-105 최신 검증 오류\n\n- 검증: 2026-10-10 참 (OP)\n- 검증: 날짜 없음\n- 출처: 상태: active`, SEAT);
    expect(cards[0]!.verifiedAt).toBeNull();
    expect(splitKnowhow(cards, NOW).dropped).toBe(1);
  });
});

describe('selectTopK — 중복 없는 상위 k', () => {
  test('k를 넘지 않고 중복·원본 순서를 지킨다', () => {
    const items = parseKnowhowItems(SAMPLE, SEAT);
    const eight = selectTopK(items, '카드', DEFAULT_TOP_K);
    expect(eight.length).toBe(7);
    const ids = eight.map(cardId);
    expect(new Set(ids).size).toBe(ids.length);
    const top = selectTopK(items, 'release checklist status 초록', 2);
    expect(cardId(top[0]!)).toBe('K-OP-001');
  });
});

describe('loadSeatPack — 헌장 전문 ⊕ 두 블록', () => {
  test('예산은 블록 순서가 아니라 질의 순위대로 배분한다', () => {
    const knowhow = `## K-OP-401 낮은 순위 큰 사실\n\n- 재는 명령: ${'x'.repeat(3_000)}\n- 검증: 2026-10-10 참 (OP)\n- 출처: 상태: active\n\n## K-OP-402 beta 관련 참고\n\n- 재는 명령: beta beta\n- 검증: 2026-10-10 못잼\n- 출처: 상태: unproven`;
    const pack = loadSeatPack(SEAT, 'beta', { read: virtualRead('c'.repeat(29_000), knowhow), now: () => NOW, repo: '/virtual' });
    expect(pack.facts).toEqual([]);
    expect(pack.refs.length).toBe(1);
    expect(pack.text).toContain('K-OP-402');
    expect(pack.text).not.toContain('K-OP-401');
  });
  test('4,000자 넘는 헌장도 잘리지 않고 전체 예산 상한만 적용된다', () => {
    const deps = {
      read: virtualRead(`# ${SEAT}\n\n${'헌장 '.repeat(3_000)}`, SAMPLE),
      now: () => NOW,
      repo: '/virtual',
    };
    const pack = loadSeatPack(SEAT, 'release checklist status', deps);
    expect(pack.charter.length).toBeGreaterThan(4_000);
    expect(pack.text).toContain(pack.charter.trim());
    expect(pack.text.length).toBeLessThanOrEqual(SEAT_PACK_TOTAL_BUDGET_CHARS);
    expect(pack.facts.length).toBe(1);
    expect(pack.text).toContain('K-OP-001');
    expect(pack.text).toContain('K-OP-002');
    expect(pack.text).not.toContain('K-OP-038');
    expect(pack.text).not.toContain('K-OP-004');
    expect(pack.text).not.toContain('K-OP-005');
    expect(pack.text).not.toContain('K-OP-006');
  });

  test('KNOWHOW 없으면 헌장만', () => {
    const deps = {
      read: virtualRead('# OP 헌장', ''),
      now: () => NOW,
      repo: '/virtual',
    };
    const pack = loadSeatPack(SEAT, '', deps);
    expect(pack.text.trim()).toBe('# OP 헌장');
    expect(pack.facts).toEqual([]);
    expect(pack.refs).toEqual([]);
    expect(pack.dropped).toBe(0);
  });

  test('top-k는 전체 후보 풀에서 한 번 — 블록별 k가 아니어서 최대 k장만 싣는다 (must-fix 2)', () => {
    const cards: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      cards.push(
        `## K-OP-1${i} 알파 카드 ${i}\n\n- 재는 명령: alpha run ${i}\n- 검증: 2026-09-01 참 (OP)\n- 출처: 상태: active · 종류: case`,
      );
    }
    for (let i = 1; i <= 5; i += 1) {
      cards.push(
        `## K-OP-2${i} 베타 카드 ${i}\n\n- 재는 명령: beta run ${i}\n- 검증: 2026-09-02 못잼\n- 출처: 상태: unproven`,
      );
    }
    const deps = {
      read: virtualRead('# OP 헌장', cards.join('\n\n')),
      now: () => NOW,
      repo: '/virtual',
      topK: 4,
    };
    const alphaPack = loadSeatPack(SEAT, 'alpha', deps);
    expect(alphaPack.facts.length + alphaPack.refs.length).toBe(4);
    expect(alphaPack.facts.length).toBe(4);
    expect(alphaPack.refs).toEqual([]);
    const betaPack = loadSeatPack(SEAT, 'beta', deps);
    expect(betaPack.facts.length + betaPack.refs.length).toBe(4);
    expect(betaPack.facts).toEqual([]);
    expect(betaPack.refs.length).toBe(4);
  });

  test('예산 초과 시 완전한 항목 단위로만 싣는다 — facts·refs가 곧 주입 내용이다 (must-fix 3)', () => {
    const charter = `# ${SEAT}\n\n${'c'.repeat(20_000)}`;
    const bigFact = (n: number) =>
      `## K-OP-10${n} BIGCARD ${n}\n\n- 재는 명령: ${'x'.repeat(5_000)}\n- 검증: 2026-09-01 참 (OP)\n- 출처: 상태: active · 종류: case`;
    const smallRef = (n: number) =>
      `## K-OP-20${n} REF ${n}\n\n- 재는 명령: beta run ${n}\n- 검증: 2026-09-02 못잼\n- 출처: 상태: unproven`;
    const knowhow = [bigFact(1), bigFact(2), bigFact(3), bigFact(4), smallRef(1), smallRef(2)].join('\n\n');
    const deps = {
      read: virtualRead(charter, knowhow),
      now: () => NOW,
      repo: '/virtual',
    };
    const pack = loadSeatPack(SEAT, 'bigcard beta', deps);
    expect(pack.text.length).toBeLessThanOrEqual(SEAT_PACK_TOTAL_BUDGET_CHARS);
    expect(pack.facts.length).toBe(2);
    expect(pack.refs.length).toBe(2);
    for (const card of [...pack.facts, ...pack.refs]) {
      expect(pack.text).toContain(card);
    }
    expect(pack.facts.some((f) => f.includes('K-OP-103'))).toBe(false);
    expect(pack.facts.some((f) => f.includes('K-OP-104'))).toBe(false);
    expect(pack.text).not.toContain('K-OP-103');
    expect(pack.text).not.toContain('K-OP-104');
  });

  test('헌장 단독으로 예산을 넘으면 헌장 전문만 싣고 카드 블록은 통째로 뺀다 (명시된 초과 헌장 정책)', () => {
    const charter = `# ${SEAT}\n\n${'c'.repeat(40_000)}`;
    const knowhow = [
      '## K-OP-301 REF 1\n\n- 재는 명령: beta run 1\n- 검증: 2026-09-02 못잼\n- 출처: 상태: unproven',
    ].join('\n\n');
    const deps = {
      read: virtualRead(charter, knowhow),
      now: () => NOW,
      repo: '/virtual',
    };
    const pack = loadSeatPack(SEAT, 'beta', deps);
    expect(pack.charter.length).toBeGreaterThan(SEAT_PACK_TOTAL_BUDGET_CHARS);
    expect(pack.text).toBe(pack.charter);
    expect(pack.facts).toEqual([]);
    expect(pack.refs).toEqual([]);
  });
});
