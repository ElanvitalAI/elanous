import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';

import { mountShareIfEnabled } from '../src/cli/share-auto-mount.js';
import { debug } from '../src/debug/log.js';
import { autoServe, defaultServe } from '../src/nexus/onboarding/pwa-share-prompt.js';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe.js';

type ServeCall = { binary: string; args: readonly string[] };

// ⛔ R-TST23 — mock.module 은 «프로세스 전역»이다. 진짜 모듈을 맨 위에서 붙잡아 두고 끝에 되돌린다
//    (함수 안에서 dynamic import 로 «원본»을 다시 얻으면 이미 가짜일 수 있다).
const originalChildProcess = { ...realChildProcess };
afterAll(() => {
  mock.module('node:child_process', () => originalChildProcess);
});

const TS_ALIVE: TailscaleProbe = {
  installed: true,
  alive: true,
  binary: '/opt/homebrew/bin/tailscale',
  hostname: 'mbp',
  magicDnsHost: 'mbp.tail-abc.ts.net',
  ips: ['100.64.0.2'],
  backendState: 'Running',
};
const TS_MISSING: TailscaleProbe = { installed: false, alive: false };
const TS_DOWN: TailscaleProbe = {
  installed: true,
  alive: false,
  binary: '/opt/homebrew/bin/tailscale',
  backendState: 'Stopped',
};

