export interface MemberInviteApi {
  read(): Promise<{ link: string | null; referralCount: number; handle: string | null; canClaimHandle: boolean }>;
  claim(handle: string): Promise<{ link: string; handle: string }>;
}

/** A shareable example-kit email draft; the browser's mail client owns sending. */
export function memberExampleKitMailto(inviteLink: string): string {
  const subject = 'Elanous 예제 키트 초대';
  const body = `예제 키트를 함께 살펴보세요.\n\n회원 가입 초대 링크: ${inviteLink}\n`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function createMemberInviteApi(baseUrl: string, fetchImpl: typeof fetch = fetch): MemberInviteApi {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/members`;
  function verifiedLink(value: unknown, handle: string): string {
    if (typeof value !== 'string') throw new Error('초대 링크 응답이 올바르지 않습니다.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || url.pathname !== `/r/${encodeURIComponent(handle)}`) throw new Error('초대 링크 주소가 올바르지 않습니다.');
    return url.toString();
  }
  return {
    async read() {
      const response = await fetchImpl(endpoint, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 401 ? '회원 로그인 후 초대 링크를 확인해 주세요.' : `초대 링크 요청 실패 (HTTP ${response.status})`);
      const body = await response.json() as { inviteLink?: unknown; referralCount?: unknown; member?: { handle?: unknown; canClaimHandle?: unknown } };
      const handle = body.member?.handle;
      if (handle !== null && (typeof handle !== 'string' || !/^[a-z][a-z0-9_]{2,29}$/.test(handle))) throw new Error('회원 ID 응답이 올바르지 않습니다.');
      if (!Number.isSafeInteger(body.referralCount) || Number(body.referralCount) < 0) throw new Error('추천 현황 응답이 올바르지 않습니다.');
      if (handle === null && body.inviteLink !== null) throw new Error('초대 링크 응답이 올바르지 않습니다.');
      return { link: handle ? verifiedLink(body.inviteLink, handle) : null, referralCount: Number(body.referralCount),
        handle: handle ?? null, canClaimHandle: body.member?.canClaimHandle === true };
    },
    async claim(handle) {
      const response = await fetchImpl(`${endpoint}/handle`, { method: 'PUT', credentials: 'include',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ handle }) });
      if (!response.ok) throw new Error(response.status === 409 ? '이미 사용 중이거나 변경할 수 없는 회원 ID입니다.'
        : response.status === 401 ? '회원 로그인 후 다시 시도해 주세요.' : '회원 ID를 설정하지 못했습니다.');
      const body = await response.json() as { handle?: unknown; inviteLink?: unknown };
      if (typeof body.handle !== 'string' || body.handle !== handle) throw new Error('회원 ID 응답이 올바르지 않습니다.');
      return { handle: body.handle, link: verifiedLink(body.inviteLink, body.handle) };
    },
  };
}
