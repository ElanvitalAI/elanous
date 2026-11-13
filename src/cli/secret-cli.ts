import type { Command } from 'commander';
import { existsSync, readFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  currentBackendId,
  deleteSecretAsync,
  getSecretAsync,
  importSecretBatchAsync,
  listSecretIdsAsync,
  selectBackendFromConfig,
  setSecretAsync,
} from '../nexus/config/secrets/index.js';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import { verifyServiceKey, type ServiceKeyVerification } from '../setup/service-keys.js';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';
import { decryptSecretBundle, encryptSecretBundle } from '../nexus/config/secrets/transfer.js';
import { SECRETS_VERSION } from '../nexus/config/types.js';
import { parseSecretEnvFile, renderSecretEnvExports } from '../nexus/config/secrets/env-import.js';
import { registerCredCommands } from './cred-cli.js';
import { registerCredentialsMigrationCommands } from './credentials-migration-cli.js';
import { appSecretId, appSecretIdForExistingApp } from '../nexus/config/secrets/app-secret-ledger.js';
import type { SecretBackendId } from '../nexus/config/secrets/types.js';
import { revokeAppSecretValues, setAppSecretValue, type AppSecretRevokeResult } from '../nexus/config/secrets/file-backend.js';
import { deleteCredentialSlotAsync, listCredentialSlotsAsync, parseCredentialSlotId, setCredentialSlotAsync, setCredentialSlotBatchAsync } from '../nexus/config/secrets/cred-slots.js';
import { credentialSlotWizardPlan, runCredentialSlotWizard } from '../nexus/config/secrets/cred-slot-wizard.js';

export interface SecretCliDeps {
  isInteractive?: () => boolean;
  promptSecret?: (message: string) => Promise<string | undefined>;
  saveSecret?: (id: string, value: string) => Promise<void>;
  saveAppSecret?: (id: string, value: string) => Promise<void>;
  revokeAppSecrets?: (app: string, name?: string) => Promise<AppSecretRevokeResult>;
  getSecret?: (id: string) => Promise<string | undefined>;
  listSecrets?: () => Promise<string[]>;
  removeSecret?: (id: string) => Promise<boolean>;
  verifySecret?: (serviceId: string, value: string) => Promise<{ result: ServiceKeyVerification; httpStatus?: number }>;
  storageBackend?: () => string;
  initializeBackend?: () => void;
  environment?: Readonly<Record<string, string | undefined>>;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
  readBundleFile?: (path: string) => Promise<string>;
  readEnvFile?: (path: string) => Promise<string>;
  writeBundleFile?: (path: string, contents: string) => Promise<void>;
  syncBundle?: (host: string, contents: string) => Promise<void>;
  importSecrets?: (secrets: Readonly<Record<string, string>>, overwrite: boolean, expectedConflicts?: readonly string[]) => Promise<{ imported: boolean; conflicts: string[]; changedSinceConfirmation: boolean }>;
  saveCredentialSlot?: (id: string, value: string) => Promise<void>;
  saveCredentialSlotBatch?: (values: Readonly<Record<string, string>>) => Promise<void>;
  removeCredentialSlot?: (id: string) => Promise<boolean>;
  listCredentialSlots?: typeof listCredentialSlotsAsync;
}

const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validId(id: string): boolean {
  return SECRET_ID_PATTERN.test(id);
}

function validRemovalId(id: string): boolean {
  return validId(id) || (id.startsWith('app/') && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id));
}

function appSecretBackendSupported(backend: string): backend is SecretBackendId {
  // Only the local file backend has synchronous, process-cancelled mutations;
  // remote providers need conditional/idempotent writes before crash recovery is safe.
  return backend === 'file';
}

function redactParserErrors(command: Command): void {
  const originalError = command.error.bind(command);
  command.error = (_message, errorOptions) => originalError('secret command failed', errorOptions);
}

export function runProcess(command: string, args: string[], input?: string, stdio: 'inherit' | 'ignore' = 'ignore'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? stdio : 'pipe', stdio, stdio] });
    child.once('error', () => reject(new Error('credential transfer process failed')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('credential transfer process failed')));
    if (input !== undefined) {
      if (!child.stdin) reject(new Error('credential transfer process failed'));
      else {
        child.stdin.once('error', () => reject(new Error('credential transfer process failed')));
        child.stdin.end(input);
      }
    }
  });
}

