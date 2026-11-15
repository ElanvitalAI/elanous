import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileArtifact } from '../tool-runtime/file-artifact.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'file-artifact-')); roots.push(parent);
  return { root: join(parent, 'bundle'), files: [{ path: 'ARCHITECTURE.md', content: '# Architecture' },
    { path: 'backend/server.ts', content: 'throw new Error("must not execute");' }], metadata: { runtime: { startCommand: ['bun', 'run', 'start'], port: 31582, healthPath: '/health' } } };
}
test('writes a generic file artifact without executing metadata', () => {
  const input = fixture(); const result = writeFileArtifact(input);
  expect(result.executed).toBe(false); expect(result.published).toBe(false);
  expect(result.metadata).toEqual(input.metadata);
  expect(readFileSync(join(input.root, 'backend/server.ts'), 'utf8')).toBe(input.files[1]!.content);
  expect(JSON.parse(readFileSync(join(input.root, 'source-artifact.json'), 'utf8')).files).toEqual(result.files);
  expect(() => writeFileArtifact(input)).toThrow();
});
test('rejects traversal, duplicate/reserved paths and prefix conflicts before writing', () => {
  for (const names of [['../escape'], ['/absolute'], ['.env'], ['source-artifact.json'], ['a', 'a/b'], ['same', 'same']]) {
    const input = fixture();
    expect(() => writeFileArtifact({ ...input, files: names.map(path => ({ path, content: 'synthetic' })) })).toThrow();
    expect(existsSync(input.root)).toBe(false);
  }
});


test('serializes the digest of a file named __proto__ without prototype mutation', () => {
  const input = fixture();
  const content = 'synthetic prototype-named file';
  const result = writeFileArtifact({ ...input, files: [{ path: '__proto__', content }] });
  const expected = createHash('sha256').update(content).digest('hex');
  const hashes = result.files as Record<string, string>;
  expect(Object.getPrototypeOf(hashes)).toBeNull();
  expect(Object.hasOwn(hashes, '__proto__')).toBe(true);
  expect(hashes['__proto__']).toBe(expected);
  const stored = JSON.parse(readFileSync(join(input.root, 'source-artifact.json'), 'utf8'));
  expect(Object.hasOwn(stored.files, '__proto__')).toBe(true);
  expect(stored.files['__proto__']).toBe(expected);
  expect(readFileSync(join(input.root, '__proto__'), 'utf8')).toBe(content);
});

test('rejects reserved receipt descendants before any partial root is written', () => {
  const input = fixture();
  expect(() => writeFileArtifact({ ...input, files: [
    { path: 'ordinary.txt', content: 'must not be written' },
    { path: 'source-artifact.json/file', content: 'reserved collision' },
  ] })).toThrow('unsafe or duplicate file');
  expect(existsSync(input.root)).toBe(false);
});


test('bounds file path bytes and depth before creating a root', () => {
  // Source: OP #64386 path transport contract, 1024 UTF-8 bytes / 16 segments.
  for (const path of ['a'.repeat(1025), Array.from({ length: 17 }, () => 'a').join('/')]) {
    const input = fixture();
    expect(() => writeFileArtifact({ ...input, files: [{ path, content: '' }] })).toThrow('file path exceeds');
    expect(existsSync(input.root)).toBe(false);
  }
});
