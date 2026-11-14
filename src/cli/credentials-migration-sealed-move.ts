import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { getSecretAsync, listSecretIdsAsync, selectBackendFromConfig } from '../nexus/config/secrets/index.js';
import { isExportableMigrationStaticId, migrationStaticSlots } from './credentials-migration-bundle.js';
import { writeBundleNoReplace } from './credentials-migration-cli.js';
import { defaultFileSealedBackend } from './credentials-migration-sealed-file-backend.js';
import { importSealedStaticMigration, sealStaticMigration, type AtomicSealedStaticBackend } from './credentials-migration-sealed.js';

const MAX_BUNDLE_BYTES = 1024 * 1024;
const fingerprintPattern = /^[a-f0-9]{64}$/;

export interface SealedMoveCliDeps {
  initializeBackend?: () => void;
  listSecrets?: () => Promise<string[]>;
  getSecret?: (id: string) => Promise<string | undefined>;
  readPublicKey?: (path: string) => Uint8Array;
  readPrivateKey?: (path: string) => Uint8Array;
  readBundle?: (path: string) => string;
  writeBundle?: (path: string, contents: string) => void;
  confirm?: (prompt: string) => Promise<string>;
  isInteractive?: () => boolean;
  backend?: () => AtomicSealedStaticBackend | undefined;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

function refuse(): never { throw new Error('SEALED_MOVE_REFUSED'); }

function readBounded(path: string, maxBytes: number, privateFile: boolean): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || stat.size === 0
      || (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) refuse();
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function decodeKey(path: string, privateFile: boolean): Uint8Array {
  const encoded = readBounded(path, 256, privateFile).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) refuse();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) refuse();
  return key;
}

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }

function equalFingerprint(left: string, right: string): boolean {
  return fingerprintPattern.test(left) && fingerprintPattern.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function confirmTyped(value: string, prompt: string, ask: (prompt: string) => Promise<string>): Promise<void> {
  if ((await ask(prompt)).trim() !== value) refuse();
}

async function askTerminal(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try { return await input.question(prompt); } finally { input.close(); }
}

interface MoveOptions {
  to: string;
  out?: string;
  in?: string;
  publicKey?: string;
  privateKey?: string;
  fingerprint?: string;
  keyVersion?: string;
  approveSha256?: string;
}

/** Registers the explicit, untrusted local machine move surface with narrow file-store apply. */
export function registerSealedMoveCommand(secret: Command, deps: SealedMoveCliDeps = {}): Command {
  const io = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const initialize = deps.initializeBackend ?? selectBackendFromConfig;
  const list = deps.listSecrets ?? listSecretIdsAsync;
  const get = deps.getSecret ?? getSecretAsync;
  const ask = deps.confirm ?? askTerminal;
  const interactive = deps.isInteractive ?? (() => process.stdin.isTTY === true && process.stderr.isTTY === true);
  const readPublicKey = deps.readPublicKey ?? ((path: string) => decodeKey(path, false));
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => decodeKey(path, true));
  const readBundle = deps.readBundle ?? ((path: string) => readBounded(path, MAX_BUNDLE_BYTES, true));
  const writeBundle = deps.writeBundle ?? writeBundleNoReplace;
  const move = secret.command('move').description('Manually approved sealed static-key move; no automatic source deletion.');
  move.error = (_message, options) => secret.error('secret move failed', options);
  move.requiredOption('--to <machine-id>')
    .option('--out <private-file>', 'Seal to a new private file')
    .option('--in <private-file>', 'Import a sealed private file')
    .requiredOption('--public-key <file>', 'Pinned target public key (base64 raw 32 bytes)')
    .requiredOption('--fingerprint <sha256>', 'Out-of-band SHA256 of target public key')
    .requiredOption('--key-version <integer>', 'Target key version')
    .option('--private-key <file>', 'Receiver private key for import (0600)')
    .option('--approve-sha256 <sha256>', 'Out-of-band envelope digest for import')
    .allowExcessArguments(false)
    .action(async (options: MoveOptions) => {
      try {
        if (!interactive() || Boolean(options.out) === Boolean(options.in)
          || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.to)
          || !/^[1-9][0-9]*$/.test(options.keyVersion ?? '')) refuse();
        const keyVersion = Number(options.keyVersion);
        if (!Number.isSafeInteger(keyVersion)) refuse();
        const publicKey = readPublicKey(options.publicKey!);
        const fingerprint = options.fingerprint ?? '';
        if (!equalFingerprint(sha256(publicKey), fingerprint)) refuse();
        if (options.out) {
          if (options.privateKey || options.approveSha256) refuse();
          initialize();
          const ids = (await list()).filter((id) => isExportableMigrationStaticId(id)
            && !migrationStaticSlots(id)?.includes('telegram'));
          await confirmTyped(options.to, `manual-untrusted export · target ${options.to} · fingerprint ${fingerprint} · ${ids.length} static slots. Type machine ID: `, ask);
          const staticSecrets: Record<string, string> = {};
          for (const id of ids) {
            const value = await get(id);
            if (value === undefined) refuse();
            staticSecrets[id] = value;
          }
          const serialized = await sealStaticMigration({ targetMachine: options.to, targetKeyVersion: keyVersion,
            targetPublicKey: publicKey, pinnedFingerprint: fingerprint, staticSecrets });
          writeBundle(options.out, serialized);
          io.log(`sealed export written · static=${ids.length} · envelopeSha256=${sha256(serialized)} · manual-untrusted source; no source deletion`);
        } else {
          if (!options.privateKey || !options.approveSha256 || !fingerprintPattern.test(options.approveSha256)) refuse();
          const serialized = readBundle(options.in!);
          const envelopeSha256 = sha256(serialized);
          if (!equalFingerprint(envelopeSha256, options.approveSha256)) refuse();
          const privateKey = readPrivateKey(options.privateKey);
          const backend = deps.backend ? deps.backend() : (initialize(), defaultFileSealedBackend());
          if (!backend) refuse();
          await confirmTyped(envelopeSha256, `manual-untrusted import · target ${options.to} · fingerprint ${fingerprint} · SHA ${envelopeSha256}. Verify source out of band; type SHA256: `, ask);
          const result = await importSealedStaticMigration({ serialized, targetMachine: options.to,
            targetKeyVersion: keyVersion, targetPublicKey: publicKey, targetPrivateKey: privateKey,
            pinnedFingerprint: fingerprint, approval: { mode: 'manual-untrusted', envelopeSha256,
              sourceConfirmedOutOfBand: true }, backend });
          io.log(`sealed import ${result.status} · static=${result.staticCount} · bundleId=${result.bundleId} · no source deletion`);
        }
        exit(0);
      } catch {
        io.error('secret move refused · no values displayed or partial restore authorized');
        exit(1);
      }
    });
  return move;
}
