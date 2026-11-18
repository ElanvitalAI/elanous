/**
 * Minimal browser cookie jar for member-flow simulations (Terra #37957 MF1: no hand-injected
 * cookies). It stores Set-Cookie from responses and attaches matching cookies to later requests,
 * the way a browser does for `credentials: 'include'`. Scope: host-only and Domain cookies, Path
 * prefix, Secure (https only), Max-Age/Expires, `__Host-` prefix rules. Not a full RFC 6265 parser.
 */
export interface SimCookie {
  readonly name: string;
  readonly value: string;
  readonly host: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expiresAt?: number;
}

export function createSimCookieJar(now: () => number = Date.now) {
  let cookies: SimCookie[] = [];
  const live = (cookie: SimCookie) => cookie.expiresAt === undefined || cookie.expiresAt > now();
  const domainMatch = (cookie: SimCookie, host: string) =>
    cookie.hostOnly ? host === cookie.host : host === cookie.host || host.endsWith(`.${cookie.host}`);
  const pathMatch = (cookiePath: string, path: string) =>
    path === cookiePath || path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);

  function store(url: URL, header: string): void {
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
    const split = pair.indexOf('=');
    if (split <= 0) return;
    const name = pair.slice(0, split);
    const value = pair.slice(split + 1);
    let domain: string | undefined;
    let path = '/';
    let secure = false;
    let httpOnly = false;
    let expiresAt: number | undefined;
    for (const attribute of attributes) {
      const [key = '', ...rest] = attribute.split('=');
      const attributeValue = rest.join('=');
      switch (key.toLowerCase()) {
        case 'domain': domain = attributeValue.replace(/^\./, '').toLowerCase(); break;
        case 'path': path = attributeValue || '/'; break;
        case 'secure': secure = true; break;
        case 'httponly': httpOnly = true; break;
        case 'max-age': expiresAt = now() + Number(attributeValue) * 1000; break;
        case 'expires': expiresAt ??= Date.parse(attributeValue); break;
      }
    }
    // A browser rejects these instead of storing them.
    if (secure && url.protocol !== 'https:') return;
    if (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/')) return;
    if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return;
    const host = domain ?? url.hostname;
    cookies = cookies.filter((cookie) => !(cookie.name === name && cookie.host === host && cookie.path === path));
    const cookie: SimCookie = { name, value, host, hostOnly: domain === undefined, path, secure, httpOnly,
      ...(expiresAt !== undefined ? { expiresAt } : {}) };
    if (live(cookie)) cookies.push(cookie);
  }

  function header(url: URL): string | undefined {
    const matched = cookies.filter((cookie) => live(cookie) && domainMatch(cookie, url.hostname)
      && pathMatch(cookie.path, url.pathname) && (!cookie.secure || url.protocol === 'https:'));
    return matched.length ? matched.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
  }

  /**
   * A `fetch` as a page on `pageOrigin` would issue it: the jar adds cookies, the browser adds
   * Origin on cross-origin and non-GET requests, and Set-Cookie from the response is stored.
   */
  function browserFetch(handler: (request: Request) => Promise<Response | null | undefined>, pageOrigin: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      const cookie = init?.credentials === 'omit' ? undefined : header(url);
      if (cookie) headers.set('cookie', cookie);
      if (url.origin !== pageOrigin || (init?.method ?? 'GET').toUpperCase() !== 'GET') headers.set('origin', pageOrigin);
      const response = await handler(new Request(url, { ...init, headers })) ?? new Response('not found', { status: 404 });
      for (const value of response.headers.getSetCookie()) store(url, value);
      return response;
    }) as typeof fetch;
  }

  return { store, header, browserFetch, snapshot: (): readonly SimCookie[] => cookies.filter(live) };
}
