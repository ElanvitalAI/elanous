import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultLocalStorageDir,
  createObjectStore,
  resolveStorageConfig,
  type RunFn,
  type StorageConfig,
} from './object-store.js';

function callsOf(): { run: RunFn; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const run: RunFn = (bin, args) => {
    calls.push({ bin, args });
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('resolveStorageConfig', () => {
  test('빈 설정 → local · 기본 localDir', () => {
    const cfg = resolveStorageConfig({}, {});
    expect(cfg.provider).toBe('local');
    expect(cfg.bucket).toBe('');
    expect(cfg.publicBucket).toBe('');
    expect(cfg.localDir).toBe(defaultLocalStorageDir());
  });

  test('옛 storage.s3.bucket → s3 (provider 미지정)', () => {
    const cfg = resolveStorageConfig({ storage: { s3: { bucket: 'priv', publicBucket: 'pub' } } }, {});
    expect(cfg.provider).toBe('s3');
    expect(cfg.bucket).toBe('priv');
    expect(cfg.publicBucket).toBe('pub');
  });

  test('storage.provider: gcs 가 버킷보다 우선', () => {
    const cfg = resolveStorageConfig({
      storage: { provider: 'gcs', bucket: 'b', gcs: { project: 'p' }, s3: { bucket: 'old' } },
    }, {});
    expect(cfg.provider).toBe('gcs');
    expect(cfg.bucket).toBe('b');
    expect(cfg.gcs).toEqual({ project: 'p' });
  });

  test('app quota ledger path is normalized for shared remote writers', () => {
    const cfg = resolveStorageConfig({ storage: { provider: 's3', quotaLedgerPath: '~/shared/app-quota.sqlite' } }, {});
    expect(cfg.quotaLedgerPath).toBe(join(homedir(), 'shared', 'app-quota.sqlite'));
  });

  test('env 가 파일 버킷보다 우선 · storage.bucket 이 s3.bucket 보다 우선', () => {
    const fromFile = resolveStorageConfig({ storage: { bucket: 'top', s3: { bucket: 'nested' } } }, { AWS_S3_BUCKET: 'from-env' });
    expect(fromFile.bucket).toBe('top');
    expect(fromFile.provider).toBe('s3');
    const onlyEnv = resolveStorageConfig({}, { AWS_S3_BUCKET: 'from-env', AWS_S3_PUBLIC_BUCKET: 'pub-env' });
    expect(onlyEnv.provider).toBe('s3');
    expect(onlyEnv.bucket).toBe('from-env');
    expect(onlyEnv.publicBucket).toBe('pub-env');
  });

  test('ELANOUS_S3_DISABLED=1 이면 원격 공급자도 local', () => {
    const cfg = resolveStorageConfig(
      { storage: { provider: 'gcs', bucket: 'b' } },
      { ELANOUS_S3_DISABLED: '1' },
    );
    expect(cfg.provider).toBe('local');
  });
});

describe('createObjectStore', () => {
  test('빈 설정으로 put 하면 provider 는 local 이고 run 은 한 번도 안 불린다', () => {
    const cfg = resolveStorageConfig({}, {});
    const dir = mkdtempSync(join(tmpdir(), 'objstore-'));
    const local: StorageConfig = { ...cfg, localDir: dir };
    const { run, calls } = callsOf();
    const store = createObjectStore(local, { run });
    expect(store.provider).toBe('local');
    store.put('monad/id/sessions/a.txt', 'hello');
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(dir, 'private', 'monad/id/sessions/a.txt'), 'utf8')).toBe('hello');
  });

  test('local 이 임시 폴더에 쓰고 읽고 head 한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'objstore-'));
    const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: 'pub', prefix: 'monad' };
    const store = createObjectStore(cfg, { run: () => { throw new Error('remote'); } });
    const src = join(dir, 'src.txt');
    writeFileSync(src, 'from-file');
    store.put('notes/a.txt', src);
    const dest = join(dir, 'out.txt');
    store.get('notes/a.txt', dest);
    expect(readFileSync(dest, 'utf8')).toBe('from-file');
    expect(store.head('notes/a.txt').exists).toBe(true);
    expect(store.head('notes/a.txt').bytes).toBe(Buffer.byteLength('from-file'));
    expect(store.head('missing').exists).toBe(false);
    expect(store.list('notes')).toContain('notes/a.txt');
    expect(existsSync(join(dir, 'private', 'notes/a.txt'))).toBe(true);
  });

  test('공개 키에 publicBucket 이 비면 원격 쓰기를 거부한다', () => {
    const { run, calls } = callsOf();
    const cfg: StorageConfig = { provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad' };
    const store = createObjectStore(cfg, { run, which: (name) => name });
    expect(() => store.put('monad/publish/abc/index.html', 'x')).toThrow(/publicBucket|버킷/);
    expect(calls).toHaveLength(0);
    store.put('monad/id/sessions/a.txt', 'ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('s3://priv/monad/id/sessions/a.txt');
  });

  test('s3 put/get/head 인자 — profile · region', () => {
    const { run, calls } = callsOf();
    const cfg: StorageConfig = {
      provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: 'pub', prefix: 'monad',
      s3: { region: 'ap-northeast-2', profile: 'dev' },
    };
    const store = createObjectStore(cfg, { run: (bin, args) => { calls.push({ bin, args }); return { stdout: '{"ContentLength":3}', stderr: '' }; } });
    store.put('k.txt', new Uint8Array([1, 2, 3]), { contentType: 'text/plain' });
    expect(calls[0]!.args.slice(0, 4)).toEqual(['s3', 'cp', '-', 's3://priv/k.txt']);
    expect(calls[0]!.args).toContain('--profile');
    expect(calls[0]!.args).toContain('dev');
    expect(calls[0]!.args).toContain('--region');
    expect(calls[0]!.args).toContain('ap-northeast-2');
    expect(calls[0]!.args).toContain('--content-type');
    store.get('k.txt', '/tmp/out');
    expect(calls[1]!.args).toContain('s3://priv/k.txt');
    const head = store.head('k.txt');
    expect(head).toEqual({ exists: true, bytes: 3 });
    expect(calls[2]!.args[0]).toBe('s3api');
  });

  test('r2 는 endpoint-url 과 profile 을 붙인다', () => {
    const { run, calls } = callsOf();
    const cfg: StorageConfig = {
      provider: 'r2', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad',
      r2: { accountId: 'abc123', profile: 'r2user' },
    };
    const store = createObjectStore(cfg, { run, which: (name) => name });
    store.put('k.txt', 'hi');
    expect(calls[0]!.args).toContain('--endpoint-url');
    expect(calls[0]!.args).toContain('https://abc123.r2.cloudflarestorage.com');
    expect(calls[0]!.args).toContain('--profile');
    expect(calls[0]!.args).toContain('r2user');
    expect(calls[0]!.bin).toBe('aws');
  });

  test('gcs 는 gcloud storage cp / objects describe', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run: RunFn = (bin, args) => {
      calls.push({ bin, args });
      if (args[0] === 'storage' && args[1] === 'objects') return { stdout: '{"size":"4"}', stderr: '' };
      if (args[1] === 'ls') return { stdout: 'gs://b/pre/a\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const cfg: StorageConfig = {
      provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: 'pub', prefix: 'monad',
      gcs: { project: 'proj' },
    };
    const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
    store.put('pre/a', 'data', { contentType: 'text/plain' });
    expect(calls[0]!.bin).toBe('gcloud');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['storage', 'cp', '-']);
    expect(calls[0]!.args).toContain('gs://b/pre/a');
    store.get('pre/a', '/tmp/g');
    expect(calls[1]!.args).toContain('gs://b/pre/a');
    expect(store.head('pre/a')).toEqual({ exists: true, bytes: 4 });
    expect(calls[2]!.args).toContain('objects');
    expect(store.list('pre')).toEqual(['pre/a']);
    expect(store.publicUrl('monad/publish/x')).toBe('https://storage.googleapis.com/pub/monad/publish/x');
    expect(store.publicUrl('monad/id/sessions/a')).toBeNull();
  });

  test('gcs put 은 gcsAccessTokenFile 을 --access-token-file 로 싣는다(JUD hold 14:57 ⑦차 ① — 자격 결속)', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run: RunFn = (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
    const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: 'pub', prefix: 'monad' };
    const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
    // 결속 있으면: gcloud storage cp 가 그 ADC 파생 토큰 파일로만 서명한다.
    store.put('pre/a', 'data', { contentType: 'text/plain', gcsAccessTokenFile: '/tmp/adcp-token' });
    expect(calls[0]!.bin).toBe('gcloud');
    expect(calls[0]!.args).toContain('--access-token-file');
    expect(calls[0]!.args).toContain('/tmp/adcp-token');
    // 결속 없으면: 어떤 --access-token-file 도 실리지 않는다(앰비언트 gcloud 자격 = 결속 없음).
    store.put('pre/b', 'data', { contentType: 'text/plain' });
    expect(calls[1]!.args).not.toContain('--access-token-file');
  });

  test('azure 는 --auth-mode login 으로 upload|download|show|list', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run: RunFn = (bin, args) => {
      calls.push({ bin, args });
      if (args[2] === 'show') return { stdout: '{"properties":{"contentLength":2}}', stderr: '' };
      if (args[2] === 'list') return { stdout: '[{"name":"k.txt"}]', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const cfg: StorageConfig = {
      provider: 'azure', localDir: '/tmp/x', bucket: 'cont', publicBucket: '', prefix: 'monad',
      azure: { account: 'acct' },
    };
    const store = createObjectStore(cfg, { run, which: () => 'az' });
    store.put('k.txt', 'ab');
    expect(calls[0]!.args).toContain('upload');
    expect(calls[0]!.args).toContain('--auth-mode');
    expect(calls[0]!.args).toContain('login');
    expect(calls[0]!.args).toContain('--account-name');
    expect(calls[0]!.args).toContain('acct');
    expect(calls[0]!.args).toContain('--container-name');
    expect(calls[0]!.args).toContain('cont');
    store.get('k.txt', '/tmp/az');
    expect(calls[1]!.args).toContain('download');
    expect(calls[1]!.args).toContain('login');
    expect(store.head('k.txt')).toEqual({ exists: true, bytes: 2 });
    expect(store.list('k')).toEqual(['k.txt']);
  });

  test('azure list rejects malformed provider output instead of reporting an empty bucket', () => {
    const cfg: StorageConfig = { provider: 'azure', localDir: '/tmp/x', bucket: 'cont', publicBucket: '', prefix: 'apps', azure: { account: 'acct' } };
    const store = createObjectStore(cfg, { run: () => ({ stdout: 'not-json', stderr: '' }), which: () => 'az' });
    expect(() => store.list('apps/notes/')).toThrow('azure storage blob list returned invalid JSON');
  });

  test('which 를 안 주면 resolveCliBin 경로를 쓰고, 없으면 이름 그대로', () => {
    const fake = '/tmp/elanous-fake-gcloud';
    const { run, calls } = callsOf();
    const cfg: StorageConfig = {
      provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad',
    };
    const store = createObjectStore(cfg, {
      run,
      cliBin: { candidates: (name) => (name === 'gcloud' ? [fake] : []), exists: (path) => path === fake },
    });
    store.put('k.txt', 'hi');
    expect(calls[0]!.bin).toBe(fake);
    const missing = callsOf();
    const bare = createObjectStore(cfg, {
      run: missing.run,
      cliBin: { candidates: () => [], exists: () => false },
    });
    bare.put('k.txt', 'hi');
    expect(missing.calls[0]!.bin).toBe('gcloud');
  });
  test("delete removes a local object", () => {
    const dir = mkdtempSync(join(tmpdir(), "objstore-delete-"));
    const cfg: StorageConfig = { provider: "local", localDir: dir, bucket: "", publicBucket: "", prefix: "monad" };
    const store = createObjectStore(cfg);
    store.put("notes/a.txt", "hello");
    expect(store.head("notes/a.txt").exists).toBe(true);
    store.delete("notes/a.txt");
    expect(store.head("notes/a.txt").exists).toBe(false);
  });

  test("delete invokes each remote provider command with the object key", () => {
    const s3 = callsOf();
    createObjectStore({ provider: "s3", localDir: "/tmp/x", bucket: "priv", publicBucket: "", prefix: "monad" }, { run: s3.run, which: name => name }).delete("apps/a/db-backups/old.json");
    expect(s3.calls[0]!.args.slice(0, 3)).toEqual(["s3", "rm", "s3://priv/apps/a/db-backups/old.json"]);

    const gcs = callsOf();
    createObjectStore({ provider: "gcs", localDir: "/tmp/x", bucket: "bucket", publicBucket: "", prefix: "monad" }, { run: gcs.run, which: name => name }).delete("apps/a/db-backups/old.json");
    expect(gcs.calls[0]!.args).toEqual(["storage", "rm", "gs://bucket/apps/a/db-backups/old.json"]);

    const azure = callsOf();
    createObjectStore({ provider: "azure", localDir: "/tmp/x", bucket: "container", publicBucket: "", prefix: "monad", azure: { account: "acct" } }, { run: azure.run, which: name => name }).delete("apps/a/db-backups/old.json");
    expect(azure.calls[0]!.args).toEqual(["storage", "blob", "delete", "--account-name", "acct", "--container-name", "container", "--name", "apps/a/db-backups/old.json", "--auth-mode", "login"]);
  });

  // WIRE ①(OBJECTHEAD-GENERATION · OP #128878/#128835) — head 가 불변 객체 버전(generation)을 반환한다.
  // 계약: local = `${dev}:${ino}:${mtimeNs}` (put 교체 시마다 값이 바뀐다 — 같은 경로 재업로드로 옛 링크가
  // 새 바이트를 가리키지 않게 하는 결속 원料) · gcs = objects describe generation · s3/r2 = VersionId
  // (버전 미활성 버킷은 미포함 — 세대가 없으면 generation 을 못 믿는다) · azure = 미제공(정책 계약 밖).
  describe('head generation (WIRE ① OBJECTHEAD-GENERATION)', () => {
    test('local: put 교체 시 generation 이 바뀐다 (mtimeNs·inode·dev 결속)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'objstore-gen-'));
      const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg);
      store.put('members/alice/private/a.txt', 'v1');
      const g1 = store.head('members/alice/private/a.txt').generation;
      expect(typeof g1).toBe('string');
      expect(g1!.length).toBeGreaterThan(0); // 출처: #39564 ObjectHead.generation 계약 — 빈 세대 문자열이면 소비층이 교체 감지 없이 결속·발급하므로 0 초과를 계약 하한으로 검증
      store.put('members/alice/private/a.txt', 'v2-longer');
      const g2 = store.head('members/alice/private/a.txt').generation;
      expect(g2).not.toBe(g1);
      expect(store.head('members/alice/private/a.txt').bytes).toBe(Buffer.byteLength('v2-longer'));
    });

    test('local: 같은 바이트 재쓰기(mtime 변화 없음)에도 inode 로 세대가 갈린다', () => {
      const dir = mkdtempSync(join(tmpdir(), 'objstore-gen-'));
      const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg);
      store.put('members/alice/private/b.txt', 'same');
      const g1 = store.head('members/alice/private/b.txt').generation;
      store.put('members/alice/private/b.txt', 'same');
      const g2 = store.head('members/alice/private/b.txt').generation;
      expect(g2).not.toBe(g1);
    });

    test('gcs: objects describe 의 generation 을 반환한다', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 'storage' && args[1] === 'objects') return { stdout: '{"size":"4","generation":"1732270000000000"}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      const h = store.head('members/alice/private/a.txt');
      expect(h.exists).toBe(true);
      expect(h.generation).toBe('1732270000000000');
    });

    test('s3: VersionId 가 있으면 generation 으로, 없으면 미포함', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 's3api') return { stdout: '{"ContentLength":3,"VersionId":"v-abc123"}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: name => name });
      const h = store.head('k.txt');
      expect(h.exists).toBe(true);
      expect(h.generation).toBe('v-abc123');
      const noVer: RunFn = (_bin, args) => {
        if (args[0] === 's3api') return { stdout: '{"ContentLength":3}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const store2 = createObjectStore(cfg, { run: noVer, which: name => name });
      expect(store2.head('k.txt').generation).toBeUndefined();
    });

    // terra mustFix ① (pr-39564-0483b3bfc959) — S3/R2 의 "null" VersionId(버저닝 중단 버킷의 널 버전)은
    // 덮어써질 수 있어 같은 세대가 서로 다른 바이트를 가리킨다. 결속 불가로 생략해야 한다.
    test('s3: VersionId "null"(중단 버킷 널 버전)은 generation 미포함 — 결속 불가 (terra mustFix ①)', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 's3api') return { stdout: '{"ContentLength":3,"VersionId":"null"}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: name => name });
      expect(store.head('k.txt')).toEqual({ exists: true, bytes: 3 }); // generation 없음
    });

    test('s3: 널 버전 덮어쓰기 시나리오 — 두 시점이 같은 "null"이라 세대 결속을 거부한다 (terra mustFix ①)', () => {
      let len = 3;
      const run: RunFn = (_bin, args) => {
        if (args[0] === 's3api') return { stdout: `{"ContentLength":${len},"VersionId":"null"}`, stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: name => name });
      expect(store.head('k.txt').generation).toBeUndefined();
      len = 5; // 같은 널 버전을 다른 바이트로 덮어쓴다 — "null"에 결속하면 v1 링크가 v2 바이트를 가리킨다
      expect(store.head('k.txt').bytes).toBe(5);
      expect(store.head('k.txt').generation).toBeUndefined();
    });

    // terra mustFix ② — GCS generation 은 안전 정수(2^53≈9.0e15)를 넘는 64비트 값이다. JSON.parse 후
    // 문자열화하면 반올림되어 서로 다른 세대가 같은 문자열로 합쳐진다. CLI JSON 원문의 숫자 원문을 보존한다.
    test('gcs: 안전 정수를 넘는 generation 은 생략한다 — 반올림 결속 방지 (terra mustFix ② r2)', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 'storage' && args[1] === 'objects') return { stdout: '{"size":"4","generation":1732270000000000123}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      const h = store.head('members/alice/private/a.txt');
      expect(h.exists).toBe(true);
      expect(h.generation).toBeUndefined(); // 1.7322700000000001e+18 반올림 원문은 버린다 — 결속 불가
    });

    test('gcs: 안전 정수 범위 number 는 문자열화한다 — ±1 세대가 구분된다 (terra mustFix ② r2)', () => {
      let gen = '9007199254740991'; // 2^53-1 = MAX_SAFE_INTEGER — 안전 경계
      const run: RunFn = (_bin, args) => {
        if (args[0] === 'storage' && args[1] === 'objects') return { stdout: `{"size":"4","generation":${gen}}`, stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      expect(store.head('k.txt').generation).toBe('9007199254740991');
      gen = '9007199254740992'; // 2^53 — 안전 정수 밖, double 로는 인접값들과 합쳐진다
      expect(store.head('k.txt').generation).toBeUndefined(); // 생략: 반올림으로 합쳐질 세대는 결속하지 않는다
    });

    test('gcs: 중첩 metadata.generation 을 최상위 generation 으로 오독하지 않는다 (terra r2 mustFix 신설)', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 'storage' && args[1] === 'objects') return { stdout: '{"metadata":{"generation":"42"},"generation":"123"}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      expect(store.head('k.txt').generation).toBe('123'); // 최상위만 — 중첩 42 아님
    });

    test('gcs: 지수 표기 generation(1e18) 은 안전 정수 검사로 생략된다 (terra r2 mustFix 신설)', () => {
      const run: RunFn = (_bin, args) => {
        if (args[0] === 'storage' && args[1] === 'objects') return { stdout: '{"size":"4","generation":1e18}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      const g = store.head('k.txt').generation;
      expect(g === undefined || (Number.isSafeInteger(Number(g)) && g === '1000000000000000000')).toBe(true); // 1 로 잘린 값은 절대 아님
      expect(g).not.toBe('1');
    });

    // terra shouldFix ① — 남은 경계: gcs 파싱 실패 · r2 head 실패(객체 소실)
    test('gcs: describe 출력이 JSON 이 아니면 bytes·generation 없이 존재만 반환한다 (terraform shouldFix)', () => {
      const run: RunFn = () => ({ stdout: 'not-json', stderr: '' });
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      expect(store.head('k.txt')).toEqual({ exists: true });
    });

    test('r2: head-object 실패(객체 소실)는 exists:false 로 내려온다 (terraform shouldFix)', () => {
      const run: RunFn = () => { throw new Error('404'); };
      const cfg: StorageConfig = { provider: 'r2', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad', r2: { accountId: 'a', profile: 'p' } };
      const store = createObjectStore(cfg, { run, which: name => name });
      expect(store.head('missing.txt')).toEqual({ exists: false });
    });

    test('azure: generation 미제공 — 존재·크기만 반환 (세대 계약 밖)', () => {
      const run: RunFn = (_bin, args) => {
        if (args[2] === 'show') return { stdout: '{"properties":{"contentLength":2}}', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const cfg: StorageConfig = { provider: 'azure', localDir: '/tmp/x', bucket: 'cont', publicBucket: '', prefix: 'monad', azure: { account: 'acct' } };
      const store = createObjectStore(cfg, { run, which: () => 'az' });
      const h = store.head('k.txt');
      expect(h.exists).toBe(true);
      expect(h.generation).toBeUndefined();
    });
  });

  // jud-39564-e5edf3206d3b(보안 HOLD 수리) — head.generation 은 메타데이터로 끝나지 않는다: 공유 링크 읽기는
  // 발급 때 세대에 «결속»된다. 교체·이동·소실이면 최신 객체를 내주지 않는 경로+시험이 이 회차의 수리다.
  // 실패 먼저: 수리 전 get(key, localPath) 에는 세대 인자가 없어 이 단언들 자체가 성립하지 않는다
  // (교체 세대 요청이 최신 바이트를 내준다 = jud HOLD 의 정적 결함 그대로).
  describe('get generation 결속 (jud-39564 — 버전 고정 읽기)', () => {
    test('local: 발급 세대 읽기는 원본 바이트 — 교체 뒤 같은 세대 요청은 최신 반환 없이 거부한다', () => {
      const dir = mkdtempSync(join(tmpdir(), 'objstore-bind-'));
      const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg);
      store.put('members/alice/private/r.pdf', 'v1-original');
      const g1 = store.head('members/alice/private/r.pdf').generation!;
      const out1 = join(dir, 'out1.bin');
      store.get('members/alice/private/r.pdf', out1, { generation: g1 });
      expect(readFileSync(out1, 'utf8')).toBe('v1-original'); // 발급 때 바이트
      store.put('members/alice/private/r.pdf', 'v2-replaced'); // head 확인 직후 같은 경로 교체
      const out2 = join(dir, 'out2.bin');
      expect(() => store.get('members/alice/private/r.pdf', out2, { generation: g1 })).toThrow(/mismatch|교체|generation/i);
      expect(existsSync(out2)).toBe(false); // 교체본(최신)을 내주지 않는다 — 옛 링크가 새 바이트를 가리키지 않는다
      const g2 = store.head('members/alice/private/r.pdf').generation!;
      const out3 = join(dir, 'out3.bin');
      store.get('members/alice/private/r.pdf', out3, { generation: g2 }); // 재발급(발급 계층 계약) 뒤 새 세대는 읽힌다
      expect(readFileSync(out3, 'utf8')).toBe('v2-replaced');
    });

    test('local: 세대 없는 get 은 기존 최신 읽기 그대로 — 결합 없는 소비자 회귀 0', () => {
      const dir = mkdtempSync(join(tmpdir(), 'objstore-bind-'));
      const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg);
      store.put('members/alice/private/n.txt', 'now');
      const out = join(dir, 'latest.bin');
      store.get('members/alice/private/n.txt', out);
      expect(readFileSync(out, 'utf8')).toBe('now');
    });

    test('s3: 고정 읽기는 s3api get-object --version-id 로 그 세대를 지목한다 — 세대 없음은 s3 cp 최신 그대로', () => {
      const calls: Array<{ bin: string; args: string[] }> = [];
      const run: RunFn = (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
      const cfg: StorageConfig = { provider: 's3', localDir: '/tmp/x', bucket: 'priv', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: (name) => name });
      store.get('members/alice/private/k.bin', '/tmp/pinned', { generation: 'v-abc123' });
      expect(calls[0]!.args.slice(0, 8)).toEqual(['s3api', 'get-object', '--bucket', 'priv', '--key', 'members/alice/private/k.bin', '--version-id', 'v-abc123']);
      expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe('/tmp/pinned');
      store.get('members/alice/private/k.bin', '/tmp/latest');
      expect(calls[1]!.args.slice(0, 3)).toEqual(['s3', 'cp', 's3://priv/members/alice/private/k.bin']);
    });

    test('gcs: 고정 읽기는 gs://bucket/key#generation 세대 지목 — 세대 없음은 접미 없는 최신 그대로', () => {
      const calls: Array<{ bin: string; args: string[] }> = [];
      const run: RunFn = (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
      const cfg: StorageConfig = { provider: 'gcs', localDir: '/tmp/x', bucket: 'b', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg, { run, which: () => 'gcloud' });
      store.get('k.txt', '/tmp/gp', { generation: '1732270000000000' });
      expect(calls[0]!.args).toContain('gs://b/k.txt#1732270000000000');
      store.get('k.txt', '/tmp/gl');
      expect(calls[1]!.args).toContain('gs://b/k.txt');
      expect(calls[1]!.args.join(' ')).not.toContain('#');
    });

    test('azure: 세대 결속 요청은 CLI 호출 없이 거부한다 — head 가 generation 을 못 믿는 공급자 (fail-closed)', () => {
      const calls: Array<{ bin: string; args: string[] }> = [];
      const run: RunFn = (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
      const cfg: StorageConfig = { provider: 'azure', localDir: '/tmp/x', bucket: 'cont', publicBucket: '', prefix: 'monad', azure: { account: 'acct' } };
      const store = createObjectStore(cfg, { run, which: () => 'az' });
      expect(() => store.get('k.txt', '/tmp/azp', { generation: 'g1' })).toThrow(/azure|세대|고정|generation/i);
      expect(calls).toHaveLength(0);
      store.get('k.txt', '/tmp/azl'); // 세대 없음 — 기존 최신 다운로드 회귀 0
      expect(calls).toHaveLength(1);
    });

    test('빈 문자열 세대는 거부한다 — 결속 불능 발급은 애초에 못 넘긴다 (fail-closed)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'objstore-bind-'));
      const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
      const store = createObjectStore(cfg);
      store.put('k.txt', 'x');
      expect(() => store.get('k.txt', join(dir, 'e.bin'), { generation: '' })).toThrow(/빈|empty|generation/i);
    });
  });

});
