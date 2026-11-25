// STEWARD-SPACE config — `loops.stewardSpace` must survive the user-config reader (11-25 15:37: `eln config set
// loops.stewardSpace.scopes.TC.mode shadow` was written but every scope read `off`). Expected values are literals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../../user-config.js';
import { parseStewardSpaceConfig, resolveScope } from './config.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'steward-space-config-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loops.stewardSpace', () => {
  test('the user-config reader keeps the scope modes the CLI wrote', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ loops: { stewardSpace: { scopes: { TC: { mode: 'shadow' }, JUD: { mode: 'shadow' } } } } }));
    const config = buildUserConfig(path).loops?.stewardSpace;
    expect(config).toEqual({ scopes: { TC: { mode: 'shadow' }, JUD: { mode: 'shadow' } } });
    expect(resolveScope('TC', 'OP', config).mode).toBe('shadow');
    expect(resolveScope('JUD', 'OP', config).mode).toBe('shadow');
    expect(resolveScope('UX', 'OP', config).mode).toBe('off');
  });
  test('only well-typed fields survive; nothing valid = absent', () => {
    expect(parseStewardSpaceConfig({
      scopes: { tc: { mode: 'shadow', caps: { assign: 2, judge: 99 } }, 'bad scope': { mode: 'live' }, UX: { mode: 'loud' } },
      // 출처: #40086 fixture — invalid values (hostSlots 0 · '4pm') must be dropped, valid ones kept
      defaultMode: 'live?', pregateHosts: ['minim5', 3, ''], hostSlots: 0, maxLoadPerCore: 0.5, cutTimes: ['16:00', '4pm'], repo: ' o/r ',
      // 출처: #40086 fixture — the same literals as the input line above
    })).toEqual({ scopes: { TC: { mode: 'shadow', caps: { assign: 2 } } }, pregateHosts: ['minim5'], maxLoadPerCore: 0.5, cutTimes: ['16:00'], repo: 'o/r' });
    expect(parseStewardSpaceConfig(undefined)).toBeUndefined();
    expect(parseStewardSpaceConfig({ scopes: { TC: { mode: 'nope' } } })).toBeUndefined();
  });
});
