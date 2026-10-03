import { afterEach, expect, test } from 'bun:test';
import { capturedEnvAvailable, mergeCapturedPath, resetCapturedEnvForTesting, setCapturedEnvForTesting } from './shell-env-bootstrap.js';

afterEach(() => resetCapturedEnvForTesting());

test('append only missing captured PATH entries after the existing target order', () => {
  const target = { PATH: '/usr/bin:/bin', TOKEN: 'keep', HTTP_PROXY: 'keep-proxy' };
  setCapturedEnvForTesting({ PATH: '/opt/x/bin:/usr/bin:/opt/y/bin:/opt/x/bin', TOKEN: 'secret', HTTP_PROXY: 'other' });
  expect(mergeCapturedPath(target)).toBe(2);
  expect(target).toEqual({ PATH: '/usr/bin:/bin:/opt/x/bin:/opt/y/bin', TOKEN: 'keep', HTTP_PROXY: 'keep-proxy' });
  expect(mergeCapturedPath(target)).toBe(0);
  expect(target.PATH).toBe('/usr/bin:/bin:/opt/x/bin:/opt/y/bin');
});

test('fallback capture does not alter even a different target PATH', () => {
  const target = { PATH: '/usr/bin:/bin' };
  setCapturedEnvForTesting(null);
  expect(capturedEnvAvailable()).toBe(false);
  expect(mergeCapturedPath(target)).toBe(0);
  expect(target.PATH).toBe('/usr/bin:/bin');
});

test('default target is the running process environment', () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    setCapturedEnvForTesting({ PATH: '/opt/x/bin:/usr/bin' });
    expect(mergeCapturedPath()).toBe(1);
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/x/bin');
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
