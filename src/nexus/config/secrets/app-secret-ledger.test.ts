import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { currentBackend, getSecretAsync, importSecretBatchAsync, importSecretsFileRaw, readSecrets, setSecret, setSecretAsync, useBackend, writeSecrets, deleteSecret, deleteSecretAsync, registerBackend, resetBackendRegistry } from './index.js';
import { registerSecretCommands } from '../../../cli/secret-cli.js';
import { deleteAppSecretValue, revokeAppSecretValues, setAppSecretValue } from './file-backend.js';
import { appSecretId, beginAppSecretEvent, finishAppSecretEvent, recoverAppSecretEvents, withAppSecretLock } from './app-secret-ledger.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'app-secret-ledger-')); setElanousConfigDir(dir); });
afterEach(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

test('app secret ids validate app slugs and credential names', () => {
  expect(appSecretId('voice-note', 'ELEVENLABS_API_KEY')).toBe('app/voice-note/ELEVENLABS_API_KEY');
  for (const [app, name] of [['api', 'KEY'], ['voice--note', 'KEY'], ['voice-note', 'key'], ['../escape', 'KEY']]) {
    expect(() => appSecretId(app, name)).toThrow();
  }
});

test('issue and revoke ledger atomically stores lifecycle metadata only with private file permissions', () => {
  const issued = beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'API_KEY', backend: 'file', at: '2026-11-06T00:00:00.000Z' });
  finishAppSecretEvent(issued.id, 'committed');
  const revoked = beginAppSecretEvent({ action: 'revoked', app: 'voice-note', name: 'API_KEY', backend: 'file', at: '2026-11-06T00:01:00.000Z' });
  finishAppSecretEvent(revoked.id, 'committed');
  const path = join(dir, 'app-secret-ledger.json');
  const rows = JSON.parse(readFileSync(path, 'utf8')).events;
  expect(rows.map(({ action, app, name, backend, state }: { action: string; app: string; name: string; backend: string; state: string }) => [action, app, name, backend, state])).toEqual([
    ['issued', 'voice-note', 'API_KEY', 'file', 'committed'], ['revoked', 'voice-note', 'API_KEY', 'file', 'committed'],
  ]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(rows)).not.toContain('secret-value');
});

test('SQLite app lock remains held across async backend work and releases afterward', async () => {
  let finishFirst!: () => void;
  let firstEntered!: () => void;
  let secondEntered = false;
  const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
  const first = withAppSecretLock('voice-note', async (assertHeld) => {
    assertHeld();
    firstEntered();
    await firstGate;
    assertHeld();
  });
  await firstStarted;
  expect(statSync(join(dir, 'app-secret-voice-note.lock.sqlite')).mode & 0o777).toBe(0o600);
  const second = withAppSecretLock('voice-note', async (assertHeld) => {
    secondEntered = true;
    assertHeld();
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(secondEntered).toBe(false);
  finishFirst();
  await Promise.all([first, second]);
  expect(secondEntered).toBe(true);
});

test('production CLI issues and revokes through the real file backend and durable ledger', async () => {
  useBackend('file');
  const output: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, {
    isInteractive: () => true,
    promptSecret: async () => 'actual-cli-secret-value',
    initializeBackend: () => useBackend('file'),
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: () => {},
  });

  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'set', 'voice-note', 'API_KEY']);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBe('actual-cli-secret-value');
  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'revoke', 'voice-note', 'API_KEY']);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBeUndefined();

  const ledger = readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8');
  expect(JSON.parse(ledger).events.map(({ action, backend, state }: { action: string; backend: string; state: string }) => [action, backend, state]))
    .toEqual([['issued', 'file', 'committed'], ['revoked', 'file', 'committed']]);
  expect(ledger).not.toContain('actual-cli-secret-value');
  expect(output.join('\n')).not.toContain('actual-cli-secret-value');
  expect(errors).toEqual([]);
});

