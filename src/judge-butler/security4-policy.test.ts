// SEC4-PATHS-RELAX (대표 11-27 12:5x) — security-4 paths come from graphs/policies/security4-paths.yaml; land-graph-cli is out.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecurity4Paths, parseSecurity4Policy, SECURITY4_FALLBACK, security4Hits, security4PolicyPath } from './done-when.js';

describe('SEC4-PATHS-RELAX — security-4 policy YAML', () => {
  test('repo policy: land-graph-cli.ts change → no security-4 hit; src/oauth/x.ts → auth hit', () => {
    const table = loadSecurity4Paths(security4PolicyPath());
    expect(table).not.toBe(SECURITY4_FALLBACK);
    expect(security4Hits(['src/cli/land-graph-cli.ts'], table)).toEqual([]);
    expect(security4Hits(['src/oauth/x.ts'], table)).toEqual(['auth:src/oauth/x.ts']);
    expect(security4Hits(['src/cli/land-graph-cli.ts'])).toEqual([]);
    expect(security4Hits(['src/oauth/x.ts'])).toEqual(['auth:src/oauth/x.ts']);
    expect(security4Hits(['seat-state/OP/tools/op-direct-land-v2.sh'], table)).toEqual(['auth:seat-state/OP/tools/op-direct-land-v2.sh']);
  });

  test('editing the policy YAML changes the classification', () => {
    const relaxed = parseSecurity4Policy("version: 1\npaths:\n  - cls: secret\n    re: '^src/secret/'\n");
    expect(security4Hits(['src/oauth/x.ts', 'src/secret/k.ts'], relaxed)).toEqual(['secret:src/secret/k.ts']);
    const strict = parseSecurity4Policy("version: 1\npaths:\n  - cls: auth\n    re: '^src/cli/land-graph-cli\\.ts$'\n");
    expect(security4Hits(['src/cli/land-graph-cli.ts'], strict)).toEqual(['auth:src/cli/land-graph-cli.ts']);
  });

  test('missing or malformed policy → built-in fallback (same relaxed list)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec4-'));
    expect(loadSecurity4Paths(join(dir, 'none.yaml'))).toBe(SECURITY4_FALLBACK);
    writeFileSync(join(dir, 'bad.yaml'), "paths:\n  - cls: nuclear\n    re: 'x'\n");
    expect(loadSecurity4Paths(join(dir, 'bad.yaml'))).toBe(SECURITY4_FALLBACK);
    expect(security4Hits(['src/cli/land-graph-cli.ts', 'src/oauth/x.ts'], SECURITY4_FALLBACK)).toEqual(['auth:src/oauth/x.ts']);
  });
});
