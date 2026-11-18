import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DeviceConnectGate, passesGate } from './DeviceConnectGate';
import { PROBE_TIMEOUT_MS, probeDeviceAuth, type DeviceAuth } from '@/lib/device-auth';
import { authRequiredNow, reportAuthRequired, resetAuthRequiredForTests } from '@/lib/auth-required';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let hash = '';
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  } });
  // `location` stays a live getter (Object.assign would copy today's value): a test sets `hash` before mounting.
  const fakeWindow = Object.assign(new EventTarget(), { localStorage });
  Object.defineProperty(fakeWindow, 'location', { get: () => ({ hash, search: '', origin: 'http://nexus.test' }) });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
});
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  hash = '';
  resetAuthRequiredForTests();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as { window?: unknown }).window;
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** Mount the gate over a child that records whether it ever mounted (a mounted screen sends its own requests). */
async function mount(answers: DeviceAuth[], pathname = '/chat', reprobeGapMs = 0) {
  const mounted: string[] = [];
  const probes: string[] = [];
  const tokens: string[] = [];
  const probe = (async (config?: { token: string }) => { probes.push(config?.token ?? ''); return answers.shift() ?? 'unconnected'; }) as typeof probeDeviceAuth;
  function Screen() { mounted.push('screen'); return createElement('p', { 'data-screen': '' }, 'chat'); }
  function Host() {
    const [token, setToken] = useState('');
    const daemon = { client: {} as never, config: { baseUrl: '', token, provider: '' }, sessionId: '',
      setSessionId: () => {}, setConfig: (next: { token?: string }) => {
        if (next.token !== undefined) { tokens.push(next.token); localStorage.setItem('elanous.daemon.token', next.token); setToken(next.token); }
      } };
    return createElement(DaemonContext.Provider, { value: daemon as never },
      createElement(DeviceConnectGate, { probe, reprobeGapMs, children: createElement(Screen) }));
  }
  await act(async () => { tree = create(createElement(PathnameContext.Provider, { value: pathname }, createElement(Host))); });
  await act(async () => {});
  return { mounted, probes, tokens, root: () => tree!.root };
}

describe('WEB-FIRST-CONNECT-ONBOARDING · probe', () => {
  const answer = (status: number | Error) => ({ fetchResponse: async () => {
    if (status instanceof Error) throw status;
    return new Response('{}', { status });
  } });
  test('no answer within the limit = unreachable (the app mounts instead of a blank screen)', async () => {
    const hanging = { fetchResponse: () => new Promise<Response>(() => {}) };
    const started = Date.now();
    expect(await probeDeviceAuth({ baseUrl: '', token: '', provider: '' }, hanging, 30)).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
  });

  test('401 = unconnected · 2xx = connected · 5xx or network failure = unreachable (not an auth answer)', async () => {
    const config = { baseUrl: '', token: '', provider: '' };
    expect(await probeDeviceAuth(config, answer(401))).toBe('unconnected');
    expect(await probeDeviceAuth(config, answer(200))).toBe('connected');
    expect(await probeDeviceAuth(config, answer(503))).toBe('unreachable');
    expect(await probeDeviceAuth(config, answer(new TypeError('offline')))).toBe('unreachable');
  });
  test('the connect link (#t=els_…) and /setup pass the gate; other routes do not', () => {
    expect(passesGate('/live-run', '#t=els_abc')).toBe(true);
    expect(passesGate('/setup/done', '')).toBe(true);
    expect(passesGate('/chat', '')).toBe(false);
    expect(passesGate('/chat', '#t=not-a-setup-token')).toBe(false);
  });
});

