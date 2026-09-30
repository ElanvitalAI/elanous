import { expect, it } from 'bun:test';
import { isPublicCaptureUrl } from './public-capture';

it('public capture is on only for ?capture=public', () => {
  expect(isPublicCaptureUrl('?capture=public')).toBe(true);
  expect(isPublicCaptureUrl('?x=1&capture=public')).toBe(true);
  expect(isPublicCaptureUrl('?capture=private')).toBe(false);
  expect(isPublicCaptureUrl('')).toBe(false);
});
