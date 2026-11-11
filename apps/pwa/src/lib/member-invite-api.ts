export interface MemberInviteApi {
  read(): Promise<{ link: string | null; referralCount: number }>;
  rotate(): Promise<string>;
  revoke(): Promise<void>;
}

/** A shareable example-kit email draft; the browser's mail client owns sending. */
export function memberExampleKitMailto(inviteLink: string): string {
  const subject = 'Elanous 예제 키트 초대';
  const body = `예제 키트를 함께 살펴보세요.\n\n회원 가입 초대 링크: ${inviteLink}\n`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function createMemberInviteApi(baseUrl: string, fetchImpl: typeof fetch = fetch): MemberInviteApi {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/members`;
  async function request(path: string, method = 'GET'): Promise<{ link: string | null; referralCount?: number }> {
    const response = await fetchImpl(`${endpoint}${path}`, { method, credentials: 'include', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(response.status === 401 ? '회원 로그인 후 초대 링크를 확인해 주세요.' : `초대 링크 요청 실패 (HTTP ${response.status})`);
    const body = await response.json() as { inviteLink?: unknown; referralCount?: unknown };
    if (body.inviteLink === null) return { link: null, referralCount: typeof body.referralCount === 'number' ? body.referralCount : undefined };
    if (typeof body.inviteLink !== 'string') throw new Error('초대 링크 응답이 올바르지 않습니다.');
    const url = new URL(body.inviteLink);
    if (url.protocol !== 'https:' || url.pathname !== '/app/signup' || !url.searchParams.get('referralCode')) throw new Error('초대 링크 주소가 올바르지 않습니다.');
    return { link: url.toString(), referralCount: typeof body.referralCount === 'number' ? body.referralCount : undefined };
  }
  return {
    async read() {
      const result = await request('');
      if (!Number.isSafeInteger(result.referralCount) || result.referralCount! < 0) throw new Error('추천 현황 응답이 올바르지 않습니다.');
      return { link: result.link, referralCount: result.referralCount! };
    },
    async rotate() {
      const { link } = await request('/referral-code', 'POST');
      if (!link) throw new Error('새 초대 링크가 발급되지 않았습니다.');
      return link;
    },
    async revoke() { await request('/referral-code', 'DELETE'); },
  };
}