export async function syncEncryptedBundleOverSsh(
  host: string,
  contents: string,
  run: typeof runProcess = runProcess,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$/.test(host)) throw new Error('invalid SSH host');
  const remotePath = `/tmp/elanous-secret-${randomUUID()}.bundle`;
  let uploadAttempted = false;
  let operationFailed = false;
  try {
    uploadAttempted = true;
    const remoteWrite = `umask 077; (set -C; : > '${remotePath}') && chmod 600 '${remotePath}' && cat > '${remotePath}' && if stat -f %Lp '${remotePath}' >/dev/null 2>&1; then mode=$(stat -f %Lp '${remotePath}'); else mode=$(stat -c %a '${remotePath}'); fi && test "$mode" = 600`;
    await run('ssh', [host, remoteWrite], contents);
    await run('ssh', ['-tt', host, 'eln', 'secret', 'import', remotePath], undefined, 'inherit');
  } catch {
    operationFailed = true;
  } finally {
    if (uploadAttempted) {
      try { await run('ssh', [host, 'rm', '--', remotePath]); }
      catch { throw new Error(`ELANOUS_SECRET_SYNC_CLEANUP: encrypted transfer file may remain at ${host}:${remotePath}`); }
    }
  }
  if (operationFailed) throw new Error('credential transfer process failed');
}

const defaultSyncBundle = syncEncryptedBundleOverSsh;

function resolveDeps(deps: SecretCliDeps) {
  const storageBackend = deps.storageBackend ?? currentBackendId;
  const getSecret = deps.getSecret ?? getSecretAsync;
  return {
    isInteractive: deps.isInteractive ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    promptSecret: deps.promptSecret ?? createSecretPrompt(),
    saveSecret: deps.saveSecret ?? setSecretAsync,
    saveCredentialSlot: deps.saveCredentialSlot ?? setCredentialSlotAsync,
    saveCredentialSlotBatch: deps.saveCredentialSlotBatch ?? setCredentialSlotBatchAsync,
    removeCredentialSlot: deps.removeCredentialSlot ?? deleteCredentialSlotAsync,
    listCredentialSlots: deps.listCredentialSlots ?? listCredentialSlotsAsync,
    saveAppSecret: deps.saveAppSecret ?? deps.saveSecret ?? setAppSecretValue,
    revokeAppSecrets: deps.revokeAppSecrets ?? revokeAppSecretValues,
    getSecret,
    listSecrets: deps.listSecrets ?? listSecretIdsAsync,
    removeSecret: deps.removeSecret ?? deleteSecretAsync,
    verifySecret: deps.verifySecret ?? (async (serviceId: string, value: string) => verifyServiceKey(serviceId, value)),
    storageBackend,
    initializeBackend: deps.initializeBackend ?? (() => { selectBackendFromConfig(); }),
    output: deps.output ?? console,
    setExitCode: deps.setExitCode ?? ((code: number) => { process.exitCode = code; }),
    readBundleFile: deps.readBundleFile ?? (async (path) => readFileSync(path, 'utf8')),
    readEnvFile: deps.readEnvFile ?? (async (path) => readFileSync(path, 'utf8')),
    writeBundleFile: deps.writeBundleFile ?? (async (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
        chmodSync(temp, 0o600);
        // Never silently replace an existing encrypted transfer artifact.
        if (existsSync(path)) throw new Error('destination exists');
        linkSync(temp, path);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    }),
    syncBundle: deps.syncBundle ?? defaultSyncBundle,
    importSecrets: deps.importSecrets ?? importSecretBatchAsync,
  };
}

