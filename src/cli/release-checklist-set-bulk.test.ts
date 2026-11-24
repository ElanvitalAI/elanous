import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { registerReleaseChecklistSetCommand } from './release-checklist-set-cli.js';
import { registerReleaseCommands } from './release-cli.js';

test('bulk set updates three cells atomically in both CLI entrances', async () => {
  for (const register of [registerReleaseChecklistSetCommand, registerReleaseCommands]) {
    const root = mkdtempSync(join(tmpdir(), 'checklist-set-bulk-'));
    setElanousConfigDir(root);
    try {
      for (const id of ['A', 'B', 'C']) addItem('9.9.9', { id, title: id });
      const run = async (...args: string[]) => {
        const program = new Command();
        program.exitOverride();
        register(program);
        await program.parseAsync(['release', 'checklist', 'set', ...args, '--version', '9.9.9'], { from: 'user' });
      };
      await run('A', 'B', 'C', '--priority', 'P1', '--owner', 'TC', '--status', 'red');
      const before = listChecklist('9.9.9');
      expect(before.items.map(({ id, priority, owner, status }) => ({ id, priority, owner, status })))
        .toEqual(['A', 'B', 'C'].map(id => ({ id, priority: 'P1', owner: 'TC', status: 'red' })));
      await expect(run('A', 'MISSING', 'C', '--priority', 'P0')).rejects.toThrow('없는 칸: MISSING');
      const after = listChecklist('9.9.9');
      expect(after.items).toEqual(before.items);
      expect(after.history).toEqual(before.history);
      await expect(run('A', 'B', '--owner', 'UX')).rejects.toThrow('지금 주인: TC');
      expect(listChecklist('9.9.9').items).toEqual(before.items);
    } finally {
      resetElanousConfigDir();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
