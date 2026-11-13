import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/** Read the private file issued by elanous member key create; never log its value. */
export function readRelayMemberKeyFile(path: string): string {
  try {
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('unsafe');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let key: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe');
      key = readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
    if (!/^emk_[A-Za-z0-9]{1,43}$/.test(key)) throw new Error('invalid');
    return key;
  } catch { throw new Error('relay member key unavailable'); }
}

export interface RelayMemberTokenProviderOptions {
  nexusUrl: string;
  readMemberKey: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  /** @internal Short deadline for focused liveness tests; production defaults to 10 seconds. */
  mintTimeoutMsForTesting?: number;
}

/** Mint a short-lived, host-bound relay token on each outbound connection attempt. */
export function createRelayMemberTokenProvider(options: RelayMemberTokenProviderOptions): (serverId: string, signal?: AbortSignal) => Promise<string> {
  const origin = new URL(options.nexusUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/') throw new Error('relay member Nexus URL must be an HTTPS origin');
  const mintTimeoutMs = options.mintTimeoutMsForTesting ?? 10_000;
  if (!Number.isSafeInteger(mintTimeoutMs) || mintTimeoutMs < 1 || mintTimeoutMs > 60_000) {
    throw new Error('invalid relay member token mint timeout');
  }
  const endpoint = new URL('/v1/tokens', origin);
  return async (serverId, signal) => {
    if (!/^[a-f0-9]{64}$/.test(serverId)) throw new Error('invalid relay serverId');
    if (signal?.aborted) throw new Error('relay member token mint aborted');
    const controller = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const abortMint = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      rejectCancelled(new Error('relay member token mint aborted'));
    };
    const timer = setTimeout(abortMint, mintTimeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abortMint, { once: true });
    try {
      let memberKey: string;
      try { memberKey = await Promise.race([Promise.resolve().then(options.readMemberKey), cancelled]); }
      catch { throw new Error('relay member key unavailable'); }
      if (!/^emk_[A-Za-z0-9_-]+$/.test(memberKey)) throw new Error('relay member key unavailable');
      let response: Response;
      try {
        response = await Promise.race([(options.fetchImpl ?? fetch)(endpoint, {
          method: 'POST', headers: { authorization: `Bearer ${memberKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ scopes: ['relay.connect'], ttlSec: 600, audience: serverId }),
          cache: 'no-store', signal: controller.signal,
        }), cancelled]);
      } catch { throw new Error('relay member token mint failed'); }
      if (response.status !== 201) throw new Error('relay member token mint rejected');
      let payload: unknown;
      try { payload = await Promise.race([response.json(), cancelled]); } catch { throw new Error('invalid relay member token response'); }
      const token = (payload as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || !/^emt_[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error('invalid relay member token response');
      }
      return token;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortMint);
    }
  };
}
