// GRAPH-VERSION-FRESH (11-27 · after rail 77, 10 SEAT-ASSIGN mails still assigned 0.3.37 with release.graph.version
// 0.3.38): the typed getUserConfig() has no `release` section and a TUI turn reads a frozen snapshot. The target is read
// from config.json on every call — a stale snapshot and a changed file must not hide it. Real temp config dir.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { getUserConfig, runWithUserConfigSnapshot } from '../user-config/reader.js';
import { readReleaseGraphVersion, resolveCurrentVersion } from './current-version.js';

const dir = mkdtempSync(join(tmpdir(), 'graph-version-fresh-'));
afterAll(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

describe('release.graph.version is read fresh from config.json', () => {
  test('inside a stale scoped snapshot and after the file changes, the reader and resolveCurrentVersion see the disk value', () => {
    setElanousConfigDir(dir, 'programmatic');
    const write = (v: string) => writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ release: { graph: { mode: 'live', version: v } } })}\n`);
    write('0.3.37');
    const stale = getUserConfig(); // the snapshot a long turn froze before the version change
    expect((stale as { release?: unknown }).release).toBeUndefined(); // the typed config never carried it
    write('0.3.38');
    const hq = join(dir, 'hq'); mkdirSync(join(hq, 'seat-state', 'OP', 'plans'), { recursive: true });
    writeFileSync(join(hq, 'seat-state', 'OP', 'plans', 'PLAN-0.3.37.md'), '---\nstatus: current\n---\n# PLAN-0.3.37 — old\n');
    runWithUserConfigSnapshot(stale, () => {
      expect(readReleaseGraphVersion()).toBe('0.3.38');
      expect(resolveCurrentVersion({ hqRoot: hq, ledgerRoot: join(dir, 'ledger') })).toMatchObject({ version: '0.3.38', source: 'graph' });
    });
    write('not-a-version');
    expect(readReleaseGraphVersion()).toBe(null);
    expect(resolveCurrentVersion({ hqRoot: hq, ledgerRoot: join(dir, 'ledger') })).toMatchObject({ version: '0.3.37', source: 'plan' });
  });
  test('unreadable config → null (no guard), never a throw', () => {
    expect(readReleaseGraphVersion(() => { throw new Error('EACCES'); })).toBe(null);
    expect(readReleaseGraphVersion(() => ({ release: { graph: { version: ' 0.3.38 ' } } }))).toBe('0.3.38');
  });
});
