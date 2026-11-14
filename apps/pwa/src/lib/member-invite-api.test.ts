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

test('unconfigured member service gives a recovery instruction without exposing the server body', async () => {
  const fetchImpl = (async () => Response.json({ error: 'members-not-configured', detail: 'private-sentinel' },
    { status: 503 })) as unknown as typeof fetch;
  const api = createMemberInviteApi('https://api.example.test', fetchImpl);
  for (const request of [() => api.read(), () => api.claim('member_a')]) {
    const pending = request();
    await expect(pending).rejects.toThrow('설치 관리자에게 회원 서비스 설정을 요청해 주세요.');
    await expect(pending).rejects.not.toThrow('private-sentinel');
  }
  const outage = createMemberInviteApi('https://api.example.test',
    (async () => Response.json({ error: 'member-store-unavailable' }, { status: 503 })) as unknown as typeof fetch);
  await expect(outage.read()).rejects.toThrow('초대 링크 요청 실패 (HTTP 503)');
});

test('example-kit mail draft carries the public member ID link', () => {
  const link = 'https://app.example.test/r/ElanvitalAI';
  const draft = new URL(memberExampleKitMailto(link));
  expect(draft.protocol).toBe('mailto:');
  expect(draft.searchParams.get('body')).toContain(link);
  expect(draft.searchParams.get('body')).not.toContain('referralCode');
});
