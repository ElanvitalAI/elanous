import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateReceiptHashesByShard } from './gate-receipt-hash.js';
import { createCutSnapshot } from './gate-cut-snapshot.js';
import { gateTestedFileHashesAtCommit } from './gate-reuse-identity.js';

const roots: string[] = [];
const CAT_FILE_BATCH = '--batch=%(objectname) %(objecttype) %(objectsize) %(rest)';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('GATE-RECEIPT-HASH-BATCH sim: hashes 6,600 test blobs in one batch within one minute', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-batch-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const files = Array.from({ length: 6_600 }, (_, index) => `sim/receipt-${String(index).padStart(4, '0')}.test.ts`);
  const contents = new Map<string, string>();
  for (const file of files) {
    const source = `export const receiptFixture = ${JSON.stringify(file)};\n`;
    writeFileSync(join(repo, file), source);
    contents.set(file, source);
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed 6600 receipt hash fixtures');
  const commit = git('rev-parse', 'HEAD');
  const shards = Array.from({ length: 33 }, (_, index) => ({ files: files.slice(index * 200, (index + 1) * 200) }));
  let catFileCalls = 0;
  const startedAt = performance.now();
  const result = gateReceiptHashesByShard(repo, commit, shards, (cwd, input) => {
    catFileCalls += 1;
    const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 256 * 1024 * 1024 });
    return { status: command.status, stdout: Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0),
      ...(command.error ? { error: command.error } : {}) };
  });
  const elapsedMs = performance.now() - startedAt;
  expect(result.batchCount).toBe(1);
  expect(catFileCalls).toBe(1);
  expect(Object.values(result.hashesByShard).every((hashes) => hashes !== null)).toBe(true);
  expect(Object.values(result.hashesByShard).reduce((count, hashes) => count + Object.keys(hashes ?? {}).length, 0)).toBe(6_600);
  const mismatches: string[] = [];
  files.forEach((file, index) => {
    const expected = createHash('sha256').update(contents.get(file)!).digest('hex');
    if (result.hashesByShard[`pod-${Math.floor(index / 200)}`]?.[file] !== expected) mismatches.push(file);
  });
  expect(mismatches).toEqual([]);
  expect(elapsedMs).toBeLessThan(60_000);
}, 120_000);

test('GATE-RECEIPT-HASH-BATCH sim: repeated commit/path across shards is read once', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-cache-')); roots.push(repo);
  const file = 'sim/repeated.test.ts';
  mkdirSync(join(repo, 'sim'));
  writeFileSync(join(repo, file), 'export const repeated = true;\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed repeated receipt hash fixture');
  const commit = git('rev-parse', 'HEAD');
  let catFileCalls = 0;
  const result = gateReceiptHashesByShard(repo, commit, [{ files: [file] }, { files: [file] }], (cwd, input) => {
    catFileCalls += 1;
    const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 1024 * 1024 });
    return { status: command.status, stdout: Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0),
      ...(command.error ? { error: command.error } : {}) };
  });
  expect(result.batchCount).toBe(1);
  expect(catFileCalls).toBe(1);
  expect(result.hashesByShard['pod-0']?.[file]).toBe(result.hashesByShard['pod-1']?.[file]);
});

test('same-head receipt hashes follow committed blobs across working-tree edits and shard order', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-same-head-')); roots.push(repo);
  mkdirSync(join(repo, 'sim'));
  const files = ['sim/a.test.ts', 'sim/b.test.ts'];
  writeFileSync(join(repo, files[0]!), 'export const value = "a";\n');
  writeFileSync(join(repo, files[1]!), 'export const value = "b";\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed same-head fixtures');
  const commit = git('rev-parse', 'HEAD');
  const first = gateReceiptHashesByShard(repo, commit, files.map((file) => ({ files: [file] }))).hashesByShard;
  writeFileSync(join(repo, files[0]!), 'export const value = "dirty";\n');
  const reversed = gateReceiptHashesByShard(repo, commit, [...files].reverse().map((file) => ({ files: [file] }))).hashesByShard;
  expect(reversed['pod-1']?.[files[0]!]).toBe(first['pod-0']?.[files[0]!]);
  expect(reversed['pod-0']?.[files[1]!]).toBe(first['pod-1']?.[files[1]!]);
  expect(first['pod-0']?.[files[0]!]).toBe(createHash('sha256').update('export const value = "a";\n').digest('hex'));
});

test('CutSnapshot receipt hashes use raw blob bytes for a non-UTF-8 test file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-snapshot-bytes-')); roots.push(repo);
  mkdirSync(join(repo, 'sim'));
  const file = 'sim/raw.test.ts';
  const raw = Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0xff, 0x0a]);
  writeFileSync(join(repo, file), raw);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed raw receipt bytes');
  const commit = git('rev-parse', 'HEAD');
  const expected = createHash('sha256').update(raw).digest('hex');
  const snapshot = createCutSnapshot(repo, commit);
  const hashes = gateReceiptHashesByShard(repo, commit, [{ files: [file] }], snapshot);
  expect(hashes.hashesByShard['pod-0']?.[file]).toBe(expected);
  expect(gateTestedFileHashesAtCommit(repo, commit, [file])?.[file]).toBe(expected);
  expect(gateReceiptHashesByShard(repo, 'a'.repeat(40), [{ files: [file] }], snapshot).hashesByShard['pod-0']).toBeNull();
});

