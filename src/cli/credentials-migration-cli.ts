import type { Command } from 'commander';
import { hostname } from 'node:os';
import { existsSync, readFileSync, linkSync, unlinkSync, writeFileSync, chmodSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { getUserConfig } from '../user-config.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { getSecretAsync, listSecretIdsAsync, selectBackendFromConfig } from '../nexus/config/secrets/index.js';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';
import { decryptMigrationBundle, encryptMigrationBundle, isExportableMigrationStaticId, assertDistinctMigrationStaticIds, migrationStaticSlots } from './credentials-migration-bundle.js';
import { planCredentialMigration, renderCredentialMigrationDryRun, type MigrationSource } from './credentials-migration-plan.js';

export interface CredentialMigrationReceipt {
  phase: 'backup-preflight' | 'backup' | 'restore-preflight' | 'restore-apply';
  outcome: 'completed' | 'failed' | 'refused';
  staticCount?: number;
  telegramIncluded?: boolean;
  sourceHost?: string;
  destinationHost?: string;
}

function writeMigrationReceipt(receipt: CredentialMigrationReceipt): void {
  getDefaultLogStore()?.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'cred.migration',
    event: `${receipt.phase}-${receipt.outcome}`, level: receipt.outcome === 'completed' ? 'info' : 'warn',
    data: receipt }, surface: 'cli' }]);
}

export interface CredentialsMigrationCliDeps {
  listSecrets?: () => Promise<string[]>;
  getSecret?: (id: string) => Promise<string | undefined>;
  readTelegram?: () => { enabled: boolean; botToken?: string; homeChannel?: number; allowedUsers: number[] };
  promptSecret?: (message: string) => Promise<string | undefined>;
  readBundleFile?: (path: string) => string;
  writeBundleFile?: (path: string, contents: string) => void;
  initializeBackend?: () => void;
  isInteractive?: () => boolean;
  hostName?: () => string;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
  recordReceipt?: (receipt: CredentialMigrationReceipt) => void;
}

function normalizedHost(value: string): string {
  const host = value.toLowerCase().replace(/\.local$/, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(host)) throw new Error('INVALID_HOST');
  return host;
}

/** Only the encrypted artifact is ever written by this command; no plaintext temporary file. */
export function writeBundleNoReplace(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(path)) throw new Error('BACKUP_EXISTS');
    linkSync(temporary, path);
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function planRows(ids: readonly string[], hasTelegram: boolean, sourceHost: string, destinationHost: string,
  existing?: ReadonlySet<string>, targetTelegram?: { enabled: boolean; botToken?: string }) {
  const staticIds = ids.filter(isExportableMigrationStaticId);
  assertDistinctMigrationStaticIds(staticIds);
  if (hasTelegram && staticIds.some((id) => migrationStaticSlots(id)?.includes('telegram')))
    throw new Error('INVALID_MIGRATION_CONTENTS');
  const existingSlots = existing && new Set([...existing].flatMap((id) => migrationStaticSlots(id) ?? []));
  if (targetTelegram?.botToken) existingSlots?.add('telegram');
  const rows: MigrationSource[] = staticIds.map((id) => ({
    id, kind: 'static-key', ownerHost: sourceHost,
    ...(existingSlots ? { destinationPresent: migrationStaticSlots(id)!.some((slot) => existingSlots.has(slot)) } : {}),
  }));
  if (hasTelegram) rows.push({ id: 'telegram-config', kind: 'telegram-bot', ownerHost: sourceHost,
    // A saved config flag cannot prove whether the old process is polling. Keep it unknown.
    ...(targetTelegram ? {
      destinationPollerActive: targetTelegram.enabled ? true : undefined,
      destinationPresent: Boolean(targetTelegram.botToken) || Boolean(existingSlots?.has('telegram')),
    } : {}),
  });
  rows.push({ id: 'codex-access-mirror', kind: 'oauth-access', ownerHost: sourceHost });
  rows.push({ id: 'codex-refresh-owner', kind: 'single-use-refresh', ownerHost: sourceHost });
  rows.push({ id: 'claude-setup-token', kind: 'setup-token', ownerHost: sourceHost });
  return planCredentialMigration(rows, destinationHost);
}

