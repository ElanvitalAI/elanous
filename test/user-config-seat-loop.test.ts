import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

const root = mkdtempSync(join(tmpdir(), 'user-config-seat-loop-'));
const path = join(root, 'config.json');
const base = { mode: 'off' as const, seats: ['MK'], podPool: 'pool-node-b@node-b:8', questions: 'shadow' as const };
function parse(loops: unknown) {
  writeFileSync(path, JSON.stringify({ loops }));
  return buildUserConfig(path).loops;
}
afterEach(() => rmSync(path, { force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('absent file and absent seat default to off while steward defaults to shadow', () => {
  expect(buildUserConfig(path).loops).toEqual({ steward: { mode: 'shadow' }, persona: { enabled: false }, seat: base });
  expect(parse(undefined)).toEqual({ steward: { mode: 'shadow' }, persona: { enabled: false }, seat: base });
  expect(parse({})).toEqual({ steward: { mode: 'shadow' }, persona: { enabled: false }, seat: base });
});

test('seat accepts the three explicit modes', () => {
  for (const mode of ['off', 'shadow', 'on'] as const) {
    expect(parse({ seat: { mode } })?.seat).toEqual({ ...base, mode });
  }
});

test('invalid seat mode or shape cannot arm the loop', () => {
  for (const seat of [{ mode: 'act' }, { mode: 'ON' }, { mode: true }, { mode: null }, {}, null, [], 'on']) {
    expect(parse({ seat })?.seat).toEqual(base);
  }
  expect(parse(null)?.seat).toEqual(base);
});

test('seat parsing preserves steward normalization independently', () => {
  const steward = { mode: 'live', linearTeam: ' team ', roles: { OP: { maxConcurrent: 2 } }, budget: 3, tracks: { OP: ' Operations ' }, alertAfterFailures: 4 };
  const expected = { mode: 'live', linearTeam: 'team', roles: { OP: { maxConcurrent: 2 } }, budget: 3, tracks: { OP: 'Operations' }, alertAfterFailures: 4 } as const;
  expect(parse({ steward })?.steward).toEqual(expected);
  expect(parse({ steward, seat: { mode: 'shadow' } })).toEqual({ steward: expected, persona: { enabled: false }, seat: { ...base, mode: 'shadow' } });
  expect(parse({ steward, seat: { mode: 'invalid' } })).toEqual({ steward: expected, persona: { enabled: false }, seat: base });
  expect(parse({ seat: { mode: 'on' }, steward: null })).toEqual({ steward: { mode: 'shadow' }, persona: { enabled: false }, seat: { ...base, mode: 'on' } });
});

test('steward mode accepts only off, shadow, live and defaults invalid values to shadow', () => {
  for (const mode of ['off', 'shadow', 'live'] as const) {
    expect(parse({ steward: { mode } })?.steward?.mode).toBe(mode);
  }
  for (const mode of ['observe', 'act', 'LIVE', '', true, null, 42]) {
    expect(parse({ steward: { mode } })?.steward?.mode).toBe('shadow');
  }
  for (const steward of [null, [], 'live']) {
    expect(parse({ steward })?.steward?.mode).toBe('shadow');
  }
});

test('seat fields persist through save while steward and unknown loop keys survive', () => {
  writeFileSync(path, JSON.stringify({ loops: {
    steward: { mode: 'act', linearTeam: ' team ', futureSteward: 'keep' },
    futureLoop: { enabled: true }, seat: { mode: 'shadow', unused: 'drop' },
  } }));
  const cfg = buildUserConfig(path);
  cfg.loops!.seat = { mode: 'on', seats: ['TC'], podPool: 'pool-x', reportPr: 12 };
  saveUserConfig(cfg, path);
  const saved = JSON.parse(readFileSync(path, 'utf8')).loops;
  expect(saved).toEqual({ steward: { mode: 'shadow', linearTeam: ' team ', futureSteward: 'keep' }, futureLoop: { enabled: true }, seat: { ...cfg.loops!.seat, questions: 'shadow' } });
  expect(buildUserConfig(path).loops).toEqual({ steward: { mode: 'shadow', linearTeam: 'team' }, persona: { enabled: false }, seat: { ...cfg.loops!.seat, questions: 'shadow' } });
  const typed = buildUserConfig(path);
  typed.loops!.steward!.mode = 'off';
  saveUserConfig(typed, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).loops.steward.mode).toBe('off');
});

test('partial config save without cfg.loops preserves raw steward and unknown loop keys', () => {
  const loops = { steward: { mode: 'act', linearTeam: ' team ', futureSteward: 'keep' }, futureLoop: { enabled: true }, seat: { mode: 'shadow', unused: 'keep' } };
  writeFileSync(path, JSON.stringify({ loops }));
  const cfg = buildUserConfig(path);
  cfg.loops = undefined;
  saveUserConfig(cfg, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).loops).toEqual(loops);
  expect(buildUserConfig(path).loops).toEqual({ steward: { mode: 'shadow', linearTeam: 'team' }, persona: { enabled: false }, seat: { ...base, mode: 'shadow' } });
});

test('saving typed steward mode preserves unrelated steward and loop keys', () => {
  writeFileSync(path, JSON.stringify({ loops: {
    steward: { mode: 'off', linearTeam: 'ELA', launch: 'shadow', futureSteward: 'keep' },
    futureLoop: { enabled: true },
  } }));
  const cfg = buildUserConfig(path);
  cfg.loops!.steward!.mode = 'live';
  saveUserConfig(cfg, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).loops).toEqual({
    steward: { mode: 'live', linearTeam: 'ELA', launch: 'shadow', futureSteward: 'keep' },
    futureLoop: { enabled: true },
    seat: base,
  });
  expect(buildUserConfig(path).loops?.steward).toEqual({ mode: 'live', linearTeam: 'ELA', launch: 'shadow' });
});

test('invalid seat parameters cannot enable new seats, and valid values normalize', () => {
  expect(parse({ seat: { mode: 'on', seats: ['TC', 'UX'], podPool: ' custom ', reportPr: 16815 } })?.seat)
    .toEqual({ mode: 'on', seats: ['TC', 'UX'], podPool: 'custom', reportPr: 16815, questions: 'shadow' });
  expect(parse({ seat: { mode: 'ON', seats: ['bad'], podPool: '', reportPr: -1 } })?.seat).toEqual(base);
});
