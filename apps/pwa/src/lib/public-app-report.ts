export type PublicReportCategory = 'abuse' | 'phishing' | 'spam';

/** Accept a public app hostname only; URLs, query strings and credentials are never submitted. */
export function publicReportHost(input: string): string | null {
  const host = input.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.elanous\.(?:app|ai)$/.test(host)
    ? host : null;
}

export async function submitPublicAppReport(host: string, category: PublicReportCategory, fetcher: typeof fetch = fetch): Promise<boolean> {
  const target = publicReportHost(host);
  if (!target || !['abuse', 'phishing', 'spam'].includes(category)) return false;
  const response = await fetcher(`https://${target}/.well-known/elanous/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category }), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  });
  return response.status === 202;
}
