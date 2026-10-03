import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realNavigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
const originalNavigation = { ...realNavigation };
mock.module('next/navigation', () => ({ ...originalNavigation, useRouter: () => ({ push: () => {} }) }));
const { default: TodayPage } = await import('./page');
afterAll(() => { mock.module('next/navigation', () => originalNavigation); });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

test('/today page prerenders without a daemon provider', () => {
  expect(() => renderToStaticMarkup(createElement(TodayPage))).not.toThrow();
});

test('/today page renders the TodayView sections through its actual route entry', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => 'general' },
    addEventListener: () => {}, removeEventListener: () => {},
  } });
  globalThis.fetch = (async (url: string) => new Response(JSON.stringify(
    url.endsWith('/v1/sessions/store') ? { sessions: [], total: 0 } : { items: [] },
  ), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const config = { baseUrl: 'https://nexus.example', token: 'token', provider: '' };
  const client = new DaemonClient(config);
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><TodayPage /></DaemonContext.Provider>);
  });
  expect(tree!.root.findByType('h1').children).toEqual(['오늘']);
  expect(tree!.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['승인 대기', '최근 맡긴 일', '최근 대화']);
  expect(tree!.root.findAllByType('p').map(paragraph => paragraph.children.join(''))).toContain('지금 결정 대기 중인 일이 없습니다.');
});
