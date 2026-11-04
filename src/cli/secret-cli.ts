import type { Command } from 'commander';
import {
  currentBackendId,
  deleteSecretAsync,
  getSecretAsync,
  listSecretIdsAsync,
  selectBackendFromConfig,
  setSecretAsync,
} from '../nexus/config/secrets/index.js';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import { verifyServiceKey, type ServiceKeyVerification } from '../setup/service-keys.js';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';

export interface SecretCliDeps {
  isInteractive?: () => boolean;
  promptSecret?: (message: string) => Promise<string | undefined>;
  saveSecret?: (id: string, value: string) => Promise<void>;
  getSecret?: (id: string) => Promise<string | undefined>;
  listSecrets?: () => Promise<string[]>;
  removeSecret?: (id: string) => Promise<boolean>;
  verifySecret?: (serviceId: string, value: string) => Promise<{ result: ServiceKeyVerification; httpStatus?: number }>;
  storageBackend?: () => string;
  initializeBackend?: () => void;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validId(id: string): boolean {
  return SECRET_ID_PATTERN.test(id);
}

function redactParserErrors(command: Command): void {
  const originalError = command.error.bind(command);
  command.error = (_message, errorOptions) => originalError('secret command failed', errorOptions);
}

function resolveDeps(deps: SecretCliDeps) {
  return {
    isInteractive: deps.isInteractive ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    promptSecret: deps.promptSecret ?? createSecretPrompt(),
    saveSecret: deps.saveSecret ?? setSecretAsync,
    getSecret: deps.getSecret ?? getSecretAsync,
    listSecrets: deps.listSecrets ?? listSecretIdsAsync,
    removeSecret: deps.removeSecret ?? deleteSecretAsync,
    verifySecret: deps.verifySecret ?? (async (serviceId: string, value: string) => verifyServiceKey(serviceId, value)),
    storageBackend: deps.storageBackend ?? currentBackendId,
    initializeBackend: deps.initializeBackend ?? (() => { selectBackendFromConfig(); }),
    output: deps.output ?? console,
    setExitCode: deps.setExitCode ?? ((code: number) => { process.exitCode = code; }),
  };
}

export function registerSecretCommands(program: Command, deps: SecretCliDeps = {}): Command {
  const cli = resolveDeps(deps);
  const secret = program.command('secret').description('Store and manage API keys without displaying their values.');
  // Commander shares output configuration across parent/child commands. Override
  // error handling on this command tree instead so sibling commands keep theirs.
  redactParserErrors(secret);

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
        await cli.saveSecret(id, value);
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
    .description('Remove a stored secret by name.')
    .allowExcessArguments(false)
    .action(async (id: string) => {
      if (!validId(id)) {
        cli.output.error('invalid secret identifier');
        cli.setExitCode(1);
        return;
      }
      try {
        cli.initializeBackend();
        const removed = await cli.removeSecret(id);
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

  for (const command of [setCommand, listCommand, removeCommand, testCommand]) redactParserErrors(command);
  return secret;
}