test('CLI retry recovers a deletion whose journal completion failed after the durable file mutation', async () => {
  useBackend('file');
  await setAppSecretValue('app/voice-note/API_KEY', 'secret');
  let failFinish = true;
  const errors: string[] = [];
  const output: string[] = [];
  const exitCodes: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, {
    isInteractive: () => true,
    initializeBackend: () => useBackend('file'),
    storageBackend: () => 'file',
    revokeAppSecrets: (app, name) => revokeAppSecretValues(app, name, {
      beforeLedgerDirectorySync: () => { if (failFinish) { failFinish = false; throw new Error('injected journal directory sync failure'); } },
      beforeLedgerRollback: () => { throw new Error('injected rollback failure'); },
    }),
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
  });
  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'revoke', 'voice-note', 'API_KEY']);
  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'revoke', 'voice-note', 'API_KEY']);
  expect(errors).toEqual(['app secret could not be revoked']);
  expect(output).toEqual(['already absent voice-note/API_KEY']);
  expect(exitCodes).toEqual([1, 0]);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBeUndefined();
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ action: string; state: string }>;
  expect(rows.map(({ action, state }) => [action, state])).toEqual([['issued', 'committed'], ['revoked', 'committed']]);
});

test('directory-sync failure leaves issue pending until durable recovery verifies the file', async () => {
  useBackend('file');
  let failSync = true;
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, {
    isInteractive: () => true,
    promptSecret: async () => 'value',
    initializeBackend: () => useBackend('file'),
    storageBackend: () => 'file',
    saveAppSecret: (id, value) => setAppSecretValue(id, value, {
      beforeSecretsDirectorySync: () => { if (failSync) { failSync = false; throw new Error('injected directory fsync failure'); } },
    }),
    output: { log: () => {}, error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
  });
  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'set', 'voice-note', 'API_KEY']);
  const pendingRows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ state: string }>;
  expect(pendingRows.map(({ state }) => state)).toEqual(['pending']);
  await program.parseAsync(['node', 'elanous', 'secret', 'app', 'set', 'voice-note', 'API_KEY']);
  expect(errors).toEqual(['app secret could not be issued', 'app secret could not be issued']);
  expect(exitCodes).toEqual([1, 1]);
  const recoveredRows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ state: string }>;
  expect(recoveredRows.map(({ state }) => state)).toEqual(['committed']);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBe('value');
});

test('different app locks retain both file-backend values and bulk import cannot bypass the app ledger', async () => {
  useBackend('file');
  await Promise.all(['voice-note', 'translator'].map((app) => setAppSecretValue(appSecretId(app, 'API_KEY'), `value-${app}`)));
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBe('value-voice-note');
  expect(await getSecretAsync('app/translator/API_KEY')).toBe('value-translator');
  await expect(importSecretBatchAsync({ 'app/voice-note/API_KEY': 'overwritten' }, true))
    .rejects.toThrow('ELANOUS_APP_SECRET_IMPORT_UNSUPPORTED');
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBe('value-voice-note');
  const events = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ state: string }>;
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.state === 'committed')).toBe(true);
});

test('direct app mutation helpers create durable journal events and serialize same-app writes', async () => {
  await expect(setAppSecretValue('app/voice-note/API_KEY/extra', 'bad')).rejects.toThrow('ELANOUS_APP_SECRET_ID_REQUIRED');
  await Promise.all([
    setAppSecretValue('app/voice-note/API_KEY', 'first'),
    setAppSecretValue('app/voice-note/OTHER_KEY', 'second'),
  ]);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBe('first');
  expect(await getSecretAsync('app/voice-note/OTHER_KEY')).toBe('second');
  await expect(deleteSecretAsync('app/voice-note/API_KEY')).rejects.toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(await deleteAppSecretValue('app/voice-note/API_KEY')).toBe(true);
  const events = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ action: string; state: string }>;
  expect(events.map(({ action, state }) => [action, state])).toEqual([
    ['issued', 'committed'], ['issued', 'committed'], ['revoked', 'committed'],
  ]);
  const backup = JSON.parse(readFileSync(join(dir, 'secrets.json.bak'), 'utf8')).secrets as Record<string, string>;
  expect(Object.keys(backup).some((id) => id.startsWith('app/'))).toBe(false);
});

