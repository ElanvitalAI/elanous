import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import MemberInvitePage from './page';

const oldProfile = { member: { handle: null, canClaimHandle: true }, inviteLink: null, referralCount: 2 };

test('claiming a public member ID updates the share link and closes the one-time form', async () => {
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  let resolveRead: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ handle: 'ElanvitalAI', inviteLink: 'https://app.example.test/r/ElanvitalAI' })
    : new Promise<Response>(resolve => { resolveRead = resolve; })) as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { root = create(createElement(NexusProvider, { client: { baseUrl: 'https://api.example.test' } as never, children: createElement(MemberInvitePage) })); });
    expect(resolveRead).toBeDefined();
    await act(async () => { resolveRead!(Response.json(oldProfile)); });
    const field = root!.root.findByProps({ id: 'member-public-id' });
    await act(async () => { field.props.onChange({ currentTarget: { value: 'ElanvitalAI' } }); });
    // The form submits the claim; the old public ID remains a server alias.
    const form = root!.root.findByType('form');
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(root!.root.findByProps({ id: 'member-invite-link' }).props.value).toBe('https://app.example.test/r/ElanvitalAI');
    expect(root!.root.findAllByProps({ id: 'member-public-id' })).toHaveLength(0);
  } finally {
    if (root) await act(async () => root!.unmount());
    globalThis.fetch = priorFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});

test('invite page shows the public member ID, referral count and share link', async () => {
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  globalThis.fetch = (async () => Response.json({ member: { handle: 'ElanvitalAI', canClaimHandle: false },
    inviteLink: 'https://app.example.test/r/ElanvitalAI', referralCount: 2 })) as unknown as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { root = create(createElement(NexusProvider, { client: { baseUrl: 'https://api.example.test' } as never, children: createElement(MemberInvitePage) })); });
    expect(root!.root.findAllByProps({ role: 'status' }).map(node => node.children.join(''))).toContain('내 링크로 가입한 회원 2명');
    expect(root!.root.findByProps({ id: 'member-invite-link' }).props.value).toBe('https://app.example.test/r/ElanvitalAI');
    expect(root!.root.findByProps({ children: 'ElanvitalAI' })).toBeDefined();
  } finally {
    if (root) await act(async () => root!.unmount());
    globalThis.fetch = priorFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});
