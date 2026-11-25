// Ratchet: no tracked code file may carry a private redaction value inside a code identifier
// (object key, variable, property). `release prepare` refuses those (0.3.36 drill: release-graph-exec.ts:108).
// The redaction table is private (outside the repo) — without it this test cannot see and skips loudly.
import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applyPrivateRedactions, loadPrivateRedactions, privateRedactionsPath } from '../scripts/public-export';

const redactions = loadPrivateRedactions();
describe('public export · private values never inside code identifiers', () => {
  test.skipIf(!redactions)(`tracked code is redaction-safe (${privateRedactionsPath()})`, () => {
    const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => /\.(?:ts|tsx|js|mjs|cjs|jsx)$/u.test(f));
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      try { applyPrivateRedactions(new Map([[file, text]]), redactions!); } catch (error) {
        const found = (error as { hits?: Array<{ file: string; line: number; marker: string }> }).hits;
        for (const hit of found ?? []) if (hit.marker === 'private-redaction-identifier') hits.push(`${hit.file}:${hit.line} (quote the key or read the name from config)`);
      }
    }
    expect(hits).toEqual([]);
  }, 120_000);
});
