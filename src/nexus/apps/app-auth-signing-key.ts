import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSecretAsync, setSecretAsync } from '../config/secrets/index.js';
import { getTestStateRoot } from '../paths.js';
import { withFileLockSync } from '../../storage/file-lock.js';

export const APP_AUTH_SIGNING_KEY_ID = 'nexus.app-auth-signing-key';

/** A distinct test-root file makes an old copied operating secret unusable without reading it. */
function getOrCreateTestSigningKey(testRoot: string): string {
  const dir = join(resolve(testRoot), 'nexus');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('test app auth key directory is unsafe');
  const path = join(dir, 'app-auth-test-signing-key');
  return withFileLockSync(`${path}.lock`, () => {
    let file;
    try { file = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (file) {
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
        throw new Error('test app auth signing key file is unsafe');
      const key = readFileSync(path, 'utf8');
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('test app auth signing key is invalid');
      return key;
    }
    const key = randomBytes(32).toString('base64url');
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } finally {
      try { unlinkSync(tmp); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return key;
  }, { breakDeadHolder: true });
}

/** Nexus boot uses a test-only file in test mode and the selected secret backend in operating mode. */
export async function getOrCreateAppAuthSigningKey(): Promise<string> {
  const testRoot = getTestStateRoot();
  if (testRoot) return getOrCreateTestSigningKey(testRoot);
  let key = await getSecretAsync(APP_AUTH_SIGNING_KEY_ID);
  if (!key) {
    key = randomBytes(32).toString('base64url');
    await setSecretAsync(APP_AUTH_SIGNING_KEY_ID, key);
  }
  return key;
}
