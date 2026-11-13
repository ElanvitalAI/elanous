import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptMigrationBundle } from './credentials-migration-bundle.js';
import { registerCredentialsMigrationCommands, writeBundleNoReplace, type CredentialMigrationReceipt, type CredentialsMigrationCliDeps } from './credentials-migration-cli.js';

const passphrase = 'test-only-long-passphrase';
function fixture(overrides: CredentialsMigrationCliDeps = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  const files = new Map<string, string>();
  const calls: string[] = [];
  const receipts: CredentialMigrationReceipt[] = [];
  const prompts = [passphrase, passphrase];
  const program = new Command();
  program.exitOverride();
  registerCredentialsMigrationCommands(program, {
    listSecrets: async () => ['exa', 'openai-codex'],
    getSecret: async (id) => { calls.push(`read:${id}`); return id === 'exa' ? 'fake-exa-value' : 'fake-refresh-value'; },
    readTelegram: () => ({ enabled: true, botToken: 'fake-telegram-value', homeChannel: -1001, allowedUsers: [42] }),
    promptSecret: async () => prompts.shift(),
    writeBundleFile: (path, contents) => { files.set(path, contents); },
    readBundleFile: (path) => files.get(path)!,
    initializeBackend: () => {}, isInteractive: () => true, hostName: () => 'mbp',
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => { codes.push(code); },
    recordReceipt: (receipt) => { receipts.push(receipt); },
    ...overrides,
  });
  return { program, output, errors, codes, files, calls, prompts, receipts };
}

async function parse(f: ReturnType<typeof fixture>, ...args: string[]): Promise<void> {
  await f.program.parseAsync(['node', 'eln', ...args]);
}

test('backup dry-run prints unknown destination and poller state without reading a value', async () => {
  const f = fixture();
  await parse(f, 'credentials', 'backup', '--to', '/tmp/unused', '--destination', 'mshq', '--dry-run');
  expect(f.codes).toEqual([0]);
  expect(f.calls).toEqual([]);
  expect(f.files.size).toBe(0);
  expect(f.receipts).toContainEqual(expect.objectContaining({ phase: 'backup-preflight', outcome: 'completed' }));
  expect(f.output.join('\n')).toContain('destination-state-unknown');
  expect(f.output.join('\n')).toContain('source-poller-unknown');
  expect(f.output.join('\n')).not.toContain('fake-telegram-value');
});

test('backup seals static and Telegram values; restore dry-run stays read-only and shows unknown source poller', async () => {
  const source = fixture();
  await parse(source, 'credentials', 'backup', '--to', '/tmp/backup', '--destination', 'mshq');
  expect(source.codes).toEqual([0]);
  expect(source.calls).toEqual(['read:exa']);
  expect(source.receipts).toContainEqual(expect.objectContaining({ phase: 'backup', outcome: 'completed', staticCount: 1 }));
  const sealed = source.files.get('/tmp/backup')!;
  expect(sealed).not.toContain('fake-exa-value');
  expect(sealed).not.toContain('fake-telegram-value');
  expect((await decryptMigrationBundle(sealed, passphrase)).staticSecrets).toEqual({ exa: 'fake-exa-value' });

  const destination = fixture({ hostName: () => 'mshq', listSecrets: async () => [],
    readTelegram: () => ({ enabled: false, allowedUsers: [] }), readBundleFile: () => sealed });
  await parse(destination, 'credentials', 'restore', '/tmp/backup', '--dry-run');
  expect(destination.calls).toEqual([]);
  expect(destination.codes).toEqual([0]);
  expect(destination.receipts).toContainEqual(expect.objectContaining({ phase: 'restore-preflight', outcome: 'completed' }));
  expect(destination.output.join('\n')).toContain('source-poller-unknown');
  expect(destination.output.join('\n')).not.toContain('fake-exa-value');
});

test('restore apply fails closed after preflight even when destination appears empty', async () => {
  const source = fixture();
  await parse(source, 'credentials', 'backup', '--to', '/tmp/backup', '--destination', 'mshq');
  const destination = fixture({ hostName: () => 'mshq', listSecrets: async () => [],
    readTelegram: () => ({ enabled: false, allowedUsers: [] }), readBundleFile: () => source.files.get('/tmp/backup')! });
  await parse(destination, 'credentials', 'restore', '/tmp/backup');
  expect(destination.codes).toEqual([1]);
  expect(destination.calls).toEqual([]);
  expect(destination.errors.join('\n')).toContain('apply unavailable');
  expect(destination.receipts).toContainEqual(expect.objectContaining({ phase: 'restore-apply', outcome: 'refused' }));
  expect(destination.errors.join('\n')).not.toContain('fake-exa-value');
});

test('noninteractive backup refuses before reading any secret value or Telegram config', async () => {
  let telegramReads = 0;
  const f = fixture({ isInteractive: () => false, readTelegram: () => { telegramReads++;
    return { enabled: false, botToken: 'fake-never-read', allowedUsers: [] }; } });
  await parse(f, 'credentials', 'backup', '--to', '/tmp/unused', '--destination', 'mshq');
  expect(f.codes).toEqual([1]);
  expect(f.calls).toEqual([]);
  expect(telegramReads).toBe(0);
  expect(f.files.size).toBe(0);
  expect(f.receipts).toEqual([{ phase: 'backup', outcome: 'failed' }]);
});

