import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPtySidetabRegistrations, registerPtySidetabEntry, setPtyManifestDbPathForTesting, unregisterPtySidetabEntry } from './pty-manifest.js';

const dirs: string[] = [];
afterEach(() => {
  setPtyManifestDbPathForTesting(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('explicit remote sidetab registration', () => {
  test('records who, host, display name, and registration time, then unregisters by exact PTY id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-sidetab-registration-'));
    dirs.push(dir);
    setPtyManifestDbPathForTesting(join(dir, 'manifest.db'));

    expect(registerPtySidetabEntry({
      ptyId: 'tui:42', host: 'node-b', name: 'research', registeredBy: 'OP', registeredAt: 1234,
    })).toBe(true);
    expect(listPtySidetabRegistrations()).toEqual([{
      ptyId: 'tui:42', host: 'node-b', name: 'research', registeredBy: 'OP', registeredAt: 1234,
    }]);
    expect(unregisterPtySidetabEntry('tui:42')).toBe(true);
    expect(unregisterPtySidetabEntry('tui:42')).toBe(false);
    expect(listPtySidetabRegistrations()).toEqual([]);
  });

  test('rejects an invalid host or incomplete human registration record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-sidetab-registration-'));
    dirs.push(dir);
    setPtyManifestDbPathForTesting(join(dir, 'manifest.db'));

    expect(registerPtySidetabEntry({ ptyId: 'tui:42', host: 'bad host', name: 'research', registeredBy: 'OP', registeredAt: 1234 })).toBe(false);
    expect(registerPtySidetabEntry({ ptyId: 'tui:42', host: 'node-b', name: '', registeredBy: 'OP', registeredAt: 1234 })).toBe(false);
    expect(listPtySidetabRegistrations()).toEqual([]);
  });
});
