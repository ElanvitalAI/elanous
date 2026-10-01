import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { FastReplyCard } from './FastReplyCard';

test('shows fetched setting and switches it through PUT', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body?: string; auth?: string | null }> = [];
  let enabled = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', body: init?.body as string | undefined, auth: new Headers(init?.headers).get('authorization') });
    if (init?.method === 'PUT') enabled = (JSON.parse(init.body as string) as { enabled: boolean }).enabled;
    return Response.json({ enabled });
  }) as typeof fetch;
  try {
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(FastReplyCard as (props: { connection: { baseUrl: string; token?: string } }) => ReturnType<typeof FastReplyCard>, { connection: { baseUrl: 'http://localhost:31415', token: 'owner' } })); });
    expect(tree!.root.findByType('input').props.checked).toBe(false);
    expect(tree!.root.findByType('input').props.disabled).toBe(false);
    expect(tree!.root.findByType('h2').children.join('')).toBe('짧은 물음은 빠르게');
    await act(async () => { tree!.root.findByType('input').props.onChange({ target: { checked: true } }); });
    expect(tree!.root.findByType('input').props.checked).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', body: undefined, auth: 'Bearer owner' },
      { method: 'PUT', body: '{"enabled":true}', auth: 'Bearer owner' },
    ]);
    await act(async () => { tree!.unmount(); });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed update keeps the last confirmed value and exposes error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ error: 'unavailable' }, { status: 503 })
    : Response.json({ enabled: true })) as typeof fetch;
  try {
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(FastReplyCard as (props: { connection: { baseUrl: string; token?: string } }) => ReturnType<typeof FastReplyCard>, { connection: { baseUrl: 'http://localhost' } })); });
    await act(async () => { tree!.root.findByType('input').props.onChange({ target: { checked: false } }); });
    expect(tree!.root.findByType('input').props.checked).toBe(true);
    expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toBe('HTTP 503');
    await act(async () => { tree!.unmount(); });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
