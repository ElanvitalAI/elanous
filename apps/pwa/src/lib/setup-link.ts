export type SetupLinkClaim =
  | { status: 'claimed'; bearer: string; expiresAt: number }
  | { status: 'unsupported' }
  | { status: 'invalid' };

/** Only a dedicated setup-link hash can be treated as a claim token. */
export function readSetupLinkToken(hash: string): string | null {
  const match = /^#t=(els_[A-Za-z0-9_-]+)$/.exec(hash);
  return match?.[1] ?? null;
}

/** Claim a one-time link without ever using the link as a bearer credential. */
export async function claimSetupLink(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SetupLinkClaim> {
  if (!/^els_[A-Za-z0-9_-]+$/.test(token)) return { status: 'invalid' };
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/setup/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: token }),
    });
  } catch {
    return { status: 'invalid' };
  }
  if (response.status === 404 || response.status === 405) return { status: 'unsupported' };
  if (!response.ok) return { status: 'invalid' };
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return { status: 'invalid' };
  const claim = body as Record<string, unknown>;
  if (claim.scope !== 'setup' || typeof claim.bearer !== 'string' || !claim.bearer ||
      typeof claim.expiresAt !== 'number' || !Number.isFinite(claim.expiresAt)) {
    return { status: 'invalid' };
  }
  return { status: 'claimed', bearer: claim.bearer, expiresAt: claim.expiresAt };
}
