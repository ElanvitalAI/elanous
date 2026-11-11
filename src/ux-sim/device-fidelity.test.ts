import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { constants as fsConstants, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { applyDeviceFidelity, canonicalizeDeviceResponse, compareDeviceRecording, compareLlmCassetteRecording, deviceFidelityStatus } from './device-fidelity.js';

const previousRoot = getTestStateRoot();
const roots: string[] = [];

afterEach(() => {
  setTestStateRoot(previousRoot ?? null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function withFidelityRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sim-device-fidelity-'));
  roots.push(root);
  setTestStateRoot(root);
  return root;
}

const recording = (realResponse: string) => ({
  version: 1,
  id: 'github-pulls-open',
  deviceId: 'fake-github',
  repository: 'acme/widget',
  recordedAt: '2026-11-04T10:00:00.000Z',
  prs: [{ number: 7, title: 'Recorded PR', branch: 'feature/recorded', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z' }],
  calls: [{ args: ['api', '/repos/acme/widget/pulls?state=open'], realResponse }],
});

const realPullResponse = '[{"number":7,"title":"Recorded PR","draft":false,"state":"open","head":{"ref":"feature/recorded","sha":"head7"},"base":{"ref":"main"},"labels":[],"created_at":"2026-11-03T00:00:00.000Z","updated_at":"2026-11-04T09:00:00.000Z","merged_at":null,"body":null,"merge_commit_sha":null}]';

test('replays recorded real GitHub responses through the fake GitHub device', () => {
  withFidelityRoot();
  const result = compareDeviceRecording(recording(realPullResponse), new Date('2026-11-05T00:00:00.000Z'));
  expect(result).toMatchObject({ recordingId: 'github-pulls-open', deviceId: 'fake-github', passed: true });
  expect(result.comparisons).toHaveLength(1);
  expect(deviceFidelityStatus('fake-github').verdict).toBe('green');
});

test('E4.5 LLM mismatch is attached only to worlds that used that cassette', () => {
  withFidelityRoot();
  const cassetteId = 'a'.repeat(64); // Source: SHA-256 recording key shape.
  const legacyRequestKey = 'd'.repeat(64); // Source: legacy cassette request-key shape.
  expect(compareLlmCassetteRecording(cassetteId, [{ type: 'text', delta: 'saved' }], [{ type: 'text', delta: 'changed' }], undefined, legacyRequestKey).passed).toBe(false);
  expect(compareLlmCassetteRecording(cassetteId, [{ type: 'text', delta: 'saved' }], [{ type: 'text', delta: 'saved' }]).passed).toBe(true);
  expect(deviceFidelityStatus('fake-llm', [cassetteId]).verdict).toBe('yellow');
  expect(deviceFidelityStatus('fake-llm', [legacyRequestKey]).verdict).toBe('yellow');
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-llm'], recordingIds: [cassetteId] })).toMatchObject({ pass: false, verdict: 'yellow' });
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-llm'], recordingIds: ['b'.repeat(64)] })).toMatchObject({ pass: true, verdict: 'green' });
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-llm'] })).toMatchObject({ pass: true, verdict: 'green', fidelity: [{ verdict: 'unmeasured' }] });
});

test('a real-versus-device mismatch is durable and downgrades only results using that device', () => {
  withFidelityRoot();
  const result = compareDeviceRecording(recording(realPullResponse.replace('Recorded PR', 'Changed PR')));
  expect(result.passed).toBe(false);
  expect(deviceFidelityStatus('fake-github')).toEqual({ verdict: 'yellow', failedRecordingIds: ['github-pulls-open'] });
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-github'] })).toMatchObject({ pass: false, verdict: 'yellow' });
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-clock'] })).toMatchObject({ pass: true, verdict: 'green' });
});

test('malformed and unsupported recordings fail closed', () => {
  withFidelityRoot();
  expect(() => compareDeviceRecording({ ...recording(realPullResponse), deviceId: 'fake-clock' })).toThrow('recording.deviceId must be fake-github');
  expect(() => compareDeviceRecording({ ...recording(realPullResponse), calls: [] })).toThrow('at least one call');
});

test('same recording id cannot replace a different recording and empty responses are retained', () => {
  withFidelityRoot();
  const mismatch = recording(realPullResponse.replace('Recorded PR', 'Changed PR'));
  expect(compareDeviceRecording(mismatch).passed).toBe(false);
  expect(() => compareDeviceRecording(recording(realPullResponse))).toThrow('recording id already belongs to different content');
  const noContent = { ...recording(''), id: 'github-no-content' };
  expect(compareDeviceRecording(noContent).passed).toBe(false);
  expect(deviceFidelityStatus('fake-gh')).toEqual({ verdict: 'yellow', failedRecordingIds: ['github-no-content', 'github-pulls-open'] });
  expect(applyDeviceFidelity({ pass: true, devices: ['fake-gh'] })).toMatchObject({ pass: false, verdict: 'yellow' });
});

test('database symlinks cannot redirect fidelity state outside the test universe', () => {
  const root = withFidelityRoot();
  const directory = join(root, 'sim-fidelity');
  mkdirSync(directory, { mode: 0o700 });
  const outside = join(root, 'outside.sqlite');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, join(directory, 'device-fidelity.sqlite'));
  expect(() => deviceFidelityStatus('fake-github')).toThrow(/private regular file|ELOOP/);
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('older fidelity databases migrate without discarding failed verdicts', () => {
  const root = withFidelityRoot();
  const directory = join(root, 'sim-fidelity');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'device-fidelity.sqlite');
  closeSync(openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600));
  const db = new Database(path);
  db.exec(`CREATE TABLE recordings (recording_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, passed INTEGER NOT NULL, payload TEXT NOT NULL);
    INSERT INTO recordings VALUES ('legacy-recording', 'fake-github', 0, '{}');`);
  db.close();
  expect(deviceFidelityStatus('fake-github')).toEqual({ verdict: 'yellow', failedRecordingIds: ['legacy-recording'] });
  expect(() => compareDeviceRecording({ ...recording(realPullResponse), id: 'legacy-recording' }))
    .toThrow('recording id already belongs to different content');
  expect(deviceFidelityStatus('fake-github')).toEqual({ verdict: 'yellow', failedRecordingIds: ['legacy-recording'] });
});

test('concurrent recording comparisons preserve every device verdict', async () => {
  const root = withFidelityRoot();
  const sourceRoot = join(import.meta.dir, '../..');
  const script = [
    "import { setTestStateRoot } from './src/nexus/paths.ts';",
    "import { compareDeviceRecording } from './src/ux-sim/device-fidelity.ts';",
    'setTestStateRoot(process.env.FIDELITY_TEST_ROOT!);',
    'compareDeviceRecording(JSON.parse(process.env.FIDELITY_RECORDING!));',
  ].join('\n');
  const run = (id: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: sourceRoot,
      env: { ...process.env, FIDELITY_TEST_ROOT: root, FIDELITY_RECORDING: JSON.stringify({
        version: 1, id, deviceId: 'fake-github', repository: 'acme/widget', recordedAt: '2026-11-04T10:00:00.000Z', prs: [],
        calls: [{ args: ['api', '/repos/acme/widget/pulls?state=open'], realResponse: '[]' }],
      }) },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`fidelity child exited ${code}`)));
  });
  const ids = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);
  await Promise.all(ids.map(run));
  const db = new Database(join(root, 'sim-fidelity', 'device-fidelity.sqlite'), { readonly: true, strict: true });
  try {
    const rows = db.query('SELECT recording_id FROM recordings').all() as Array<{ recording_id: string }>;
    expect(rows.map((row) => row.recording_id).sort()).toEqual(ids.sort());
  } finally { db.close(); }
});

