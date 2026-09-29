import { describe, expect, test } from 'bun:test';
import { approveCliLogin, classifyLoginPage, loginViaBrowser, launchBrowserProfileLogin, browserProfileDir, browserProfileStatus, type LoginSnapshot, type LoginDeps } from './browser-login.js';
import type { CdpClient } from '../browser-cdp/client.js';
import type { DecisionEvent } from '../live/detail-switch.js';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { setTreeDerivedTestForTesting } from '../instance/resolve.js';

const URL = 'https://auth.openai.com/oauth/authorize?secret=never-log-this';
const page = (changes: Partial<LoginSnapshot> = {}): LoginSnapshot => ({ url: URL, text: 'Approve access', inputs: [], buttons: ['Authorize'], ...changes });

function fake(pages: LoginSnapshot[], opts: { profile?: boolean } = {}) {
  const actions: string[] = [], events: DecisionEvent[] = [], logs: string[] = [];
  let n = 0;
  const client = {
    navigate: async (url: string) => { actions.push('navigate:' + url); return { frameId: '1' }; },
    evaluate: async (expression: string) => {
      if (expression.includes('"click" === \'click\'')) { actions.push('click'); return true; }
      if (expression.includes('"enter-code" === \'click\'')) { actions.push('enter'); return true; }
      return pages[Math.min(n++, pages.length - 1)];
    },
    close: async () => { actions.push('close'); },
  } as unknown as CdpClient;
  const deps: LoginDeps = {
    profileExists: () => opts.profile ?? false,
    chromeBinary: () => opts.profile ? '/fake/chrome' : null,
    spawnChrome: () => ({ kill: () => { actions.push('kill'); } }) as never,
    resolveChromePort: async () => {},
    connect: async (port: number) => { actions.push(`connect:${port}`); return client; },
    sleep: async () => {},
    log: (event, data) => { logs.push(JSON.stringify({ event, data })); },
    decide: event => { events.push(event); },
  };
  return { deps, actions, logs, events };
}

