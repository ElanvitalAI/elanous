import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstalledIdentity } from './self-update.js';

describe('run-origin installed build', () => {
  test('install.json version and commit are the fields run-origin records, or unknown when unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-run-origin-'));
    try {
      expect(readInstalledIdentity(root)).toEqual({ installedVersion: 'unknown', installedCommit: 'unknown' });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.16-dev.0', commit: 'abcdef123456', channel: 'dev' }));
      expect(readInstalledIdentity(root)).toEqual({ installedVersion: '0.2.16-dev.0', installedCommit: 'abcdef123456' });
      writeFileSync(join(root, 'install.json'), '{');
      expect(readInstalledIdentity(root)).toEqual({ installedVersion: 'unknown', installedCommit: 'unknown' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
