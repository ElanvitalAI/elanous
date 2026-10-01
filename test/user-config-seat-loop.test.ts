import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

const root = mkdtempSync(join(tmpdir(), 'user-config-seat-loop-'));
const path = join(root, 'config.json');

function parse(loops: unknown) {
  writeFileSync(path, JSON.stringify({ loops }));
  return buildUserConfig(path).loops;
}

afterEach(() => rmSync(path, { force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('absent file and absent seat default to off without a steward', () => {
  expect(buildUserConfig(path).loops).toEqual({ seat: { mode: 'off' } });
  expect(parse(undefined)).toEqual({ seat: { mode: 'off' } });
  expect(parse({})).toEqual({ seat: { mode: 'off' } });
});

test('seat accepts the three explicit modes', () => {
  for (const mode of ['off', 'shadow', 'on'] as const) {
    expect(parse({ seat: { mode } })?.seat).toEqual({ mode });
  }
});

test('invalid seat mode or shape cannot arm the loop', () => {
  for (const seat of [{ mode: 'act' }, { mode: 'ON' }, { mode: true }, { mode: null }, {}, null, [], 'on']) {
    expect(parse({ seat })?.seat).toEqual({ mode: 'off' });
  }
  expect(parse(null)?.seat).toEqual({ mode: 'off' });
});

test('seat parsing preserves steward normalization independently', () => {
  const steward = {
    mode: 'act', linearTeam: ' team ', roles: { OP: { maxConcurrent: 2 } },
    budget: 3, tracks: { OP: ' Operations ' }, alertAfterFailures: 4,
  };
  const expected = {
    mode: 'act', linearTeam: 'team', roles: { OP: { maxConcurrent: 2 } },
    budget: 3, tracks: { OP: 'Operations' }, alertAfterFailures: 4,
  } as const;
  expect(parse({ steward })?.steward).toEqual(expected);
  expect(parse({ steward, seat: { mode: 'shadow' } })).toEqual({ steward: expected, seat: { mode: 'shadow' } });
  expect(parse({ steward, seat: { mode: 'invalid' } })).toEqual({ steward: expected, seat: { mode: 'off' } });
  expect(parse({ seat: { mode: 'on' }, steward: null })).toEqual({ seat: { mode: 'on' } });
});

test('seat mode persists through save while steward and unknown loop keys survive', () => {
  writeFileSync(path, JSON.stringify({ loops: {
    steward: { mode: 'act', linearTeam: ' team ', futureSteward: 'keep' },
    futureLoop: { enabled: true }, seat: { mode: 'shadow', unused: 'drop' },
  } }));
  const cfg = buildUserConfig(path);
  cfg.loops!.seat = { mode: 'on' };
  saveUserConfig(cfg, path);
  const saved = JSON.parse(readFileSync(path, 'utf8')).loops;
  expect(saved).toEqual({
    steward: { mode: 'act', linearTeam: ' team ', futureSteward: 'keep' },
    futureLoop: { enabled: true }, seat: { mode: 'on' },
  });
  expect(buildUserConfig(path).loops).toEqual({
    steward: { mode: 'act', linearTeam: 'team' }, seat: { mode: 'on' },
  });
  const typed = buildUserConfig(path);
  typed.loops!.steward!.mode = 'observe';
  saveUserConfig(typed, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).loops.steward.mode).toBe('act');
});

test('partial config save without cfg.loops preserves raw steward and unknown loop keys', () => {
  const loops = {
    steward: { mode: 'act', linearTeam: ' team ', futureSteward: 'keep' },
    futureLoop: { enabled: true },
    seat: { mode: 'shadow', unused: 'keep' },
  };
  writeFileSync(path, JSON.stringify({ loops }));
  const cfg = buildUserConfig(path);
  cfg.loops = undefined;
  saveUserConfig(cfg, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).loops).toEqual(loops);
  expect(buildUserConfig(path).loops).toEqual({
    steward: { mode: 'act', linearTeam: 'team' }, seat: { mode: 'shadow' },
  });
});