describe('browser profile universe', () => {
  test('follows the state resolver in an explicitly isolated instance', () => {
    const previous = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = join(import.meta.dir, '../../.elanous-test/browser-login-isolation');
      expect(browserProfileDir()).toBe(join(elanousStateRoot(), 'browser-profile'));
      expect(browserProfileDir()).toStartWith(join(import.meta.dir, '../../.elanous-test'));
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });

  test('follows a tree-derived test universe even without a state env override', () => {
    const previous = process.env.ELANOUS_STATE_DIR;
    try {
      delete process.env.ELANOUS_STATE_DIR;
      setTreeDerivedTestForTesting(true);
      expect(browserProfileDir()).toBe(join(elanousStateRoot(), 'browser-profile'));
      expect(browserProfileDir()).toContain('.elanous-test');
    } finally {
      setTreeDerivedTestForTesting(undefined);
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  });
});

describe('login page classification', () => {
  test('one approval and ambiguous buttons are distinct', () => {
    expect(classifyLoginPage(page())).toEqual({ headless: true, action: 'click', target: 'Authorize' });
    expect(classifyLoginPage(page({ buttons: ['Authorize', 'Allow'] }))).toEqual({ headless: false, reason: 'account-choice' });
  });
  test('unsafe signals override otherwise clickable approval', () => {
    for (const [changes, reason] of [
      [{ inputs: [{ type: 'password' }] }, 'password'],
      [{ inputs: [{ type: 'text', autocomplete: 'email' }] }, 'password'],
      [{ inputs: [{ type: 'text', name: 'user_email' }] }, 'password'],
      [{ text: 'hcaptcha challenge' }, 'captcha'],
      [{ text: '2-Step verification code' }, 'two-factor'],
      [{ text: 'Use your passkey' }, 'passkey'],
      [{ text: 'Select an account' }, 'account-choice'],
    ] as Array<[Partial<LoginSnapshot>, 'password' | 'captcha' | 'two-factor' | 'passkey' | 'account-choice']>) expect(classifyLoginPage(page(changes))).toEqual({ headless: false, reason });
  });
  test('only the exact allowlisted origin and github device path', () => {
    for (const url of ['https://github.com/login', 'https://github.com.evil.test/login/device', 'http://auth.openai.com/', 'https://evil.test/']) {
      expect(classifyLoginPage(page({ url }))).toEqual({ headless: false, reason: 'host-not-allowed' });
    }
    expect(classifyLoginPage(page({ url: 'https://github.com/login/device' })).headless).toBe(true);
  });
});

describe('browser approval with fake CDP', () => {
  test('one button clicks, routes and verifies, profile first and never logs URL query', async () => {
    const f = fake([page(), page(), page({ buttons: [], text: 'Done' })], { profile: true });
    expect(await approveCliLogin({ url: URL, provider: 'codex' }, f.deps)).toEqual({ outcome: 'approved' });
    expect(f.actions.filter(a => a === 'click')).toHaveLength(1);
    expect(f.actions.some(a => a.startsWith('connect:9222'))).toBe(false);
    expect(f.events.map(e => e.kind)).toEqual(['ROUTE', 'ROUTE', 'VERIFY']);
    expect(f.logs.join(' ')).not.toContain('never-log-this');
  });
  test('failed persistent profile falls back to port 9222', async () => {
    const f = fake([page(), page(), page({ buttons: [], text: 'Done' })], { profile: true });
    const original = f.deps.connect!;
    f.deps.connect = async port => {
      if (port !== 9222) throw Error('profile locked');
      return original(port);
    };
    expect(await approveCliLogin({ url: URL, provider: 'codex' }, f.deps)).toEqual({ outcome: 'approved' });
    expect(f.actions).toContain('connect:9222');
    expect(f.logs.join(' ')).toContain('cdp-9222');
  });
  test('unsafe password, captcha, ambiguous approvals never mutate the page', async () => {
    for (const [changes, reason] of [
      [{ inputs: [{ type: 'password' }] }, 'password'],
      [{ text: 'recaptcha' }, 'captcha'],
      [{ buttons: ['Approve', 'Allow'] }, 'account-choice'],
    ] as Array<[Partial<LoginSnapshot>, 'password' | 'captcha' | 'two-factor' | 'passkey' | 'account-choice']>) {
      const f = fake([page(changes)]);
      expect(await approveCliLogin({ url: URL, provider: 'codex' }, f.deps)).toEqual({ outcome: 'ask-human', reason });
      expect(f.actions).not.toContain('click');
      expect(f.actions).not.toContain('enter');
      expect(f.events.at(-1)?.kind).toBe('ESCALATE');
    }
  });
  test('foreign host is rejected before connect or navigate', async () => {
    const f = fake([page()]);
    expect(await approveCliLogin({ url: 'https://elsewhere.test/', provider: 'claude' }, f.deps)).toEqual({ outcome: 'ask-human', reason: 'host-not-allowed' });
    expect(f.actions).toEqual([]);
  });
  test('one device-code field enters only the PTY-supplied code', async () => {
    const f = fake([page({ inputs: [{ type: 'text', name: 'device_code' }], buttons: [] }), page({ inputs: [{ type: 'text', name: 'device_code' }], buttons: [] }), page({ text: 'Done', buttons: [] })]);
    expect(await approveCliLogin({ url: URL, code: 'ABCD-EFGH', provider: 'codex' }, f.deps)).toEqual({ outcome: 'approved' });
    expect(f.actions.filter(a => a === 'enter')).toHaveLength(1);
    expect(f.logs.join(' ')).not.toContain('ABCD-EFGH');
  });
  test('a device code is not re-entered while the page still awaits completion', async () => {
    const inputPage = page({ inputs: [{ type: 'text', name: 'device_code' }], buttons: [] });
    const f = fake([inputPage, inputPage, inputPage]);
    expect(await approveCliLogin({ url: URL, code: 'ABCD-EFGH', provider: 'codex' }, f.deps)).toEqual({ outcome: 'ask-human', reason: 'timeout' });
    expect(f.actions.filter(a => a === 'enter')).toHaveLength(1);
  });
  test('unsafe re-observation stops before mutation', async () => {
    const f = fake([page(), page({ text: 'captcha', buttons: ['Authorize'] })]);
    expect(await approveCliLogin({ url: URL, provider: 'codex' }, f.deps)).toEqual({ outcome: 'ask-human', reason: 'captcha' });
    expect(f.actions).not.toContain('click');
  });
  test('no browser returns ask-human, including extracted PTY device code', async () => {
    const result = await loginViaBrowser('pty', 'codex', {
      ...fake([page()]).deps,
      connect: async () => { throw Error('offline'); },
      snapshot: async () => 'Visit https://auth.openai.com/device and enter the code ABCD-EFGH',
    });
    expect(result).toEqual({ outcome: 'ask-human', reason: 'no-backend', url: 'https://auth.openai.com/device', code: 'ABCD-EFGH' });
  });
  test('Claude code travels only to PTY input and the log records its length', async () => {
    const code = 'super-secret-code-314159';
    const codePage = page({ url: 'https://claude.ai/oauth', text: `Copy this authorization code [login-code]${code}[/login-code]`, buttons: [] });
    const f = fake([codePage, codePage]);
    const writes: string[] = [];
    let snapshots = 0;
    const result = await loginViaBrowser('pty', 'claude', {
      ...f.deps,
      snapshot: async () => ++snapshots === 1 ? 'https://claude.ai/oauth' : 'Login successful',
      text: async (_ref, value) => { writes.push(value); return true; },
    });
    expect(result).toEqual({ outcome: 'verified', provider: 'claude' });
    expect(writes).toEqual([code]);
    expect(f.logs.join(' ')).not.toContain(code);
    expect(f.logs.join(' ')).toContain(String(code.length));
    expect(f.events.some(e => JSON.stringify(e).includes(code))).toBe(false);
  });
  test('verification is provider specific', async () => {
    const f = fake([page(), page(), page({ buttons: [], text: 'Done' })]);
    expect(await loginViaBrowser('pty', 'codex', { ...f.deps, snapshot: async () => URL, codexStatus: () => 'Logged in' })).toEqual({ outcome: 'verified', provider: 'codex' });
  });
  test('visible profile uses the same binary without any remote debugging flag', () => {
    const calls: string[][] = [];
    expect(launchBrowserProfileLogin({ profileDir: join(import.meta.dir, '../../.elanous-test/browser-login-profile'), chromeBinary: () => '/chrome', spawnChrome: (binary, args) => { calls.push([binary, ...args]); return {} as never; } })).toBe(true);
    expect(calls[0]?.[0]).toBe('/chrome');
    expect(calls[0]?.join(' ')).not.toContain('remote-debugging');
    expect(calls[0]?.join(' ')).not.toContain('headless');
    expect(browserProfileStatus('/not-a-real-login-profile')).toEqual({ exists: false, lastUse: null });
  });
});