export function registerSecretCommands(program: Command, deps: SecretCliDeps = {}): Command {
  const cli = resolveDeps(deps);
  registerCredentialsMigrationCommands(program);
  const cred = registerCredCommands(program, {
    listSecrets: cli.listSecrets,
    getSecret: cli.getSecret,
    verifySecret: cli.verifySecret,
    storageBackend: cli.storageBackend,
    initializeBackend: cli.initializeBackend,
    environment: deps.environment,
    output: cli.output,
    setExitCode: cli.setExitCode,
  });
  const exportableSecretIds = new Set(SERVICE_KEY_CATALOG
    .filter((entry) => entry.kind === 'api-key')
    .flatMap((entry) => [entry.id, ...entry.envNames, ...(entry.storeIds ?? [])]));
  const importableEnvNames = new Set(SERVICE_KEY_CATALOG
    .filter((entry) => entry.kind === 'api-key')
    .flatMap((entry) => entry.envNames));
  const secret = program.command('secret').description('Store and manage API keys without displaying their values.');
  // Commander shares output configuration across parent/child commands. Override
  // error handling on this command tree instead so sibling commands keep theirs.
  redactParserErrors(secret);

  const slots = secret.command('slot').description('Inspect shared credential slots without displaying their values.');
  slots.command('list')
    .description('List supported shared credential slots and whether each is present.')
    .allowExcessArguments(false)
    .action(async () => {
      try {
        cli.initializeBackend();
        const inventory = await cli.listCredentialSlots();
        cli.output.log('slot\tservice\tfield\tstatus');
        for (const row of inventory) cli.output.log(`${row.id}\t${row.label}\t${row.field}\t${row.present ? 'present' : 'missing'}`);
        cli.setExitCode(0);
      } catch {
        cli.output.error('credential slot list failed');
        cli.setExitCode(1);
      }
    });

  slots.command('setup <service>')
    .description('Prompt privately for every catalogued credential field and save the service in one batch.')
    .allowExcessArguments(false)
    .action(async (service: string) => {
      const plan = credentialSlotWizardPlan(service);
      if (!plan) { cli.output.error('credential slot setup unsupported'); cli.setExitCode(2); return; }
      if (!cli.isInteractive()) { cli.output.error('credential slot setup requires an interactive terminal'); cli.setExitCode(1); return; }
      try {
        cli.initializeBackend();
        const result = await runCredentialSlotWizard(plan, {
          prompt: (slot) => cli.promptSecret(`${slot}: `),
          saveBatch: cli.saveCredentialSlotBatch,
        });
        cli.output.log(`saved ${result.slots.join(', ')} · success`);
        cli.setExitCode(0);
      } catch {
        cli.output.error('credential slot setup failed');
        cli.setExitCode(1);
      }
    });

  const appSecret = secret.command('app').description('Manage app-scoped secrets; values remain in the secret backend.');
  appSecret.command('set <slug> <name>')
    .description('Issue one app secret using hidden input; revoke an existing name before issuing it again.')
    .allowExcessArguments(false)
    .action(async (slug: string, name: string) => {
      let id: string;
      try { id = appSecretId(slug, name); }
      catch { cli.output.error('invalid app secret name'); cli.setExitCode(1); return; }
      if (!cli.isInteractive()) { cli.output.error('secret app set requires an interactive terminal'); cli.setExitCode(1); return; }
      try {
        cli.initializeBackend();
        const backend = cli.storageBackend();
        if (!appSecretBackendSupported(backend)) {
          cli.output.error('app secret operations require the file backend');
          cli.setExitCode(1);
          return;
        }
        const value = await cli.promptSecret('Secret value: ');
        if (value === undefined || !value.trim() || value.includes('\0')) {
          cli.output.error('secret input cancelled or invalid'); cli.setExitCode(1); return;
        }
        await cli.saveAppSecret(id, value);
        cli.output.log(`issued ${slug}/${name} · ${cli.storageBackend()}`);
        cli.setExitCode(0);
      } catch { cli.output.error('app secret could not be issued'); cli.setExitCode(1); }
    });
  appSecret.command('revoke <slug> [name]')
    .description('Revoke one app secret or every secret for the app; values are never shown.')
    .allowExcessArguments(false)
    .action(async (slug: string, name?: string) => {
      try { appSecretIdForExistingApp(slug, name ?? 'PLACEHOLDER'); }
      catch { cli.output.error('invalid app secret name'); cli.setExitCode(1); return; }
      try {
        cli.initializeBackend();
        const backend = cli.storageBackend();
        if (!appSecretBackendSupported(backend)) {
          cli.output.error('app secret operations require the file backend');
          cli.setExitCode(1);
          return;
        }
        const result = await cli.revokeAppSecrets(slug, name);
        cli.output.log(result.alreadyAbsent
          ? `already absent ${name === undefined ? slug : `${slug}/${name}`}`
          : `revoked ${slug} · ${result.revoked} secret(s)`);
        cli.setExitCode(0);
      } catch { cli.output.error('app secret could not be revoked'); cli.setExitCode(1); }
    });

  const registerEncryptedExport = (parent: Command, label: 'secret' | 'credential'): void => {
    const command = parent.command('export')
      .description(`Write an encrypted bundle of static ${label} values; passphrase is entered without echo.`)
      .requiredOption('--to <file>', 'Destination file (must not already exist)')
      .allowExcessArguments(false)
      .action(async (options: { to: string }) => {
        if (!cli.isInteractive()) {
          cli.output.error(`${label} export requires an interactive terminal`);
          cli.setExitCode(1);
          return;
        }
        try {
          cli.initializeBackend();
          const first = await cli.promptSecret('Bundle passphrase (12+ characters): ');
          const second = await cli.promptSecret('Repeat bundle passphrase: ');
          if (first === undefined || second === undefined || first !== second || first.length < 12) {
            cli.output.error('bundle passphrase was not accepted');
            cli.setExitCode(1);
            return;
          }
          const secrets: Record<string, string> = {};
          for (const id of await cli.listSecrets()) {
            // Only catalogued static API keys transfer. OAuth/session stores and unknown names fail closed.
            if (!exportableSecretIds.has(id)) continue;
            const value = await cli.getSecret(id);
            if (value !== undefined) secrets[id] = value;
          }
          const contents = await encryptSecretBundle({ version: SECRETS_VERSION, secrets }, first);
          await cli.writeBundleFile(options.to, contents);
          cli.output.log(label === 'credential'
            ? `exported ${Object.keys(secrets).length} static credentials · encrypted · rotating login credentials excluded; sign in on destination`
            : `exported ${Object.keys(secrets).length} secrets · encrypted · non-catalog names and rotating login credentials excluded; sign in on destination`);
          cli.setExitCode(0);
        } catch {
          cli.output.error(`${label} export failed`);
          cli.setExitCode(1);
        }
      });
    redactParserErrors(command);
  };

  const registerEncryptedImport = (parent: Command, label: 'secret' | 'credential'): void => {
    const command = parent.command('import <file>')
      .description(`Import an encrypted static ${label} bundle; existing names require explicit confirmation.`)
      .option('--overwrite', 'Allow replacing names already in the secret store after confirmation')
      .allowExcessArguments(false)
      .action(async (file: string, options: { overwrite?: boolean }) => {
        if (!cli.isInteractive()) {
          cli.output.error(`${label} import requires an interactive terminal`);
          cli.setExitCode(1);
          return;
        }
        try {
          cli.initializeBackend();
          const passphrase = await cli.promptSecret('Bundle passphrase: ');
          if (passphrase === undefined) {
            cli.output.error(`${label} import cancelled`);
            cli.setExitCode(1);
            return;
          }
          const bundle = await decryptSecretBundle(await cli.readBundleFile(file), passphrase);
          const unsupportedIds = Object.keys(bundle.secrets).filter((id) => !exportableSecretIds.has(id));
          if (unsupportedIds.length) {
            cli.output.error(`bundle contains unsupported secret names: ${unsupportedIds.join(', ')}`);
            cli.setExitCode(1);
            return;
          }
          const firstImport = await cli.importSecrets(bundle.secrets, false);
          const collisions = firstImport.conflicts;
          if (collisions.length && !options.overwrite) {
            cli.output.error(`name conflicts: ${collisions.join(', ')} · rerun with --overwrite to confirm`);
            cli.setExitCode(1);
            return;
          }
          if (collisions.length) {
            cli.output.log(`replace names: ${collisions.join(', ')}`);
            const confirmation = await cli.promptSecret(`Type exactly: REPLACE ${collisions.join(',')}`);
            if (confirmation !== `REPLACE ${collisions.join(',')}`) {
              cli.output.error(`${label} import cancelled`);
              cli.setExitCode(1);
              return;
            }
          }
          const result = collisions.length
            ? await cli.importSecrets(bundle.secrets, true, collisions)
            : firstImport;
          if (!result.imported) {
            cli.output.error(result.changedSinceConfirmation ? 'secret names changed during import confirmation' : `${label} import was not applied`);
            cli.setExitCode(1);
            return;
          }
          cli.output.log(label === 'credential'
            ? `imported ${Object.keys(bundle.secrets).length} static credentials · values hidden`
            : `imported ${Object.keys(bundle.secrets).length} secrets · values hidden`);
          cli.setExitCode(0);
        } catch (error) {
          cli.output.error(error instanceof Error && error.message === 'ELANOUS_IMPORT_BACKEND_UNSUPPORTED'
            ? 'atomic secret import currently requires the file backend'
            : `${label} import failed`);
          cli.setExitCode(1);
        }
      });
    redactParserErrors(command);
  };

  registerEncryptedExport(cred, 'credential');
  registerEncryptedImport(cred, 'credential');

  const setCommand = secret.command('set <id>')
    .description('Prompt for a secret without echo; the value is never accepted as an argument.')
    .allowExcessArguments(false)
    .action(async (id: string) => {
      if (!validId(id)) {
        cli.output.error('invalid secret identifier');
        cli.setExitCode(1);
        return;
      }
      if (!cli.isInteractive()) {
        cli.output.error('secret set requires an interactive terminal');
        cli.setExitCode(1);
        return;
      }
      try {
        const value = await cli.promptSecret('Secret value: ');
        if (value === undefined) {
          cli.output.error('secret input cancelled');
          cli.setExitCode(1);
          return;
        }
        if (!value.trim() || value.includes('\0')) {
          cli.output.error('secret value is empty or invalid');
          cli.setExitCode(1);
          return;
        }
        cli.initializeBackend();
        if (id.startsWith('cred:')) {
          if (!parseCredentialSlotId(id)) throw new Error('unsupported credential slot');
          await cli.saveCredentialSlot(id, value);
        } else {
          await cli.saveSecret(id, value);
        }
        cli.output.log(`saved ${id} · ${cli.storageBackend()}`);
        cli.setExitCode(0);
      } catch {
        cli.output.error('secret could not be stored');
        cli.setExitCode(1);
      }
    });

  const listCommand = secret.command('list')
    .description('List secret names and storage backend; values are never shown.')
    .allowExcessArguments(false)
    .action(async () => {
      try {
        cli.initializeBackend();
        const ids = await cli.listSecrets();
        if (ids.length === 0) cli.output.log('no secrets');
        else {
          cli.output.log('id\tstorage\tlast-test');
          for (const id of ids) cli.output.log(`${id}\t${cli.storageBackend()}\tunknown`);
        }
        cli.setExitCode(0);
      } catch {
        cli.output.error('secret list failed');
        cli.setExitCode(1);
      }
    });

  const removeCommand = secret.command('rm <id>')
    .description('Remove a stored secret by name; legacy app-prefixed IDs remain removable unless their lifecycle ledger owns them.')
    .allowExcessArguments(false)
    .action(async (id: string) => {
      if (!validRemovalId(id)) {
        cli.output.error('invalid secret identifier');
        cli.setExitCode(1);
        return;
      }
      try {
        cli.initializeBackend();
        const removed = id.startsWith('cred:')
          ? parseCredentialSlotId(id) ? await cli.removeCredentialSlot(id) : false
          : await cli.removeSecret(id);
        cli.output.log(removed ? `removed ${id}` : `not found ${id}`);
        cli.setExitCode(removed ? 0 : 1);
      } catch {
        cli.output.error('secret could not be removed');
        cli.setExitCode(1);
      }
    });

  const testCommand = secret.command('test <id>')
    .description('Make one bounded service verification request; only a status is displayed.')
    .allowExcessArguments(false)
    .action(async (id: string) => {
      if (!validId(id)) {
        cli.output.error('invalid secret identifier');
        cli.setExitCode(1);
        return;
      }
      const service = SERVICE_KEY_CATALOG.find((entry) => entry.id === id && entry.kind === 'api-key');
      if (!service) {
        cli.output.error('secret test is unsupported for this id');
        cli.setExitCode(2);
        return;
      }
      try {
        cli.initializeBackend();
        const value = await cli.getSecret(id);
        if (!value) {
          cli.output.log(`test ${id} · missing`);
          cli.setExitCode(1);
          return;
        }
        const result = await cli.verifySecret(service.id, value);
        const status = result.httpStatus === undefined ? result.result : `${result.result} · HTTP ${result.httpStatus}`;
        cli.output.log(`test ${id} · ${status}`);
        cli.setExitCode(result.result === 'verified' ? 0 : 1);
      } catch {
        cli.output.error('secret test failed');
        cli.setExitCode(1);
      }
    });

  registerEncryptedExport(secret, 'secret');
  registerEncryptedImport(secret, 'secret');

  const syncCommand = secret.command('sync <host>')
    .description('Send an encrypted bundle over SSH; the destination prompts for its passphrase.')
    .allowExcessArguments(false)
    .action(async (host: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$/.test(host)) {
        cli.output.error('invalid SSH host');
        cli.setExitCode(1);
        return;
      }
      if (!cli.isInteractive()) {
        cli.output.error('secret sync requires an interactive terminal');
        cli.setExitCode(1);
        return;
      }
      try {
        cli.initializeBackend();
        const first = await cli.promptSecret('Bundle passphrase (12+ characters): ');
        const second = await cli.promptSecret('Repeat bundle passphrase: ');
        if (first === undefined || second === undefined || first !== second || first.length < 12) {
          cli.output.error('bundle passphrase was not accepted');
          cli.setExitCode(1);
          return;
        }
        const secrets: Record<string, string> = {};
        for (const id of await cli.listSecrets()) {
          if (!exportableSecretIds.has(id)) continue;
          const value = await cli.getSecret(id);
          if (value !== undefined) secrets[id] = value;
        }
        const contents = await encryptSecretBundle({ version: SECRETS_VERSION, secrets }, first);
        await cli.syncBundle(host, contents);
        cli.output.log(`synced ${Object.keys(secrets).length} secrets · encrypted · non-catalog names and rotating login credentials excluded; destination import confirmed`);
        cli.setExitCode(0);
      } catch (error) {
        cli.output.error(error instanceof Error && error.message.startsWith('ELANOUS_SECRET_SYNC_CLEANUP:')
          ? error.message.slice('ELANOUS_SECRET_SYNC_CLEANUP: '.length)
          : 'secret sync failed');
        cli.setExitCode(1);
      }
    });

  const importEnvCommand = secret.command('import-env <file>')
    .description('Absorb literal export KEY=value lines into the secret store without displaying values.')
    .option('--overwrite', 'Allow replacing names already in the secret store after confirmation')
    .allowExcessArguments(false)
    .action(async (file: string, options: { overwrite?: boolean }) => {
      if (!cli.isInteractive()) {
        cli.output.error('secret import-env requires an interactive terminal');
        cli.setExitCode(1);
        return;
      }
      try {
        cli.initializeBackend();
        const secrets = parseSecretEnvFile(await cli.readEnvFile(file));
        if (!Object.keys(secrets).length) {
          cli.output.error('environment file contains no secret assignments');
          cli.setExitCode(1);
          return;
        }
        const unsupported = Object.keys(secrets).filter((name) => !importableEnvNames.has(name));
        if (unsupported.length) {
          cli.output.error(`unsupported environment variable names: ${unsupported.join(', ')}`);
          cli.setExitCode(1);
          return;
        }
        const firstImport = await cli.importSecrets(secrets, false);
        const collisions = firstImport.conflicts;
        if (collisions.length && !options.overwrite) {
          cli.output.error(`name conflicts: ${collisions.join(', ')} · rerun with --overwrite to confirm`);
          cli.setExitCode(1);
          return;
        }
        if (collisions.length) {
          cli.output.log(`replace names: ${collisions.join(', ')}`);
          const exact = `REPLACE ${collisions.join(',')}`;
          if (await cli.promptSecret(`Type exactly: ${exact}`) !== exact) {
            cli.output.error('secret import-env cancelled');
            cli.setExitCode(1);
            return;
          }
        }
        const result = collisions.length ? await cli.importSecrets(secrets, true, collisions) : firstImport;
        if (!result.imported) {
          cli.output.error(result.changedSinceConfirmation ? 'secret names changed during import confirmation' : 'secret import-env was not applied');
          cli.setExitCode(1);
          return;
        }
        cli.output.log(`absorbed ${Object.keys(secrets).length} environment names · values hidden · back up then empty the plaintext file`);
        cli.setExitCode(0);
      } catch {
        cli.output.error('secret import-env failed');
        cli.setExitCode(1);
      }
    });

  const envCommand = secret.command('env')
    .description('Print shell-quoted exports for the requested stored environment names only.')
    .requiredOption('--names <names>', 'Comma-separated environment variable names')
    .allowExcessArguments(false)
    .action(async (options: { names: string }) => {
      try {
        cli.initializeBackend();
        const names = options.names.split(',');
        const secrets: Record<string, string> = {};
        for (const name of names) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid environment variable name');
          const value = await cli.getSecret(name);
          if (value !== undefined) secrets[name] = value;
        }
        cli.output.log(renderSecretEnvExports(secrets, names).trimEnd());
        cli.setExitCode(0);
      } catch (error) {
        cli.output.error(error instanceof Error && /^(missing secrets:|invalid environment variable name|duplicate environment variable name|at least one environment variable name)/.test(error.message)
          ? error.message
          : 'secret env failed');
        cli.setExitCode(1);
      }
    });

  for (const command of [setCommand, listCommand, removeCommand, testCommand, syncCommand, importEnvCommand, envCommand]) redactParserErrors(command);
  return secret;
}
