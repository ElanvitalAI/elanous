import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist, parseOwner } from '../release-loop/checklist.js';
import { registerReleaseCommands } from './release-cli.js';

test('release checklist claim accepts manual seats, wildcard buckets, and legacy seat syntax', async () => {
  expect(parseOwner('TC-1')).toEqual({ seat: 'TC-1' });
  expect(parseOwner('MVP-D/rel')).toEqual({ seat: 'MVP-D', sub: 'rel' });
  expect(parseOwner('TC/rel')).toEqual({ seat: 'TC', sub: 'rel' });
  const dir = mkdtempSync(join(tmpdir(), 'release-manual-seat-claim-'));
  setElanousConfigDir(dir);
  const run = async (...args: string[]) => {
    const command = new Command();
    registerReleaseCommands(command);
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  try {
    const seats = ['MVP-D', 'MVP-*', 'NM-*', 'NT-*', 'GATE-G'];
    for (const [index, seat] of seats.entries()) {
      const id = `M${index + 1}`;
      await run('add', id, 'manual work', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    for (const [id, seat] of [['M7', 'MVP-D/rel'], ['M8', 'TC-1']] as const) {
      await run('add', id, 'compatible seat syntax', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    await run('add', 'M6', 'invalid manual label', '--owner', 'OP');
    for (const invalid of ['MVP-D-EXTRA', 'MVP-**', 'MVP-']) {
      await expect(run('claim', 'M6', '--by', invalid, '--force')).rejects.toThrow('잘못된 담당');
    }
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'M6')?.owner).toBe('OP');
  } finally {
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});