test('legacy reserved app slug secrets remain revocable while new issuance stays blocked', async () => {
  expect(() => appSecretId('api', 'KEY')).toThrow('invalid app slug');
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { 'app/api/KEY': 'legacy-value' } }), { mode: 0o600 });
  expect(await deleteAppSecretValue('app/api/KEY')).toBe(true);
  expect(await getSecretAsync('app/api/KEY')).toBeUndefined();
  const events = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ app: string; name: string; action: string; state: string }>;
  expect(events).toEqual([expect.objectContaining({ app: 'api', name: 'KEY', action: 'revoked', state: 'committed' })]);
});

test('legacy malformed app IDs remain deletable and recover through exact stored IDs', async () => {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: {
    'app/Bad/KEY': 'legacy-upper-slug',
    'app/foo': 'legacy-no-name',
    'app/foo/key': 'legacy-lower-name',
  } }), { mode: 0o600 });
  expect(deleteSecret('app/Bad/KEY')).toBe(true);
  expect(await deleteSecretAsync('app/foo')).toBe(true);
  let failSync = true;
  await expect(revokeAppSecretValues('foo', undefined, {
    beforeLedgerDirectorySync: () => { if (failSync) { failSync = false; throw new Error('ledger sync failed'); } },
  })).rejects.toThrow('ledger sync failed');
  expect(await revokeAppSecretValues('foo')).toMatchObject({ revoked: 1, alreadyAbsent: false });
  expect(await getSecretAsync('app/foo/key')).toBeUndefined();
  const events = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ secretId?: string; state: string }>;
  expect(events.find((event) => event.secretId === 'app/foo/key')?.state).toBe('committed');
});

test('issue recovery checks the exact stored ID from a legacy revoke intent', async () => {
  const legacyId = 'app/foo/key';
  const hashedName = `LEGACY_${createHash('sha256').update(legacyId).digest('hex').slice(0, 32).toUpperCase()}`;
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { [legacyId]: 'legacy-value' } }), { mode: 0o600 });
  await expect(deleteAppSecretValue(legacyId, { afterRevokeIntent: () => { throw new Error('simulated interruption'); } }))
    .rejects.toThrow('simulated interruption');
  const pending = (JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; action: string; state: string }>)[0]!;
  expect(pending).toMatchObject({ action: 'revoked', state: 'pending' });
  await setAppSecretValue(`app/foo/${hashedName}`, 'new-value');
  expect(await getSecretAsync(legacyId)).toBe('legacy-value');
  expect(await getSecretAsync(`app/foo/${hashedName}`)).toBe('new-value');
  const events = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; action: string; state: string }>;
  expect(events.find((event) => event.id === pending.id)?.state).toBe('aborted');
  expect(events.at(-1)).toMatchObject({ action: 'issued', state: 'committed' });
});

test('legacy app IDs on a remote backend remain deletable when no app ledger owns them', async () => {
  const removed: string[] = [];
  registerBackend({
    id: 'gcp',
    async get() { return undefined; },
    async set() {},
    async delete(id) { removed.push(id); return true; },
    async list() { return []; },
    async isAvailable() { return { ok: true }; },
  });
  try {
    useBackend('gcp');
    expect(await deleteSecretAsync('app/voice-note/REMOTE_KEY')).toBe(true);
    expect(removed).toEqual(['app/voice-note/REMOTE_KEY']);
  } finally {
    resetBackendRegistry();
  }
});

test('remote legacy delete rechecks ledger ownership while holding the app lock', async () => {
  let removed = false;
  registerBackend({
    id: 'gcp', async get() { return undefined; }, async set() {},
    async delete() { removed = true; return true; }, async list() { return []; }, async isAvailable() { return { ok: true }; },
  });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    useBackend('gcp');
    const holder = withAppSecretLock('voice-note', async (assertHeld) => {
      entered();
      await gate;
      beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'REMOTE_KEY', backend: 'file', at: new Date().toISOString() });
      assertHeld();
    });
    await ready;
    const deletion = deleteSecretAsync('app/voice-note/REMOTE_KEY');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(removed).toBe(false);
    release();
    await holder;
    await expect(deletion).rejects.toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
    expect(removed).toBe(false);
  } finally {
    resetBackendRegistry();
  }
});

