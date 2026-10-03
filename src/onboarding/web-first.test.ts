import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { claimSetupLinkToken } from '../auth/setup-link-tokens.js';
import { registerPwaInstance } from '../cli/pwa-registry.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { runWebFirstSetup, type WebFirstSetupDeps } from './web-first.js';
import type { NexusShowResult } from '../cli/nexus-show.js';
import { debug } from '../debug/log.js';

const cli = resolve(import.meta.dir, '../../bin/elanous.mjs');

test('real CLI first run waits for health before printing a claimable setup link', async () => {
  const dir = mkdtempSync(join(resolve(import.meta.dir, '../..'), '.web-first-cli-'));
  const events: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    events.push(new URL(request.url).pathname);
    return new Response('ok');
  } });
  const env = { ...process.env, ELANOUS_HOME: dir, HOME: dir, XDG_CONFIG_HOME: dir,
    ELANOUS_RUN_CONTEXT: 'production', DISPLAY: '', WAYLAND_DISPLAY: '' };
  try {
    registerPwaInstance({
      pid: process.pid, ports: [server.port!], mode: 'static', kind: 'test',
      cwd: resolve(import.meta.dir, '../..'), daemonDir: dir, shareMounted: false,
      https: false, startedAt: new Date().toISOString(),
    }, { registryPath: join(dir, 'pwa-registry.json') });
    const child = Bun.spawn([process.execPath, cli, `--test=${dir}`], {
      cwd: resolve(import.meta.dir, '../..'), env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const output = stdout + stderr;
      expect(exitCode).toBe(0);
      expect(events).toContain('/v1/health');
      const link = output.match(new RegExp(`http://127\\.0\\.0\\.1:${server.port}/setup#t=(els_[A-Za-z0-9_-]{43})`));
      expect(link).not.toBeNull();
      expect(claimSetupLinkToken(link![1]!, { dir }).ok).toBe(true);
      expect(output).not.toContain('Choose LLM');
    } finally { clearTimeout(timer); }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);

const configuredLlm = { llm: { provider: 'openai', apiKey: 'sk-test-not-a-real-key' } };

test('real CLI does not print a link when health responds with an error', async () => {
  const dir = mkdtempSync(join(resolve(import.meta.dir, '../..'), '.web-first-unhealthy-'));
  // A configured LLM keeps first-run off the host's detected subscriptions: without it a bare Linux host stops at
  // «eln setup llm» (exit 0) before the web-first probe, while a dev Mac detects codex and reaches the TTY check.
  mkdirSync(join(dir, 'elanous'));
  writeFileSync(join(dir, 'elanous', 'config.json'), JSON.stringify(configuredLlm));
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response('unavailable', { status: 503 });
  } });
  try {
    registerPwaInstance({
      pid: process.pid, ports: [server.port!], mode: 'static', kind: 'test',
      cwd: resolve(import.meta.dir, '../..'), daemonDir: dir, shareMounted: false,
      https: false, startedAt: new Date().toISOString(),
    }, { registryPath: join(dir, 'pwa-registry.json') });
    const child = Bun.spawn([process.execPath, cli, `--test=${dir}`], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, ELANOUS_HOME: dir, HOME: dir, XDG_CONFIG_HOME: dir,
        ELANOUS_RUN_CONTEXT: 'production', DISPLAY: '', WAYLAND_DISPLAY: '' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(requests).toContain('/v1/health');
      // No terminal: one health probe, then a quiet fallback (reason non-tty) — never a link, never a started daemon.
      expect(stdout + stderr).not.toContain('/setup#t=');
    } finally { clearTimeout(timer); }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);

