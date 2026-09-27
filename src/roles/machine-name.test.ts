import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineConfigPath, resolveMachineName, writeConfiguredMachine } from './machine-name.js';
import { readMachineProfile, writeMachineProfile } from './machine-profile.js';

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'machine-name-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const noJoin = () => undefined;

describe('resolveMachineName', () => {
  test('macOS hostname falls back lowercased instead of failing the lease rule', () => withRoot((root) => {
    expect(resolveMachineName({ root, host: 'MacBookProM5.local', readJoinMachine: noJoin })).toEqual({ machine: 'macbookprom5', source: 'hostname' });
  }));
  test('explicit config wins over hostname and join', () => withRoot((root) => {
    writeConfiguredMachine('mbp', root);
    expect(statSync(machineConfigPath(root)).mode & 0o777).toBe(0o600);
    expect(resolveMachineName({ root, host: 'MacBookProM5', readJoinMachine: () => 'node-b' })).toEqual({ machine: 'mbp', source: 'config' });
  }));
  test('set-machine changes id without erasing configured duties and seats', () => withRoot((root) => {
    writeMachineProfile({ id: 'first', duties: ['compute'], seats: { control: { rank: 3 } } }, root);
    writeConfiguredMachine('second', root);
    expect(readMachineProfile(root)).toEqual({ id: 'second', duties: ['compute'], seats: { control: { rank: 3 } } });
    expect(resolveMachineName({ root, readJoinMachine: noJoin })).toEqual({ machine: 'second', source: 'config' });
  }));
  test('joined machine with stale conflicting profile cannot become lease owner', () => withRoot((root) => {
    mkdirSync(join(root, 'control'), { recursive: true });
    writeFileSync(join(root, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'node-b', token: 'a'.repeat(64) }), { mode: 0o600 });
    writeFileSync(machineConfigPath(root), JSON.stringify({ id: 'demo', duties: ['compute'], seats: { control: { rank: 1 } } }));
    expect(() => resolveMachineName({ root })).toThrow('machine id demo differs from joined machine node-b');
    expect(() => writeConfiguredMachine('demo', root)).toThrow('machine id demo differs from joined machine node-b');
  }));
  test('valid joined identity is used when no config; invalid join is rejected rather than becoming a different hostname', () => withRoot((root) => {
    expect(resolveMachineName({ root, host: 'MacStudioB1', readJoinMachine: () => 'node-b' })).toEqual({ machine: 'node-b', source: 'join' });
    expect(() => resolveMachineName({ root, host: 'MacStudioB1', readJoinMachine: () => 'MSB1' })).toThrow('invalid joined machine id: MSB1');
  }));
  test('mixed-case joined identity cannot be silently lowercased to another registry identity', () => withRoot((root) => {
    mkdirSync(join(root, 'control'), { recursive: true });
    writeFileSync(join(root, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'MSB1', token: 'a'.repeat(64) }), { mode: 0o600 });
    expect(() => writeConfiguredMachine('node-b', root)).toThrow('machine id node-b differs from joined machine MSB1');
    writeFileSync(machineConfigPath(root), JSON.stringify({ id: 'node-b', duties: [], seats: {} }));
    expect(() => resolveMachineName({ root })).toThrow('machine id node-b differs from joined machine MSB1');
  }));
  test('option wins over everything', () => withRoot((root) => {
    writeConfiguredMachine('mbp', root);
    expect(resolveMachineName({ root, option: 'node-b', readJoinMachine: noJoin }).machine).toBe('node-b');
  }));
  test('damaged or invalid config falls through', () => withRoot((root) => {
    mkdirSync(join(root, 'control'), { recursive: true });
    writeFileSync(machineConfigPath(root), '{"machine":"Bad Name"}');
    expect(resolveMachineName({ root, host: 'h', readJoinMachine: noJoin }).source).toBe('hostname');
    expect(() => writeConfiguredMachine('MacBookProM5', root)).toThrow('invalid machine');
  }));
});
