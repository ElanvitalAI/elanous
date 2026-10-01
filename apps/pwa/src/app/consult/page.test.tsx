import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import ConsultPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
});

async function mount() {
  const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
  const client = new DaemonClient(config);
  await act(async () => {
    tree = create(
      <DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
        <ConsultPage />
      </DaemonContext.Provider>,
    );
  });
  return tree!.root;
}

async function change(name: string, value: string | boolean) {
  await act(async () => {
    tree!.root.findByProps({ name }).props.onChange({ target: { value, checked: value } });
  });
}

async function send() {
  await act(async () => {
    await tree!.root.findByType('form').props.onSubmit({ preventDefault: () => {} });
  });
}

test('consent gates submission; personal enquiry POSTs contract and displays receipt', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ receiptId: 'R-123', receivedAt: '2026-10-02T06:00:00Z' }), { status: 202 });
  }) as typeof fetch;
  const root = await mount();
  const consentLabel = root.findByProps({ name: 'consent' }).parent;
  expect(consentLabel?.findByType('span').children.join('')).toBe('입력한 정보는 상담 연락을 위해 서버로 전송하며, 상담 연락에만 사용합니다');
  expect(root.findByType('button').props.disabled).toBe(true);
  await change('name', ' 민지 ');
  await change('contact', ' minji@example.com ');
  await send();
  expect(calls).toHaveLength(0);
  await change('consent', true);
  expect(root.findByType('button').props.disabled).toBe(false);
  await send();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://nexus.example/v1/consult-requests');
  expect(calls[0]!.init.method).toBe('POST');
  expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer owner-token' });
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: '민지', kind: 'personal', interest: 'A', contact: 'minji@example.com', consent: true });
  expect(root.findByProps({ role: 'status' }).children.join('')).toBe('접수했습니다 · R-123 — 곧 연락드리겠습니다');
});

test('company enquiry includes org and B, and 400 field becomes a human message', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ error: 'bad_request', field: 'org' }), { status: 400 });
  }) as typeof fetch;
  const root = await mount();
  await change('name', '민지');
  await change('contact', '010-0000-5678');
  await change('consent', true);
  await act(async () => { root.findByProps({ name: 'kind', value: 'company' }).props.onChange(); });
  await act(async () => { root.findByProps({ name: 'interest', value: 'B' }).props.onChange(); });
  await change('org', ' ACME ');
  await send();
  expect(bodies).toEqual([{ name: '민지', org: 'ACME', kind: 'company', interest: 'B', contact: '010-0000-5678', consent: true }]);
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('회사명 항목을 확인해 주세요.');
});

test('missing company name is shown before sending', async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string, _init: RequestInit) => { calls++; return new Response('{}', { status: 202 }); }) as typeof fetch;
  const root = await mount();
  await change('name', '민지');
  await change('contact', 'minji@example.com');
  await change('consent', true);
  await act(async () => { root.findByProps({ name: 'kind', value: 'company' }).props.onChange(); });
  await send();
  expect(calls).toBe(0);
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('회사명 항목을 입력해 주세요.');
});


test('shows the consult mail address as a mailto link', async () => {
  const src = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
  expect(src).toContain("CONSULT_EMAIL = 'user@elanvital.ai'");
  expect(src).toContain('href={`mailto:${CONSULT_EMAIL}`}');
  expect(src).not.toContain('hello@elanous.ai');
});