test('shared async, sync, backend, import, and raw-write APIs cannot mutate app secrets outside the ledger', async () => {
  useBackend('file');
  const id = 'app/voice-note/API_KEY';
  await setAppSecretValue(id, 'ledger-owned-value');
  await expect(setSecretAsync(id, 'bypass')).rejects.toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  await expect(deleteSecretAsync(id)).rejects.toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(() => setSecret(id, 'bypass')).toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(() => deleteSecret(id)).toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(() => currentBackend().set(id, 'bypass')).toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  await expect(currentBackend().delete(id)).rejects.toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(() => importSecretsFileRaw({ [id]: 'bypass' }, true)).toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  await expect(importSecretBatchAsync({ [id]: 'bypass' }, true)).rejects.toThrow('ELANOUS_APP_SECRET_IMPORT_UNSUPPORTED');
  writeSecrets(readSecrets());
  expect(() => writeSecrets({ version: 1, secrets: { [id]: 'bypass' } })).toThrow('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  expect(await getSecretAsync(id)).toBe('ledger-owned-value');
});

test('pending issue and revoke events recover from the backend state', async () => {
  const pendingIssue = beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'NEW_KEY', backend: 'file', at: '2026-11-06T00:02:00.000Z' });
  const pendingRevoke = beginAppSecretEvent({ action: 'revoked', app: 'voice-note', name: 'OLD_KEY', backend: 'file', at: '2026-11-06T00:03:00.000Z' });
  const values = new Set(['NEW_KEY']);
  await recoverAppSecretEvents('voice-note', async (name) => values.has(name));
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; name: string; state: string }>;
  expect(rows.find((row) => row.id === pendingIssue.id)?.state).toBe('committed');
  expect(rows.find((row) => row.id === pendingRevoke.id)?.state).toBe('committed');
});

test('pending recovery fails closed for remote backend even when the current value matches', async () => {
  const pending = beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'REMOTE_KEY', backend: 'gcp', at: '2026-11-06T00:03:30.000Z' });
  const checked: string[] = [];
  await expect(recoverAppSecretEvents('voice-note', async (_name, backend) => {
    checked.push(backend);
    return true;
  })).rejects.toThrow('indeterminate for backend gcp');
  expect(checked).toEqual([]);
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; name: string; state: string }>;
  expect(rows.find((row) => row.id === pending.id)?.state).toBe('pending');
});

test('durable absence resolves a pending revoke and reports the recovered removal', async () => {
  const pending = beginAppSecretEvent({ action: 'revoked', app: 'voice-note', name: 'API_KEY', backend: 'file', at: '2026-11-06T00:04:00.000Z' });
  beginAppSecretEvent({ action: 'revoked', app: 'voice-note', name: 'OTHER_KEY', backend: 'file', at: '2026-11-06T00:04:30.000Z' });
  expect(await revokeAppSecretValues('voice-note', 'API_KEY')).toMatchObject({ revoked: 1, alreadyAbsent: false });
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; name: string; state: string }>;
  expect(rows.find((row) => row.id === pending.id)?.state).toBe('committed');
  expect(rows.find((row) => row.name === 'OTHER_KEY')?.state).toBe('pending');
  expect(await revokeAppSecretValues('voice-note', 'OTHER_KEY')).toMatchObject({ revoked: 1, alreadyAbsent: false });
});

test('all-app revoke keeps the app lock through target listing and deletion', async () => {
  await setAppSecretValue('app/voice-note/API_KEY', 'first');
  let listed!: () => void;
  let continueRevoke!: () => void;
  const targetListReady = new Promise<void>((resolve) => { listed = resolve; });
  const gate = new Promise<void>((resolve) => { continueRevoke = resolve; });
  const revoke = revokeAppSecretValues('voice-note', undefined, { afterRevokeTargetsListed: async () => { listed(); await gate; } });
  await targetListReady;
  let issueFinished = false;
  const issue = setAppSecretValue('app/voice-note/NEW_KEY', 'second').then(() => { issueFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(issueFinished).toBe(false);
  continueRevoke();
  await Promise.all([revoke, issue]);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBeUndefined();
  expect(await getSecretAsync('app/voice-note/NEW_KEY')).toBe('second');
});

test('synchronous legacy deletion fails fast while an app lifecycle lock is held', async () => {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { 'app/voice-note/OLD_KEY': 'legacy' } }), { mode: 0o600 });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withAppSecretLock('voice-note', async () => { entered(); await gate; });
  await ready;
  expect(() => deleteSecret('app/voice-note/OLD_KEY')).toThrow('ELANOUS_APP_SECRET_LOCK_BUSY');
  expect(await getSecretAsync('app/voice-note/OLD_KEY')).toBe('legacy');
  release();
  await holder;
  expect(deleteSecret('app/voice-note/OLD_KEY')).toBe(true);
});

