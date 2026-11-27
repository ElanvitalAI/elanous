import { describe, expect, test } from 'bun:test';
import { knowhowField, parseKnowhowDoc, parseKnowhowField, seatKnowhowCards } from './index.js';

// Literal fixtures shaped like 내부 문서 `KNOWHOW` — expected values are written out by hand,
// never derived from the kit's own constants.
const DOC = [
  '# OP 노하우',
  '',
  '서두 — 카드 아님.',
  '',
  '## K-OP-012 착지 거부는 rebase 한 줄로 (2026-10-01)',
  '- 상황: 리뷰가 main 보다 뒤라며 거부한다.',
  '- 처방(힐링): 앞머리에 rebase 를 넣는다.',
  '### 처방: 세부 사다리',
  '- 재는 명령: `git rev-list --count ..origin/main`',
  '- 검증: 2026-10-01 참 (OP)',
  '- 출처: OP #1 · 상태: active. · 종류: playbook',
  '',
  '## K-OP-PR-01 draft 정리 바퀴 (2026-10-22)',
  '- 출처: 회의 · 상태: unproven(운영 확인 대기)',
  '',
  '## K-OP-7a 잘못된 제목',
  '- 출처: 상태: active',
  '',
  '## K-TC-3: 다른 자리 카드',
  '- 상태: stale',
  '- 검증: 2026-09-02 거짓',
  '',
  '## 부록 — 카드 아님',
  '- 출처: 상태: active',
  '',
  '## K-OP-013 상태 없는 카드',
  '- 검증: 2026-10-05 참 (OP)',
  '- 검증: 날짜 없음',
  '```',
  '- 상태: active',
  '## K-OP-999 울타리 안 제목',
  '```',
  '- 출처: 회의',
].join('\n');

