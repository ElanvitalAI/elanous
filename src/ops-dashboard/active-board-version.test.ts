// WORK-PULL-RELEASE-VERSION (11-27 12:20): main stayed 0.3.37-dev.0 after the 0.3.37 release while release.graph.version
// was 0.3.38 — `eln work next` read the published 0.3.37 board («일감 0»). The board readers take release.graph.version
// first and fall back to the package's checklist version. Literals only; real temp config dir for the disk read.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { activeBoardVersion } from './current-version.js';

const dir = mkdtempSync(join(tmpdir(), 'active-board-version-'));
afterAll(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

describe('activeBoardVersion — the board «current» readers follow the release in play', () => {
  test('config 0.3.38 + package dev 0.3.37 → 0.3.38', () => {
    expect(activeBoardVersion(() => '0.3.38', () => '0.3.37')).toBe('0.3.38');
  });
  test('no graph target → package fallback 0.3.37', () => {
    expect(activeBoardVersion(() => null, () => '0.3.37')).toBe('0.3.37');
  });
  test('graph read throws → package fallback, never a throw', () => {
    expect(activeBoardVersion(() => { throw new Error('EACCES'); }, () => '0.3.37')).toBe('0.3.37');
  });
  test('default reader: config.json release.graph.version 0.3.38 on disk wins over the package fallback 0.3.37', () => {
    setElanousConfigDir(dir, 'programmatic');
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ release: { graph: { mode: 'live', version: '0.3.38' } } })}\n`);
    expect(activeBoardVersion(undefined, () => '0.3.37')).toBe('0.3.38');
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ release: { graph: { mode: 'live' } } })}\n`);
    expect(activeBoardVersion(undefined, () => '0.3.37')).toBe('0.3.37');
  });
});
