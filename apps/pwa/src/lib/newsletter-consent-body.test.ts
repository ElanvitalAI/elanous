import { expect, test } from 'bun:test';
import { memberSignupBody } from './member-signup-intent';

test('signup request records an explicit newsletter decline with the contract revision', () => {
  expect(memberSignupBody({ eventCode: 'KCB1114' }, 'declined')).toMatchObject({
    newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' },
  });
});

test('newsletter choice preserves public member referral mapping without sending the link alias', () => {
  expect(memberSignupBody({ ref: 'ElanvitalAI', eventCode: 'KCB1114' }, 'declined')).toEqual({
    consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
    referrerMemberId: 'ElanvitalAI', eventCode: 'KCB1114',
    newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' },
  });
  expect(memberSignupBody({ ref: 'em_legacy123' }, 'opted_in')).toEqual({
    consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, legacyPublicId: 'em_legacy123',
    newsletterPreference: { choice: 'opted_in', revision: 'newsletter-v1' },
  });
});
