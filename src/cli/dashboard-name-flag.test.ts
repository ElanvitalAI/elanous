import { describe, expect, test } from 'bun:test';
import { readDashboardNameFlag } from './dashboard-name-flag.js';
import { readRemoteFlag } from './remote-resolve.js';

describe('readDashboardNameFlag', () => {
  test('strips --name <v> and --name=<v> from a bare dashboard launch', () => {
    expect(readDashboardNameFlag(['--name', 'op'])).toEqual({ args: [], name: 'op' });
    expect(readDashboardNameFlag(['--debug', '--name=op'])).toEqual({ args: ['--debug'], name: 'op' });
    expect(readDashboardNameFlag(['--resume', 's1', '--name', ' op '])).toEqual({ args: ['--resume', 's1'], name: 'op' });
  });

  test('leaves argv untouched when there is no flag or a subcommand leads', () => {
    expect(readDashboardNameFlag([])).toEqual({ args: [] });
    expect(readDashboardNameFlag(['--debug'])).toEqual({ args: ['--debug'] });
    expect(readDashboardNameFlag(['session', 'new', '--name', 'x'])).toEqual({ args: ['session', 'new', '--name', 'x'] });
    // 루트 플래그 뒤에 하위 명령이 오면 그 뒤 --name 은 하위 명령의 것이다(리뷰 must-fix).
    expect(readDashboardNameFlag(['--debug', 'session', 'new', '--name', 'x'])).toEqual({ args: ['--debug', 'session', 'new', '--name', 'x'] });
    expect(readDashboardNameFlag(['--resume', 's1', 'session', '--name', 'x'])).toEqual({ args: ['--resume', 's1', 'session', '--name', 'x'] });
    expect(readDashboardNameFlag(['--', '--name', 'x'])).toEqual({ args: ['--', '--name', 'x'] });
  });

  test('reports a missing or empty value instead of swallowing the next flag', () => {
    expect(readDashboardNameFlag(['--name'])).toMatchObject({ error: expect.stringContaining('--name needs a value') });
    expect(readDashboardNameFlag(['--name', '--debug'])).toMatchObject({ args: ['--debug'], error: expect.stringContaining('needs a value') });
    expect(readDashboardNameFlag(['--name=  '])).toMatchObject({ error: 'elanous: --name must not be empty' });
  });
});

test('--name value does not end the root flag run — a following -r is still the root remote flag', () => {
  expect(readRemoteFlag(['--name', 'op', '-r'])).toMatchObject({ present: true });
});
