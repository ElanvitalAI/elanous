import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredSha } from './desired-sha.js';

test('desiredSha — 40자 hex 만 소문자로, 그 밖(없음·깨짐·짧음·비문자)은 undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desired-sha-'));
  try {
    const put = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
    expect(desiredSha(put('ok.json', JSON.stringify({ sha: 'AB'.repeat(20) })))).toBe('ab'.repeat(20));
    expect(desiredSha(put('short.json', JSON.stringify({ sha: 'abc' })))).toBeUndefined();
    expect(desiredSha(put('num.json', JSON.stringify({ sha: 5 })))).toBeUndefined();
    expect(desiredSha(put('bad.json', '{nope'))).toBeUndefined();
    expect(desiredSha(join(dir, 'missing.json'))).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
