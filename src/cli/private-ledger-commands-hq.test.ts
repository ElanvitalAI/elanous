import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileLeaseStore, serializeLease } from '../hq/lease.js';
import { registerPrivateLedgerCommands } from './private-ledger-commands.js';
import { withIsolatedElanousRoot } from '../../test/helpers/with-test-home.js';

test('private ledger writers refuse a foreign HQ, while isolated instance writes and read-only commands remain usable', async () => {
  await withIsolatedElanousRoot(async (dir) => {
    const instance = dir;
  const outside = join(dirname(dir), `${basename(dir)}-outside`);
    const store = fileLeaseStore(join(dir, 'lease.json'), () => 100);
    const hq = { store, config: { hostName: 'mbp', standby: 'node-b' }, hostPath: join(dir, 'host'), localPath: join(dir, 'local.json'), seenPath: join(dir, 'seen-generation'), now: () => 100, log: (() => {}) as never };
    const oldExit = process.exitCode;
    const errors: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(store.cas(null, serializeLease({ holder: 'node-b', generation: 2, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }))).toBe(true);
      const cli = new Command();
      registerPrivateLedgerCommands(cli, hq);
      const run = (...args: string[]) => cli.parseAsync(args, { from: 'user' });
      // The private ledger target is inside a separate test instance; a foreign operational lease cannot block it.
      await run('claims', 'add', 'C1', '--claim', 'Claim', '--audience', 'owners', '--owner', 'OP');
      expect(existsSync(join(instance, 'claims', 'claims.sqlite'))).toBe(true);
      const external = new Command();
      registerPrivateLedgerCommands(external, hq, outside);
      const runOutside = (...args: string[]) => external.parseAsync(args, { from: 'user' });
      process.exitCode = 0;
      await runOutside('claims', 'add', 'C2', '--claim', 'Claim', '--audience', 'owners', '--owner', 'OP');
      expect(process.exitCode).toBe(4);
      expect(errors.at(-1)).toContain('원장 쓰기는 지금 본부로 보내라');
      expect(existsSync(join(outside, 'claims', 'claims.sqlite'))).toBe(false);
      process.exitCode = 0;
      await runOutside('lesson', 'add', 'L1', '--incident', 'Incident', '--cause', 'Cause', '--remedy', 'Remedy', '--owner', 'OP', '--source', 'incident');
      expect(process.exitCode).toBe(4);
      expect(existsSync(join(outside, 'lessons', 'lessons.sqlite'))).toBe(false);
      await runOutside('directives', 'sync');
      expect(process.exitCode).toBe(4);
      expect(existsSync(join(outside, 'directives', 'directives.db'))).toBe(false);
      await runOutside('claims', 'list');
      expect(process.exitCode).toBe(4);
      expect(existsSync(join(outside, 'claims', 'claims.sqlite'))).toBe(false);
      process.exitCode = 0;
      await runOutside('lesson', 'candidates');
      expect(process.exitCode).toBe(0);
    } finally {
      error.mockRestore(); output.mockRestore(); process.exitCode = oldExit ?? 0;
    rmSync(outside, { recursive: true, force: true });
    }
  });
});
