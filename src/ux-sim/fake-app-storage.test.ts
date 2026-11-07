import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectStore, type RunFn } from '../storage/object-store.js';
import { createAppUpload } from '../nexus/apps/app-upload.js';
import {
  APP_STORAGE_CONTRACT_CASES,
  createFakeAppStorage,
  runAppStorageContractCase,
  runAppStorageContractMatrix,
  type AppStorageContractPortFactory,
} from './fake-app-storage.js';

function fakeS3(status: 403 | 503): RunFn {
  return (bin, args) => {
    if (bin !== 'aws') throw new Error(`unexpected fake command: ${bin} ${args.join(' ')}`);
    if (args[0] === 's3' && args[1] === 'ls') return { stdout: '', stderr: '' };
    if (args[0] === 's3api' && args[1] === 'head-object') throw new Error('404 Not Found');
    if (args[0] === 's3' && args[1] === 'cp') throw new Error(`${status} ${status === 403 ? 'Forbidden' : 'Service Unavailable'}`);
    throw new Error(`unexpected fake S3 command: ${bin} ${args.join(' ')}`);
  };
}

const factory: AppStorageContractPortFactory = {
  create(options) {
    return createFakeAppStorage({
      ...options,
      signingKey: 'test-only-app-storage-signing-key',
      now: () => 1_700_000_000_000,
      ...(options.provider === 's3' ? { run: options.run ?? fakeS3(options.providerFailureStatus ?? 503) } : {}),
    });
  },
};

