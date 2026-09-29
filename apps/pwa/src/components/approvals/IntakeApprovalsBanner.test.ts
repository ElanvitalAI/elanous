import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntakeApprovalsBannerView, pendingApprovals } from './IntakeApprovalsBanner';

const item = (number: number, changes: Partial<{ title: string; state: string; draft: boolean }> = {}) => ({
  number, title: `아이디어 ${number}`, state: 'OPEN', draft: false, ...changes,
});

test('only open, ready PRs count as pending', () => {
  expect(pendingApprovals([item(1), item(2, { draft: true }), item(3, { state: 'MERGED' })]).map((i) => i.number)).toEqual([1]);
});

test('renders nothing when there is nothing to approve', () => {
  expect(renderToStaticMarkup(createElement(IntakeApprovalsBannerView, { items: [] }))).toBe('');
  expect(renderToStaticMarkup(createElement(IntakeApprovalsBannerView, { items: [item(9, { draft: true })] }))).toBe('');
});

test('shows the count, links to the tab and to each PR, and folds past three', () => {
  const html = renderToStaticMarkup(createElement(IntakeApprovalsBannerView, { items: [item(21239), item(21299), item(3), item(4)] }));
  expect(html).toContain('승인 대기 4건');
  expect(html).toContain('href="/approvals"');
  expect(html).toContain('href="/approvals?pr=21239"');
  expect(html).toContain('href="/approvals?pr=21299"');
  expect(html).not.toContain('href="/approvals?pr=4"');
  expect(html).toContain('외 1건');
});
