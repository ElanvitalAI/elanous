import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
});
