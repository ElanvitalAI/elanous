import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoevolutionMetricsPanel, DEMO_COEVOLUTION_LEDGER } from './coevolution-metrics';

test('fixed ledger snapshot renders exactly three labeled round cards and their recorded counts', () => {
  const html = renderToStaticMarkup(<CoevolutionMetricsPanel ledger={DEMO_COEVOLUTION_LEDGER} />);
  expect(html).toMatchSnapshot();
  expect(html.match(/aria-label="라운드 [123]"/g)).toHaveLength(3);
  expect(html).toContain('시연용 고정 원장 · 실측 아님');
  expect(html).toContain('aria-label="근거 카드 4"');
  expect(html).toContain('aria-label="남은 빈칸 0"');
  expect(html).toContain('aria-label="통과 수 3"');
});

test('a missing round stays missing and invalid counts cannot appear as measurements', () => {
  const oneRound = renderToStaticMarkup(<CoevolutionMetricsPanel ledger={{
    id: 'ledger-one', label: '원장 1', kind: 'run-ledger',
    rounds: [{ round: 2, evidenceBackedCards: 7, remainingGaps: 1, passedChecks: 0 }],
  }} />);
  expect(oneRound).toContain('aria-label="라운드 2"');
  expect(oneRound).not.toContain('aria-label="라운드 1"');
  expect(oneRound).toContain('aria-label="근거 카드 7"');
  const invalid = renderToStaticMarkup(<CoevolutionMetricsPanel ledger={{
    id: 'bad', label: '잘못된 원장', kind: 'run-ledger',
    rounds: [{ round: 1, evidenceBackedCards: -1, remainingGaps: 0, passedChecks: 0 }],
  }} />);
  expect(invalid).toContain('확인할 수 있는 라운드 원장 값이 없습니다.');
  expect(invalid).not.toContain('근거 카드 -1');
});
