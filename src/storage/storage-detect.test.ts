import { describe, expect, test } from 'bun:test';
import {
  defaultWhich,
  detectStorageProviders,
  type StorageCommandResult,
  type StorageDetectDeps,
  type StorageProviderId,
} from './storage-detect.js';

const FAKE_TOKEN = 'ya29.fake-token-should-never-appear';

type Handler = (args: string[]) => StorageCommandResult | 'timeout' | 'throw';

function ok(stdout: string, stderr = ''): StorageCommandResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr = 'error'): StorageCommandResult {
  return { code: 1, stdout: '', stderr };
}

interface Harness {
  deps: StorageDetectDeps;
  calls: Array<{ bin: string; args: string[] }>;
  logs: Array<{ category: string; event: string; data?: unknown }>;
}

function harness(opts: {
  bins?: Partial<Record<string, string | null>>;
  handlers?: Record<string, Handler>;
  platform?: NodeJS.Platform;
  localWritable?: boolean;
}): Harness {
  const calls: Harness['calls'] = [];
  const logs: Harness['logs'] = [];
  const bins = opts.bins ?? {};
  const handlers = opts.handlers ?? {};
  const deps: StorageDetectDeps = {
    which: (name) => (name in bins ? bins[name]! : `/usr/bin/${name}`),
    platform: opts.platform ?? 'darwin',
    home: '/tmp/elanous-detect-home',
    localDir: '/tmp/elanous-detect-home/.elanous/storage',
    localWritable: opts.localWritable ?? true,
    log: (category, event, data) => logs.push({ category, event, data }),
    run: async (bin, args) => {
      calls.push({ bin, args });
      const name = bin.split('/').pop() ?? bin;
      const handler = handlers[name];
      if (!handler) return fail('unscripted');
      const outcome = handler(args);
      if (outcome === 'timeout') return { code: 124, stdout: '', stderr: 'timed out', timedOut: true };
      if (outcome === 'throw') throw new Error(`boom ${FAKE_TOKEN}`);
      return outcome;
    },
  };
  return { deps, calls, logs };
}