test('real CLI honors explicit webFirst=false without probing health or issuing a link', async () => {
  const dir = mkdtempSync(join(resolve(import.meta.dir, '../..'), '.web-first-disabled-'));
  try {
    mkdirSync(join(dir, 'elanous'));
    writeFileSync(join(dir, 'elanous', 'config.json'), JSON.stringify({ ...configuredLlm, onboarding: { webFirst: false } }));
    const child = Bun.spawn([process.execPath, cli, `--test=${dir}`], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, ELANOUS_HOME: dir, HOME: dir, XDG_CONFIG_HOME: dir,
        ELANOUS_RUN_CONTEXT: 'production', DISPLAY: '', WAYLAND_DISPLAY: '' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stdout + stderr).not.toContain('/setup#t=');
      expect(stdout + stderr).not.toContain('daemon-start-failed');
      expect(stdout + stderr).toContain('대시보드는 stdin TTY');
    } finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25_000);

test('real CLI setup --terminal selects the terminal wizard without a TTY or web link', async () => {
  const dir = mkdtempSync(join(resolve(import.meta.dir, '../..'), '.web-first-terminal-'));
  try {
    const child = Bun.spawn([process.execPath, cli, `--test=${dir}`, 'setup', '--terminal'], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, ELANOUS_HOME: dir, HOME: dir, XDG_CONFIG_HOME: dir, ELANOUS_RUN_CONTEXT: 'production' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout + stderr).toContain('대화형 온보딩은 stdin TTY');
      expect(stdout + stderr).not.toContain('/setup#t=');
    } finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25_000);

const daemon = (tailnet?: string, port = 4321): NexusShowResult => ({
  exitCode: 0, status: 'unregistered',
  urls: {
    pwa: { loopback: `http://127.0.0.1:${port}/app/`, ...(tailnet ? { tailnet } : {}) },
    rest: { loopback: `http://127.0.0.1:${port}/v1/` },
    sse: { loopback: `http://127.0.0.1:${port}/v1/events` },
  },
});
function fixture(overrides: Partial<WebFirstSetupDeps> = {}) {
  const lines: string[] = [];
  const qrLinks: string[] = [];
  const deps: WebFirstSetupDeps = {
    config: { onboarding: { completed: false, version: 0, webFirst: true } }, isTty: true,
    showNexus: async () => daemon(), probeHealth: async () => true,
    issueSetupLinkToken: async () => ({ token: 'secret+/=' }),
    renderQr: link => { qrLinks.push(link); return 'QR image'; },
    isHeadless: () => true, browserEnv: {}, browserPlatform: 'darwin',
    httpHost: () => '0.0.0.0', interfaces: () => ({}), defaultRouteInterface: () => undefined,
    print: line => lines.push(line), ...overrides,
  };
  return { deps, lines, qrLinks };
}

test('disabled and --terminal never inspect daemon or issue tokens', async () => {
  for (const change of [
    { config: { onboarding: { completed: false, version: 0, webFirst: false } } },
    { terminal: true },
  ]) {
    const { deps, lines } = fixture({ ...change, showNexus: async () => { throw Error('should not inspect'); } });
    expect(await runWebFirstSetup(deps)).toBe('fallback');
    expect(lines).toEqual([]);
  }
});

test('daemon absent or registered but dead starts background and waits for health before issuing', async () => {
  for (const result of [{ exitCode: 1, status: 'absent' }, { exitCode: 1, status: 'registered', instance: { alive: false } }] as NexusShowResult[]) {
    const calls: string[] = [];
    let inspected = 0;
    const { deps, lines } = fixture({
      showNexus: async () => { calls.push('show'); return inspected++ === 0 ? result : daemon(); },
      startDaemon: async () => { calls.push('start'); return { exitCode: 0 }; },
      probeHealth: async (url) => { calls.push(url); return true; },
      issueSetupLinkToken: async () => { calls.push('issue'); return { token: 'secret+/=' }; },
    });
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    expect(calls).toEqual(['show', 'start', 'show', 'http://127.0.0.1:4321/v1/health', 'issue']);
    expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret%2B%2F%3D');
    const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
    expect(event?.event).toBe('link-shown');
    expect((event?.data as { ms: number })?.ms).toBeLessThan(15_000);
  }
});

test('registered daemon still starting retries health beyond 500ms before issuing a token', async () => {
  for (const show of [daemon(), { ...daemon(), status: 'registered', instance: { alive: true } } as NexusShowResult]) {
    const calls: string[] = [];
    let probes = 0;
    const { deps, lines } = fixture({
      showNexus: async () => { calls.push('show'); return show; },
      startDaemon: async () => { calls.push('start'); return { exitCode: 0 }; },
      probeHealth: async (url, timeoutMs) => {
        calls.push(`${url} ${timeoutMs}`);
        if (++probes === 1) { await Bun.sleep(600); return false; }
        return true;
      },
      issueSetupLinkToken: async () => { calls.push('issue'); return { token: 'secret' }; },
    });
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    expect(calls).not.toContain('start');
    expect(probes).toBe(2);
    expect(calls.at(-1)).toBe('issue');
    expect(calls).toContain('http://127.0.0.1:4321/v1/health 500');
    expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret');
  }
}, 5_000);

test('registered daemon that never becomes healthy falls back without issuing a token', async () => {
  let issued = false;
  let probes = 0;
  const { deps, lines } = fixture({
    probeHealth: async () => { probes++; return false; },
    startDaemon: async () => { throw Error('must not relaunch registered daemon'); },
    issueSetupLinkToken: async () => { issued = true; return { token: 'secret' }; },
  });
  expect(await runWebFirstSetup(deps)).toBe('fallback');
  expect(probes).toBeGreaterThan(1);
  expect(issued).toBe(false);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('daemon-health-unavailable');
}, 16_000);

test('daemon inspection failure still launches and retries until health responds', async () => {
  const calls: string[] = [];
  let inspected = 0;
  let probes = 0;
  const { deps, lines } = fixture({
    showNexus: async () => {
      calls.push('show');
      if (inspected++ === 0) throw Error('no daemon');
      return daemon();
    },
    startDaemon: async () => { calls.push('start'); return { exitCode: 0 }; },
    probeHealth: async () => { calls.push('health'); return ++probes === 2; },
    issueSetupLinkToken: async () => { calls.push('issue'); return { token: 'secret+/=' }; },
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(calls).toEqual(['show', 'start', 'show', 'health', 'show', 'health', 'issue']);
  expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret%2B%2F%3D');
});

test('daemon launch failure or unhealthy daemon falls back with one reason and no token', async () => {
  for (const [launch, expected] of [[1, 'daemon-start-failed'], [0, 'daemon-health-timeout']] as const) {
    let issued = false;
    let inspected = 0;
    const { deps, lines } = fixture({
      showNexus: async () => inspected++ === 0 ? { exitCode: 0, status: 'absent' } : daemon(),
      startDaemon: async () => ({ exitCode: launch }),
      probeHealth: async () => false,
      issueSetupLinkToken: async () => { issued = true; return { token: 'secret' }; },
    });
    expect(await runWebFirstSetup(deps)).toBe('fallback');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(expected);
    expect(issued).toBe(false);
  }
}, 16_000);

test('unavailable issuer falls back without displaying a link', async () => {
  const { deps, lines } = fixture({ issueSetupLinkToken: async () => { throw Error('missing'); } });
  expect(await runWebFirstSetup(deps)).toBe('fallback');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('issuer-missing');
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.event).toBe('fallback');
  expect(event?.data).toMatchObject({ reason: 'issuer-missing', qr: false, browserOpened: false, remote: 'loopback' });
});

test('default issuer issues a real claimable setup link when webFirst is unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-first-'));
  setElanousConfigDir(dir);
  try {
    const { deps, lines } = fixture({ config: { onboarding: { completed: false, version: 0 } } });
    delete deps.issueSetupLinkToken;
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    const link = lines.find(line => line.includes('/setup#t='));
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4321\/setup#t=els_[A-Za-z0-9_-]{43}$/);
    const token = new URL(link!).hash.slice(3);
    expect(claimSetupLinkToken(token, { dir }).ok).toBe(true);
    const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
    expect(event?.event).toBe('link-shown');
    expect((event?.data as { ms: number })?.ms).toBeLessThan(15_000);
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain('/setup');
  } finally {
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a terminal, an already-healthy daemon still gets a link (no daemon is started)', async () => {
  let started = 0;
  const { deps, lines } = fixture({ isTty: false, startDaemon: async () => { started += 1; return { exitCode: 0 } as never; } });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret%2B%2F%3D');
  expect(started).toBe(0);
});

test('without a terminal and no healthy daemon: fall back at once, never start a daemon, issue no token', async () => {
  let started = 0;
  let issued = 0;
  const { deps, lines } = fixture({
    isTty: false, probeHealth: async () => false,
    startDaemon: async () => { started += 1; return { exitCode: 0 } as never; },
    issueSetupLinkToken: async () => { issued += 1; return { token: 'x' }; },
  });
  const t0 = Date.now();
  expect(await runWebFirstSetup(deps)).toBe('fallback');
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(started).toBe(0);
  expect(issued).toBe(0);
  expect(lines).toEqual([]);
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

test('wildcard bind prints one LAN link using the same token, QR fallback and safe observation', async () => {
  const { deps, lines, qrLinks } = fixture({
    interfaces: () => ({ en0: [{ address: '192.168.0.12', family: 'IPv4', internal: false } as never], utun3: [{ address: '100.101.1.2', family: 'IPv4', internal: false } as never] }),
    defaultRouteInterface: () => 'en0',
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines.filter(line => line.includes('/setup#t='))).toEqual([
    'http://127.0.0.1:4321/setup#t=secret%2B%2F%3D',
    '같은 와이파이의 폰이면: http://192.168.0.12:4321/setup#t=secret%2B%2F%3D',
  ]);
  expect(lines).toContain('이 링크는 10분 안에 한 번만 열 수 있습니다');
  expect(qrLinks).toEqual(['http://192.168.0.12:4321/setup#t=secret%2B%2F%3D']);
  expect(lines).toContain('같은 와이파이의 폰 카메라로 스캔하세요');
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.data).toMatchObject({ lan: 'shown', ssh: false, qr: true });
  const observed = debug.events(20).filter(e => e.category === 'onboarding.web-first').map(e => JSON.stringify(e)).join('\n');
  for (const forbidden of ['secret', '192.168.0.12', 'host.example']) expect(observed).not.toContain(forbidden);
});

test('no private address leaves phone link absent; loopback bind only prints restart hint', async () => {
  const interfaces = () => ({ en0: [{ address: '100.101.1.2', family: 'IPv4', internal: false } as never] });
  for (const [host, expected] of [['0.0.0.0', 'no-address'], ['127.0.0.1', 'loopback-bind']] as const) {
    const { deps, lines, qrLinks } = fixture({
      httpHost: () => host,
      interfaces: host === '127.0.0.1'
        ? () => ({ en0: [{ address: '192.168.0.12', family: 'IPv4', internal: false } as never] })
        : interfaces,
    });
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    expect(lines.filter(line => line.includes('/setup#t='))).toEqual(['http://127.0.0.1:4321/setup#t=secret%2B%2F%3D']);
    expect(qrLinks).toEqual([]);
    expect(lines.some(line => line.includes('루프백 없이 다시 띄우세요'))).toBe(host === '127.0.0.1');
    expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ lan: expected, ssh: false });
  }
});

test('specific private bind uses its listening address rather than the default-route interface for LAN and QR', async () => {
  const { deps, lines, qrLinks } = fixture({
    httpHost: () => '192.168.1.20',
    interfaces: () => ({ en0: [{ address: '10.0.0.5', family: 'IPv4', internal: false } as never], en7: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never] }),
    defaultRouteInterface: () => 'en0',
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines.filter(line => line.includes('/setup#t='))).toEqual([
    'http://127.0.0.1:4321/setup#t=secret%2B%2F%3D',
    '같은 와이파이의 폰이면: http://192.168.1.20:4321/setup#t=secret%2B%2F%3D',
  ]);
  expect(qrLinks).toEqual(['http://192.168.1.20:4321/setup#t=secret%2B%2F%3D']);
  expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ lan: 'shown' });
});

