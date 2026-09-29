import { describe, expect, test } from 'bun:test';
import { loadingStatus, SLOW_AFTER_MS } from './ApprovalsLoading';

describe('approvals loading status', () => {
  test('names what it waits on and ticks a clock', () => {
    expect(loadingStatus(0, 'open', null)).toEqual({ title: 'GitHub 에서 승인 대기 PR 을 읽고 있습니다', clock: '0.0초', hint: null });
    expect(loadingStatus(3_240, 'open', 21449).title).toContain('#21449');
    expect(loadingStatus(3_240, 'open', 21449).clock).toBe('3.2초');
    expect(loadingStatus(1_000, 'merged', null).title).toContain('머지된');
  });

  test('says it is still alive once it runs long', () => {
    expect(loadingStatus(SLOW_AFTER_MS - 1, 'open', null).hint).toBeNull();
    expect(loadingStatus(SLOW_AFTER_MS, 'open', null).hint).toContain('멈추지 않았습니다');
  });
});

test('renders a spinner, a live clock and placeholder cards (not a single static line)', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { ApprovalsLoading } = await import('./ApprovalsLoading');
  const html = renderToStaticMarkup(createElement(ApprovalsLoading, { view: 'open', target: 21449 }));
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('animate-spin');
  expect(html).toContain('0.0초');
  expect(html).toContain('#21449');
  expect((html.match(/animate-pulse/g) ?? []).length).toBe(2);
});
