// CRED-TYPED-SLOT-MOVE-PATH — static API key `cred:` slots move between isolated stores through the
// encrypted bundle, rotating login (OAuth/refresh) slots never do, and `secret set` takes piped input
// without echo. Every value here is synthetic; HOME, config dir and state dir are temp directories.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { getSecretAsync, importSecretBatchAsync, setCredentialSlotAsync, useBackend } from '../nexus/config/secrets/index.js';
import { decryptSecretBundle, encryptSecretBundle } from '../nexus/config/secrets/transfer.js';
import { SECRETS_VERSION } from '../nexus/config/types.js';
import { registerSecretCommands, type SecretCliDeps } from './secret-cli.js';

const PASSPHRASE = 'synthetic-bundle-passphrase';
const FIRECRAWL = 'synthetic-firecrawl-static-value';
const BRAVE = 'synthetic-brave-static-value';
const OAUTH = 'synthetic-rotating-refresh-value';

let root: string;
let sourceDir: string;
let targetDir: string;
const savedEnv = { HOME: process.env.HOME, ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cred-typed-slot-move-'));
  sourceDir = join(root, 'source-config');
  targetDir = join(root, 'target-config');
  process.env.HOME = join(root, 'home');
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  useBackend('file');
});
afterEach(() => {
  resetElanousConfigDir();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function harness(extra: SecretCliDeps = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, {
    isInteractive: () => true,
    isStdoutTTY: () => false,
    promptSecret: async () => PASSPHRASE,
    initializeBackend: () => { useBackend('file'); },
    storageBackend: () => 'file',
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
    ...extra,
  });
  const run = (...args: string[]) => program.parseAsync(['node', 'elanous', ...args]);
  const printed = () => [...output, ...errors].join('\n');
  return { run, output, errors, exitCodes, printed };
}

/** A rotating login slot can only exist through a foreign writer; plant it straight into the temp source file. */
function plantRotatingLoginSlot(configDir: string): void {
  const path = join(configDir, 'secrets.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: SECRETS_VERSION, secrets: {} };
  file.secrets['cred:codex-login'] = OAUTH;
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
}

test('cred export → import carries typed static-key slots between two isolated config dirs and excludes OAuth slots', async () => {
  setElanousConfigDir(sourceDir);
  await setCredentialSlotAsync('cred:firecrawl.api_key', FIRECRAWL);
  await setCredentialSlotAsync('cred:brave.api_key', BRAVE);
  plantRotatingLoginSlot(sourceDir);
  const bundlePath = join(root, 'bundle.enc');

  const exporter = harness();
  await exporter.run('cred', 'export', '--to', bundlePath);
  expect(exporter.exitCodes).toEqual([0]);
  const bundle = await decryptSecretBundle(readFileSync(bundlePath, 'utf8'), PASSPHRASE);
  expect(Object.keys(bundle.secrets).sort()).toEqual(['cred:brave.api_key', 'cred:firecrawl.api_key']);
  expect(readFileSync(bundlePath, 'utf8')).not.toContain(FIRECRAWL);

  setElanousConfigDir(targetDir);
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBeUndefined();
  const importer = harness();
  await importer.run('cred', 'import', bundlePath);
  expect(importer.errors).toEqual([]);
  expect(importer.exitCodes).toEqual([0]);
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBe(FIRECRAWL);
  expect(await getSecretAsync('cred:brave.api_key')).toBe(BRAVE);
  expect(await getSecretAsync('cred:codex-login')).toBeUndefined();
  for (const value of [FIRECRAWL, BRAVE, OAUTH, PASSPHRASE]) {
    expect(exporter.printed()).not.toContain(value);
    expect(importer.printed()).not.toContain(value);
  }
});

test('a bundle carrying an OAuth/refresh cred: slot is refused before any write; the store layer refuses it too', async () => {
  setElanousConfigDir(targetDir);
  const bundlePath = join(root, 'oauth-bundle.enc');
  writeFileSync(bundlePath, await encryptSecretBundle({ version: SECRETS_VERSION, secrets: {
    'cred:firecrawl.api_key': FIRECRAWL, 'cred:codex-login': OAUTH,
  } }, PASSPHRASE), { mode: 0o600 });
  const importer = harness();
  await importer.run('cred', 'import', bundlePath);
  expect(importer.exitCodes).toEqual([1]);
  expect(importer.errors.join('\n')).toContain('rotating login credentials that stay with their owner host: cred:codex-login');
  expect(importer.printed()).not.toContain(OAUTH);
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBeUndefined();

  for (const id of ['cred:codex-login', 'cred:claude.oauth_refresh_token', 'cred:openai.refresh_token']) {
    await expect(importSecretBatchAsync({ [id]: OAUTH }, true)).rejects.toThrow('ELANOUS_CREDENTIAL_SLOT_ROTATING_LOGIN_NOT_TRANSFERABLE');
  }
  await expect(importSecretBatchAsync({ 'cred:firecrawl.api_key': FIRECRAWL, 'cred:unknown.api_key': OAUTH }, true))
    .rejects.toThrow('ELANOUS_CREDENTIAL_SLOT_IMPORT_UNSUPPORTED');
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBeUndefined();
});

test('non-TTY secret set --value-fd stores a typed slot from a real descriptor without printing it', async () => {
  setElanousConfigDir(targetDir);
  const valuePath = join(root, 'value.txt');
  writeFileSync(valuePath, `${FIRECRAWL}\n`, { mode: 0o600 });
  const fd = openSync(valuePath, 'r');
  try {
    const cli = harness({ isInteractive: () => false, promptSecret: async () => { throw new Error('prompt must not run'); } });
    await cli.run('secret', 'set', 'cred:firecrawl.api_key', '--value-fd', String(fd));
    expect(cli.errors).toEqual([]);
    expect(cli.exitCodes).toEqual([0]);
    expect(cli.output).toEqual(['saved cred:firecrawl.api_key · file']);
    expect(cli.printed()).not.toContain(FIRECRAWL);
  } finally { closeSync(fd); }
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBe(FIRECRAWL);
});

test('non-TTY secret set --stdin reads a pipe without echo; terminal, empty, both-flag and unknown-flag input are refused', async () => {
  setElanousConfigDir(targetDir);
  const piped = harness({ isInteractive: () => false, isTerminalFd: () => false, readValueFd: async (fd) => (fd === 0 ? `${BRAVE}\n` : '') });
  await piped.run('secret', 'set', 'cred:brave.api_key', '--stdin');
  expect(piped.exitCodes).toEqual([0]);
  expect(piped.printed()).not.toContain(BRAVE);
  expect(await getSecretAsync('cred:brave.api_key')).toBe(BRAVE);

  const terminal = harness({ isInteractive: () => false, isTerminalFd: () => true, readValueFd: async () => { throw new Error('must not read a terminal'); } });
  await terminal.run('secret', 'set', 'cred:firecrawl.api_key', '--stdin');
  expect(terminal.exitCodes).toEqual([1]);
  expect(terminal.errors.join('\n')).toContain('refuses terminal input');

  for (const raw of ['', '\n', '   \n', 'two\nlines\n', 'nul\0byte']) {
    const empty = harness({ isInteractive: () => false, isTerminalFd: () => false, readValueFd: async () => raw });
    await empty.run('secret', 'set', 'cred:firecrawl.api_key', '--stdin');
    expect(empty.exitCodes).toEqual([1]);
    expect(empty.errors).toEqual(['secret value is empty or invalid']);
  }

  const both = harness({ isInteractive: () => false, isTerminalFd: () => false, readValueFd: async () => FIRECRAWL });
  await both.run('secret', 'set', 'cred:firecrawl.api_key', '--stdin', '--value-fd', '0');
  expect(both.exitCodes).toEqual([1]);
  const badFd = harness({ isInteractive: () => false });
  await badFd.run('secret', 'set', 'cred:firecrawl.api_key', '--value-fd', 'stdin');
  expect(badFd.exitCodes).toEqual([1]);

  const unknown = harness({ isInteractive: () => false });
  await expect(unknown.run('secret', 'set', 'cred:firecrawl.api_key', '--value', FIRECRAWL)).rejects.toThrow();
  expect(unknown.printed()).not.toContain(FIRECRAWL);

  const noFlag = harness({ isInteractive: () => false });
  await noFlag.run('secret', 'set', 'cred:firecrawl.api_key');
  expect(noFlag.exitCodes).toEqual([1]);
  expect(noFlag.errors.join('\n')).toContain('requires an interactive terminal');
  expect(await getSecretAsync('cred:firecrawl.api_key')).toBeUndefined();
});
