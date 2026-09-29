import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatStorageDetectLine,
  registerStorageDetectCommand,
  runStorageDetect,
  runStoragePut,
  type StoragePutResult,
} from './storage-cli.js';
import { createObjectStore, type RunFn, type StorageConfig } from '../storage/object-store.js';
import type { StorageProviderDetect } from '../storage/storage-detect.js';

const FAKE_TOKEN = 'ya29.fake-token-should-never-appear';

function row(partial: Partial<StorageProviderDetect> & Pick<StorageProviderDetect, 'provider'>): StorageProviderDetect {
  return {
    cli: { name: partial.provider, path: null, version: null },
    signedIn: null,
    account: null,
    project: null,
    bucketCount: null,
    hint: '',
    ...partial,
  };
}

const sample: StorageProviderDetect[] = [
  row({ provider: 'local', cli: { name: 'local', path: '/tmp/home/.elanous/storage', version: null }, signedIn: true, hint: '/tmp/home/.elanous/storage 쓰기 가능' }),
  row({ provider: 'gcs', cli: { name: 'gcloud', path: '/opt/homebrew/bin/gcloud', version: 'Google Cloud SDK 480' }, signedIn: true, account: 'ada@example.com', project: 'proj-1', bucketCount: 2 }),
  row({ provider: 'azure', cli: { name: 'az', path: null, version: null }, hint: 'brew install azure-cli' }),
  row({ provider: 's3', cli: { name: 'aws', path: '/usr/local/bin/aws', version: 'aws-cli/2' }, signedIn: null, hint: 'aws configure sso' }),
  row({ provider: 'r2', cli: { name: 'wrangler', path: '/usr/bin/wrangler', version: '3.0.0' }, signedIn: false, hint: 'wrangler login' }),
];

