import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { constants as sqliteConstants, Database } from 'bun:sqlite';
import { getTestStateRoot } from '../nexus/paths.js';
import { createFakeGh, type FakeGhPr } from './fake-gh.js';

export interface DeviceRecording {
  version: 1;
  id: string;
  deviceId: 'fake-github';
  repository: string;
  recordedAt: string;
  prs: FakeGhPr[];
  calls: Array<{ args: string[]; realResponse: string }>;
}

export interface DeviceFidelityComparison {
  recordingId: string;
  deviceId: string;
  passed: boolean;
  comparisons: Array<{ index: number; passed: boolean; expectedSha256: string; actualSha256: string }>;
  comparedAt: string;
}

function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseRecording(value: unknown): DeviceRecording {
  const row = recordObject(value, 'recording');
  if (row.version !== 1) throw new Error('recording.version must be 1');
  const id = string(row.id, 'recording.id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('recording.id is invalid');
  if (row.deviceId !== 'fake-github') throw new Error('recording.deviceId must be fake-github');
  const repository = string(row.repository, 'recording.repository');
  const recordedAt = string(row.recordedAt, 'recording.recordedAt');
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('recording.recordedAt must be an ISO date-time');
  if (!Array.isArray(row.prs) || !Array.isArray(row.calls) || row.calls.length === 0) {
    throw new Error('recording.prs and recording.calls must be arrays, with at least one call');
  }
  const prs = row.prs.map((candidate, index) => {
    const pr = recordObject(candidate, `recording.prs[${index}]`);
    if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1) throw new Error(`recording.prs[${index}].number is invalid`);
    for (const key of ['title', 'branch', 'createdAt', 'updatedAt'] as const) string(pr[key], `recording.prs[${index}].${key}`);
    return pr as unknown as FakeGhPr;
  });
  const calls = row.calls.map((candidate, index) => {
    const call = recordObject(candidate, `recording.calls[${index}]`);
    if (!Array.isArray(call.args) || call.args.length === 0 || call.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`recording.calls[${index}].args must be a non-empty string array`);
    }
    if (typeof call.realResponse !== 'string') throw new Error(`recording.calls[${index}].realResponse must be a string`);
    return { args: call.args as string[], realResponse: call.realResponse };
  });
  return { version: 1, id, deviceId: 'fake-github', repository, recordedAt, prs, calls };
}

