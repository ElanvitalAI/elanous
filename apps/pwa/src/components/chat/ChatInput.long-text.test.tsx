// ChatInput — DEMO-1121-WEBCHAT-LONG-TEXT red tests.
// 수만 자(강의 노트: 표·종목명·수치) 붙여넣기가 멈추거나 잘리면 안 된다.
// 폴드 레이블 레이아웃 · 응답 스트리밍 표시 필요. iOS 제외.

import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatInput } from './ChatInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ——— 시험 리터럴: «주식 전문가 강의 노트» 꼴 장문 (표·종목명·수치, ≥ 20,000자) ———
const TICKERS = ['삼성전자', 'SK하이닉스', 'LG에너지솔루션', '네이버', '카카오', '현대차', '기아', '셀트리온', '포스코홀딩스', 'KB금융'];
function buildLectureNotes(): string {
  const lines: string[] = [
    '주식 전문가 강의 노트 — 2026년 11월 16일 (수만 자 붙여넣기 시험용 리터럴)',
    '',
    '| 종목명 | 시가 | 고가 | 저가 | 종가 | 거래량 | 등락률 | PER | PBR |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (let i = 0; i < 640; i++) {
    const t = TICKERS[i % TICKERS.length]!;
    const base = 25000 + ((i * 137) % 90000);
    lines.push(`| ${t} | ${base} | ${base + 1200} | ${base - 900} | ${base + 300} | ${String(120000 + i * 37)}주 | ${(((i * 7) % 21) - 10).toFixed(2)}% | ${(4 + (i % 30)).toFixed(1)} | ${(0.4 + (i % 12) / 10).toFixed(2)} |`);
    lines.push('');
    lines.push(`· ${t} ${i + 1}번째 관찰: 외국인 순매수 ${String((i * 13) % 3000 - 1500)}주, 기관 순매수 ${String((i * 29) % 4000 - 2000)}주, 투자자별 잔고 변동은 표의 ${i + 1}행과 대응한다.`);
    lines.push(`· 재무: 매출 ${String(base * 12)}억, 영업이익 ${String(base * 2)}억, 순이익 ${String(base * 3)}억, 부채비율 ${String(30 + (i % 60))}%, 유보율 ${String(200 + (i % 700))}%.`);
    lines.push(`· 밸류에이션: 목표가 ${base + 5000}원 (Buy), 12개월 예상 수익률 ${String(8 + (i % 25))}%, 시장대비 초과수익 ${String((i % 11) - 5)}% 포인트.`);
    lines.push('');
  }
  lines.push('— 이상: 강의 노트 끝. 붙여넣기가 이 전문을 한 글자도 잃지 않고 통과해야 한다.');
  const text = lines.join('\n');
  if (text.length < 20000) throw new Error(`lecture notes literal too short: ${text.length}`);
  return text;
}
const LECTURE_NOTES = buildLectureNotes();

const mount = async (onSubmit: (text: string) => void) => {
  const daemon = {
    client: { listSeatRequests: async () => ({ items: [], seats: [] }) } as never,
    config: { baseUrl: '', token: '', provider: '' },
    sessionId: '', setSessionId: () => {}, setConfig: () => {},
  };
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={onSubmit} /></DaemonContext.Provider>);
  });
  return tree;
};

describe('DEMO-1121-WEBCHAT-LONG-TEXT · ChatInput 수만 자 붙여넣기', () => {
  test('수만 자 강의 노트 리터럴이 최소 2만 자를 넘는다', () => {
    expect(LECTURE_NOTES.length).toBeGreaterThanOrEqual(20000);
    expect(LECTURE_NOTES).toContain('주식 전문가 강의 노트');
    expect(LECTURE_NOTES).toContain('| 삼성전자 |');
  });

  test('수만 자 붙여넣기: textarea 가 전문을 한 글자도 자르지 않는다', async () => {
    const sent: string[] = [];
    let tree!: ReturnType<typeof create>;
    await (async () => { tree = await mount((text) => { sent.push(text); }); })();
    try {
      const textarea = tree.root.findByType('textarea');
      expect(textarea.props.maxLength).toBeUndefined();
      await act(async () => { textarea.props.onChange({ target: { value: LECTURE_NOTES } }); });
      const after = tree.root.findByType('textarea');
      // 붙여넣은 값이 그대로 composer state 에 남아야 한다 (잘림 0).
      expect(after.props.value).toBe(LECTURE_NOTES);
      // Enter 로 제출 시 onSubmit 이 전문을 받아야 한다 (멈춤 없이).
      await act(async () => { after.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      expect(sent).toEqual([LECTURE_NOTES]);
    } finally {
      await act(async () => { tree.unmount(); });
    }
  });

  test('RED: 폴드 레이블 — 긴 초안은 접힌 프리뷰 + 펼치기 레이블을 제공한다', async () => {
    let tree!: ReturnType<typeof create>;
    await (async () => { tree = await mount(() => {}); })();
    try {
      await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: LECTURE_NOTES } }); });
      // composer 는 긴 값을 접는 fold 콘테이너와 «펼치기/접기» 레이블을 노출해야 한다.
      const folds = tree.root.findAll((node) => typeof node.props?.['data-elanous-composer-fold'] === 'string');
      expect(folds.length).toBeGreaterThan(0);
      const labels = tree.root.findAll((node) => typeof node.props?.['data-elanous-composer-fold-label'] === 'string');
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.some((node) => node.children.join('').includes('펼치기') || node.children.join('').includes('접기'))).toBe(true);
    } finally {
      await act(async () => { tree.unmount(); });
    }
  });

  test('RED: 스트리밍 표시 — 제출 후 응답 대기 중 composer 는 스트리밍 라인을 표시한다', async () => {
    let resolveReply!: () => void;
    const pending = new Promise<void>((resolve) => { resolveReply = resolve; });
    let tree!: ReturnType<typeof create>;
    await (async () => { tree = await mount(() => { /* in-flight: submit never settles until resolveReply */ }); })();
    try {
      const textarea = tree.root.findByType('textarea');
      await act(async () => { textarea.props.onChange({ target: { value: LECTURE_NOTES } }); });
      await act(async () => { textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); });
      // 제출 직후(응답 스트리밍 중) composer 는 aria-live 스트리밍 상태 라인을 표시해야 한다.
      const streaming = tree.root.findAll((node) =>
        typeof node.props?.['data-elanous-composer-streaming'] === 'string'
        || (node.props?.['aria-live'] === 'polite' && node.children.join('').includes('스트리밍')));
      expect(streaming.length).toBeGreaterThan(0);
      resolveReply();
    } finally {
      resolveReply?.();
      await act(async () => { tree.unmount(); });
    }
  });
});