test('missing or failed bind inspection keeps LAN and QR absent even with a private interface', async () => {
  for (const httpHost of [() => undefined, () => { throw Error('runtime missing'); }]) {
    const { deps, lines, qrLinks } = fixture({
      httpHost,
      interfaces: () => ({ en0: [{ address: '192.168.0.12', family: 'IPv4', internal: false } as never] }),
    });
    expect(await runWebFirstSetup(deps)).toBe('link-shown');
    expect(lines.filter(line => line.includes('/setup#t='))).toEqual(['http://127.0.0.1:4321/setup#t=secret%2B%2F%3D']);
    expect(lines.some(line => line.includes('루프백 없이 다시 띄우세요'))).toBe(false);
    expect(qrLinks).toEqual([]);
    expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ lan: 'no-address', qr: false });
  }
});

test('confirmed empty bind is distinct from an unknown bind and can show the LAN link', async () => {
  const { deps, lines, qrLinks } = fixture({
    httpHost: () => '',
    interfaces: () => ({ en0: [{ address: '192.168.0.12', family: 'IPv4', internal: false } as never] }),
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('같은 와이파이의 폰이면: http://192.168.0.12:4321/setup#t=secret%2B%2F%3D');
  expect(qrLinks).toEqual(['http://192.168.0.12:4321/setup#t=secret%2B%2F%3D']);
  expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ lan: 'shown' });
});

