type AuthRequiredDetail = { path: string };

const EVENT_NAME = 'elanous:auth-required';
let reportedPath: string | null = null;
let dismissed = false;

export function reportAuthRequired(path: string): void {
  if (typeof window === 'undefined' || reportedPath !== null) return;
  reportedPath = path;
  window.dispatchEvent(new CustomEvent<AuthRequiredDetail>(EVENT_NAME, { detail: { path } }));
}

export function onAuthRequired(cb: (detail: AuthRequiredDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const target = window;
  const listener = (event: Event): void => cb((event as CustomEvent<AuthRequiredDetail>).detail);
  target.addEventListener(EVENT_NAME, listener);
  // The first 401 may precede the shell mount, but a dismissed notice must not return.
  if (reportedPath !== null && !dismissed) cb({ path: reportedPath });
  return () => target.removeEventListener(EVENT_NAME, listener);
}

/** Has any request been answered 401 (this device is not connected)? The chat's connect card reads it. */
export function authRequiredNow(): boolean {
  return reportedPath !== null;
}

/** Subscribe to the first 401 regardless of the banner's dismissal (the chat card is not dismissible). */
export function onAuthRequiredEvent(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (): void => cb();
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

/** A fresh connection (token pasted or claimed): the next 401 is news again (token expiry later in the session). */
export function clearAuthRequired(): void {
  reportedPath = null;
  dismissed = false;
}

export function dismissAuthRequired(): void {
  dismissed = true;
}

export function resetAuthRequiredForTests(): void {
  reportedPath = null;
  dismissed = false;
}