test('GATE-RECEIPT-HASH-BATCH sim: binary and empty blobs hash; a missing blob only invalidates its shard', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-partial-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const binaryFile = 'sim/binary.test.ts';
  const emptyFile = 'sim/empty.test.ts';
  const binary = Buffer.from([0x00, 0xff, 0x0a, 0x80]);
  writeFileSync(join(repo, binaryFile), binary);
  writeFileSync(join(repo, emptyFile), Buffer.alloc(0));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed binary and empty receipt fixtures');
  const commit = git('rev-parse', 'HEAD');
  const missingFile = 'sim/missing.test.ts';
  let catFileCalls = 0;
  const result = gateReceiptHashesByShard(repo, commit,
    [{ files: [binaryFile, emptyFile] }, { files: [missingFile] }, { files: [binaryFile] }], (cwd, input) => {
      catFileCalls += 1;
      const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 1024 * 1024 });
      return { status: command.status, stdout: Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0),
        ...(command.error ? { error: command.error } : {}) };
    });
  expect(catFileCalls).toBe(1);
  expect(result.hashesByShard['pod-0']?.[binaryFile]).toBe(createHash('sha256').update(binary).digest('hex'));
  expect(result.hashesByShard['pod-0']?.[emptyFile]).toBe(createHash('sha256').digest('hex'));
  expect(result.hashesByShard['pod-1']).toBeNull();
  expect(result.hashesByShard['pod-2']?.[binaryFile]).toBe(result.hashesByShard['pod-0']?.[binaryFile]);
});

test('GATE-RECEIPT-HASH-BATCH sim: repeated malformed records do not poison later shard hashes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-malformed-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const files = ['sim/01-first.test.ts', 'sim/02-second.test.ts', 'sim/03-third.test.ts', 'sim/04-fourth.test.ts'];
  const contents = files.map((file, index) => `export const value${index} = ${JSON.stringify(file)};\n`);
  files.forEach((file, index) => writeFileSync(join(repo, file), contents[index]!));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed malformed batch recovery fixtures');
  const commit = git('rev-parse', 'HEAD');
  let catFileCalls = 0;
  const corruptHeader = (stdout: Buffer, target: number): Buffer => {
    let offset = 0;
    for (let index = 0; index <= target; index += 1) {
      const headerEnd = stdout.indexOf(0x0a, offset);
      if (headerEnd < 0) throw new Error('fixture batch header missing');
      if (index === target) {
        return Buffer.concat([stdout.subarray(0, offset), Buffer.from('damaged batch header\n'), stdout.subarray(headerEnd + 1)]);
      }
      const match = /^([a-f0-9]{40}) blob (\d+) (.+)$/i.exec(stdout.toString('ascii', offset, headerEnd));
      if (!match) throw new Error('fixture batch blob header invalid');
      offset = headerEnd + 1 + Number(match[2]) + 1;
    }
    throw new Error('fixture target header not reached');
  };
  const result = gateReceiptHashesByShard(repo, commit, files.map((file) => ({ files: [file] })), (cwd, input) => {
    catFileCalls += 1;
    const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 1024 * 1024 });
    const stdout = Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0);
    return { status: command.status,
      stdout: catFileCalls === 1 ? corruptHeader(stdout, 1) : catFileCalls === 2 ? corruptHeader(stdout, 0) : stdout,
      ...(command.error ? { error: command.error } : {}) };
  });
  expect(catFileCalls).toBe(3);
  expect(result.batchCount).toBe(3);
  expect(result.hashesByShard['pod-0']?.[files[0]!]).toBe(createHash('sha256').update(contents[0]!).digest('hex'));
  expect(result.hashesByShard['pod-1']).toBeNull();
  expect(result.hashesByShard['pod-2']).toBeNull();
  expect(result.hashesByShard['pod-3']?.[files[3]!]).toBe(createHash('sha256').update(contents[3]!).digest('hex'));
});

