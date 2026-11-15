import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLockSync } from '../storage/file-lock.js';
import { issueToPrivateFile } from './member-key-token-cli.js';
import type { IssuedMemberKey } from '../nexus/members/member-store.js';

const ORIGIN = 'https://api.elanous.ai';
const MAX_CONFIG_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Deliver a newly issued key directly to this machine; never accept a caller key. */
export async function connectMemberRelay(input: {
  configDir: string; sessionToken: string; fetchImpl: typeof fetch;
}): Promise<void> {
  const keyPath = join(input.configDir, 'relay-member-' + randomUUID() + '.key');
  let published = false;
  try {
    const response = await input.fetchImpl(ORIGIN + '/v1/member/keys', {
      method: 'POST', headers: { authorization: 'Bearer ' + input.sessionToken,
        'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: 'local-relay' }), credentials: 'omit', redirect: 'error',
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 201) { await response.body?.cancel(); throw new Error(); }
    const value: unknown = await response.json();
    if (!object(value) || typeof value.key !== 'string' || !/^emk_[A-Za-z0-9]{1,43}$/.test(value.key)
      || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error();
    // Reuse the issuer's exclusive 0600 writer and fsync behavior. The response
    // is private in-memory delivery, never a log, shell argument or artifact.
    issueToPrivateFile(keyPath, deliver => { deliver(value as unknown as IssuedMemberKey); return value as unknown as IssuedMemberKey; });
    published = true;
    const configPath = join(input.configDir, 'config.json');
    withFileLockSync(configPath + '.lock', () => {
      let config: Record<string, unknown> = {};
      let fd: number | undefined;
      try {
        fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES
          || process.getuid && stat.uid !== process.getuid()) throw new Error();
        const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
        if (!object(parsed)) throw new Error();
        config = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A dangling symlink is not an absent config.
        try { lstatSync(configPath); throw new Error(); }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
      } finally { if (fd !== undefined) closeSync(fd); }
      if (config.nexus !== undefined && !object(config.nexus)) throw new Error();
      const nexus = config.nexus as Record<string, unknown> | undefined;
      if (nexus?.relay !== undefined && !object(nexus.relay)) throw new Error();
      const relay = nexus?.relay as Record<string, unknown> | undefined;
      // Existing credentials belong to their own enrollment. Never silently
      // replace them, even if they happen to point at the same member service.
      if (relay?.memberKeyFile !== undefined || relay?.memberNexusUrl !== undefined) throw new Error();
      const next = { ...config, nexus: { ...nexus, relay: { ...relay,
        memberKeyFile: keyPath, memberNexusUrl: ORIGIN } } };
      const temporary = configPath + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, configPath);
      } finally { try { unlinkSync(temporary); } catch { /* already committed */ } }
    });
  } catch {
    if (published) { try { unlinkSync(keyPath); } catch { /* report only generic failure */ } }
    throw new Error('회원 릴레이 키를 안전하게 연결하지 못했습니다.');
  }
}
