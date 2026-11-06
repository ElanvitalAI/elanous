// IMPORT-DIET-JSONRESPONSE (2026-11-05) — route handlers under src/nexus/api must not import
// the 3.4k-line http-server.ts just to get `jsonResponse`. That edge closed an 80-file import
// cycle and made the classic TUI eagerly load the whole Nexus server subtree (273 files ·
// 55k lines measured on origin/main e58e90296a). `jsonResponse`/`corsPreflight` live in
// ./json-response.ts; http-server.ts only re-exports them for compatibility.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_DIR = import.meta.dir;

describe('nexus api import diet', () => {
  test('no non-test module in src/nexus/api imports ./http-server.js', () => {
    const offenders = readdirSync(API_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'http-server.ts')
      .filter((name) => /from\s+['"]\.\/http-server\.js['"]/.test(readFileSync(join(API_DIR, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