test('named revoke preserves another name pending after a failed journal sync', async () => {
  await setAppSecretValue('app/voice-note/API_KEY', 'first');
  await setAppSecretValue('app/voice-note/OTHER_KEY', 'second');
  let failSync = true;
  await expect(revokeAppSecretValues('voice-note', 'OTHER_KEY', {
    beforeLedgerDirectorySync: () => { if (failSync) { failSync = false; throw new Error('journal directory sync failed'); } },
  })).rejects.toThrow('journal directory sync failed');
  expect(await revokeAppSecretValues('voice-note', 'API_KEY')).toMatchObject({ revoked: 1, alreadyAbsent: false });
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ name: string; state: string }>;
  expect(rows.find((row) => row.name === 'OTHER_KEY' && row.state === 'pending')).toBeDefined();
  expect(await revokeAppSecretValues('voice-note', 'OTHER_KEY')).toMatchObject({ revoked: 1, alreadyAbsent: false });
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBeUndefined();
  expect(await getSecretAsync('app/voice-note/OTHER_KEY')).toBeUndefined();
});

test('direct delete retry re-syncs a committed journal before reporting absence', async () => {
  await setAppSecretValue('app/voice-note/API_KEY', 'secret');
  let failSync = true;
  await expect(deleteAppSecretValue('app/voice-note/API_KEY', {
    beforeLedgerDirectorySync: () => { if (failSync) { failSync = false; throw new Error('journal directory sync failed'); } },
    beforeLedgerRollback: () => { throw new Error('journal rollback failed'); },
  })).rejects.toThrow('journal rollback failed');
  await expect(deleteAppSecretValue('app/voice-note/API_KEY', {
    beforeAbsentStateDurabilitySync: () => { throw new Error('retry durability sync required'); },
  })).rejects.toThrow('retry durability sync required');
  expect(await deleteAppSecretValue('app/voice-note/API_KEY')).toBe(false);
  expect(await getSecretAsync('app/voice-note/API_KEY')).toBeUndefined();
});

test('failed atomic rename leaves a recoverable pending journal event', () => {
  const pending = beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'API_KEY', backend: 'file', at: '2026-11-06T00:04:00.000Z' });
  expect(() => finishAppSecretEvent(pending.id, 'committed', () => { throw new Error('rename boundary failed'); })).toThrow('rename boundary failed');
  const path = join(dir, 'app-secret-ledger.json');
  let rows = JSON.parse(readFileSync(path, 'utf8')).events as Array<{ id: string; state: string }>;
  expect(rows.find((row) => row.id === pending.id)?.state).toBe('pending');
  finishAppSecretEvent(pending.id, 'committed');
  rows = JSON.parse(readFileSync(path, 'utf8')).events;
  expect(rows.find((row) => row.id === pending.id)?.state).toBe('committed');
});

test('directory sync failure after atomic rename restores the pending event for recovery', () => {
  const pending = beginAppSecretEvent({ action: 'issued', app: 'voice-note', name: 'DURABLE_KEY', backend: 'file', at: '2026-11-06T00:05:00.000Z' });
  expect(() => finishAppSecretEvent(pending.id, 'committed', undefined, () => { throw new Error('directory sync failed'); }))
    .toThrow('directory sync failed');
  const rows = JSON.parse(readFileSync(join(dir, 'app-secret-ledger.json'), 'utf8')).events as Array<{ id: string; state: string }>;
  expect(rows.find((row) => row.id === pending.id)?.state).toBe('pending');
});
