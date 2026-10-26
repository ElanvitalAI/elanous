import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { coalescedInstallationCredential } from '../../auth/github-app-token.js';
import { POD_GH_LOGIN_RETRY_BACKOFF_MS, hostGrokCredentials, podGhLoginRetryBackoffMs, podGrokSkippedLine, podGrokSubscriptionUsable, podJobName, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

const now = Date.parse('2026-10-05T05:00:00Z');
const credentials = () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'human-token' });

function cluster(exits: number[]) {
  const applied: Array<{ kind: string; stringData?: Record<string, string>; spec?: any }> = [];
  const calls: string[] = [];
  let attempt = -1;
  const kubectl: Kubectl = (args, input) => {
    const command = args.join(' ');
    calls.push(command);
    if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
    if (command.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (command.endsWith('apply -f -')) {
      const manifest = JSON.parse(input!);
      applied.push(manifest);
      if (manifest.kind === 'Job') attempt++;
    }
    if (command.includes('status.conditions[*].type')) return { status: 0, stdout: exits[attempt] === 0 ? 'Complete' : 'Failed', stderr: '' };
    if (command.includes('conditions[?(@.type=="Failed")].reason')) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
    if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: `2026-10-05T05:01:00Z\tError\t${exits[attempt]}\n`, stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: exits[attempt] === 0 ? '{"stage":"pr-opened","ok":true}\n' : 'login failed\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { kubectl, applied, calls };
}

const app = (index: number) => ({ token: `installation-${index}`, expires_at: new Date(now + (index === 1 ? 5 : 60) * 60_000).toISOString() });

describe('Pod credential refresh', () => {
  test('a five-minute App token is shipped (host renewal keeps it alive) and its short remaining life is observed', async () => {
    const sim = cluster([0]);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-credential-short', emit: (record) => {
      if (record.category === 'self-implement.pod' && typeof record.event === 'string' && record.event.startsWith('github-app')) events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    let issued = 0;
    try {
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {}, now: () => now,
        githubInstallation: () => app(++issued), githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ feature: 'same goal', spaceId: 'app-five-minutes' }).done;
      expect(result.exitCode).toBe(0);
      expect(sim.applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['gh-token']).toBe('installation-1');
      expect(events).toContainEqual({ event: 'github-app-short-lived', data: expect.objectContaining({ requiredSeconds: 1200 }) });
      expect(JSON.stringify(events)).not.toContain('installation-');
    } finally { off(); }
  });

  test('a fresh App token is not reported short-lived', async () => {
    const sim = cluster([0]);
    const events: string[] = [];
    const off = debug.registerSink({ name: 'pod-credential-fresh', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'github-app-short-lived') events.push(record.event);
    } });
    try {
      await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {}, now: () => now,
        githubInstallation: () => app(2), githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ feature: 'same goal', spaceId: 'app-fresh' }).done;
      expect(events).toEqual([]);
    } finally { off(); }
  });

  test('an initial App issuance exception preserves the human credential fallback', async () => {
    const sim = cluster([0]);
    const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {},
      githubInstallation: () => { throw new Error('App unavailable'); },
    })({ feature: 'same goal', spaceId: 'app-initial-exception' }).done;
    expect(result.exitCode).toBe(0);
    expect(sim.applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['gh-token']).toBe('human-token');
  });

  test('a still-short App token uses the authenticated relay and host renewal on the first live poll', async () => {
    const applied: Array<{ kind: string; stringData?: Record<string, string> }> = [];
    const pushed: string[] = [];
    let issued = 0;
    let polls = 0;
    const kubectl: Kubectl = (args, input) => {
      const command = args.join(' ');
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (command.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: '' };
      if (command.endsWith('apply -f -')) applied.push(JSON.parse(input!));
      if (command.includes('status.conditions[*].type')) return { status: 0, stdout: ++polls > 1 ? 'Complete' : '', stderr: '' };
      if (args.includes('exec') && args.includes('--with-token')) pushed.push(input!);
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl, credentials, env: {}, now: () => now, sleep: async () => {},
      deadlineSeconds: 1200, groundingUrl: 'https://host:31415',
      githubInstallation: () => ({ token: `installation-${++issued}`, expires_at: new Date(now + 5 * 60_000).toISOString() }),
      githubRepositories: async () => ['ElanvitalAI/elanous'],
      mintGrounding: async () => ({ token: 'relay', exp: now + 1200_000 }), revokeGrounding: () => {},
    })({ feature: 'same goal', spaceId: 'app-relay-renewal' }).done;
    expect(result.exitCode).toBe(0);
    expect(issued).toBe(2);
    expect(applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['env-ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN']).toBe('relay');
    expect(pushed).toEqual(['installation-2\n']);
  });

  test('unavailable App preserves the human token and legacy GH_TOKEN script', async () => {
    const sim = cluster([0]);
    const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {},
      githubInstallation: () => null,
    })({ feature: 'same goal', spaceId: 'human-gh-preserved' }).done;
    expect(result.exitCode).toBe(0);
    expect(sim.applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['gh-token']).toBe('human-token');
    const job = sim.applied.find((manifest) => manifest.kind === 'Job');
    expect(job?.spec.template.spec.containers[0].args[0]).toContain('export GH_TOKEN="$(cat /creds/gh-token)"');
    expect(job?.spec.template.spec.containers[0].args[0]).not.toContain('gh auth login --with-token < /creds/gh-token');
  }, 15_000); // Simulated kubectl startup exceeded Bun's 5s default on the shared host.

  test('exit 7 backs off then retries the same goal once with a newly issued token; a second 7 fails with reason and other exits never retry', async () => {
    for (const [exits, expectedCode] of [[[7, 0], undefined], [[7, 7], 'pod-gh-login-failed'], [[8], 'pod-job-failed']] as const) {
      const sim = cluster([...exits]);
      const events: Array<Record<string, unknown>> = [];
      const off = debug.registerSink({ name: `pod-credential-exit-${exits.join('-')}`, emit: (record) => {
        if (record.category === 'self-implement.pod' && record.event === 'gh-login-failed') events.push(record.data as Record<string, unknown>);
      } });
      let issued = 0;
      const slept: number[] = [];
      try {
        const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {}, now: () => now, sleep: async (ms) => { slept.push(ms); },
          deadlineSeconds: 1200, githubInstallation: () => app(++issued),
          githubRepositories: async () => ['ElanvitalAI/elanous'],
          groundingUrl: 'https://host:31415', mintGrounding: async () => ({ token: 'relay', exp: now + 1200_000 }), revokeGrounding: () => {},
        })({ feature: 'same goal', spaceId: `login-${exits.join('-')}` }).done;
        const secrets = sim.applied.filter((manifest) => manifest.kind === 'Secret');
        const jobs = sim.applied.filter((manifest) => manifest.kind === 'Job');
        expect(jobs).toHaveLength(exits.length);
        expect(secrets.map((manifest) => manifest.stringData?.feature)).toEqual(exits.map(() => 'same goal'));
        expect(secrets.map((manifest) => manifest.stringData?.['gh-token'])).toEqual(exits.map((_, i) => `installation-${i + 1}`));
        expect(sim.calls.filter((call) => call.includes('delete job') && call.includes('--wait=true'))).toHaveLength(exits.length - 1);
        expect(events).toEqual(exits.filter((exit) => exit === 7).map((_, i) => expect.objectContaining({ job: podJobName(`login-${exits.join('-')}`), attempt: i + 1, tokenExpiresInSec: i === 0 ? 300 : 3600 })));
        expect(result.error?.code).toBe(expectedCode);
        // One backoff before the single retry, at least the base and spread by job name; never a second retry.
        const backoffs = slept.filter((ms) => ms >= POD_GH_LOGIN_RETRY_BACKOFF_MS);
        expect(backoffs).toEqual(exits[0] === 7 ? [podGhLoginRetryBackoffMs(podJobName(`login-${exits.join('-')}`))] : []);
        if (expectedCode === 'pod-gh-login-failed') expect(result.error?.message).toContain('1회 재시도했으나 다시 실패');
      } finally { off(); }
    }
  }, 30_000); // Three sequential simulated Job runs exceed Bun's 5s default under shared host load.

  test('1h44m Grok auth refreshes through the production host credential preflight before applying the Job', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-window-'));
    try {
      mkdirSync(join(home, '.grok'));
      const auth = join(home, '.grok', 'auth.json');
      const put = (key: string, expiresAt: number) => writeFileSync(auth, JSON.stringify({
        'https://auth.x.ai::client': { key, expires_at: new Date(expiresAt).toISOString(), refresh_token: 'same-session' },
      }));
      put('old', now + 104 * 60_000);
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const grok = join(bin, 'grok');
      writeFileSync(grok, `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(home, 'grok-calls'))},'called\\n');const p=${JSON.stringify(auth)};const a=JSON.parse(fs.readFileSync(p,'utf8'));const s=a['https://auth.x.ai::client'];s.key='new';s.expires_at=new Date(${now} + 6*60*60*1000).toISOString();fs.writeFileSync(p,JSON.stringify(a));\n`);
      chmodSync(grok, 0o755);
      const originalHome = process.env.HOME;
      const originalPath = process.env.PATH;
      process.env.HOME = home;
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      const sim = cluster([0]);
      try {
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {}, now: () => now,
        grokCredentials: () => hostGrokCredentials({ home, env: {}, now: () => now, ghToken: () => 'human-token', grokPath: grok }),
      })({ feature: 'grok proactive refresh', spaceId: 'grok-window-refresh' }).done;
      expect(result.exitCode, result.error?.message).toBe(0);
      expect(readFileSync(join(home, 'grok-calls'), 'utf8').trim().split(/\\n/)).toEqual(['called']);
      const refreshed = JSON.parse(readFileSync(auth, 'utf8'))['https://auth.x.ai::client'];
      expect(refreshed.key).toBe('new');
      expect(refreshed.expires_at).toBe(new Date(now + 6 * 60 * 60_000).toISOString());
      } finally {
        if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
        if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      }
      expect(sim.applied.some((manifest) => manifest.kind === 'Job')).toBe(true);
      const shipped = sim.applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['grok-auth.json'];
      expect(shipped).toContain('new');
      expect(shipped).not.toContain('same-session');
      expect(JSON.stringify(sim.applied)).not.toContain('same-session');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('same-key scopes do not lend a refresh token to the selected scope; no Job is applied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-scope-'));
    try {
      mkdirSync(join(home, '.grok'));
      writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
        'https://auth.x.ai::refreshable': { key: 'shared', expires_at: new Date(now + 60 * 60_000).toISOString(), refresh_token: 'other-session' },
        'https://auth.x.ai::selected': { key: 'shared', expires_at: new Date(now + 104 * 60_000).toISOString() },
      }));
      const sim = cluster([0]);
      let refreshCalls = 0;
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {}, now: () => now,
        grokCredentials: () => hostGrokCredentials({ home, env: {}, now: () => now, ghToken: () => 'human-token', refresh: () => { refreshCalls++; return 'refreshed'; } }),
      })({ feature: 'selected scope token check', spaceId: 'grok-selected-scope-no-token' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('선택된 구독 scope에 refresh token 없음');
      expect(sim.applied.some((manifest) => manifest.kind === 'Job')).toBe(false);
      expect(sim.calls.some((call) => call.includes('apply -f -') && sim.applied.some((manifest) => manifest.kind === 'Job'))).toBe(false);
      expect(refreshCalls).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a healthy selected scope without refresh token still launches without refresh', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-healthy-no-refresh-'));
    try {
      mkdirSync(join(home, '.grok'));
      writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
        'https://auth.x.ai::selected': { key: 'healthy', expires_at: new Date(now + 6 * 60 * 60_000).toISOString() },
      }));
      const sim = cluster([0]);
      let refreshCalls = 0;
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {}, now: () => now,
        grokCredentials: () => hostGrokCredentials({ home, env: {}, now: () => now, ghToken: () => 'human-token', refresh: () => { refreshCalls++; return 'refreshed'; } }),
      })({ feature: 'healthy no refresh token', spaceId: 'grok-healthy-no-refresh' }).done;
      expect(result.exitCode).toBe(0);
      expect(sim.applied.some((manifest) => manifest.kind === 'Job')).toBe(true);
      expect(refreshCalls).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a selected-scope change during host refresh is rejected before any Job is applied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-race-'));
    try {
      mkdirSync(join(home, '.grok'));
      const auth = join(home, '.grok', 'auth.json');
      writeFileSync(auth, JSON.stringify({
        'https://auth.x.ai::initial': { key: 'old', expires_at: new Date(now + 104 * 60_000).toISOString(), refresh_token: 'same-session' },
      }));
      const sim = cluster([0]);
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {}, now: () => now,
        grokCredentials: () => hostGrokCredentials({ home, env: {}, now: () => now, ghToken: () => 'human-token', refresh: () => {
          writeFileSync(auth, JSON.stringify({
            'https://auth.x.ai::replacement': { key: 'unchecked', expires_at: new Date(now + 6 * 60 * 60_000).toISOString(), refresh_token: 'replacement-session' },
          }));
          return 'refreshed';
        } }),
      })({ feature: 'scope changes during preflight', spaceId: 'grok-scope-race' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('선택된 구독 scope가 사라졌거나 바뀜');
      expect(sim.applied.some((manifest) => manifest.kind === 'Job')).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('1h44m Grok auth with failed refresh remains no-launch before any Job is applied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-failed-window-'));
    try {
      mkdirSync(join(home, '.grok'));
      writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
        'https://auth.x.ai::client': { key: 'old', expires_at: new Date(now + 104 * 60_000).toISOString(), refresh_token: 'same-session' },
      }));
      const sim = cluster([0]);
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {}, now: () => now,
        grokCredentials: () => hostGrokCredentials({ home, env: {}, now: () => now, ghToken: () => 'human-token', refresh: () => 'failed' }),
      })({ feature: 'grok proactive refresh', spaceId: 'grok-window-no-launch' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('구독 access 토큰 남은 시간');
      expect(sim.applied.some((manifest) => manifest.kind === 'Job')).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('five-minute Grok auth refreshes on host and ships the new access copy without its refresh token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-credential-grok-'));
    try {
      mkdirSync(join(home, '.grok'));
      const auth = join(home, '.grok', 'auth.json');
      const put = (key: string, ms: number) => writeFileSync(auth, JSON.stringify({ 'https://auth.x.ai::client': { key, expires_at: new Date(Date.now() + ms).toISOString(), refresh_token: 'host-refresh' } }));
      put('old', 5 * 60_000);
      let refreshes = 0;
      const refresh = () => { refreshes++; put('new', 6 * 3600_000); };
      expect(podGrokSubscriptionUsable({ home, env: {}, refresh }).usable).toBe(true);
      const sim = cluster([0]);
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, provider: 'grok', env: {},
        grokCredentials: () => hostGrokCredentials({ home, env: {}, ghToken: () => 'human-token', refresh }),
      })({ feature: 'grok goal', spaceId: 'grok-refreshed' }).done;
      expect(result.exitCode).toBe(0);
      expect(refreshes).toBe(1);
      expect(readFileSync(auth, 'utf8')).toContain('new');
      const shipped = sim.applied.find((manifest) => manifest.kind === 'Secret')?.stringData?.['grok-auth.json'];
      expect(shipped).toContain('new');
      expect(shipped).not.toContain('old');
      expect(shipped).not.toContain('refresh_token');
      expect(sim.applied.find((manifest) => manifest.kind === 'Job')?.spec.template.spec.containers[0].args[0]).toContain('install -m 600 /creds/grok-auth.json ~/.grok/auth.json');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('the exit-7 retry through real coalescing mints a different token instead of reusing the one that failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-credential-coalesce-'));
    try {
      const sim = cluster([7, 0]);
      let mints = 0;
      const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {}, sleep: async () => {},
        githubInstallation: (repo, o) => coalescedInstallationCredential({ repository: repo.split('/')[1]! }, { cacheDir: dir, fresh: o?.fresh,
          mint: () => ({ token: `coalesced-${++mints}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }) }),
        githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ feature: 'same goal', spaceId: 'login-coalesced' }).done;
      const shipped = sim.applied.filter((manifest) => manifest.kind === 'Secret').map((manifest) => manifest.stringData?.['gh-token']);
      expect(result.exitCode).toBe(0);
      expect(mints).toBe(2);
      expect(shipped).toEqual(['coalesced-1', 'coalesced-2']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an abort during the exit-7 backoff stops before a second Secret, Job or token', async () => {
    const sim = cluster([7, 0]);
    const controller = new AbortController();
    let issued = 0;
    const result = await podSelfImplementSpawn({ kubectl: sim.kubectl, credentials, env: {}, now: () => now,
      sleep: async (ms) => { if (ms >= POD_GH_LOGIN_RETRY_BACKOFF_MS) controller.abort(); },
      githubInstallation: () => app(++issued + 1), githubRepositories: async () => ['ElanvitalAI/elanous'],
    })({ feature: 'same goal', spaceId: 'login-abort', signal: controller.signal }).done;
    expect(result.error?.code).toBe('aborted');
    expect(sim.applied.filter((manifest) => manifest.kind === 'Job')).toHaveLength(1);
    expect(sim.applied.filter((manifest) => manifest.kind === 'Secret')).toHaveLength(1);
    expect(issued).toBe(1);
  });
});
