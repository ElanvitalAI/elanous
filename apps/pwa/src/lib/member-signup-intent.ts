export interface MemberSignupLinkIntent { ref?: string; referralCode?: string; eventCode?: string }
export type NewsletterChoice = 'opted_in' | 'declined';
export const NEWSLETTER_REVISION = 'newsletter-v1';

/** Public member ID and legacy referral code are distinct, mutually exclusive inputs. */
export function memberSignupIntentFromSearch(search: string): MemberSignupLinkIntent {
  const params = new URLSearchParams(search);
  const refs = params.getAll('ref');
  const referralCodes = params.getAll('referralCode');
  const eventCodes = params.getAll('code');
  if (refs.length > 1 || referralCodes.length > 1 || eventCodes.length > 1 || (refs.length && referralCodes.length))
    throw new Error('가입 링크의 추천 정보가 중복되었습니다.');
  const ref = refs[0]?.trim();
  const referralCode = referralCodes[0]?.trim();
  const rawEventCode = eventCodes[0]?.trim().toUpperCase();
  // The demo code accepts common spoken and printed separators; other event codes keep their spelling.
  const eventCode = rawEventCode?.replace(/[_\-\s]/g, '') === 'KCB1114' ? 'KCB1114' : rawEventCode;
  if (referralCodes.length && !referralCode) throw new Error('초대 코드가 비어 있습니다.');
  if (refs.length && !ref) throw new Error('회원 ID가 비어 있습니다.');
  if (eventCodes.length && !eventCode) throw new Error('행사 코드가 비어 있습니다.');
  if (referralCode && !/^[A-Za-z0-9_-]{1,80}$/.test(referralCode)) throw new Error('초대 코드가 올바르지 않습니다.');
  if (ref && !(/^em_[A-Za-z0-9_-]{3,80}$/.test(ref) || /^[a-z][a-z0-9_]{2,29}$/.test(ref)))
    throw new Error('회원 ID가 올바르지 않습니다.');
  if (eventCode && !/^[A-Z0-9_-]{1,80}$/.test(eventCode)) throw new Error('행사 코드가 올바르지 않습니다.');
  return { ...(ref ? { ref } : {}), ...(referralCode ? { referralCode } : {}), ...(eventCode ? { eventCode } : {}) };
}

export function memberSignupBody(intent: MemberSignupLinkIntent, newsletterChoice?: NewsletterChoice) {
  const { ref, ...rest } = intent;
  return { consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
    ...(ref ? ref.startsWith('em_') ? { legacyPublicId: ref } : { referrerMemberId: ref } : {}), ...rest,
    ...(newsletterChoice ? { newsletterPreference: { choice: newsletterChoice, revision: NEWSLETTER_REVISION } } : {}) };
}
