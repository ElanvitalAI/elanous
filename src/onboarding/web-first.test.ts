import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runWebFirstSetup, type WebFirstSetupDeps } from './web-first.js';
import type { NexusShowResult } from '../cli/nexus-show.js';
import { debug } from '../debug/log.js';

test('setup --terminal preserves the wizard failure exit status', () => {
  const index = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
  const setupHook = index.split(".option('--terminal', 'Run the terminal onboarding wizard')")[1]?.split('registerStartCommand(program);')[0];
  expect(setupHook).toBeDefined();
  expect(setupHook).toMatch(/if \(action\.name\(\) === 'setup' && action\.opts\(\)\.terminal\) \{\s*const completed = await runOnboardingForCli\(\);\s*process\.exit\(completed \? 0 : \(process\.exitCode \|\| 2\)\);/);
});

const daemon = (tailnet?: string): NexusShowResult => ({
  exitCode: 0, status: 'unregistered',
  urls: {
    pwa: { loopback: 'http://127.0.0.1:4321/app/', ...(tailnet ? { tailnet } : {}) },
    rest: { loopback: 'http://127.0.0.1:4321/v1/' },
    sse: { loopback: 'http://127.0.0.1:4321/v1/events' },
  },
});
function fixture(overrides: Partial<WebFirstSetupDeps> = {}) {
  const lines: string[] = [];
  const qrLinks: string[] = [];
  const deps: WebFirstSetupDeps = {
    config: { onboarding: { completed: false, version: 0, webFirst: true } }, isTty: true,
    showNexus: async () => daemon(), issueSetupLinkToken: async () => ({ token: 'secret+/=' }),
    renderQr: link => { qrLinks.push(link); return 'QR image'; },
    isHeadless: () => true, browserEnv: {}, browserPlatform: 'darwin', print: line => lines.push(line), ...overrides,
  };
  return { deps, lines, qrLinks };
}

test('disabled, non-TTY and --terminal never inspect daemon or issue tokens', async () => {
  for (const change of [
    { config: { onboarding: { completed: false, version: 0 } } },
    { config: { onboarding: { completed: false, version: 0, webFirst: false } } },
    { isTty: false }, { terminal: true },
  ]) {
    const { deps, lines } = fixture({ ...change, showNexus: async () => { throw Error('should not inspect'); } });
    expect(await runWebFirstSetup(deps)).toBe('fallback');
    expect(lines).toEqual([]);
  }
});

test('daemon absent or registered but dead falls back before issuing', async () => {
  for (const result of [{ exitCode: 1, status: 'absent' }, { exitCode: 1, status: 'registered', instance: { alive: false } }] as NexusShowResult[]) {
    const { deps, lines } = fixture({ showNexus: async () => result, issueSetupLinkToken: async () => { throw Error('not called'); } });
    expect(await runWebFirstSetup(deps)).toBe('fallback');
    expect(lines).toEqual([]);
  }
});

test('unavailable issuer falls back without displaying a link', async () => {
  const { deps, lines } = fixture({ issueSetupLinkToken: async () => { throw Error('missing'); } });
  expect(await runWebFirstSetup(deps)).toBe('fallback');
  expect(lines).toEqual([]);
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.event).toBe('fallback');
  expect(event?.data).toMatchObject({ reason: 'issuer-missing', qr: false, browserOpened: false, remote: 'loopback' });
});

test('default issuer is optional until the auth module exists', async () => {
  const { deps, lines } = fixture();
  delete deps.issueSetupLinkToken;
  expect(await runWebFirstSetup(deps)).toBe('fallback');
  expect(lines).toEqual([]);
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.data).toMatchObject({ reason: 'issuer-missing' });
});

test('running daemon prints loopback setup link once, without QR when tailnet is absent', async () => {
  const { deps, lines, qrLinks } = fixture();
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toEqual([
    '브라우저에서 셋업을 이어가세요',
    'http://127.0.0.1:4321/setup#t=secret%2B%2F%3D',
    '터미널에서 하려면: `elanous setup --terminal`',
  ]);
  expect(qrLinks).toEqual([]);
});

test('registered live daemon and successful browser open produce a link and safe observation', async () => {
  const { deps } = fixture({
    showNexus: async () => ({ ...daemon(), status: 'registered', instance: { alive: true } } as NexusShowResult),
    isHeadless: () => false,
    openBrowser: () => true,
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.data).toMatchObject({ qr: false, browserOpened: true, remote: 'loopback' });
  expect(JSON.stringify(event)).not.toContain('secret');
});

test('SSH Mac and displayless Linux show the link and why without invoking the opener; local Mac opens once', async () => {
  for (const [env, platform, expected] of [
    [{ SSH_CONNECTION: 'x' }, 'darwin', '원격(ssh)'],
    [{}, 'linux', '화면(디스플레이)이 없는 세션'],
    [{}, 'darwin', null],
  ] as const) {
    const opened: string[] = [];
    const { deps, lines } = fixture({
      browserEnv: env, browserPlatform: platform, isHeadless: () => false,
      openBrowser: url => { opened.push(url); return true; },
    });
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret%2B%2F%3D');
    if (expected) {
      expect(opened).toEqual([]);
      expect(lines.join('\n')).toContain(expected);
      const event = debug.events(20).filter(e => e.category === 'browser.open').at(-1);
      expect(event?.event).toBe('skipped');
      expect(event?.data).toMatchObject({ reason: platform === 'darwin' ? 'ssh' : 'no-display' });
    } else {
      expect(opened).toEqual(['http://127.0.0.1:4321/setup#t=secret%2B%2F%3D']);
    }
  }
});

test('tailnet gets phone QR; browser opens loopback and failure does not cancel the link', async () => {
  const opened: string[] = [];
  const { deps, lines, qrLinks } = fixture({
    showNexus: async () => daemon('https://machine.ts.net/app/'),
    isHeadless: () => false,
    openBrowser: link => { opened.push(link); throw Error('no browser'); },
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(opened).toEqual(['http://127.0.0.1:4321/setup#t=secret%2B%2F%3D']);
  expect(qrLinks).toEqual(['https://machine.ts.net/setup#t=secret%2B%2F%3D']);
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.event).toBe('link-shown');
  expect(event?.data).toMatchObject({ qr: true, browserOpened: false, remote: 'tailnet' });
  expect(JSON.stringify(event)).not.toContain('secret');
  expect(JSON.stringify(event)).not.toContain('/setup');
  expect(lines).toContain('QR image');
  expect(lines).toContain('같은 와이파이·tailnet 의 폰 카메라로 스캔하세요');
});
