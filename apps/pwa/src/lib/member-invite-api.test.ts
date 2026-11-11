import { expect, test } from 'bun:test';
import { createMemberInviteApi, memberExampleKitMailto } from './member-invite-api';

test('member invite client uses a credentialed profile read and rotation, then clears a revoked link', async () => {
  const calls: Array<{ url: string; method: string; credentials: RequestCredentials | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', credentials: init?.credentials });
    return Response.json({ inviteLink: init?.method === 'DELETE' ? null : 'https://app.example.test/app/signup?referralCode=abc', referralCount: 2 });
  }) as typeof fetch;
  const api = createMemberInviteApi('https://api.example.test/', fetchImpl);
  expect(await api.read()).toEqual({ link: 'https://app.example.test/app/signup?referralCode=abc', referralCount: 2 });
  expect(await api.rotate()).toBe('https://app.example.test/app/signup?referralCode=abc');
  await api.revoke();
  expect(calls).toEqual([
    { url: 'https://api.example.test/v1/members', method: 'GET', credentials: 'include' },
    { url: 'https://api.example.test/v1/members/referral-code', method: 'POST', credentials: 'include' },
    { url: 'https://api.example.test/v1/members/referral-code', method: 'DELETE', credentials: 'include' },
  ]);
});

test('example-kit mail draft carries the active invite link without member ID or price', () => {
  const link = 'https://app.example.test/app/signup?referralCode=abc';
  const draft = new URL(memberExampleKitMailto(link));
  expect(draft.protocol).toBe('mailto:');
  expect(draft.searchParams.get('body')).toContain(link);
  expect(draft.searchParams.get('body')).not.toContain('memberId');
});
