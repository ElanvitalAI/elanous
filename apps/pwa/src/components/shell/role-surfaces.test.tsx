import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realNavigation from 'next/navigation';
import * as realLink from 'next/link';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { PWA_ROLE_EVENT, PWA_ROLE_KEY, writePwaRole } from '@/lib/pwa-role';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let pathname = '/settings';
const originalNavigation = { ...realNavigation };
const originalLink = { ...realLink };
afterAll(() => {
  mock.module('next/navigation', () => originalNavigation);
  mock.module('next/link', () => originalLink);
});
mock.module('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));

const { MaturityBanner } = await import('./MaturityBanner');
const { PwaRolePicker } = await import('./PwaRolePicker');
const { SidebarNav } = await import('./SidebarNav');
const { WelcomeHome } = await import('../welcome/WelcomeHome');
const { default: SettingsPage } = await import('../../app/settings/page');
const { default: SetupPage } = await import('../../app/setup/page');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

test('the banner follows beta and broken route changes without hiding other routes', () => {
  for (const [path, message] of [
    ['/settings', '베타 — 화면과 동작이 바뀔 수 있습니다.'],
    ['/morning', '이 화면은 지금 고치는 중입니다.'],
    ['/missions/123', '베타 — 화면과 동작이 바뀔 수 있습니다.'],
  ]) {
    pathname = path;
    expect(renderToStaticMarkup(<MaturityBanner />)).toContain(message);
  }
  pathname = '/chat';
  expect(renderToStaticMarkup(<MaturityBanner />)).toBe('');
  pathname = '/approvals';
  expect(renderToStaticMarkup(<MaturityBanner />)).toBe('');
});

test('setup and settings mount the same three-choice picker', () => {
  const setup = renderToStaticMarkup(<SetupPage />);
  expect(setup).toContain('aria-label="화면 역할"');
  expect(setup).toContain('오너');
  expect(setup).toContain('기여자');
  expect(setup).toContain('일반');
  const settings = SettingsPage();
  expect(settings.props.children[0].props.children.type).toBe(PwaRolePicker);
});

test('choosing a role immediately updates the sidebar in the same window', async () => {
  let saved: string | null = 'owner';
  const handlers = new Map<string, Set<EventListener>>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => key === PWA_ROLE_KEY ? saved : null,
        setItem: (key: string, value: string) => { if (key === PWA_ROLE_KEY) saved = value; },
      },
      addEventListener: (name: string, handler: EventListener) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(handler);
      },
      removeEventListener: (name: string, handler: EventListener) => { handlers.get(name)?.delete(handler); },
      dispatchEvent: (event: Event) => { for (const handler of handlers.get(event.type) ?? []) handler(event); return true; },
    },
  });
  await act(async () => { tree = create(<><PwaRolePicker /><SidebarNav /><WelcomeHome /></>); });
  const links = () => tree!.root.findByType('nav').findAllByType('a').map((link) => link.props.href);
  const welcomeLinks = () => tree!.root.findByProps({ 'data-testid': 'welcome-home' }).findAllByType('a').map((link) => link.props.href);
  expect(links()).toContain('/scheduler');
  expect(links()).toContain('/approvals');
  expect(welcomeLinks()).toContain('/approvals');
  const choice = tree!.root.findAllByType('button').find((button) => button.props.children?.some?.((child: { props?: { children?: string } }) => child.props?.children === '일반'))!;
  await act(async () => { choice.props.onClick(); });
  expect(String(saved)).toBe('general');
  expect(links()).toContain('/settings');
  expect(links()).not.toContain('/approvals');
  expect(links()).not.toContain('/scheduler');
  expect(welcomeLinks()).not.toContain('/approvals');
  expect(welcomeLinks()).toContain('/setup');
  await act(async () => { writePwaRole('contributor'); });
  expect(links()).toContain('/approvals');
  expect(welcomeLinks()).toContain('/approvals');
  expect(links()).not.toContain('/scheduler');
  await act(async () => { writePwaRole('owner'); });
  expect(links()).toContain('/scheduler');
  expect(welcomeLinks()).toContain('/scheduler');
  expect(handlers.get(PWA_ROLE_EVENT)?.size).toBeGreaterThan(0);
});

test('MAT2 — with no stored role the sidebar hides beta/tool/ops screens', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    },
  });
  await act(async () => { tree = create(<SidebarNav />); });
  const links = tree!.root.findByType('nav').findAllByType('a').map((link) => link.props.href);
  expect(links).toContain('/chat');
  for (const hidden of ['/approvals', '/scheduler', '/trace', '/intake', '/design-check', '/autopilot', '/vault']) {
    expect(links).not.toContain(hidden);
  }
});
