import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/** Explicit operator projection; search listing is not an access grant. */
export function loadPublicAppReadConfig(path: string): ReadonlySet<string> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('safe open unavailable');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    // Source: existing relay owner-only config policy; bound startup config I/O.
    const maxConfigBytes = 64 * 1024;
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxConfigBytes
      || process.getuid && stat.uid !== process.getuid()) throw new Error('public read config must be an owner-only regular file');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'apps'
      || !Array.isArray((value as { apps?: unknown }).apps)) throw new Error('invalid public read config');
    const result = new Set<string>();
    for (const entry of (value as { apps: unknown[] }).apps) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).sort().join() !== 'app,user') throw new Error('invalid public read app');
      const { app, user } = entry as { app?: unknown; user?: unknown };
      if (typeof app !== 'string' || typeof user !== 'string' || app.includes('/') || user.includes('/')) throw new Error('invalid public read app');
      const key = user + '/' + app;
      if (result.has(key)) throw new Error('duplicate public read app');
      result.add(key);
    }
    return result;
  } finally { closeSync(fd); }
}

export function isAnonymousPublicAppRead(request: Request, user: string, app: string, allowed: ReadonlySet<string>): boolean {
  const path = new URL(request.url).pathname;
  return (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('upgrade')
    && path !== '/host' && path !== '/client' && !path.startsWith('/.well-known/elanous/')
    && allowed.has(user + '/' + app);
}
