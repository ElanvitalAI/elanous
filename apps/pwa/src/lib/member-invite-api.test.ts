import { expect, test } from 'bun:test';
import { createMemberInviteApi, memberExampleKitMailto } from './member-invite-api';

test('invite client reads only a public member ID link and claims a one-time handle', async () => {
  const calls: Array<{ url: string; method: string; credentials: RequestCredentials | undefined; body?: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', credentials: init?.credentials, body: String(init?.body ?? '') });
    return init?.method === 'PUT'
      ? Response.json({ handle: 'ElanvitalAI', inviteLink: 'https://app.example.test/r/ElanvitalAI' })
      : Response.json({ member: { handle: null, canClaimHandle: true },
        inviteLink: null, referralCount: 2 });
  }) as typeof fetch;
  const api = createMemberInviteApi('https://api.example.test/', fetchImpl);
  expect(await api.read()).toEqual({ link: null, handle: null, canClaimHandle: true, referralCount: 2 });
  expect(await api.claim('ElanvitalAI')).toEqual({ link: 'https://app.example.test/r/ElanvitalAI', handle: 'ElanvitalAI' });
  expect(calls).toEqual([
    { url: 'https://api.example.test/v1/members', method: 'GET', credentials: 'include', body: '' },
    { url: 'https://api.example.test/v1/members/handle', method: 'PUT', credentials: 'include', body: '{"handle":"ElanvitalAI"}' },
  ]);
});

test('invite client rejects a legacy code link in the default sharing slot', async () => {
  const fetchImpl = (async () => Response.json({ member: { handle: 'ElanvitalAI', canClaimHandle: false },
    inviteLink: 'https://app.example.test/app/signup?referralCode=old', referralCount: 0 })) as unknown as typeof fetch;
  expect(createMemberInviteApi('https://api.example.test', fetchImpl).read()).rejects.toThrow('초대 링크 주소');
});

test('example-kit mail draft carries the public member ID link', () => {
  const link = 'https://app.example.test/r/ElanvitalAI';
  const draft = new URL(memberExampleKitMailto(link));
  expect(draft.protocol).toBe('mailto:');
  expect(draft.searchParams.get('body')).toContain(link);
  expect(draft.searchParams.get('body')).not.toContain('referralCode');
});
