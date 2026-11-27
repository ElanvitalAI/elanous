// OP-OBSERVE-LANDED neighbour (11-27 22:39): `eln fed snapshot` read «build ?» on an install — the code root
// `versions/<dir>/node_modules/elanous` has no .git. The install record `versions/<dir>/install.json` names the build.
// Expectations are literals (rule 11).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedBuildSha } from './sources-live.js';

let dir: string;
let codeRoot: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fed-build-'));
  codeRoot = join(dir, 'versions', '0.3.38-dev.0-03b1eebc6258', 'node_modules', 'elanous');
  mkdirSync(codeRoot, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('installedBuildSha', () => {
  test('a git checkout: the git marker wins', () => {
    expect(installedBuildSha(codeRoot, { gitSha: () => '1111111111111111111111111111111111111111' })).toBe('1111111111111111111111111111111111111111');
  });

  test('an install (no .git): the version folder install.json commit', () => {
    writeFileSync(join(dir, 'versions', '0.3.38-dev.0-03b1eebc6258', 'install.json'),
      '{"version":"0.3.38-dev.0","commit":"03b1eebc6258f7eba85184364599b9c0ca7292fd"}\n');
    expect(installedBuildSha(codeRoot, { gitSha: () => null })).toBe('03b1eebc6258f7eba85184364599b9c0ca7292fd');
  });

  test('git marker throws → still the install record', () => {
    writeFileSync(join(dir, 'versions', '0.3.38-dev.0-03b1eebc6258', 'install.json'), '{"commit":"03b1eebc6258f7eba85184364599b9c0ca7292fd"}');
    expect(installedBuildSha(codeRoot, { gitSha: () => { throw new Error('boom'); } })).toBe('03b1eebc6258f7eba85184364599b9c0ca7292fd');
  });

  test('neither (no record · broken JSON · non-sha commit) → null, shown as «?»', () => {
    expect(installedBuildSha(codeRoot, { gitSha: () => null })).toBeNull();
    writeFileSync(join(dir, 'versions', '0.3.38-dev.0-03b1eebc6258', 'install.json'), '{not json');
    expect(installedBuildSha(codeRoot, { gitSha: () => null })).toBeNull();
    writeFileSync(join(dir, 'versions', '0.3.38-dev.0-03b1eebc6258', 'install.json'), '{"commit":"unknown"}');
    expect(installedBuildSha(codeRoot, { gitSha: () => null })).toBeNull();
  });
});
