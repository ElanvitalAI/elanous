import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import NotFound from './not-found';

describe('NotFound — retained route guidance', () => {
  test('identifies the missing location without calling itself the default entry', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('data-testid="not-found"');
    expect(html).toContain('여기엔 없습니다');
    expect(html).toContain('알 수 없는 주소');
    expect(html).not.toContain('기본 진입 화면');
  });

  test('links only to the six retained screens', () => {
    const html = renderToStaticMarkup(<NotFound />);
    for (const path of ['/term', '/chat', '/live-run', '/vault', '/settings', '/editor']) expect(html).toContain(`href="${path}"`);
    for (const path of ['/today', '/approvals', '/scheduler', '/workspace', '/market', '/setup']) expect(html).not.toContain(`href="${path}"`);
  });
});
