export interface MemberSignupLinkIntent { referralCode?: string; eventCode?: string }

/** Only the two code inputs may cross from a public link into signup. */
export function memberSignupIntentFromSearch(search: string): MemberSignupLinkIntent {
  const params = new URLSearchParams(search);
  const referralCodes = params.getAll('referralCode');
  const eventCodes = params.getAll('code');
  if (referralCodes.length > 1 || eventCodes.length > 1) throw new Error('가입 링크의 코드가 중복되었습니다.');
  const referralCode = referralCodes[0]?.trim();
  const eventCode = eventCodes[0]?.trim().toUpperCase();
  if (referralCodes.length && !referralCode) throw new Error('초대 코드가 비어 있습니다.');
  if (eventCodes.length && !eventCode) throw new Error('행사 코드가 비어 있습니다.');
  if (referralCode && !/^[A-Za-z0-9_-]{1,80}$/.test(referralCode)) throw new Error('초대 코드가 올바르지 않습니다.');
  if (eventCode && !/^[A-Z0-9_-]{1,80}$/.test(eventCode)) throw new Error('행사 코드가 올바르지 않습니다.');
  return { ...(referralCode ? { referralCode } : {}), ...(eventCode ? { eventCode } : {}) };
}

export function memberSignupBody(intent: MemberSignupLinkIntent) {
  return { consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, ...intent };
}
