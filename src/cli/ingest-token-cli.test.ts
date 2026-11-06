import { expect, test, spyOn } from 'bun:test';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { registerIngestTokenCommands } from './ingest-token-cli.js';
import { withIsolatedElanousRoot } from '../../test/helpers/with-test-home.js';

test('nexus ingest-token issue prints only the one-time secret; list and revoke never print it', async () => {
  await withIsolatedElanousRoot(async () => {
    const program = new Command();
    program.exitOverride();
    const nexus = program.command('nexus');
    registerIngestTokenCommands(nexus);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
    try {
      await program.parseAsync(['nexus', 'ingest-token', 'issue', 'gateway'], { from: 'user' });
      const secret = stdout.join('').trim();
      expect(stdout).toEqual([`${secret}\n`]);
      expect(secret.length).toBeGreaterThan(30);
      expect(readFileSync(join(effectiveInstanceRoot(), 'nexus', 'ingest-tokens.json'), 'utf8')).not.toContain(secret);
      stdout.length = 0;
      await program.parseAsync(['nexus', 'ingest-token', 'list'], { from: 'user' });
      expect(stdout.join('')).toContain('gateway\t');
      expect(stdout.join('')).not.toContain(secret);
      stdout.length = 0;
      await program.parseAsync(['nexus', 'ingest-token', 'revoke', 'gateway'], { from: 'user' });
      expect(stdout).toEqual([]);
      await program.parseAsync(['nexus', 'ingest-token', 'list'], { from: 'user' });
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
    } finally { write.mockRestore(); error.mockRestore(); }
  });
});