describe('WEB-FIRST-CONNECT-ONBOARDING · gate', () => {
  test('no token: one connect screen and the screens never mount (no other request)', async () => {
    const ui = await mount(['unconnected']);
    expect(ui.mounted).toEqual([]);
    const screen = ui.root().findByProps({ 'data-elanous-connect-gate': 'unconnected' });
    expect(JSON.stringify(screen.findAllByType('h1').map((node) => node.children))).toContain('이 기기를 연결해야 합니다');
    expect(JSON.stringify(tree!.toJSON())).toContain('eln nexus pwa connect-link');
  });

  test('connected: the screens mount once the answer arrives', async () => {
    const ui = await mount(['connected']);
    expect(ui.mounted).toContain('screen');
    expect(ui.root().findAllByProps({ 'data-elanous-connect-gate': 'unconnected' })).toHaveLength(0);
  });

  test('a pasted token is saved and probed again; a refused one says so; an accepted one opens the app', async () => {
    const ui = await mount(['unconnected', 'unconnected', 'connected']);
    const paste = async (value: string) => {
      await act(async () => ui.root().findByType('input').props.onChange({ target: { value } }));
      await act(async () => ui.root().findByType('form').props.onSubmit({ preventDefault() {} }));
      await act(async () => {});
    };
    await paste('wrong');
    expect(ui.tokens).toEqual(['wrong']);
    expect(JSON.stringify(tree!.toJSON())).toContain('이 토큰으로는 연결되지 않았습니다');
    expect(ui.mounted).toEqual([]);
    await paste('right');
    expect(ui.tokens).toEqual(['wrong', 'right']);
    expect(ui.mounted).toContain('screen');
  });

  test('token expired mid-session: a later 401 asks again, and the device refusal brings the connect screen', async () => {
    const ui = await mount(['connected', 'unconnected']);
    expect(ui.mounted).toContain('screen');
    expect(authRequiredNow()).toBe(false);
    await act(async () => { reportAuthRequired('/v1/sessions/store'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(ui.probes).toHaveLength(2);
    expect(ui.root().findAllByProps({ 'data-elanous-connect-gate': 'unconnected' })).toHaveLength(1);
    expect(ui.root().findAllByProps({ 'data-screen': '' })).toHaveLength(0);
  });

  test('another API\'s 401 while the device is still connected keeps the app (that screen shows its own error)', async () => {
    const ui = await mount(['connected', 'connected']);
    const before = ui.mounted.length;
    await act(async () => { reportAuthRequired('/v1/members/home'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(ui.probes).toHaveLength(2);
    expect(ui.root().findAllByProps({ 'data-elanous-connect-gate': 'unconnected' })).toHaveLength(0);
    expect(ui.root().findAllByProps({ 'data-screen': '' })).toHaveLength(1);
    // Still the same mounted screen: it was never taken down while the device question was asked again.
    expect(ui.mounted).toHaveLength(before);
    // A fresh «connected» answer re-arms the notice, so a real expiry later is caught again.
    expect(authRequiredNow()).toBe(false);
  });

  test('#38209 REVIEW-1 ①: a 401 whose re-check is «unreachable» re-arms the notice, so the next 401 asks again and a refusal still shows the connect screen', async () => {
    const ui = await mount(['connected', 'unreachable', 'unconnected']);
    await act(async () => { reportAuthRequired('/v1/sessions/store'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(ui.probes).toHaveLength(2);
    // Re-armed: the one-shot notice is open again (it used to stay set and swallow every later 401).
    expect(authRequiredNow()).toBe(false);
    expect(ui.root().findAllByProps({ 'data-screen': '' })).toHaveLength(1);
    await act(async () => { reportAuthRequired('/v1/sessions/store'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(ui.probes).toHaveLength(3);
    expect(ui.root().findAllByProps({ 'data-elanous-connect-gate': 'unconnected' })).toHaveLength(1);
  });

  test('unreachable Nexus is not an auth answer: the screens mount and keep their own retry', async () => {
    const ui = await mount(['unreachable']);
    expect(ui.mounted).toContain('screen');
  });

  test('the one-time connect link passes even before the answer', async () => {
    hash = '#t=els_link';
    const ui = await mount(['unconnected'], '/live-run');
    expect(ui.mounted).toContain('screen');
  });
});
