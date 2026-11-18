import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { scopeStopBootRows } from '../cli/seat-cli.js';
import { scopeStopWarnings } from './stop-expiry.js';

const NOW = new Date('2026-11-17T18:00:00.000Z');

describe('SCOPE-STOP-EXPIRY', () => {
  test('a STOP line without an expiry instant warns', () => {
    const warnings = scopeStopWarnings([{
      seat: 'RES', path: 'seats/RES/SCOPE.md',
      text: '# STOP\nA37 work stops now. No expiry on this line.\n',
    }], NOW);
    expect(warnings).toEqual([{ seat: 'RES', path: 'seats/RES/SCOPE.md', reason: 'missing-expiry' }]);
  });

  test('a STOP whose expiry is already past warns once', () => {
    const warnings = scopeStopWarnings([{
      seat: 'RES', path: 'seats/RES/SCOPE.md',
      text: 'STOP A37: expires: 2026-11-17T00:00:00Z\n',
    }], NOW);
    expect(warnings).toEqual([{
      seat: 'RES', path: 'seats/RES/SCOPE.md', reason: 'expired', expiresAt: '2026-11-17T00:00:00Z',
    }]);
  });

  test('markdown STOP forms warn, and a lowercase second branch does not', () => {
    const forms = [
      '## STOP A37 work holds',
      '- STOP A37 work holds',
      '**STOP** A37 work holds',
      '**STOP A37** work holds',
    ];
    for (const text of forms) {
      expect(scopeStopWarnings([{ seat: 'RES', path: 'seats/RES/SCOPE.md', text: `${text}\n` }], NOW))
        .toEqual([{ seat: 'RES', path: 'seats/RES/SCOPE.md', reason: 'missing-expiry' }]);
    }
    const quiet = scopeStopWarnings([
      { seat: 'RES', path: 'seats/RES/SCOPE.md', text: 'A37 work stops now.\n' },
      { seat: 'OP', path: 'seats/OP/SCOPE.md', text: '## Stop conditions are not a hold.\n' },
    ], NOW);
    expect(quiet).toEqual([]);
  });

  test('ordinary words containing stop are not a STOP, and a timezone expiry is read', () => {
    const warnings = scopeStopWarnings([
      { seat: 'RES', path: 'seats/RES/SCOPE.md', text: 'Stop conditions and a Stopwatch are not a STOP.\n' },
      { seat: 'OP', path: 'seats/OP/SCOPE.md', text: 'STOP A37 expires: 2026-11-18T12:00:00+09:00\n' },
    ], NOW);
    expect(warnings).toEqual([]);
  });

  test('a marked expiry that is not an instant is unrecognized, not missing', () => {
    const warnings = scopeStopWarnings([{
      seat: 'RES', path: 'seats/RES/SCOPE.md', text: 'STOP A37 expires: tomorrow\n',
    }], NOW);
    expect(warnings).toEqual([{ seat: 'RES', path: 'seats/RES/SCOPE.md', reason: 'unrecognized-expiry' }]);
  });

  test('a STOP that has not expired is silent, and a file without STOP is silent', () => {
    const warnings = scopeStopWarnings([
      { seat: 'RES', path: 'seats/RES/SCOPE.md', text: 'STOP A37 expires: 2026-11-18T00:00:00Z\n' },
      { seat: 'OP', path: 'seats/OP/SCOPE.md', text: 'ordinary scope, no stop instruction\n' },
    ], NOW);
    expect(warnings).toEqual([]);
  });

  test('boot rows warn on a missing expiry and stay quiet when the expiry is still ahead', () => {
    const home = mkdtempSync(join(tmpdir(), 'scope-stop-'));
    const seatDir = join(home, 'elanous-hq', 'seats', 'RES');
    mkdirSync(seatDir, { recursive: true });
    const path = join(seatDir, 'SCOPE.md');
    try {
      writeFileSync(path, 'STOP A37 work stops now\n');
      const missing = scopeStopBootRows(home, 'RES', NOW);
      expect(missing.rows).toEqual(['STOP 만료 시각 없음 — 경고, 침묵 보류 아님']);
      writeFileSync(path, 'STOP A37 expires: tomorrow\n');
      const unrecognized = scopeStopBootRows(home, 'RES', NOW);
      expect(unrecognized.rows).toEqual(['STOP 만료 형식 미인식 — 경고, 침묵 보류 아님']);
      writeFileSync(path, 'STOP A37 expires: 2026-11-18T00:00:00Z\n');
      const ahead = scopeStopBootRows(home, 'RES', NOW);
      expect(ahead.rows).toEqual([]);
      expect(ahead.reason).toBe('STOP 없음 또는 미만료');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
