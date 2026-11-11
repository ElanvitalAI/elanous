/** The daemon owns the active graph registry; only exact authenticated routes bypass the owner bearer gate. */
export function isSelfVerifiedGraphWebhookRequest(method: string, pathname: string, daemon?: {
  isSelfVerifiedGraphWebhookRoute?: (method: string, path: string) => boolean;
}): boolean {
  const prefix = '/v1/workflows/webhooks/';
  if (!pathname.startsWith(prefix)) return false;
  return daemon?.isSelfVerifiedGraphWebhookRoute?.(method, pathname.slice(prefix.length - 1)) === true;
}
