import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import MemberInvitePage from './page';

test('a late initial read cannot replace a freshly rotated invite link', async () => {
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  let resolveRead: ((response: Response) => void) | undefined;
  const oldLink = 'https://app.example.test/app/signup?referralCode=oldCode';
  const newLink = 'https://app.example.test/app/signup?referralCode=newCode';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ inviteLink: newLink }, { status: 201 });
    return new Promise<Response>(resolve => { resolveRead = resolve; });
  }) as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { root = create(createElement(NexusProvider, { client: { baseUrl: 'https://api.example.test' } as never, children: createElement(MemberInvitePage) })); });
    expect(resolveRead).toBeDefined();
    await act(async () => { await root!.root.findByProps({ children: '새 초대 링크 발급' }).props.onClick(); });
    expect(root!.root.findByType('input').props.value).toBe(newLink);
    await act(async () => { resolveRead!(Response.json({ inviteLink: oldLink, referralCount: 1 })); });
    expect(root!.root.findByType('input').props.value).toBe(newLink);
  } finally {
    if (root) await act(async () => root!.unmount());
    globalThis.fetch = priorFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});

test('member invite page displays the server referral count', async () => {
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  globalThis.fetch = (async () => Response.json({ inviteLink: null, referralCount: 3 })) as unknown as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { root = create(createElement(NexusProvider, { client: { baseUrl: 'https://api.example.test' } as never, children: createElement(MemberInvitePage) })); });
    expect(root!.root.findAllByProps({ role: 'status' }).map(node => node.children.join(''))).toContain('내 링크로 가입한 회원 3명');
  } finally {
    if (root) await act(async () => root!.unmount());
    globalThis.fetch = priorFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});

test('rotation hides the old link and QR before the server responds', async () => {
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const oldLink = 'https://app.example.test/app/signup?referralCode=oldCode';
  const newLink = 'https://app.example.test/app/signup?referralCode=newCode';
  let resolveRotate: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { resolveRotate = resolve; })
    : Response.json({ inviteLink: oldLink, referralCount: 1 })) as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      root = create(createElement(NexusProvider, { client: { baseUrl: 'https://api.example.test' } as never, children: createElement(MemberInvitePage) }));
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    expect(root!.root.findByType('input').props.value).toBe(oldLink);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    expect(root!.root.findAllByType('img')).toHaveLength(1);
    let rotation: Promise<void> | undefined;
    act(() => { rotation = root!.root.findByProps({ children: '재발급' }).props.onClick(); });
    expect(resolveRotate).toBeDefined();
    expect(root!.root.findAllByType('img')).toHaveLength(0);
    expect(root!.root.findAllByType('input')).toHaveLength(0);
    await act(async () => { resolveRotate!(Response.json({ inviteLink: newLink }, { status: 201 })); await rotation; });
    expect(root!.root.findByType('input').props.value).toBe(newLink);
  } finally {
    if (root) await act(async () => root!.unmount());
    globalThis.fetch = priorFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});
