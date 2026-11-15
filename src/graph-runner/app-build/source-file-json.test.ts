import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSourceFileJson, sourceFileResponseFormat, writeSourceFileRaw } from './source-file-json.js';

test('strict schema fixes the path and requires only path and content', () => {
  const format = sourceFileResponseFormat('backend/db.ts');
  expect(format.type).toBe('json_schema');
  expect(format.json_schema.strict).toBe(true);
  expect(format.json_schema.schema).toEqual({ type: 'object',
    properties: { path: { type: 'string', enum: ['backend/db.ts'] }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false });
});

test('generic parser accepts a fenced object with literal code line breaks but preserves content', () => {
  const content = 'import { Database } from "bun:sqlite";\nexport const db = new Database("x");';
  const raw = '```json\n' + JSON.stringify({ path: 'backend/db.ts', content }).replaceAll('\\n', '\n') + '\n```';
  const normalized = normalizeSourceFileJson(raw, 'backend/db.ts');
  expect(JSON.parse(normalized)).toEqual({ path: 'backend/db.ts', content });
  expect(normalizeSourceFileJson(normalized, 'backend/db.ts')).toBe(normalized);
  const root = mkdtempSync(join(tmpdir(), 'source-raw-'));
  try {
    const receipt = writeSourceFileRaw(join(root, 'private'), 'run-123', raw);
    expect(readFileSync(receipt.path, 'utf8')).toBe(raw);
    expect(receipt.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(statSync(receipt.path).mode & 0o077).toBe(0);
    expect(statSync(join(root, 'private')).mode & 0o077).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parser leaves a wrong path or extra keys for the bounded validator to reject', () => {
  const wrong = '{"path":"other.ts","content":"export {}"}';
  const extra = '{"path":"backend/db.ts","content":"export {}","notes":"not contracted"}';
  expect(normalizeSourceFileJson(wrong, 'backend/db.ts')).toBe(wrong);
  expect(normalizeSourceFileJson(extra, 'backend/db.ts')).toBe(extra);
});
