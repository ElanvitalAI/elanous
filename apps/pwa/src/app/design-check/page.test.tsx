import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DesignCheckPage from './page';

test('/design-check offers a clear return path to App Studio', () => {
  const html = renderToStaticMarkup(createElement(DesignCheckPage));
  expect(html).toContain('href="/apps"');
  expect(html).toContain('앱 스튜디오');
});