test('encrypted bundle writer creates 0600 file and never replaces an existing artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credentials-migration-'));
  try {
    const path = join(dir, 'backup.enc');
    writeBundleNoReplace(path, 'encrypted-only');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeBundleNoReplace(path, 'replacement')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('encrypted-only');
    expect(readdirSync(dir)).toEqual(['backup.enc']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('backup fails closed when a listed static value disappears before sealing', async () => {
  const f = fixture({ getSecret: async () => undefined });
  await parse(f, 'credentials', 'backup', '--to', '/tmp/missing', '--destination', 'mshq');
  expect(f.codes).toEqual([1]);
  expect(f.files.size).toBe(0);
  expect(f.errors.join('\n')).toContain('backup failed');
  expect(f.receipts).toContainEqual({ phase: 'backup', outcome: 'failed' });
});

test('actual CLI plan includes blocked Codex mirror and owner transfer plus Claude reissue', async () => {
  const f = fixture();
  await parse(f, 'credentials', 'backup', '--to', '/tmp/unused', '--destination', 'mshq', '--dry-run');
  const plan = f.output.join('\n');
  expect(plan).toContain('codex-access-mirror\toauth-access\taccess-mirror');
  expect(plan).toContain('codex-refresh-owner\tsingle-use-refresh\trelogin-and-transfer\tmbp -> mshq\towner-fence-missing');
  expect(plan).toContain('claude-setup-token\tsetup-token\treissue-on-destination\tmbp -> mshq\tsetup-token-reissue-required');
  expect(plan).not.toContain('fake-refresh-value');
});

test('source aliases and destination alias collision cannot be called a clean backup or restore plan', async () => {
  const aliases = fixture({ listSecrets: async () => ['exa', 'EXA_API_KEY'] });
  await parse(aliases, 'credentials', 'backup', '--to', '/tmp/aliases', '--destination', 'mshq');
  expect(aliases.codes).toEqual([1]);
  expect(aliases.files.size).toBe(0);

  const source = fixture();
  await parse(source, 'credentials', 'backup', '--to', '/tmp/backup', '--destination', 'mshq');
  const destination = fixture({ hostName: () => 'mshq', listSecrets: async () => ['EXA_API_KEY'],
    readTelegram: () => ({ enabled: false, allowedUsers: [] }), readBundleFile: () => source.files.get('/tmp/backup')! });
  await parse(destination, 'credentials', 'restore', '/tmp/backup', '--dry-run');
  expect(destination.output.join('\n')).toContain('exa\tstatic-key\tencrypted-restore\tmbp -> mshq\tdestination-conflict');

  const telegramAlias = fixture({ listSecrets: async () => ['ELANOUS_TELEGRAM_BOT_TOKEN'] });
  await parse(telegramAlias, 'credentials', 'backup', '--to', '/tmp/telegram-alias', '--destination', 'mshq');
  expect(telegramAlias.codes).toEqual([1]);
  expect(telegramAlias.files.size).toBe(0);

  const grouped = fixture({ listSecrets: async () => ['toss'], getSecret: async () => 'fake-group' });
  await parse(grouped, 'credentials', 'backup', '--to', '/tmp/grouped', '--destination', 'mshq');
  const groupedDestination = fixture({ hostName: () => 'mshq', listSecrets: async () => ['TOSSINVEST_CLIENT_ID'],
    readTelegram: () => ({ enabled: false, allowedUsers: [] }), readBundleFile: () => grouped.files.get('/tmp/grouped')! });
  await parse(groupedDestination, 'credentials', 'restore', '/tmp/grouped', '--dry-run');
  expect(groupedDestination.output.join('\n')).toContain('toss\tstatic-key\tencrypted-restore\tmbp -> mshq\tdestination-conflict');
});


test('restore preflight catches static Telegram token against destination bot config', async () => {
  const source = fixture({ listSecrets: async () => ['ELANOUS_TELEGRAM_BOT_TOKEN'],
    getSecret: async () => 'fake-source-token', readTelegram: () => ({ enabled: false, allowedUsers: [] }) });
  await parse(source, 'credentials', 'backup', '--to', '/tmp/static-telegram', '--destination', 'mshq');
  expect(source.codes).toEqual([0]);
  const destination = fixture({ hostName: () => 'mshq', listSecrets: async () => [],
    readTelegram: () => ({ enabled: false, botToken: 'fake-destination-token', allowedUsers: [] }),
    readBundleFile: () => source.files.get('/tmp/static-telegram')! });
  await parse(destination, 'credentials', 'restore', '/tmp/static-telegram', '--dry-run');
  expect(destination.codes).toEqual([0]);
  expect(destination.output.join('\n')).toContain('ELANOUS_TELEGRAM_BOT_TOKEN\tstatic-key\tencrypted-restore\tmbp -> mshq\tdestination-conflict');
  expect(destination.output.join('\n')).not.toContain('fake-destination-token');
});

test('restore preflight catches bot config against destination static Telegram alias', async () => {
  const source = fixture({ listSecrets: async () => [] });
  await parse(source, 'credentials', 'backup', '--to', '/tmp/config-telegram', '--destination', 'mshq');
  expect(source.codes).toEqual([0]);
  const destination = fixture({ hostName: () => 'mshq', listSecrets: async () => ['ELANOUS_TELEGRAM_BOT_TOKEN'],
    readTelegram: () => ({ enabled: false, allowedUsers: [] }),
    readBundleFile: () => source.files.get('/tmp/config-telegram')! });
  await parse(destination, 'credentials', 'restore', '/tmp/config-telegram', '--dry-run');
  expect(destination.codes).toEqual([0]);
  expect(destination.output.join('\n')).toContain('telegram-config\ttelegram-bot\tencrypted-restore\tmbp -> mshq\tdestination-conflict');
  expect(destination.output.join('\n')).not.toContain('fake-telegram-value');
});
