import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createMemberCloudBackupRoute } from '../nexus/members/member-cloud-backup-route.js';
import { registerSecretBackupCommands } from './secret-backup-cli.js';

test('eln secret backup push, status and restore use member session and local identity without printing values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-command-'));
  const store = createMemberStore({ path: join(dir, 'members.sqlite') });
  const route = createMemberCloudBackupRoute({ memberStore: store, dbPath: join(dir, 'backups.sqlite') });
  try {
    const profile = store.register({ sub: 'synthetic-cli', email: 'cli@example.test', emailVerified: true,
      name: 'CLI' }, { consents: { privacy: 'v1', terms: 'v1' } });
    const session = store.createSession(profile.id, '2026-11-14T00:00:00Z').token;
    const sessionFile = join(dir, 'session');
    const identityFile = join(dir, 'identity');
    writeFileSync(sessionFile, session, { mode: 0o600 });
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const run = async (operation: 'push' | 'status' | 'restore') => {
      const program = new Command();
      const secret = program.command('secret');
      registerSecretBackupCommands(secret, {
        initializeBackend: () => {},
        output: { log: line => logs.push(line), error: line => errors.push(line) },
        setExitCode: code => exits.push(code),
        listSecrets: async () => ['OPENAI_API_KEY'],
        getSecret: async () => 'SYNTHETIC-COMMAND-KEY',
        importSecrets: async () => ({ imported: true, conflicts: [], changedSinceConfirmation: false }),
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await route.handle(new Request(input, init));
          if (!response) throw new Error('fake route not handled');
          return response;
        }) as typeof fetch,
      });
      await program.parseAsync(['secret', 'backup', operation, '--url', 'https://api.example.test',
        '--session-file', sessionFile, '--identity-file', identityFile], { from: 'user' });
    };
    await run('push');
    await run('status');
    await run('restore');
    expect(exits).toEqual([0, 0, 0]);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('generation=1');
    expect(logs.join('\n')).toContain('restored\t1');
    expect(logs.join('\n')).not.toContain('SYNTHETIC-COMMAND-KEY');
  } finally { route.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
