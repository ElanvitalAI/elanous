import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { renderMemberHomePage, type MemberHomePageInput } from './member-home-page.js';

const member: MemberHomePageInput = {
  name: '회원 A', email: 'a@example.test', publicId: 'elan-member-a',
  referralUrl: 'https://elanous.ai/r/ElanvitalAI',
  membership: { label: '무료 멤버', note: '유료 멤버십은 2027년 2월 시작 예정입니다' },
  connection: { linked: false, startUrl: '/app/connect' }, startUrl: '/app',
  devices: [], nonce: 'fake-nonce',
};

test('signed-in home has one next action, public account data and no key controls', () => {
  const page = renderMemberHomePage(member);
  expect(page).toContain('로그인됨 · 회원 A');
  expect(page).toContain('이 기기를 연결하면 바로 시작할 수 있어요');
  expect(page.match(/class="primary"/g)).toHaveLength(1);
  expect(page).toContain('내 추천 링크 복사');
  expect(page).toContain('무료 멤버');
  expect(page).toContain('2027년 2월 시작 예정');
  expect(page).not.toContain('API 키');
  expect(page).not.toContain('data-action=');
  expect(page).not.toContain('issued-key');
});

test('linked device is read-only and public fields are escaped', () => {
  const page = renderMemberHomePage({ ...member,
    name: '<img src=x onerror=alert(1)>', publicId: 'id" onclick="alert(1)',
    referralUrl: 'javascript:alert(1)',
    connection: { ...member.connection, linked: true },
    devices: [{ name: '내 Mac', kind: 'TUI', lastUsed: '방금' }],
  });
  expect(page).toContain('class="primary" href="/app">엘라누스 시작하기');
  expect(page).toContain('내 Mac');
  expect(page).not.toContain('연결 해제');
  expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(page).toContain('id&quot; onclick=&quot;alert(1)');
  expect(page).not.toContain('<img src=x onerror=alert(1)>');
  expect(page).toContain('id="referral-url">javascript:alert(1)');
});

test('unknown connection and device inventory do not claim that no device exists', () => {
  const page = renderMemberHomePage({ ...member,
    connection: { linked: null, startUrl: 'https://app.example.test/app/connect' },
    startUrl: 'https://app.example.test/app', devices: null,
  });
  expect(page).toContain('연결 상태를 아직 확인하지 못했어요');
  expect(page).toContain('연결 기기 상태를 아직 확인하지 못했어요');
  expect(page).toContain('href="https://app.example.test/app/connect"');
  expect(page).not.toContain('연결된 기기가 없어요');
});

test('copy works after BFCache pagehide and pageshow', async () => {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(renderMemberHomePage(member))?.[1];
  const telegramButton = { disabled: false, addEventListener: () => {} };
  const elements = new Map<string, unknown>([
    ['feedback', { textContent: '' }], ['public-id', { textContent: 'elan-member-a' }],
    ['telegram-issue', telegramButton], ['telegram-copy', { ...telegramButton }],
    ['telegram-command', { textContent: '' }], ['telegram-instructions', { hidden: true }],
    ['telegram-expiry', { textContent: '' }], ['telegram-feedback', { textContent: '' }],
  ]);
  const handlers = new Map<string, (event?: unknown) => void>();
  let copied = '';
  runInNewContext(script!, {
    document: { getElementById: (id: string) => elements.get(id),
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    window: { addEventListener: (name: string, handler: () => void) => handlers.set(name, handler) },
    navigator: { clipboard: { writeText: async (value: string) => { copied = value; } } },
  });
  const button = { dataset: { copy: 'public-id' } };
  const click = () => handlers.get('click')!({ target: { closest: () => button } });
  handlers.get('pagehide')!();
  click();
  await Promise.resolve();
  expect(copied).toBe('');
  handlers.get('pageshow')!();
  click();
  await Promise.resolve();
  expect(copied).toBe('elan-member-a');
});

test('Telegram enrollment uses the signed-in POST, shows a short-lived DM command and clears it on pagehide', async () => {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(renderMemberHomePage(member))?.[1];
  const callbacks = new Map<string, () => void>();
  const element = (id: string) => ({ textContent: '', hidden: true, disabled: false,
    addEventListener: (_name: string, callback: () => void) => callbacks.set(id, callback) });
  const elements = new Map(['feedback', 'telegram-issue', 'telegram-copy', 'telegram-command',
    'telegram-instructions', 'telegram-expiry', 'telegram-feedback'].map(id => [id, element(id)]));
  const windowCallbacks = new Map<string, () => void>();
  const requests: Array<{ url: string; options: RequestInit }> = [];
  let copied = '';
  runInNewContext(script!, {
    document: { getElementById: (id: string) => elements.get(id), addEventListener: () => {} },
    window: { addEventListener: (name: string, callback: () => void) => windowCallbacks.set(name, callback),
      setInterval: () => 1, clearInterval: () => {} },
    navigator: { clipboard: { writeText: async (value: string) => { copied = value; } } },
    fetch: async (url: string, options: RequestInit) => { requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 'a'.repeat(32), expiresInSeconds: 600 }) }; },
  });
  callbacks.get('telegram-issue')!();
  await new Promise(resolve => setImmediate(resolve));
  expect(requests).toEqual([{ url: '/v1/telegram/member-enrollment', options: {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: '{}', cache: 'no-store',
  } }]);
  expect(elements.get('telegram-command')!.textContent).toBe('/connect ' + 'a'.repeat(32));
  expect(elements.get('telegram-instructions')!.hidden).toBe(false);
  callbacks.get('telegram-copy')!();
  await Promise.resolve();
  expect(copied).toBe('/connect ' + 'a'.repeat(32));
  windowCallbacks.get('pagehide')!();
  expect(elements.get('telegram-command')!.textContent).toBe('');
  expect(elements.get('telegram-instructions')!.hidden).toBe(true);
});

