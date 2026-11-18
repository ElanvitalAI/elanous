// ── 약속 추출 시험 — fixture 양성·음성 ⊕ 묶음 답 (ELN-COMMITMENT-LEDGER · I1) ──
import { describe, expect, test } from 'bun:test';
import { classifyCommitmentSentence, commitmentCandidateSentences, extractCommitments } from './commitment-extract.js';
import { NEGATIVE_COMMITMENTS, POSITIVE_COMMITMENTS } from './commitment-extract.fixtures.js';

describe('commitment-extract · 양성 fixture', () => {
  for (const fx of POSITIVE_COMMITMENTS) {
    test(fx.name, () => {
      const found = extractCommitments(fx.input);
      expect(found).toHaveLength(1);
      expect(found[0]!.pattern).toBe(fx.pattern);
      expect(found[0]!.text).toBe(fx.text);
      expect(found[0]!.waitHint).toEqual(fx.waitHint);
      expect(fx.input).toContain(found[0]!.evidence);
    });
  }
});

describe('commitment-extract · 음성 fixture(오탐 금지)', () => {
  for (const fx of NEGATIVE_COMMITMENTS) {
    test(fx.name, () => {
      expect(extractCommitments(fx.input)).toEqual([]);
    });
  }
});

describe('commitment-extract · 답 전문', () => {
  test('여러 문장 답에서 약속만 — 보고·질문·코드·인용은 버린다', () => {
    const reply = [
      '#38013 리뷰 반영을 끝냈습니다.',
      '```bash',
      'eln msg post --to OP --body "다음 스텝: 이건 명령 예시"',
      '```',
      '> 이어서 진행합니다 — 인용',
      '알겠습니다. 바로 시험을 돌리겠습니다.',
      '다음 스텝: pregate 영수증을 PR 본문에 싣기',
      '이 방향이 맞을까요?',
    ].join('\n');
    const found = extractCommitments(reply);
    expect(found.map(f => f.pattern)).toEqual(['pledge-ko', 'declared-next-step']);
    expect(found.map(f => f.text)).toEqual(['바로 시험을 돌리겠습니다', 'pregate 영수증을 PR 본문에 싣기']);
  });

  test('같은 약속 두 번은 하나로', () => {
    const found = extractCommitments('다음 스텝: 착지 확인\n- 다음 스텝: 착지 확인.');
    expect(found).toHaveLength(1);
  });

  test('빈 답·문자열 아님 = 빈 목록', () => {
    expect(extractCommitments('')).toEqual([]);
    expect(extractCommitments(undefined as unknown as string)).toEqual([]);
  });

  test('후보 문장 — 코드·인용·표·제목 줄은 후보에서 빠진다', () => {
    const sentences = commitmentCandidateSentences('## 제목\n| a | b |\n> 인용\n```\ncode\n```\n본문 한 줄. 둘째 문장.');
    expect(sentences).toEqual(['본문 한 줄.', '둘째 문장.']);
  });

  test('문장 판정은 순수 — 같은 입력 같은 결과', () => {
    const s = '이어서 ELN-SELF-TIMER-WATCH 칸을 진행합니다.';
    expect(classifyCommitmentSentence(s)).toEqual(classifyCommitmentSentence(s));
  });
});