export function canonicalizeDeviceResponse(value: string): string {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(value[cursor] ?? '') && cursor < value.length) cursor++; };
  const parseString = (): string => {
    const start = cursor++;
    while (cursor < value.length) {
      if (value[cursor] === '\\') { cursor += 2; continue; }
      if (value[cursor++] === '"') return JSON.parse(value.slice(start, cursor)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const parseValue = (): string => {
    whitespace();
    const token = value[cursor];
    if (token === '"') return JSON.stringify(parseString());
    if (token === '[') {
      cursor++;
      whitespace();
      const items: string[] = [];
      if (value[cursor] !== ']') while (true) {
        items.push(parseValue());
        whitespace();
        if (value[cursor] !== ',') break;
        cursor++;
      }
      if (value[cursor++] !== ']') throw new Error('invalid JSON array');
      return `[${items.join(',')}]`;
    }
    if (token === '{') {
      cursor++;
      whitespace();
      const entries: Array<[string, string]> = [];
      const keys = new Set<string>();
      if (value[cursor] !== '}') while (true) {
        whitespace();
        if (value[cursor] !== '"') throw new Error('invalid JSON object key');
        const key = parseString();
        if (keys.has(key)) throw new Error('duplicate JSON object key');
        keys.add(key);
        whitespace();
        if (value[cursor++] !== ':') throw new Error('invalid JSON object separator');
        entries.push([key, parseValue()]);
        whitespace();
        if (value[cursor] !== ',') break;
        cursor++;
      }
      if (value[cursor++] !== '}') throw new Error('invalid JSON object');
      entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${item}`).join(',')}}`;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(value.slice(cursor));
    if (number) {
      cursor += number[0].length;
      const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(number[0])!;
      let digits = `${parts[2]}${parts[3] ?? ''}`.replace(/^0+/, '');
      if (!digits) return '0';
      let exponent = BigInt(parts[4] ?? '0') - BigInt((parts[3] ?? '').length);
      while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
      return `${parts[1]}${digits}e${exponent}`;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (value.startsWith(literal, cursor)) { cursor += literal.length; return literal; }
    }
    throw new Error('invalid JSON value');
  };
  try {
    const result = parseValue();
    whitespace();
    if (cursor !== value.length) throw new Error('trailing JSON content');
    return result;
  } catch {
    // Non-JSON device output is compared byte-for-byte. Malformed/duplicate-key JSON
    // therefore cannot be normalized into a false match.
    return value;
  }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function statePath(): string {
  const root = getTestStateRoot();
  if (!root) throw new Error('sim fidelity requires an explicit --test universe');
  const logical = resolve(root);
  const rootInfo = lstatSync(logical);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('sim fidelity test root must be a real directory');
  const physical = realpathSync(logical);
  const directory = join(physical, 'sim-fidelity');
  const rel = relative(physical, directory);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(directory) !== directory) throw new Error('sim fidelity storage escaped the test universe');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const dirInfo = lstatSync(directory);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || (dirInfo.mode & 0o077) !== 0) {
    throw new Error('sim fidelity storage must be a private directory in the test universe');
  }
  return join(directory, 'device-fidelity.sqlite');
}

function withStateDatabase<T>(action: (db: Database) => T): T {
  const path = statePath();
  let anchorFd: number;
  try {
    anchorFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    anchorFd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  const anchor = fstatSync(anchorFd);
  let db: Database | undefined;
  try {
    const beforeOpen = lstatSync(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.nlink !== 1
      || beforeOpen.dev !== anchor.dev || beforeOpen.ino !== anchor.ino || (beforeOpen.mode & 0o077) !== 0) {
      throw new Error('sim fidelity database must be the private regular file anchored in the test universe');
    }
    const flags = sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW;
    db = new Database(path, flags);
    const afterOpen = lstatSync(path);
    if (afterOpen.isSymbolicLink() || afterOpen.dev !== anchor.dev || afterOpen.ino !== anchor.ino || afterOpen.nlink !== 1) {
      throw new Error('sim fidelity database changed while SQLite opened it');
    }
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS recordings (
        recording_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
        recording_sha256 TEXT,
        payload TEXT NOT NULL
      )`);
      const columns = db.query('PRAGMA table_info(recordings)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'recording_sha256')) {
        db.exec('ALTER TABLE recordings ADD COLUMN recording_sha256 TEXT');
        db.exec("UPDATE recordings SET recording_sha256 = 'legacy:' || recording_id WHERE recording_sha256 IS NULL");
      }
      const result = action(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db?.close();
    closeSync(anchorFd);
  }
}

export function compareDeviceRecording(value: unknown, now = new Date()): DeviceFidelityComparison {
  const recording = parseRecording(value);
  const device = createFakeGh({ prs: recording.prs, repository: recording.repository, now: () => new Date(recording.recordedAt) });
  const comparisons = recording.calls.map((call, index) => {
    let actual: string;
    try { actual = device.api([...call.args]); }
    catch { actual = '<device-error>'; }
    const expected = canonicalizeDeviceResponse(call.realResponse);
    const observed = canonicalizeDeviceResponse(actual);
    return { index, passed: expected === observed, expectedSha256: sha(expected), actualSha256: sha(observed) };
  });
  const result = { recordingId: recording.id, deviceId: recording.deviceId,
    passed: comparisons.every((item) => item.passed), comparisons, comparedAt: now.toISOString() };
  const recordingSha256 = sha(JSON.stringify(recording));
  withStateDatabase((db) => {
    const existing = db.query('SELECT recording_sha256 FROM recordings WHERE recording_id = ?').get(recording.id) as { recording_sha256: string } | null;
    if (existing && existing.recording_sha256 !== recordingSha256) {
      throw new Error(`recording id already belongs to different content: ${recording.id}`);
    }
    db.query(`INSERT INTO recordings(recording_id, device_id, passed, recording_sha256, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(recording_id) DO UPDATE SET device_id = excluded.device_id, passed = excluded.passed, recording_sha256 = excluded.recording_sha256, payload = excluded.payload`)
      .run(recording.id, recording.deviceId, result.passed ? 1 : 0, recordingSha256, JSON.stringify(result));
  });
  return result;
}

export function deviceFidelityStatus(deviceId: string): { verdict: 'green' | 'yellow' | 'unmeasured'; failedRecordingIds: string[] } {
  const canonicalDeviceId = deviceId === 'fake-gh' ? 'fake-github' : deviceId;
  return withStateDatabase((db) => {
    const comparisons = db.query('SELECT recording_id, passed FROM recordings WHERE device_id = ? ORDER BY recording_id')
      .all(canonicalDeviceId) as Array<{ recording_id: string; passed: number }>;
    const failedRecordingIds = comparisons.filter((row) => row.passed === 0).map((row) => row.recording_id);
    if (failedRecordingIds.length) return { verdict: 'yellow', failedRecordingIds };
    return { verdict: comparisons.length ? 'green' as const : 'unmeasured' as const, failedRecordingIds: [] };
  });
}

export function applyDeviceFidelity<T extends { pass: boolean; devices: string[] }>(result: T): T & {
  verdict: 'green' | 'yellow' | 'red';
  fidelity: Array<{ deviceId: string; verdict: 'green' | 'yellow' | 'unmeasured'; failedRecordingIds: string[] }>;
} {
  const fidelity = result.devices.map((deviceId) => ({
    deviceId,
    ...deviceFidelityStatus(deviceId),
  }));
  const hasMismatch = fidelity.some((row) => row.verdict === 'yellow');
  return { ...result, pass: result.pass && !hasMismatch, verdict: hasMismatch ? 'yellow' : result.pass ? 'green' : 'red', fidelity };
}