test('GATE-RECEIPT-HASH-BATCH sim: same-length body corruption fails object-id validation and retries only later paths', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-object-id-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const files = ['sim/01-first.test.ts', 'sim/02-second.test.ts', 'sim/03-third.test.ts'];
  const contents = files.map((file, index) => `export const value${index} = ${JSON.stringify(file)};\n`);
  files.forEach((file, index) => writeFileSync(join(repo, file), contents[index]!));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed blob object-id verification fixtures');
  const commit = git('rev-parse', 'HEAD');
  let catFileCalls = 0;
  const corruptBody = (stdout: Buffer, target: number): Buffer => {
    let offset = 0;
    for (let index = 0; index <= target; index += 1) {
      const headerEnd = stdout.indexOf(0x0a, offset);
      if (headerEnd < 0) throw new Error('fixture batch header missing');
      const match = /^([a-f0-9]{40}) blob (\d+) (.+)$/i.exec(stdout.toString('ascii', offset, headerEnd));
      if (!match) throw new Error('fixture batch blob header invalid');
      const contentStart = headerEnd + 1;
      if (index === target) {
        const damaged = Buffer.from(stdout);
        damaged[contentStart] = damaged[contentStart]! ^ 0x01;
        return damaged;
      }
      offset = contentStart + Number(match[2]) + 1;
    }
    throw new Error('fixture target body not reached');
  };
  const result = gateReceiptHashesByShard(repo, commit, files.map((file) => ({ files: [file] })), (cwd, input) => {
    catFileCalls += 1;
    const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 1024 * 1024 });
    const stdout = Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0);
    return { status: command.status, stdout: catFileCalls === 1 ? corruptBody(stdout, 1) : stdout,
      ...(command.error ? { error: command.error } : {}) };
  });
  expect(catFileCalls).toBe(2);
  expect(result.batchCount).toBe(2);
  expect(result.hashesByShard['pod-0']?.[files[0]!]).toBe(createHash('sha256').update(contents[0]!).digest('hex'));
  expect(result.hashesByShard['pod-1']).toBeNull();
  expect(result.hashesByShard['pod-2']?.[files[2]!]).toBe(createHash('sha256').update(contents[2]!).digest('hex'));
});

test('GATE-RECEIPT-HASH-BATCH sim: a missing response record cannot shift the next blob onto the wrong path', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-missing-record-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const files = ['sim/01-first.test.ts', 'sim/02-second.test.ts', 'sim/03-third.test.ts'];
  const contents = files.map((file, index) => `export const value${index} = ${JSON.stringify(file)};\n`);
  files.forEach((file, index) => writeFileSync(join(repo, file), contents[index]!));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed missing response record fixtures');
  const commit = git('rev-parse', 'HEAD');
  let catFileCalls = 0;
  const removeRecord = (stdout: Buffer, target: number): Buffer => {
    let offset = 0;
    for (let index = 0; index <= target; index += 1) {
      const headerEnd = stdout.indexOf(0x0a, offset);
      if (headerEnd < 0) throw new Error('fixture batch header missing');
      const match = /^([a-f0-9]{40}) blob (\d+) (.+)$/i.exec(stdout.toString('ascii', offset, headerEnd));
      if (!match) throw new Error('fixture batch blob header invalid');
      const contentEnd = headerEnd + 1 + Number(match[2]);
      if (index === target) return Buffer.concat([stdout.subarray(0, offset), stdout.subarray(contentEnd + 1)]);
      offset = contentEnd + 1;
    }
    throw new Error('fixture target record not reached');
  };
  const result = gateReceiptHashesByShard(repo, commit, files.map((file) => ({ files: [file] })), (cwd, input) => {
    catFileCalls += 1;
    const command = spawnSync('git', ['cat-file', CAT_FILE_BATCH], { cwd, input, maxBuffer: 1024 * 1024 });
    const stdout = Buffer.isBuffer(command.stdout) ? command.stdout : Buffer.alloc(0);
    return { status: command.status, stdout: catFileCalls === 1 ? removeRecord(stdout, 1) : stdout,
      ...(command.error ? { error: command.error } : {}) };
  });
  expect(catFileCalls).toBe(2);
  expect(result.batchCount).toBe(2);
  expect(result.hashesByShard['pod-0']?.[files[0]!]).toBe(createHash('sha256').update(contents[0]!).digest('hex'));
  expect(result.hashesByShard['pod-1']).toBeNull();
  expect(result.hashesByShard['pod-2']?.[files[2]!]).toBe(createHash('sha256').update(contents[2]!).digest('hex'));
});

test('GATE-RECEIPT-HASH-BATCH sim: a process-level batch failure stops without per-file retries', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-receipt-hash-process-failure-')); roots.push(repo);
  const directory = join(repo, 'sim');
  mkdirSync(directory);
  const files = ['sim/first.test.ts', 'sim/second.test.ts', 'sim/third.test.ts'];
  files.forEach((file) => writeFileSync(join(repo, file), 'export const fixture = true;\n'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Gate receipt hash sim');
  git('config', 'user.email', 'gate-receipt-hash-sim@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'seed process failure fixtures');
  const commit = git('rev-parse', 'HEAD');
  let catFileCalls = 0;
  const result = gateReceiptHashesByShard(repo, commit, files.map((file) => ({ files: [file] })), () => {
    catFileCalls += 1;
    return { status: 127, stdout: Buffer.alloc(0), error: new Error('git execution unavailable') };
  });
  expect(catFileCalls).toBe(1);
  expect(result.batchCount).toBe(1);
  expect(Object.values(result.hashesByShard).every((hashes) => hashes === null)).toBe(true);
});
