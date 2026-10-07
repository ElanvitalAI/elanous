import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ROUTE_GUIDANCE_ITEMS, RouteGuidanceList, isSidebarRouteHref, WelcomeHome } from './WelcomeHome';
import { isSidebarViewLink, SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';
import { splitWelcomeRoutes } from './welcome-core-routes';

function decodedHtml(html: string): string {
  return html.replaceAll('&quot;', '"');
}

function routeGuidanceTestId(href: string): string {
  return `route-guidance-${href === '/' ? 'root' : href.slice(1).replaceAll('/', '-')}`;
}

describe('WelcomeHome — core routes and not-found guidance', () => {
  test('MAT2 — a device with no chosen role renders only stable tiles (no beta/tool/ops, no repair list)', () => {
    const html = decodedHtml(renderToStaticMarkup(<WelcomeHome />));
    for (const hidden of ['/approvals', '/scheduler', '/trace', '/intake', '/design-check']) {
      expect(html).not.toContain(`data-testid="${routeGuidanceTestId(hidden)}"`);
    }
    expect(html).toContain(`data-testid="${routeGuidanceTestId('/chat')}"`);
    expect(html).not.toContain('고치는 중인 화면');
  });

  test('renders a welcome-home root with the headline', () => {
    const html = renderToStaticMarkup(<WelcomeHome />);
    expect(html).toContain('data-testid="welcome-home"');
    expect(html).toContain('웰컴 — 어디부터 시작할까요?');
  });

  test('shows core tiles first and nests every other menu tile in the closed all-screens disclosure', () => {
    const html = decodedHtml(renderToStaticMarkup(<WelcomeHome role="owner" />));
    // 보기 링크(`?view=`)는 주소 안내에 없다 — 그 경로 타일이 이미 있다.
    const { core, more } = splitWelcomeRoutes([...SIDEBAR_NAV_ITEMS.filter((item) => !isSidebarViewLink(item.href)), { href: '/setup' }]);
    expect(html).toContain('aria-label="핵심 화면"');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open=""');
    expect(html).toContain(`모든 화면 (${more.length})`);
    const disclosure = html.indexOf('<details');
    for (const item of core) {
      expect(html.indexOf(`data-testid="${routeGuidanceTestId(item.href)}"`)).toBeLessThan(disclosure);
    }
    for (const item of more) {
      expect(html.indexOf(`data-testid="${routeGuidanceTestId(item.href)}"`)).toBeGreaterThan(disclosure);
    }
    expect(html).not.toContain('참고 주소');
    expect(html).not.toContain('data-route-kind="reference"');
    expect(html).toContain('고치는 중인 화면');
    for (const href of ['/morning', '/settings/devices', '/workflows/chat-ui']) {
      expect(html.indexOf(`data-testid="${routeGuidanceTestId(href)}"`)).toBeGreaterThan(html.indexOf('고치는 중인 화면'));
    }
  });

  test('keeps full menu and non-menu references on the not-found guidance list', () => {
    const html = decodedHtml(renderToStaticMarkup(<RouteGuidanceList ariaLabel="이동 가능한 주소와 참고 주소" />));
    for (const item of ROUTE_GUIDANCE_ITEMS) {
      expect(html.match(new RegExp(`data-testid="${routeGuidanceTestId(item.href)}"`, 'g'))?.length).toBe(1);
      if (item.navigable) expect(html).toContain(`href="${item.href}"`);
      else {
        expect(html).toContain(item.reason!);
        expect(html).not.toContain(`href="${item.href}"`);
      }
    }
  });

  test('accepts only addresses present in the shared route-accounting table', () => {
    for (const route of ROUTE_GUIDANCE_ITEMS) expect(isSidebarRouteHref(route.href)).toBe(true);
    expect(isSidebarRouteHref('/garbage')).toBe(false);
  });

  // This source-name guard only covers direct redirect/router APIs in RootPage;
  // aliases, dynamic property access, and runtime effects need integration coverage.
  test('RootPage executable source names forbid direct automatic navigation APIs', async () => {
    const source = await Bun.file(new URL('../../app/page.tsx', import.meta.url)).text();
    // This examines executable import/call syntax, not comments; aliases, dynamic property access,
    // and runtime effects still require integration coverage.
    const executableSource = source.replace(/^\s*\/\/.*$/gm, '');
    expect(executableSource).not.toMatch(/(?:import\s+\{[^}]*\b(?:redirect|permanentRedirect|useRouter)\b[^}]*\}|\b(?:redirect|permanentRedirect)\s*\(|\buseRouter\s*\()/);
  });
});
