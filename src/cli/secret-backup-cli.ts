import type { Command } from 'commander';
import { selectBackendFromConfig } from '../nexus/config/secrets/index.js';
import { pushSecretBackup, restoreSecretBackup, statusSecretBackup,
  type SecretBackupDeps, type SecretBackupOptions } from './secret-backup-service.js';

export interface SecretBackupCliDeps extends SecretBackupDeps {
  initializeBackend?: () => void;
  environment?: Readonly<Record<string, string | undefined>>;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

type CliOptions = { url?: string; sessionFile: string; identityFile: string; overwrite?: boolean };

/** Registered under the existing `secret` command in secret-cli.ts. */
export function registerSecretBackupCommands(secret: Command, deps: SecretBackupCliDeps = {}): Command {
  const io = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const environment = deps.environment ?? process.env;
  const initializeBackend = deps.initializeBackend ?? (() => { selectBackendFromConfig(); });
  const backup = secret.command('backup').description('Client-encrypted member backup of supported static secrets.');
  const options = (command: Command) => command
    .option('--url <url>', 'HTTPS Nexus origin (or ELANOUS_NEXUS_URL)')
    .requiredOption('--session-file <path>', 'private file containing the member session token')
    .requiredOption('--identity-file <path>', 'private local recovery and sender identity file')
    .allowExcessArguments(false);
  const context = (value: CliOptions): SecretBackupOptions => {
    const baseUrl = value.url ?? environment.ELANOUS_NEXUS_URL;
    if (!baseUrl) throw new Error('BACKUP_URL_REQUIRED');
    return { baseUrl, sessionFile: value.sessionFile, identityFile: value.identityFile };
  };
  options(backup.command('push').description('Encrypt local static secrets before uploading ciphertext.'))
    .action(async (value: CliOptions) => {
      try {
        initializeBackend();
        const result = await pushSecretBackup(context(value), deps);
        io.log(`backup\t${result.id}\tgeneration=${result.generation}`);
        exit(0);
      } catch { io.error('secret backup push failed'); exit(1); }
    });
  options(backup.command('restore').description('Restore after member authentication and local recovery-key verification.'))
    .option('--overwrite', 'explicitly allow replacement of existing supported static secrets')
    .action(async (value: CliOptions) => {
      try {
        initializeBackend();
        const result = await restoreSecretBackup({ ...context(value), overwrite: value.overwrite === true }, deps);
        io.log(`restored\t${result.count}\tgeneration=${result.generation}`);
        exit(0);
      } catch { io.error('secret backup restore failed'); exit(1); }
    });
  options(backup.command('status').description('Show member-scoped backup presence without secret values.'))
    .action(async (value: CliOptions) => {
      try {
        const result = await statusSecretBackup(context(value), deps);
        io.log(`backup\t${result.remote}\tremote=${result.generation ?? 'none'}\tlocal=${result.localGeneration ?? 'none'}`);
        exit(0);
      } catch { io.error('secret backup status failed'); exit(1); }
    });
  return backup;
}