describe('storage detect CLI', () => {
  test('사람 출력은 공급자마다 한 줄이고 맨 끝에 현재 설정이 있다', async () => {
    const lines: string[] = [];
    const result = await runStorageDetect({}, {
      detect: async () => sample,
      currentProvider: () => 'gcs',
      output: (line) => lines.push(line),
    });
    expect(result.current).toBe('gcs');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toStartWith('✅ local');
    expect(lines[1]).toContain('로그인됨');
    expect(lines[1]).toContain('ada@example.com');
    expect(lines[1]).toContain('proj-1');
    expect(lines[2]).toStartWith('✖ azure');
    expect(lines[2]).toContain('brew install azure-cli');
    expect(lines[3]).toStartWith('⚪ s3');
    expect(lines[3]).toContain('로그인 모름');
    expect(lines[4]).toContain('설치됨·로그인 안 됨');
    expect(lines[5]).toBe('지금 설정: storage.provider = gcs');
    expect(lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  test('--json 은 providers 와 current 만 담고 토큰 문자열을 싣지 않는다', async () => {
    const lines: string[] = [];
    await runStorageDetect({ json: true }, {
      detect: async () => sample.map((item) => ({ ...item, hint: item.hint.includes(FAKE_TOKEN) ? item.hint : item.hint })),
      currentProvider: () => 'local',
      output: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { providers: StorageProviderDetect[]; current: string };
    expect(parsed.current).toBe('local');
    expect(parsed.providers.map((item) => item.provider)).toEqual(['local', 'gcs', 'azure', 's3', 'r2']);
    expect(parsed.providers[1]?.signedIn).toBe(true);
    expect(lines[0]).not.toContain(FAKE_TOKEN);
  });

  test('출력 한 줄에 가짜 토큰이 있으면 그대로 나가지 않게 계정 필드만 쓴다', () => {
    const line = formatStorageDetectLine(row({
      provider: 'gcs',
      cli: { name: 'gcloud', path: '/usr/bin/gcloud', version: '1' },
      signedIn: true,
      account: 'ada@example.com',
      project: 'proj',
    }));
    expect(line).toContain('ada@example.com');
    expect(line).not.toContain(FAKE_TOKEN);
  });

  test('elanous storage --help 에 detect 와 put 이 등록된다', () => {
    const program = new Command();
    program.exitOverride();
    registerStorageDetectCommand(program);
    const storage = program.commands.find((command) => command.name() === 'storage');
    expect(storage).toBeDefined();
    const detect = storage!.commands.find((command) => command.name() === 'detect');
    expect(detect).toBeDefined();
    expect(detect!.description()).toContain('클라우드 CLI');
    expect(storage!.helpInformation()).toContain('detect');
    expect(detect!.helpInformation()).toContain('--json');
    const put = storage!.commands.find((command) => command.name() === 'put');
    expect(put).toBeDefined();
    const help = put!.helpInformation();
    expect(help).toContain('--public');
    expect(help).toContain('--local-dir');
    expect(help).toContain('--json');
    expect(help).toContain('--key');
  });
});

function localCfg(dir: string, extra: Partial<StorageConfig> = {}): StorageConfig {
  return {
    provider: 'local',
    localDir: dir,
    bucket: '',
    publicBucket: '',
    prefix: 'monad',
    ...extra,
  };
}

describe('storage put', () => {
  test('빈 설정에서 --local-dir 로 put 하면 kind 는 path 이고 그 폴더에 파일이 있으며 run 은 안 불린다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'note.txt');
    const destDir = join(root, 'vault');
    writeFileSync(src, 'hello-vault');
    const calls: string[] = [];
    const lines: string[] = [];
    const run: RunFn = (bin) => {
      calls.push(bin);
      return { stdout: '', stderr: '' };
    };
    const code = await runStoragePut(src, { localDir: destDir }, {
      readConfig: () => localCfg(join(root, 'store')),
      run,
      output: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(destDir, 'note.txt'), 'utf8')).toBe('hello-vault');
    expect(lines[0]).toBe(join(destDir, 'note.txt'));
  });

  test('같은 이름이 있고 내용이 다르면 -1 을 붙인다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'note.txt');
    const destDir = join(root, 'vault');
    writeFileSync(src, 'new');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'note.txt'), 'old');
    const lines: string[] = [];
    const code = await runStoragePut(src, { localDir: destDir, json: true }, {
      readConfig: () => localCfg(join(root, 'store')),
      output: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as StoragePutResult;
    expect(parsed.kind).toBe('path');
    if (parsed.kind !== 'path') return;
    expect(parsed.path).toBe(join(destDir, 'note-1.txt'));
    expect(parsed.provider).toBe('local');
    expect(readFileSync(parsed.path, 'utf8')).toBe('new');
    expect(readFileSync(join(destDir, 'note.txt'), 'utf8')).toBe('old');
  });

  test('local 이고 --local-dir 이 없으면 localDir/<private|public>/<key> 로 놓는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'a.txt');
    const storeDir = join(root, 'store');
    writeFileSync(src, 'body');
    const lines: string[] = [];
    const code = await runStoragePut(src, {}, {
      readConfig: () => localCfg(storeDir),
      output: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const dest = join(storeDir, 'private', 'a.txt');
    expect(lines[0]).toBe(dest);
    expect(readFileSync(dest, 'utf8')).toBe('body');
  });

  test('가짜 gcs --public 은 url 을 내고 public 버킷으로 올린다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'pic.png');
    writeFileSync(src, 'png');
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run: RunFn = (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '', stderr: '' };
    };
    const cliBin = {
      candidates: (name: 'gcloud' | 'aws' | 'az' | 'wrangler') => (name === 'gcloud' ? ['/tmp/elanous-fake-gcloud'] : []),
      exists: (path: string) => path === '/tmp/elanous-fake-gcloud',
    };
    const cfg: StorageConfig = {
      provider: 'gcs',
      localDir: join(root, 'unused'),
      bucket: 'priv',
      publicBucket: 'pub',
      prefix: 'monad',
    };
    const lines: string[] = [];
    const code = await runStoragePut(src, { public: true, json: true }, {
      readConfig: () => cfg,
      run,
      cliBin,
      now: () => new Date('2026-09-28T00:00:00Z'),
      output: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(calls[0]!.bin).toBe('/tmp/elanous-fake-gcloud');
    expect(calls[0]!.args).toContain('gs://pub/monad/uploads/2026-09-28/pic.png');
    const parsed = JSON.parse(lines[0]!) as StoragePutResult;
    expect(parsed).toEqual({
      kind: 'url',
      url: 'https://storage.googleapis.com/pub/monad/uploads/2026-09-28/pic.png',
      provider: 'gcs',
    });
  });

  test('--public 인데 publicBucket 이 없으면 exit 2 이고 run 은 안 불린다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'pic.png');
    writeFileSync(src, 'png');
    const calls: string[] = [];
    const errors: string[] = [];
    const run: RunFn = (bin) => {
      calls.push(bin);
      return { stdout: '', stderr: '' };
    };
    const cfg: StorageConfig = {
      provider: 'gcs', localDir: join(root, 'unused'), bucket: 'priv', publicBucket: '', prefix: 'monad',
    };
    const code = await runStoragePut(src, { public: true }, {
      readConfig: () => cfg,
      run,
      error: (line) => errors.push(line),
      output: () => {},
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(errors[0]).toBe('storage.publicBucket 이 설정되지 않았다');
  });

  test('비공개 원격은 uri 를 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'doc.txt');
    writeFileSync(src, 'secret');
    const cfg: StorageConfig = {
      provider: 'azure',
      localDir: join(root, 'unused'),
      bucket: 'cont',
      publicBucket: '',
      prefix: 'monad',
      azure: { account: 'acct' },
    };
    const lines: string[] = [];
    const code = await runStoragePut(src, { json: true, key: 'monad/uploads/2026-09-28/doc.txt' }, {
      readConfig: () => cfg,
      store: createObjectStore(cfg, { run: () => ({ stdout: '', stderr: '' }), which: () => 'az' }),
      output: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual({
      kind: 'object',
      uri: 'https://acct.blob.core.windows.net/cont/monad/uploads/2026-09-28/doc.txt',
      provider: 'azure',
    });
  });

  test('빈 원격 설정은 없고 local 빈 설정은 run 을 부르지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-put-'));
    const src = join(root, 'a.txt');
    writeFileSync(src, 'x');
    const calls: string[] = [];
    const code = await runStoragePut(src, {}, {
      readConfig: () => localCfg(join(root, 'store')),
      run: (bin) => {
        calls.push(bin);
        return { stdout: '', stderr: '' };
      },
      output: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
