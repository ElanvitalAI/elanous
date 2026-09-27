import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineConfigPath } from './machine-name.js';
import { readMachineProfile, seatRank, writeMachineProfile } from './machine-profile.js';

test('legacy machine reads as id; atomic profile writes mode 0600 and validates ranks and names', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-profile-'));
  try {
    mkdirSync(join(root, 'control'));
    writeFileSync(machineConfigPath(root), '{"machine":"mbp"}');
    expect(readMachineProfile(root)).toEqual({ id: 'mbp', duties: [], seats: {} });
    writeFileSync(machineConfigPath(root), '{"id":"invalid!","machine":"mbp"}');
    expect(readMachineProfile(root)).toBeUndefined();
    writeFileSync(machineConfigPath(root), '{"machine":"mbp"}');
    const profile = { id: 'node-b', duties: ['compute', 'character'], seats: { control: { rank: 2 } } };
    writeMachineProfile(profile, root);
    expect(readMachineProfile(root)).toEqual(profile);
    expect(seatRank(readMachineProfile(root), 'control')).toBe(2);
    expect(seatRank(readMachineProfile(root), 'bot-core')).toBeUndefined();
    expect(statSync(machineConfigPath(root)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(machineConfigPath(root), 'utf8'))).toEqual(profile);
    expect(() => writeMachineProfile({ ...profile, seats: { control: { rank: 100 } } }, root)).toThrow('invalid machine profile');
    expect(readMachineProfile(root)).toEqual(profile);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
