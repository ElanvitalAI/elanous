import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../../elanous-config-dir.js';
import { fileBackend, writeSecretsFileRaw } from './file-backend.js';

if (process.env.ELANOUS_SECRETS_RACE_WORKER === '1') {
  setElanousConfigDir(process.env.ELANOUS_SECRETS_RACE_DIR!);
  process.stdout.write('READY\n');
  await new Response(Bun.stdin.stream()).text();
  await fileBackend.set(process.env.ELANOUS_SECRETS_RACE_KEY!, 'value');
} else {
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secrets-file-')); setElanousConfigDir(dir); });
afterEach(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

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
  expect(readFileSync(`${path}.bak`, 'utf8')).toBe(original);
  const previous = readFileSync(path, 'utf8');
  expect(await fileBackend.delete('new')).toBe(true);
  expect(readFileSync(`${path}.bak`, 'utf8')).toBe(previous);
  expect(JSON.parse(readFileSync(path, 'utf8')).secrets).toEqual({ retained: 'old' });
  expect(readdirSync(dir).sort()).toEqual(['secrets.json', 'secrets.json.bak']);
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
}