describe('kit/knowhow parseKnowhowDoc', () => {
  const doc = parseKnowhowDoc(DOC);

  test('cards are K-<seat>[-<sub>]-<n> headings; the preamble and non-card sections are not cards', () => {
    expect(doc.cards.map(c => c.id)).toEqual(['K-OP-012', 'K-OP-PR-01', 'K-TC-3', 'K-OP-013']);
    expect(doc.malformed).toEqual([{ line: 16, id: 'K-OP-7a' }]);
  });

  test('id parts, title and heading line', () => {
    const pr = doc.cards[1]!;
    expect([pr.seat, pr.sub, pr.num, pr.line]).toEqual(['OP', 'PR', 1, 13]);
    expect(doc.cards[2]!.title).toBe('다른 자리 카드');
    expect(doc.cards[0]!.title).toBe('착지 거부는 rebase 한 줄로 (2026-10-01)');
  });

  test('a ### subsection stays inside the card and its fields count', () => {
    const card = doc.cards[0]!;
    expect(card.text).toContain('### 처방: 세부 사다리');
    expect(card.text.startsWith('## K-OP-012 착지 거부는')).toBe(true);
    expect(card.text.endsWith('상태: active. · 종류: playbook')).toBe(true);
    expect(knowhowField(card, '재는 명령')).toBe('`git rev-list --count ..origin/main`');
    expect(knowhowField(card, /^처방(?:\(힐링\))?$/)).toBe('앞머리에 rebase 를 넣는다.');
  });

  test('상태 is the first ASCII word: «active.» and «unproven(…)» read cleanly', () => {
    expect(doc.cards[0]!.status).toBe('active');
    expect(doc.cards[1]!.status).toBe('unproven');
    expect(doc.cards[2]!.status).toBe('stale');
  });

  test('종류 and 검증', () => {
    const card = doc.cards[0]!;
    expect(card.kind).toBe('playbook');
    expect(card.kindDeclared).toBe(true);
    expect(card.verified).toBe(true);
    expect(card.verifiedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const tc = doc.cards[2]!;
    expect(tc.verified).toBe(false);
    expect(tc.kind).toBe('fact');
    expect(tc.kindDeclared).toBe(false);
  });

  test('a later malformed 검증 clears an earlier 참; fenced lines are neither fields nor headings', () => {
    const card = doc.cards[3]!;
    expect(card.hasVerification).toBe(true);
    expect(card.verified).toBe(null);
    expect(card.verifiedAt).toBe(null);
    expect(card.status).toBe('');
    expect(card.text).toContain('## K-OP-999 울타리 안 제목');
    expect(card.prose.map(([n]) => n)).toEqual([27, 28, 33]);
    expect(card.fields.map(f => f.label)).toEqual(['검증', '검증', '출처']);
  });
});

describe('kit/knowhow modes and helpers', () => {
  test('endAtAnyHeading stops a card at ###', () => {
    const lint = parseKnowhowDoc(DOC, { endAtAnyHeading: true });
    const card = lint.cards[0]!;
    expect(card.text).not.toContain('재는 명령');
    expect(card.status).toBe('');
    expect(lint.malformed.map(m => m.id)).toEqual(['K-OP-7a']);
  });

  test('seatKnowhowCards filters by seat (case-insensitive) and drops sub-track cards unless asked', () => {
    expect(seatKnowhowCards(DOC, 'op').map(c => c.id)).toEqual(['K-OP-012', 'K-OP-013']);
    expect(seatKnowhowCards(DOC, 'OP', { withSub: true }).map(c => c.id)).toEqual(['K-OP-012', 'K-OP-PR-01', 'K-OP-013']);
    expect(seatKnowhowCards(DOC, 'TC').map(c => c.id)).toEqual(['K-TC-3']);
  });

  test('a named seat reads hyphenated loop-agent ids; the generic grammar calls them malformed', () => {
    const doc = '## K-JUDGE-BUTLER-001 같은 head 영수\n- 검증: 2026-11-27 참 (JUD)\n- 출처: 시드 · 상태: active\n\n## K-JUDGE-BUTLER-002: 두 번째\n- 출처: 시드 · 상태: unproven\n';
    const cards = seatKnowhowCards(doc, 'JUDGE-BUTLER');
    expect(cards.map(c => [c.id, c.seat, c.sub, c.num, c.status])).toEqual([
      ['K-JUDGE-BUTLER-001', 'JUDGE-BUTLER', null, 1, 'active'],
      ['K-JUDGE-BUTLER-002', 'JUDGE-BUTLER', null, 2, 'unproven'],
    ]);
    expect(parseKnowhowDoc(doc).malformed.map(m => m.id)).toEqual(['K-JUDGE-BUTLER-001', 'K-JUDGE-BUTLER-002']);
  });

  test('CRLF documents and an empty document', () => {
    const crlf = parseKnowhowDoc('## K-UX-1 제목\r\n- 상태: active\r\n- 검증: 2026-10-12 못잼\r\n');
    expect(crlf.cards[0]!.status).toBe('active');
    expect(crlf.cards[0]!.verifiedAt?.toISOString().slice(0, 10)).toBe('2026-10-12');
    expect(crlf.cards[0]!.verified).toBe(null);
    expect(parseKnowhowDoc('')).toEqual({ cards: [], malformed: [] });
  });

  test('an impossible calendar date leaves verifiedAt null', () => {
    const card = parseKnowhowDoc('## K-OP-104 없는 날짜\n- 검증: 2026-09-31 참 (OP)\n- 출처: 상태: active').cards[0]!;
    expect(card.verified).toBe(true);
    expect(card.verifiedAt).toBe(null);
  });

  test('parseKnowhowField reads `-`/`*` bullets and refuses non-fields', () => {
    expect(parseKnowhowField('- 재는 명령: eln ops status')).toEqual({ label: '재는 명령', value: 'eln ops status' });
    expect(parseKnowhowField('* 출처: 회의')).toEqual({ label: '출처', value: '회의' });
    expect(parseKnowhowField('본문 문장: 필드 아님')).toBe(null);
    expect(parseKnowhowField('---')).toBe(null);
  });
});