test('SIM-APPSTORAGE production app upload enforces scope, type, and per-file size', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-production-app-upload-'));
  const upload = createAppUpload({
    store: createObjectStore({ provider: 'local', localDir: root, bucket: 'private', publicBucket: '', prefix: 'apps' }),
    maxUploadBytes: 5,
  });
  try {
    expect(upload.upload({ appSlug: 'notes', key: 'audio/a.wav', body: new TextEncoder().encode('abc'), contentType: 'audio/wav' }).status).toBe(201);
    expect(upload.upload({ appSlug: 'notes', key: '../outside.wav', body: new TextEncoder().encode('x'), contentType: 'audio/wav' }).status).toBe(400);
    expect(upload.upload({ appSlug: 'notes', key: 'audio/b.wav', body: new TextEncoder().encode('123456'), contentType: 'audio/wav' }).status).toBe(413);
    expect(upload.upload({ appSlug: 'notes', key: 'audio/script.js', body: new TextEncoder().encode('x'), contentType: 'application/javascript' }).status).toBe(415);
    expect(upload.list('notes')).toEqual(['audio/a.wav']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const contract of APP_STORAGE_CONTRACT_CASES) {
  test(`SIM-APPSTORAGE ${contract.id}: ${contract.name}`, () => {
    const result = runAppStorageContractCase(contract, factory);
    expect(result.passed).toBe(true);
    expect(result.actual).toEqual(contract.expected);
  });
}

test('SIM-APPSTORAGE exported contract matrix runs through the object-store reference adapter', () => {
  const results = runAppStorageContractMatrix(factory);
  expect(results.map(({ id, passed }) => ({ id, passed }))).toEqual(APP_STORAGE_CONTRACT_CASES.map(({ id }) => ({ id, passed: true })));
});

test('SIM-APPSTORAGE injected provider runner receives the stable command name', () => {
  const commands: string[] = [];
  const port = createFakeAppStorage({
    provider: 's3',
    run: (bin, args) => {
      commands.push(bin);
      if (args[0] === 's3' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 's3api' && args[1] === 'head-object') throw new Error('404 Not Found');
      if (args[0] === 's3' && args[1] === 'cp') throw new Error('503 Service Unavailable');
      throw new Error(`unexpected fake S3 command: ${bin} ${args.join(' ')}`);
    },
  });
  try {
    const response = port.upload({ appSlug: 'notes', key: 'result.json', body: new TextEncoder().encode('{}'), contentType: 'application/json' });
    expect(response).toMatchObject({ status: 503, retryable: true });
    expect(commands).toEqual(['aws', 'aws', 'aws']);
  } finally { port.close(); }
});

test('SIM-APPSTORAGE shared path contract detects writes outside its storage root', () => {
  const badFactory: AppStorageContractPortFactory = {
    create(options) {
      const port = createFakeAppStorage(options);
      return {
        ...port,
        upload(input) {
          const response = port.upload(input);
          if (input.key === '../outside.wav') writeFileSync(join(options.rootDir, '..', 'outside.wav'), 'escaped');
          return response;
        },
      };
    },
  };
  const contract = APP_STORAGE_CONTRACT_CASES.find(({ id }) => id === 'path-escape')!;
  const result = runAppStorageContractCase(contract, badFactory);
  expect(result.passed).toBe(false);
  expect(result.actual.physicalFiles).toEqual(['outside.wav']);
});

test('SIM-APPSTORAGE contract runner cleans its fixture when adapter creation fails', () => {
  let rootDir = '';
  const failingFactory: AppStorageContractPortFactory = {
    create(options) { rootDir = options.rootDir; throw new Error('adapter setup failed'); },
  };
  const contract = APP_STORAGE_CONTRACT_CASES.find(({ id }) => id === 'path-escape')!;
  expect(() => runAppStorageContractCase(contract, failingFactory)).toThrow('adapter setup failed');
  expect(existsSync(join(rootDir, '..'))).toBe(false);
});

test('SIM-APPSTORAGE observation ledger records byte counts and status without request bodies', () => {
  const port = createFakeAppStorage({ signingKey: 'test-only-app-storage-signing-key', now: () => 1_700_000_000_000 });
  try {
    const response = port.upload({ appSlug: 'notes', key: 'audio/clip.wav', body: new TextEncoder().encode('private recording'), contentType: 'audio/wav' });
    expect(response.status).toBe(201);
    expect(port.ledger()).toEqual([{ appSlug: 'notes', bytes: 17, status: 201 }]);
    expect(JSON.stringify(port.ledger())).not.toContain('private recording');
  } finally { port.close(); }
});

test('SIM-APPSTORAGE quota and rejected paths are enforced against actual files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-app-storage-physical-'));
  const port = createFakeAppStorage({ rootDir: root, appQuotaBytes: 5 });
  try {
    expect(port.upload({ appSlug: 'notes', key: 'audio/clip.wav', body: new TextEncoder().encode('abc'), contentType: 'audio/wav' }).status).toBe(201);
    expect(port.upload({ appSlug: 'notes', key: 'audio/overflow.wav', body: new TextEncoder().encode('def'), contentType: 'audio/wav' }).status).toBe(413);
    const invalidKeys = ['../outside.wav', '/etc/passwd', 'apps/other/secret.wav', '..\\outside.wav'];
    expect(invalidKeys.map((key) => port.upload({ appSlug: 'notes', key, body: new TextEncoder().encode('escape'), contentType: 'audio/wav' }).status)).toEqual([400, 400, 400, 400]);
    expect(readFileSync(join(root, 'private', 'apps', 'notes', 'audio', 'clip.wav'), 'utf8')).toBe('abc');
    expect(existsSync(join(root, 'private', 'apps', 'notes', 'audio', 'overflow.wav'))).toBe(false);
    expect(existsSync(join(root, 'private', 'apps', 'outside.wav'))).toBe(false);
    const files: string[] = [];
    const walk = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    expect(files).toEqual(['private/apps/notes/audio/clip.wav']);
  } finally { port.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SIM-APPSTORAGE shared root persists across port recreation and non-local requires a fake', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-app-storage-reopen-'));
  try {
    const first = createFakeAppStorage({ rootDir: root });
    expect(first.upload({ appSlug: 'notes', key: 'clip.wav', body: new TextEncoder().encode('abc'), contentType: 'audio/wav' }).status).toBe(201);
    first.close();
    const second = createFakeAppStorage({ rootDir: root, appQuotaBytes: 5 });
    expect(second.read({ appSlug: 'notes', key: 'clip.wav' }).status).toBe(200);
    expect(second.list('notes')).toEqual(['clip.wav']);
    expect(second.upload({ appSlug: 'notes', key: 'clip.wav', body: new TextEncoder().encode('12345'), contentType: 'audio/wav' }).status).toBe(201);
    expect(second.read({ appSlug: 'notes', key: 'clip.wav' }).body).toEqual(new TextEncoder().encode('12345'));
    expect(second.upload({ appSlug: 'notes', key: 'clip.wav', body: new TextEncoder().encode('123456'), contentType: 'audio/wav' }).status).toBe(413);
    expect(second.read({ appSlug: 'notes', key: 'clip.wav' }).body).toEqual(new TextEncoder().encode('12345'));
    expect(second.upload({ appSlug: 'notes', key: 'overflow.wav', body: new TextEncoder().encode('a'), contentType: 'audio/wav' }).status).toBe(413);
    second.close();
    expect(() => createFakeAppStorage({ provider: 's3' })).toThrow('requires an injected fake RunFn');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SIM-APPSTORAGE anonymous rate limit counts valid attempts even when provider rejects one', () => {
  const port = createFakeAppStorage({
    provider: 's3', anonymousUploadsPerMinute: 1,
    run: () => { throw new Error('503 Service Unavailable'); },
  });
  try {
    const upload = (key: string) => port.upload({ appSlug: 'notes', key, body: new TextEncoder().encode('x'), contentType: 'audio/wav', anonymous: true });
    expect(upload('first.wav').status).toBe(503);
    expect(upload('second.wav').status).toBe(429);
    expect(port.providerCalls()).toBe(1);
  } finally { port.close(); }
});

test('SIM-APPSTORAGE preserves provider status during quota discovery and read', () => {
  const quotaFailure = (message: string) => createFakeAppStorage({ provider: 's3', run: () => { throw new Error(message); } });
  for (const [message, expected, retryable] of [['403 Forbidden', 403, false], ['503 Service Unavailable', 503, true]] as const) {
    const port = quotaFailure(message);
    try {
      const response = port.upload({ appSlug: 'notes', key: 'clip.wav', body: new TextEncoder().encode('x'), contentType: 'audio/wav' });
      expect(response.status).toBe(expected);
      expect(response.retryable === true).toBe(retryable);
    } finally { port.close(); }
  }
  const missing = createFakeAppStorage({ provider: 's3', run: () => { throw new Error('404 NoSuchKey'); } });
  try { expect(missing.read({ appSlug: 'notes', key: 'missing.wav' }).status).toBe(404); }
  finally { missing.close(); }
});