describe('mountShareIfEnabled', () => {
  test('switch=enabled mounts tailscale serve against the live port', async () => {
    let servedPort = -1;
    let servedBinary = '';
    const r = await mountShareIfEnabled({
      httpPort: 31420,
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async (bin, port) => {
        servedBinary = bin;
        servedPort = port;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('serving');
    expect(servedPort).toBe(31420);
    expect(servedBinary).toBe('/opt/homebrew/bin/tailscale');
    expect(r.url).toBe('https://mbp.tail-abc.ts.net:31420/app/');
  });

  test('switch=disabled skips without calling serve', async () => {
    let serveCalls = 0;
    const r = await mountShareIfEnabled({
      httpPort: 31415,
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => {
        serveCalls += 1;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('switch-disabled');
    expect(serveCalls).toBe(0);
  });

  test('switch=ask skips without calling serve', async () => {
    let serveCalls = 0;
    const r = await mountShareIfEnabled({
      httpPort: 31415,
      readShareSwitchFn: () => 'ask',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => {
        serveCalls += 1;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('switch-ask');
    expect(serveCalls).toBe(0);
  });

  test('https=true bypasses switch=disabled (force-enable for THIS run)', async () => {
    let servedPort = -1;
    const r = await mountShareIfEnabled({
      httpPort: 31420,
      https: true,
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async (_bin, port) => {
        servedPort = port;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('serving');
    expect(servedPort).toBe(31420);
  });

  test('tailscale missing → skipped with reason', async () => {
    let serveCalls = 0;
    const r = await mountShareIfEnabled({
      httpPort: 31415,
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_MISSING,
      shareServeFn: async () => {
        serveCalls += 1;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('tailscale-missing');
    expect(serveCalls).toBe(0);
  });

  test('tailscale installed but down → skipped with reason', async () => {
    let serveCalls = 0;
    const r = await mountShareIfEnabled({
      httpPort: 31415,
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_DOWN,
      shareServeFn: async () => {
        serveCalls += 1;
        return { exitCode: 0 };
      },
    });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('tailscale-down');
    expect(serveCalls).toBe(0);
  });

  test('serve non-zero exit → failed with reason + exit code', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'share.auto-mount' && event === 'failed') seen.push(data);
      return original(category, event, data);
    }) as typeof debug.log;
    try {
      const r = await mountShareIfEnabled({
        httpPort: 31415,
        readShareSwitchFn: () => 'enabled',
        shareProbeFn: async () => TS_ALIVE,
        shareServeFn: async () => ({ exitCode: 7 }),
      });
      expect(r.outcome).toBe('failed');
      expect(r.reason).toBe('serve-error');
      expect(r.serveExitCode).toBe(7);
      expect(seen[seen.length - 1]?.likelyCause).toBeUndefined();
    } finally {
      debug.log = original;
    }
  });

  test('url uses the actual live port (mount target = httpPort param)', async () => {
    const r = await mountShareIfEnabled({
      httpPort: 31499,
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => ({ exitCode: 0 }),
    });
    expect(r.url).toBe('https://mbp.tail-abc.ts.net:31499/app/');
  });

  async function withRecordedExec(
    script: Array<{ exitCode: number; stderr?: string }>,
    calls: ServeCall[],
    run: () => Promise<void>,
  ): Promise<void> {
    const original = originalChildProcess.execFile;
    const fake = ((cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ binary: cmd, args });
      const next = script.shift() ?? { exitCode: 0 };
      const err = next.exitCode === 0 ? null : Object.assign(new Error('serve failed'), { code: next.exitCode });
      cb(err, '', next.stderr ?? '');
      return {} as ReturnType<typeof original>;
    }) as typeof original;
    mock.module('node:child_process', () => ({ ...originalChildProcess, execFile: fake }));
    try {
      await run();
    } finally {
      mock.module('node:child_process', () => originalChildProcess);
    }
  }

  test('autoServe omits useSudo so the existing ladder stays intact', async () => {
    const calls: ServeCall[] = [];
    await withRecordedExec([{ exitCode: 0 }], calls, () => autoServe('/opt/homebrew/bin/tailscale', 31415).then(() => undefined));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binary).not.toBe('sudo');
    expect(calls[0]?.args[0]).not.toBe('-n');
  });

  test('non-sudo first attempt rc 0 yields serving with zero sudo calls', async () => {
    const calls: ServeCall[] = [];
    let outcome = '';
    await withRecordedExec([{ exitCode: 0 }], calls, async () => {
      const r = await mountShareIfEnabled({
        httpPort: 31415,
        readShareSwitchFn: () => 'enabled',
        shareProbeFn: async () => TS_ALIVE,
      });
      outcome = r.outcome;
    });
    expect(outcome).toBe('serving');
    expect(calls.filter((c) => c.binary === 'sudo' || c.args[0] === '-n')).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  test('permission error on the first attempt yields exactly one sudo -n', async () => {
    const calls: ServeCall[] = [];
    const seen: Array<Record<string, unknown> | undefined> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'share.auto-mount' && event === 'failed') seen.push(data);
      return original(category, event, data);
    }) as typeof debug.log;
    try {
      let outcome = '';
      await withRecordedExec(
        [{ exitCode: 1, stderr: 'permission denied' }, { exitCode: 1, stderr: 'a password is required' }],
        calls,
        async () => {
          const r = await mountShareIfEnabled({
            httpPort: 31415,
            readShareSwitchFn: () => 'enabled',
            shareProbeFn: async () => TS_ALIVE,
          });
          outcome = r.outcome;
        },
      );
      expect(outcome).toBe('failed');
      expect(calls.filter((c) => c.binary === 'sudo' && c.args[0] === '-n')).toHaveLength(1);
      expect(seen[seen.length - 1]?.likelyCause).toBe('sudo-cache-empty-in-fork-detach');
    } finally {
      debug.log = original;
    }
  });

  test('mounting via defaultServe uses sudo on the first call', async () => {
    const calls: ServeCall[] = [];
    let outcome = '';
    await withRecordedExec([{ exitCode: 0 }], calls, async () => {
      const r = await mountShareIfEnabled({
        httpPort: 31415,
        readShareSwitchFn: () => 'enabled',
        shareProbeFn: async () => TS_ALIVE,
        shareServeFn: defaultServe,
      });
      outcome = r.outcome;
    });
    expect(outcome).toBe('serving');
    expect(calls[0]?.binary).toBe('sudo');
    expect(calls[0]?.args[0]).toBe('-n');
  });

  test('an injected serve failure does not claim the sudo ladder ran', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'share.auto-mount' && event === 'failed') seen.push(data);
      return original(category, event, data);
    }) as typeof debug.log;
    try {
      const r = await mountShareIfEnabled({
        httpPort: 31415,
        readShareSwitchFn: () => 'enabled',
        shareProbeFn: async () => TS_ALIVE,
        shareServeFn: async () => ({ exitCode: 7 }),
      });
      expect(r.outcome).toBe('failed');
      expect(seen[seen.length - 1]?.likelyCause).toBeUndefined();
    } finally {
      debug.log = original;
    }
  });
});
