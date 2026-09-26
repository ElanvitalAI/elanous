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

export function dismissAuthRequired(): void {
  dismissed = true;
}

export function resetAuthRequiredForTests(): void {
  reportedPath = null;
  dismissed = false;
}
