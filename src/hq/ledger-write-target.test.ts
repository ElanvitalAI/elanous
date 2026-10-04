import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIsolatedLedgerWriteRoot } from './ledger-write-target.js';

test('only writes into the isolated instance ledger bypass the operational HQ lease', () => {
  const base = mkdtempSync(join(tmpdir(), 'hq-ledger-target-'));
  try {
    const prod = join(base, 'operational');
    const isolated = join(base, 'universe');
    const other = join(base, 'other');
    mkdirSync(prod);
    mkdirSync(isolated);
    mkdirSync(other);
    expect(isIsolatedLedgerWriteRoot(isolated, isolated, prod)).toBe(true);
    expect(isIsolatedLedgerWriteRoot(join(isolated, 'release'), isolated, prod)).toBe(true);
    expect(isIsolatedLedgerWriteRoot(prod, isolated, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(prod, 'release'), isolated, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(other, 'release'), isolated, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(isolated, '..', 'operational'), isolated, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(base, 'universe-copy'), isolated, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(prod, prod, prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(prod, 'release'), join(prod, 'tests'), prod)).toBe(false);
    expect(isIsolatedLedgerWriteRoot(join(prod, 'tests', 'release'), join(prod, 'tests'), prod)).toBe(false);
    symlinkSync(prod, join(isolated, 'alias-to-prod'));
    expect(isIsolatedLedgerWriteRoot(join(isolated, 'alias-to-prod', 'release'), isolated, prod)).toBe(false);
    mkdirSync(join(prod, 'child'));
    symlinkSync(join(prod, 'child'), join(isolated, 'alias-to-prod-child'));
    // Keep the raw traversal: path.join() would erase the '..' before the filesystem sees the link.
    expect(isIsolatedLedgerWriteRoot(`${isolated}/alias-to-prod-child/../release`, isolated, prod)).toBe(false);
    mkdirSync(join(isolated, 'child'));
    symlinkSync(join(isolated, 'child'), join(base, 'alias-to-isolated-child'));
    expect(isIsolatedLedgerWriteRoot(`${base}/alias-to-isolated-child/../release`, isolated, prod)).toBe(true);
    symlinkSync(isolated, join(base, 'alias-to-isolated'));
    expect(isIsolatedLedgerWriteRoot(join(base, 'alias-to-isolated', 'release'), isolated, prod)).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