test('SQLite releases fidelity transactions when a writer process exits unexpectedly', async () => {
  const root = withFidelityRoot();
  deviceFidelityStatus('fake-github');
  const databasePath = join(root, 'sim-fidelity', 'device-fidelity.sqlite');
  const script = "import { Database } from 'bun:sqlite'; const db = new Database(process.env.FIDELITY_DB!); db.exec('BEGIN IMMEDIATE'); process.exit(0);";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, FIDELITY_DB: databasePath },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`fidelity lock holder exited ${code}`)));
  });
  expect(compareDeviceRecording(recording(realPullResponse)).passed).toBe(true);
  expect(deviceFidelityStatus('fake-github').verdict).toBe('green');
});

test('lossless JSON normalization does not collapse integers above the safe range', () => {
  expect(canonicalizeDeviceResponse('[{"count":9007199254740992}]'))
    .not.toBe(canonicalizeDeviceResponse('[{"count":9007199254740993}]'));
  expect(canonicalizeDeviceResponse('{ "x": 1, "y": [2] }'))
    .toBe(canonicalizeDeviceResponse('{"y":[2],"x":1}'));
  expect(canonicalizeDeviceResponse('{"count":1}')).toBe(canonicalizeDeviceResponse('{"count":1.0}'));
  expect(canonicalizeDeviceResponse('{"count":1}')).toBe(canonicalizeDeviceResponse('{"count":1e0}'));
});
