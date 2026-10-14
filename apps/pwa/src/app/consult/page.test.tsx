import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { debug } from '../../../../../src/debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../../../../src/elanous-config-dir.js';
import { setTestStateRoot } from '../../../../../src/nexus/paths.js';
import { createNexusState } from '../../../../../src/nexus/state/state.js';
import { TabRegistry } from '../../../../../src/nexus/state/tab-registry.js';
import { NexusEventBus } from '../../../../../src/nexus/api/event-bus.js';
import { startNexusHttpServer } from '../../../../../src/nexus/api/http-server.js';
import ConsultPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
});

async function mount(baseUrl = 'https://nexus.example', token = 'owner-token') {
  const config = { baseUrl, token, provider: '' };
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

test('consented form reaches the running Nexus through real routing, auth, ledger and OP alert', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'consult-live-config-'));
  const ledgerDir = mkdtempSync(join(tmpdir(), 'consult-live-ledger-'));
  const alerts: Array<{ text: string; kind: string }> = [];
  const seen: Array<{ category: string; data?: unknown }> = [];
  const sink = debug.registerSink({ name: 'consult-live-route-test', emit: (row) => { seen.push(row as { category: string; data?: unknown }); } });
  setElanousConfigDir(configDir);
  setTestStateRoot(configDir);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 49600 + Math.floor(Math.random() * 300), portRange: 50,
    metaApi: { bearerToken: 'owner-token', noAuth: false },
    consultRequests: {
      root: () => ledgerDir,
      now: () => '2026-10-02T06:00:00.000Z',
      send: (text: string, kind: string) => { alerts.push({ text, kind }); },
    } });
  try {
    // 익명의 cross-site POST는 실제 인증 관문에 걸려 401로 거부된다.
    const anonymous = await fetch(`${server.url}/v1/consult-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ name: '익명', kind: 'personal', interest: 'A', contact: 'anon@example.com', consent: true }),
    });
    expect(anonymous.status).toBe(401);

    // 폼은 이 실행 중인 서버에 실제 HTTP 제출을 보낸다 — 라우팅 → checkAuth → handleConsultRequests.
    const page = await mount(server.url);
    await change('name', ' 민지 ');
    await change('contact', ' minji@example.com ');
    await change('consent', true);
    await send();
    await Bun.sleep(10);

    // 원장에는 정확히 1건 — 익명 401 탐침은 아무것도 쓰지 않았다.
    const records = readFileSync(join(ledgerDir, 'consult-requests', 'requests.jsonl'), 'utf8').trimEnd().split('\n');
    expect(records).toHaveLength(1);
    const entry = JSON.parse(records[0]!) as { receiptId: string; name: string; org: null; kind: string; interest: string; contact: string; consent: true; receivedAt: string };
    expect(entry).toMatchObject({ name: '민지', org: null, kind: 'personal', interest: 'A', contact: 'minji@example.com', consent: true, receivedAt: '2026-10-02T06:00:00.000Z' });

    // 화면 접수증은 실행 중인 수신 경로가 돌려준 접수증 그 자체다.
    expect(page.findByProps({ role: 'status' }).children.join('')).toBe(`접수했습니다 · ${entry.receiptId} — 곧 연락드리겠습니다`);

    // 서버의 요청 기록: 같은 접수증이 consult.request accepted로 관측된다.
    expect(seen.some((event) => event.category === 'consult.request'
      && (event.data as { receiptId?: string }).receiptId === entry.receiptId)).toBe(true);

    // OP 알림 — 원본 연락처는 알림에 없다.
    expect(alerts).toEqual([{ text: `📮 상담 문의 ${entry.receiptId} · 민지(개인) · 관심 A\n앱에서 보기`, kind: 'ops-alert' }]);
    expect(JSON.stringify(alerts)).not.toContain(entry.contact);
  } finally {
    server.stop();
    sink();
    resetElanousConfigDir();
    setTestStateRoot(null);
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
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

test('journal failure is displayed as a failure, never as a receipt', async () => {
  globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'journal-unavailable' }), { status: 503 })) as typeof fetch;
  const root = await mount();
  await change('name', '민지');
  await change('contact', 'minji@example.com');
  await change('consent', true);
  await send();
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('접수하지 못했습니다. 서버 또는 연결 상태를 확인하고 다시 보내 주세요.');
  expect(root.findAllByProps({ role: 'status' })).toHaveLength(0);
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
