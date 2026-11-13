import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync, openSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../../elanous-config-dir.js';
import { fileBackend, importSecretsFileRaw, setSecretFileSyncHooksForTest, writeSecretsFileRaw } from './file-backend.js';

if (process.env.ELANOUS_SECRETS_RACE_WORKER === '1') {
  setElanousConfigDir(process.env.ELANOUS_SECRETS_RACE_DIR!);
  process.stdout.write('READY\n');
  await new Response(Bun.stdin.stream()).text();
  await fileBackend.set(process.env.ELANOUS_SECRETS_RACE_KEY!, 'value');
} else {
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secrets-file-')); setElanousConfigDir(dir); });
afterEach(() => { setSecretFileSyncHooksForTest(null); resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

test('corrupt or version-mismatched secrets never become an empty store on set or delete', async () => {
  const path = join(dir, 'secrets.json');
  for (const bytes of ['{not-json', JSON.stringify({ version: 99, secrets: { retained: 'value' } })]) {
    writeFileSync(path, bytes);
    await expect(fileBackend.set('new', 'value')).rejects.toThrow('cannot read secrets file');
    await expect(fileBackend.delete('retained')).rejects.toThrow('cannot read secrets file');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  }
});

test('explicit raw write recovers corrupted or version-mismatched files while preserving the previous bytes', async () => {
  const path = join(dir, 'secrets.json');
  for (const bytes of ['{not-json', JSON.stringify({ version: 99, secrets: { old: 'value' } })]) {
    writeFileSync(path, bytes);
    writeSecretsFileRaw({ version: 1, secrets: { restored: 'value' } });
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(bytes);
    expect(JSON.parse(readFileSync(path, 'utf8')).secrets).toEqual({ restored: 'value' });
  }
});

test('set and delete retain other keys and keep one previous-file backup', async () => {
  const path = join(dir, 'secrets.json');
  const original = JSON.stringify({ version: 1, secrets: { retained: 'old' } });
  writeFileSync(path, original);
  await fileBackend.set('new', 'value');
  expect(JSON.parse(readFileSync(path, 'utf8')).secrets).toEqual({ retained: 'old', new: 'value' });
  expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual({ version: 1, secrets: { retained: 'old' } });
  const previous = readFileSync(path, 'utf8');
  expect(await fileBackend.delete('new')).toBe(true);
  expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual(JSON.parse(previous));
  expect(JSON.parse(readFileSync(path, 'utf8')).secrets).toEqual({ retained: 'old' });
  expect(readdirSync(dir).sort()).toEqual(['secrets.json', 'secrets.json.bak']);
});

test('backups retain legacy app values while excluding lifecycle-owned app values', async () => {
  const path = join(dir, 'secrets.json');
  writeFileSync(path, JSON.stringify({ version: 1, secrets: { 'app/legacy/OLD_KEY': 'old-value', ordinary: 'kept' } }));
  await fileBackend.set('new-shared', 'new-value');
  expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).secrets).toEqual({ 'app/legacy/OLD_KEY': 'old-value', ordinary: 'kept' });
});

test('unreadable app ledger prevents making a secret-bearing backup', async () => {
  const path = join(dir, 'secrets.json');
  const original = JSON.stringify({ version: 1, secrets: { 'app/voice-note/API_KEY': 'ledger-owned-value' } });
  writeFileSync(path, original, { mode: 0o600 });
  writeFileSync(join(dir, 'app-secret-ledger.json'), '{invalid-ledger');
  await expect(fileBackend.set('shared', 'new-value')).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(existsSync(`${path}.bak`)).toBe(false);
});

test('batch import checks collisions under the file lock and pins overwrite confirmation to exact names', () => {
  writeSecretsFileRaw({ version: 1, secrets: { exa: 'fake-existing-value' } });
  expect(importSecretsFileRaw({ exa: 'fake-new-value', tavily: 'fake-tavily-value' }, false)).toEqual({
    imported: false, conflicts: ['exa'], changedSinceConfirmation: false,
  });
  expect(importSecretsFileRaw({ exa: 'fake-new-value', tavily: 'fake-tavily-value' }, true, [])).toEqual({
    imported: false, conflicts: ['exa'], changedSinceConfirmation: true,
  });
  expect(importSecretsFileRaw({ exa: 'fake-new-value', tavily: 'fake-tavily-value' }, true, ['exa'])).toEqual({
    imported: true, conflicts: ['exa'], changedSinceConfirmation: false,
  });
});

test('simultaneously released processes serialize writes to the same secrets file', async () => {
  const workers = Array.from({ length: 8 }, (_, i) => Bun.spawn(['bun', import.meta.path], {
    cwd: import.meta.dir,
    env: { ...process.env, ELANOUS_SECRETS_RACE_WORKER: '1', ELANOUS_SECRETS_RACE_DIR: dir,
      ELANOUS_SECRETS_RACE_KEY: `key${i}` },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  }));
  try {
    // All children must reach the barrier before any is allowed to write.
    const ready = await Promise.all(workers.map(async worker => {
      const reader = worker.stdout.getReader();
      const { value, done } = await reader.read();
      reader.releaseLock();
      return !done && new TextDecoder().decode(value) === 'READY\n';
    }));
    expect(ready).toEqual(workers.map(() => true));
    for (const worker of workers) worker.stdin.end();
    const exits = await Promise.all(workers.map(worker => worker.exited));
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()));
    expect(exits).toEqual(workers.map(() => 0));
    expect(errors).toEqual(workers.map(() => ''));
    const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')).secrets;
    expect(secrets).toEqual(Object.fromEntries(workers.map((_, i) => [`key${i}`, 'value'])));
  } finally {
    for (const worker of workers) worker.kill();
  }
}, 30_000);
test('Windows EPERM model uses writable descriptors through actual backend write and backup', async () => {
  const opened = new Map<number, string>();
  const synced: string[] = [];
  setSecretFileSyncHooksForTest({
    platform: 'win32',
    openFile: (path, flags) => { const fd = openSync(path, flags); opened.set(fd, flags); return fd; },
    sync: (fd) => {
      const flags = opened.get(fd);
      if (flags === 'r') throw Object.assign(new Error('Windows read-only fsync'), { code: 'EPERM' });
      synced.push(flags ?? 'directory');
      fsyncSync(fd);
    },
  });
  await fileBackend.set('first', 'one');
  await fileBackend.set('second', 'two');
  expect(synced).toEqual(['r+', 'r+', 'r+']);
  expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')).secrets).toEqual({ first: 'one', second: 'two' });
  expect(JSON.parse(readFileSync(join(dir, 'secrets.json.bak'), 'utf8')).secrets).toEqual({ first: 'one' });
  expect(readdirSync(dir).sort()).toEqual(['secrets.json', 'secrets.json.bak']);
});

test('backend fsync error leaves the previous secret and backup intact', async () => {
  await fileBackend.set('first', 'one');
  await fileBackend.set('second', 'two');
  const path = join(dir, 'secrets.json');
  const before = readFileSync(path, 'utf8');
  const backup = readFileSync(`${path}.bak`, 'utf8');
  for (const code of ['EPERM', 'EACCES']) {
    setSecretFileSyncHooksForTest({ platform: 'win32', sync: () => { throw Object.assign(new Error(code), { code }); } });
    await expect(fileBackend.set('third', 'three')).rejects.toThrow(code);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(backup);
    expect(readdirSync(dir).sort()).toEqual(['secrets.json', 'secrets.json.bak']);
  }
});

test('non-Windows backend still calls directory fsync', async () => {
  let calls = 0;
  setSecretFileSyncHooksForTest({ platform: 'darwin', sync: (fd) => { calls += 1; fsyncSync(fd); } });
  await fileBackend.set('first', 'one');
  expect(calls).toBe(2);
});
}