test('LAN route lookup exception falls back to the first private interface without failing setup', async () => {
  const { deps, lines } = fixture({
    interfaces: () => ({ en7: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never], en0: [{ address: '10.0.0.5', family: 'IPv4', internal: false } as never] }),
    defaultRouteInterface: () => { throw Error('route unavailable'); },
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('같은 와이파이의 폰이면: http://10.0.0.5:4321/setup#t=secret%2B%2F%3D');
  expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ lan: 'shown' });
});

test('tailnet QR retains priority over LAN QR even when both links are available', async () => {
  const { deps, lines, qrLinks } = fixture({
    showNexus: async () => daemon('https://machine.ts.net/app/'),
    interfaces: () => ({ en0: [{ address: '192.168.0.12', family: 'IPv4', internal: false } as never] }),
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('같은 와이파이의 폰이면: http://192.168.0.12:4321/setup#t=secret%2B%2F%3D');
  expect(qrLinks).toEqual(['https://machine.ts.net/setup#t=secret%2B%2F%3D']);
});

test('SSH prints a local forwarding command after the existing reason without logging identity', async () => {
  const { deps, lines } = fixture({ browserEnv: { SSH_CONNECTION: 'x' }, hostname: () => 'host.example', username: () => 'operator' });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  const reason = lines.findIndex(line => line.includes('원격(ssh)'));
  expect(lines[reason + 1]).toBe('ssh -L 4321:localhost:4321 operator@host.example');
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.data).toMatchObject({ lan: 'no-address', ssh: true });
  const observed = debug.events(20).filter(e => e.category === 'onboarding.web-first').map(e => JSON.stringify(e)).join('\n');
  for (const forbidden of ['secret', 'operator', 'host.example', '100.101.1.2']) expect(observed).not.toContain(forbidden);
});

test('SSH user information failure does not interrupt setup or disclose identity', async () => {
  const { deps, lines } = fixture({
    browserEnv: { SSH_CONNECTION: 'x' },
    username: () => { throw Error('user lookup unavailable'); },
    hostname: () => 'host.example',
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('http://127.0.0.1:4321/setup#t=secret%2B%2F%3D');
  expect(lines.join('\n')).toContain('원격(ssh)');
  expect(lines.some(line => line.startsWith('ssh -L '))).toBe(false);
  const event = debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1);
  expect(event?.data).toMatchObject({ ssh: true, lan: 'no-address' });
  expect(JSON.stringify(event)).not.toContain('host.example');
});

test('SSH forwards the actual daemon port from the setup link', async () => {
  const { deps, lines } = fixture({
    showNexus: async () => daemon(undefined, 31415), browserEnv: { SSH_TTY: '/dev/pts/1' },
    hostname: () => 'host.example', username: () => 'operator',
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(lines).toContain('http://127.0.0.1:31415/setup#t=secret%2B%2F%3D');
  expect(lines).toContain('ssh -L 31415:localhost:31415 operator@host.example');
  expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ ssh: true });
});

test('SSH with DISPLAY still prints forwarding hint and preserves browser-open behavior', async () => {
  const opened: string[] = [];
  const { deps, lines } = fixture({
    browserEnv: { SSH_CLIENT: 'x', DISPLAY: ':1' }, browserPlatform: 'linux',
    hostname: () => 'host.example', username: () => 'operator', isHeadless: () => false,
    openBrowser: link => { opened.push(link); return true; },
  });
  expect(await runWebFirstSetup(deps)).toBe('link-shown');
  expect(opened).toEqual(['http://127.0.0.1:4321/setup#t=secret%2B%2F%3D']);
  expect(lines).toContain('ssh -L 4321:localhost:4321 operator@host.example');
  expect(debug.events(20).filter(e => e.category === 'onboarding.web-first').at(-1)?.data).toMatchObject({ ssh: true });
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