test('Telegram code response arriving after pagehide never appears in the restored page', async () => {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(renderMemberHomePage(member))?.[1];
  const callbacks = new Map<string, () => void>();
  const element = (id: string) => ({ textContent: '', hidden: true, disabled: false,
    addEventListener: (_name: string, callback: () => void) => callbacks.set(id, callback) });
  const elements = new Map(['feedback', 'telegram-issue', 'telegram-copy', 'telegram-command',
    'telegram-instructions', 'telegram-expiry', 'telegram-feedback'].map(id => [id, element(id)]));
  const windowCallbacks = new Map<string, () => void>();
  let finishFetch!: (response: unknown) => void;
  runInNewContext(script!, {
    document: { getElementById: (id: string) => elements.get(id), addEventListener: () => {} },
    window: { addEventListener: (name: string, callback: () => void) => windowCallbacks.set(name, callback),
      setInterval: () => 1, clearInterval: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: () => new Promise(resolve => { finishFetch = resolve; }),
  });
  callbacks.get('telegram-issue')!();
  windowCallbacks.get('pagehide')!();
  windowCallbacks.get('pageshow')!();
  finishFetch({ ok: true, status: 200, json: async () => ({ code: 'a'.repeat(32), expiresInSeconds: 600 }) });
  await new Promise(resolve => setImmediate(resolve));
  expect(elements.get('telegram-command')!.textContent).toBe('');
  expect(elements.get('telegram-instructions')!.hidden).toBe(true);
  expect(elements.get('telegram-issue')!.disabled).toBe(false);
});

test('delayed Telegram enrollment never extends the server code lifetime', async () => {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(renderMemberHomePage(member))?.[1];
  const callbacks = new Map<string, () => void>();
  const element = (id: string) => ({ textContent: '', hidden: true, disabled: false,
    addEventListener: (_name: string, callback: () => void) => callbacks.set(id, callback) });
  const elements = new Map(['feedback', 'telegram-issue', 'telegram-copy', 'telegram-command',
    'telegram-instructions', 'telegram-expiry', 'telegram-feedback'].map(id => [id, element(id)]));
  const pending: Array<(response: unknown) => void> = [];
  let now = 1_000_000;
  runInNewContext(script!, {
    document: { getElementById: (id: string) => elements.get(id), addEventListener: () => {} },
    window: { addEventListener: () => {}, setInterval: () => 1, clearInterval: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    Date: { now: () => now },
    fetch: () => new Promise(resolve => { pending.push(resolve); }),
  });
  const response = { ok: true, status: 200,
    json: async () => ({ code: 'a'.repeat(32), expiresInSeconds: 600 }) };
  callbacks.get('telegram-issue')!();
  now += 120_000;
  pending.shift()!(response);
  await new Promise(resolve => setImmediate(resolve));
  expect(elements.get('telegram-expiry')!.textContent).toBe('남은 시간 8분 00초');
  callbacks.get('telegram-issue')!();
  now += 601_000;
  pending.shift()!(response);
  await new Promise(resolve => setImmediate(resolve));
  expect(elements.get('telegram-command')!.textContent).toBe('');
  expect(elements.get('telegram-instructions')!.hidden).toBe(true);
  expect(elements.get('telegram-feedback')!.textContent).toBe('코드가 만료됐어요. 새 코드를 받으세요.');
});
