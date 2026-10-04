import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { program } from './index.js';

const repo = join(import.meta.dir, '..');

function invoke(...args: string[]) {
  return spawnSync('bun', ['bin/elanous.mjs', '--test', 'seat', 'pack', 'export', ...args],
    { cwd: repo, encoding: 'utf8', timeout: 30_000 });
}

test('seat pack export is registered with required seat and out options', () => {
  const seat = program.commands.find((command) => command.name() === 'seat');
  const pack = seat?.commands.find((command) => command.name() === 'pack');
  const command = pack?.commands.find((child) => child.name() === 'export');
  expect(command?.options.filter((option) => option.required).map((option) => option.long)).toEqual(['--seat', '--out']);
  const help = invoke('--help');
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--seat <SEAT>');
  expect(help.stdout).toContain('--out <dir>');
}, 60_000);

test('seat pack export CLI rejects an actual leaking seat charter with exit 2 and file:line before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-pack-cli-'));
  const out = join(root, 'pack');
  try {
    const result = invoke('--seat', 'TC', '--out', out);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/docs\/roles\/TC\.md:\d+: public leak/);
    expect(existsSync(out)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