export function registerCredentialsMigrationCommands(program: Command, deps: CredentialsMigrationCliDeps = {}): Command {
  const io = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const listSecrets = deps.listSecrets ?? listSecretIdsAsync;
  const getSecret = deps.getSecret ?? getSecretAsync;
  const readTelegram = deps.readTelegram ?? (() => getUserConfig().telegram);
  const prompt = deps.promptSecret ?? createSecretPrompt();
  const initialize = deps.initializeBackend ?? selectBackendFromConfig;
  const isInteractive = deps.isInteractive ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const host = deps.hostName ?? hostname;
  const readBundle = deps.readBundleFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const writeBundle = deps.writeBundleFile ?? writeBundleNoReplace;
  const recordReceipt = (receipt: CredentialMigrationReceipt): void => {
    try { (deps.recordReceipt ?? writeMigrationReceipt)(receipt); } catch { /* logging never exposes an error or credential */ }
  };
  const credentials = program.command('credentials').description('Encrypted host credential backup and restore preflight.');
  credentials.error = (_message, options) => program.error('credentials command failed', options);

  credentials.command('backup')
    .requiredOption('--to <file>')
    .requiredOption('--destination <host>')
    .option('--dry-run')
    .allowExcessArguments(false)
    .action(async (options: { to: string; destination: string; dryRun?: boolean }) => {
      try {
        initialize();
        const source = normalizedHost(host());
        const destination = normalizedHost(options.destination);
        const ids = (await listSecrets()).filter(isExportableMigrationStaticId);
        assertDistinctMigrationStaticIds(ids);
        if (options.dryRun) {
          const telegram = readTelegram();
          io.log(renderCredentialMigrationDryRun(planRows(ids, Boolean(telegram.botToken), source, destination)));
          recordReceipt({ phase: 'backup-preflight', outcome: 'completed', staticCount: ids.length,
            telegramIncluded: Boolean(telegram.botToken), sourceHost: source, destinationHost: destination });
          exit(0); return;
        }
        if (!isInteractive()) throw new Error('INTERACTIVE_REQUIRED');
        const telegram = readTelegram();
        if (telegram.botToken && ids.some((id) => migrationStaticSlots(id)?.includes('telegram')))
          throw new Error('INVALID_MIGRATION_CONTENTS');
        const first = await prompt('Backup passphrase (12+ characters): ');
        const second = await prompt('Repeat backup passphrase: ');
        if (!first || first.length < 12 || first !== second) throw new Error('PASSPHRASE_REJECTED');
        const staticSecrets: Record<string, string> = {};
        for (const id of ids) {
          const value = await getSecret(id);
          if (value === undefined) throw new Error('MISSING_STATIC_SECRET');
          staticSecrets[id] = value;
        }
        const bundle = await encryptMigrationBundle({ sourceHost: source, staticSecrets,
          ...(telegram.botToken ? { telegram: { botToken: telegram.botToken, allowedUsers: telegram.allowedUsers,
            ...(telegram.homeChannel === undefined ? {} : { homeChannel: telegram.homeChannel }) } } : {}) }, first);
        writeBundle(options.to, bundle);
        recordReceipt({ phase: 'backup', outcome: 'completed', staticCount: Object.keys(staticSecrets).length,
          telegramIncluded: Boolean(telegram.botToken), sourceHost: source, destinationHost: destination });
        io.log(`backup encrypted · static=${Object.keys(staticSecrets).length} · telegram=${telegram.botToken ? 1 : 0} · OAuth/refresh excluded`);
        exit(0);
      } catch { recordReceipt({ phase: 'backup', outcome: 'failed' });
        io.error('credentials backup failed · no values displayed'); exit(1); }
    });

  credentials.command('restore <file>')
    .option('--dry-run')
    .allowExcessArguments(false)
    .action(async (file: string, options: { dryRun?: boolean }) => {
      if (!isInteractive()) { recordReceipt({ phase: 'restore-preflight', outcome: 'failed' });
        io.error('credentials restore preflight requires an interactive terminal'); exit(1); return; }
      try {
        initialize();
        const passphrase = await prompt('Backup passphrase: ');
        if (!passphrase) throw new Error('PASSPHRASE_REJECTED');
        const bundle = await decryptMigrationBundle(readBundle(file), passphrase);
        const currentIds = new Set(await listSecrets());
        const rows = planRows(Object.keys(bundle.staticSecrets), Boolean(bundle.telegram),
          bundle.sourceHost, normalizedHost(host()), currentIds, readTelegram());
        io.log(renderCredentialMigrationDryRun(rows));
        recordReceipt({ phase: 'restore-preflight', outcome: 'completed', staticCount: Object.keys(bundle.staticSecrets).length,
          telegramIncluded: Boolean(bundle.telegram), sourceHost: bundle.sourceHost, destinationHost: normalizedHost(host()) });
        if (options.dryRun) { exit(0); return; }
        // Existing file and keychain backends cannot guarantee zero plaintext during apply.
        // The owner/poller transfer also lacks a live source receipt. Never turn this into a partial restore.
        recordReceipt({ phase: 'restore-apply', outcome: 'refused' });
        io.error('credentials restore apply unavailable · encrypted preflight only; no values written');
        exit(1);
      } catch { recordReceipt({ phase: 'restore-preflight', outcome: 'failed' });
        io.error('credentials restore preflight failed · values hidden'); exit(1); }
    });
  return credentials;
}