function byProvider<T extends { provider: StorageProviderId }>(rows: T[], id: StorageProviderId): T {
  const row = rows.find((item) => item.provider === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
}

describe('detectStorageProviders', () => {
  test('가짜 gcloud 가 계정·프로젝트를 주고 az 가 없으면 gcs 는 로그인, azure 는 설치 힌트', async () => {
    const h = harness({
      bins: { gcloud: '/opt/homebrew/bin/gcloud', az: null, aws: null, wrangler: null },
      handlers: {
        gcloud: (args) => {
          const joined = args.join(' ');
          if (args[0] === '--version') return ok('Google Cloud SDK 480.0.0');
          if (joined === 'config get-value account') return ok('ada@example.com\n');
          if (joined === 'config get-value project') return ok('proj-1\n');
          if (joined.startsWith('storage buckets list')) return ok('b-one\nb-two\n');
          return fail();
        },
      },
    });
    const rows = await detectStorageProviders(h.deps);
    const gcs = byProvider(rows, 'gcs');
    const azure = byProvider(rows, 'azure');
    expect(gcs.signedIn).toBe(true);
    expect(gcs.account).toBe('ada@example.com');
    expect(gcs.project).toBe('proj-1');
    expect(gcs.bucketCount).toBe(2);
    expect(gcs.cli.path).toBe('/opt/homebrew/bin/gcloud');
    expect(azure.cli.path).toBeNull();
    expect(azure.hint).toContain('brew install azure-cli');
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
  });

  test('aws sts 가 시간 초과되면 s3 signedIn 은 null', async () => {
    const h = harness({
      bins: { gcloud: null, az: null, aws: '/usr/local/bin/aws', wrangler: null },
      handlers: {
        aws: (args) => {
          if (args[0] === '--version') return ok('aws-cli/2.15.0', '');
          if (args[0] === 'sts') return 'timeout';
          return fail();
        },
      },
    });
    const rows = await detectStorageProviders(h.deps);
    const s3 = byProvider(rows, 's3');
    expect(s3.signedIn).toBeNull();
    expect(s3.cli.path).toBe('/usr/local/bin/aws');
    expect(s3.cli.version).toContain('aws-cli/2.15.0');
    expect(s3.account).toBeNull();
  });

  test('다섯 공급자 설치·로그인·미설치 조합', async () => {
    const h = harness({
      bins: {
        gcloud: '/usr/bin/gcloud',
        az: '/usr/bin/az',
        aws: '/usr/bin/aws',
        wrangler: null,
      },
      handlers: {
        gcloud: (args) => {
          if (args[0] === '--version') return ok('Google Cloud SDK 1');
          if (args.join(' ') === 'config get-value account') return ok('(unset)\n');
          if (args.join(' ') === 'config get-value project') return ok('(unset)\n');
          return fail();
        },
        az: (args) => {
          if (args[0] === 'version') return ok('{\n  "azure-cli": "2.60.0"\n}\n');
          if (args[0] === 'account' && args[1] === 'show') {
            return ok(JSON.stringify({ user: 'lee@contoso.com', sub: 'sub-name' }));
          }
          if (args[0] === 'account' && args[1] === 'list') return ok('3\n');
          return fail();
        },
        aws: (args) => {
          if (args[0] === '--version') return ok('', 'aws-cli/2.0.0 Python/3.9');
          if (args[0] === 'sts') return ok('arn:aws:iam::1:user/ada\n');
          if (args[0] === 's3api') return ok('4\n');
          if (args[0] === 'configure') return ok('default\nr2-prod\n');
          return fail();
        },
      },
    });
    const rows = await detectStorageProviders(h.deps);
    expect(rows.map((row) => row.provider)).toEqual(['local', 'gcs', 'azure', 's3', 'r2']);
    expect(byProvider(rows, 'local').signedIn).toBe(true);
    expect(byProvider(rows, 'local').hint).toContain('쓰기 가능');
    expect(byProvider(rows, 'gcs').signedIn).toBe(false);
    expect(byProvider(rows, 'gcs').hint).toBe('gcloud auth login');
    const azure = byProvider(rows, 'azure');
    expect(azure.signedIn).toBe(true);
    expect(azure.account).toBe('lee@contoso.com');
    expect(azure.project).toBe('sub-name');
    expect(azure.bucketCount).toBe(3);
    const s3 = byProvider(rows, 's3');
    expect(s3.signedIn).toBe(true);
    expect(s3.account).toBe('arn:aws:iam::1:user/ada');
    expect(s3.bucketCount).toBe(4);
    expect(s3.cli.version).toContain('aws-cli/2.0.0');
    const r2 = byProvider(rows, 'r2');
    expect(r2.cli.path).toBeNull();
    expect(r2.account).toBe('r2-prod');
    expect(r2.hint).toContain('brew install wrangler');
    expect(h.logs).toEqual([{
      category: 'storage.detect',
      event: 'done',
      data: { found: ['local', 'gcs', 'azure', 's3'], signedIn: ['local', 'azure', 's3'] },
    }]);
    const blob = JSON.stringify({ rows, logs: h.logs });
    expect(blob).not.toContain(FAKE_TOKEN);
    expect(blob).not.toContain('AKIA');
  });

  test('명령이 던지거나 비정상 종료면 signedIn 을 false 로 단정하지 않는다', async () => {
    const h = harness({
      bins: { gcloud: '/usr/bin/gcloud', az: '/usr/bin/az', aws: null, wrangler: '/usr/bin/wrangler' },
      handlers: {
        gcloud: () => 'throw',
        az: (args) => (args[0] === 'version' ? ok('azure-cli 2') : fail('not logged in')),
        wrangler: (args) => (args[0] === '--version' ? ok('3.0.0') : fail()),
      },
    });
    const rows = await detectStorageProviders(h.deps);
    expect(byProvider(rows, 'gcs').signedIn).toBeNull();
    expect(byProvider(rows, 'azure').signedIn).toBeNull();
    expect(byProvider(rows, 'azure').hint).toBe('az login');
    expect(byProvider(rows, 's3').cli.path).toBeNull();
    expect(byProvider(rows, 's3').hint).toContain('brew install awscli');
    expect(byProvider(rows, 'r2').signedIn).toBeNull();
    expect(byProvider(rows, 'r2').hint).toBe('wrangler login');
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
  });

  test('wrangler whoami 는 이메일·계정 ID 만 담고 토큰은 싣지 않는다', async () => {
    const h = harness({
      bins: { gcloud: null, az: null, aws: null, wrangler: '/usr/bin/wrangler' },
      handlers: {
        wrangler: (args) => {
          if (args[0] === '--version') return ok('wrangler 3.78.0');
          if (args[0] === 'whoami') {
            return ok(`Getting User settings...\nYou are logged in with an OAuth Token ${FAKE_TOKEN}\nassociated with the email ada@example.com\nAccount ID: abcdef0123456789abcdef0123456789\n`);
          }
          return fail();
        },
      },
    });
    const rows = await detectStorageProviders(h.deps);
    const r2 = byProvider(rows, 'r2');
    expect(r2.signedIn).toBe(true);
    expect(r2.account).toBe('ada@example.com');
    expect(r2.project).toBe('abcdef0123456789abcdef0123456789');
    expect(JSON.stringify(r2)).not.toContain(FAKE_TOKEN);
  });

  test('리눅스 미설치 힌트는 brew 가 아니다', async () => {
    const h = harness({
      bins: { gcloud: null, az: null, aws: null, wrangler: null },
      platform: 'linux',
    });
    const rows = await detectStorageProviders(h.deps);
    expect(byProvider(rows, 'gcs').hint).toContain('snap install google-cloud-cli');
    expect(byProvider(rows, 'azure').hint).toContain('InstallAzureCLIDeb');
    expect(byProvider(rows, 's3').hint).toContain('snap install aws-cli');
    expect(byProvider(rows, 'r2').hint).toContain('npm install -g wrangler');
    expect(byProvider(rows, 'local').signedIn).toBe(true);
  });

  test('로컬 디렉터리를 쓸 수 없으면 힌트만 바꾸고 공급자는 사용 가능으로 둔다', async () => {
    const h = harness({
      bins: { gcloud: null, az: null, aws: null, wrangler: null },
      localWritable: false,
    });
    const local = byProvider(await detectStorageProviders(h.deps), 'local');
    expect(local.signedIn).toBe(true);
    expect(local.cli.path).toBe('/tmp/elanous-detect-home/.elanous/storage');
    expect(local.hint).toContain('쓰기 불가');
  });

  test('호출은 timeoutMs 8000 으로만 나가고 쓰기 명령은 없다', async () => {
    const seen: Array<{ args: string[]; timeoutMs: number }> = [];
    const deps: StorageDetectDeps = {
      which: (name) => (name === 'gcloud' ? '/usr/bin/gcloud' : null),
      platform: 'darwin',
      home: '/tmp/elanous-detect-home',
      localWritable: true,
      log: () => {},
      run: async (_bin, args, opts) => {
        seen.push({ args, timeoutMs: opts.timeoutMs });
        return fail();
      },
    };
    await detectStorageProviders(deps);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.timeoutMs).toBe(8000);
      const joined = call.args.join(' ');
      expect(joined).not.toMatch(/\b(mb|rb|cp|mv|rm|sync|put|create|delete|insert)\b/);
    }
  });

  test('defaultWhich 는 resolveCliBin 을 쓴다 — 찾으면 그 경로, 없으면 null', () => {
    const fake = '/tmp/elanous-fake-bins/gcloud';
    expect(defaultWhich('gcloud', {
      candidates: (name) => (name === 'gcloud' ? [fake] : []),
      exists: (path) => path === fake,
    })).toBe(fake);
    expect(defaultWhich('aws', { candidates: () => [], exists: () => false })).toBeNull();
  });
});
