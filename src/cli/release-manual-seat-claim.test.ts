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
  expect(parseOwner('MVP-A')).toEqual({ seat: 'MVP-A' });
  expect(parseOwner('MVP-Z')).toEqual({ seat: 'MVP-Z' });
  expect(parseOwner('TC/rel')).toEqual({ seat: 'TC', sub: 'rel' });
  const dir = mkdtempSync(join(tmpdir(), 'release-manual-seat-claim-'));
  setElanousConfigDir(dir);
  const run = async (...args: string[]) => {
    const command = new Command();
    registerReleaseCommands(command);
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  const previousTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'OP';
  try {
    const seats = ['MVP-D', 'MVP-Z', 'MVP-*', 'NM-*', 'NT-*', 'GATE-G'];
    for (const [index, seat] of seats.entries()) {
      const id = `M${index + 1}`;
      await run('add', id, 'manual work', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force', '--reason', 'OP test reassignment');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    for (const [id, seat] of [['M7', 'MVP-D/rel'], ['M8', 'TC-1']] as const) {
      await run('add', id, 'compatible seat syntax', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force', '--reason', 'OP test reassignment');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    await run('add', 'MI', 'invalid manual label', '--owner', 'OP');
    for (const invalid of ['MVP-D-EXTRA', 'MVP-**', 'MVP-']) {
      await expect(run('claim', 'MI', '--by', invalid)).rejects.toThrow('잘못된 담당');
    }
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'MI')?.owner).toBe('OP');
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previousTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('incident simulation: only the current cell owner may delegate and only OP may force-reassign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-claim-authorization-sim-'));
  const previousTrack = process.env.ELANOUS_TRACK;
  setElanousConfigDir(dir);
  const runAs = async (seat: string, ...args: string[]) => {
    process.env.ELANOUS_TRACK = seat;
    const command = new Command();
    registerReleaseCommands(command);
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  try {
    await runAs('TC', 'add', 'C1', 'owned cell', '--owner', 'TC');
    await runAs('TC', 'claim', 'C1', '--by', 'TC/rel');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');

    await expect(runAs('MVP-D', 'claim', 'C1', '--by', 'MVP-D'))
      .rejects.toThrow(/칸 주인 또는 OP만 claim/);
    await expect(runAs('OP/rel', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'subseat cannot sign'))
      .rejects.toThrow(/OP 서명/);
    await expect(runAs('MVP-D', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'simulation authorization'))
      .rejects.toThrow(/OP|서명/);
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');

    await expect(runAs('OP', 'claim', 'C1', '--by', 'MVP-D', '--force')).rejects.toThrow(/--reason/);
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');
    await runAs('OP', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'OP simulation approval');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('MVP-D');
    expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ by: 'OP', from: 'TC/rel', to: 'MVP-D', force: true, reason: 'OP simulation approval' });

    await runAs('TC', 'add', 'C2', 'delegation cell', '--owner', 'TC');
    await runAs('TC', 'claim', 'C2', '--by', 'MVP-D');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C2')?.owner).toBe('MVP-D');
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK;
    else process.env.ELANOUS_TRACK = previousTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});
