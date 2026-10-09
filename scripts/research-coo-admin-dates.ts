import { readFile } from 'node:fs/promises';
import { searchFirecrawl } from '../skills/omni-crawl/src/firecrawl.js';

type Check = { identifier: string; query: string; inspectedLead: { url: string } | null };
type Search = (query: string, options: { limit: number }) => Promise<{ items: Array<{ url?: string }> }>;

export async function recheckCooAdminLeads(checks: Check[], search: Search): Promise<string[]> {
  let verified = 0;
  let withUrl = 0;
  let withoutUrl = 0;
  const lines: string[] = [];
  for (const check of checks) {
    const result = await search(check.query, { limit: 3 });
    const recordedUrl = check.inspectedLead?.url?.trim();
    if (!recordedUrl) {
      withoutUrl++;
      lines.push(`${check.identifier} hits=${result.items.length} recordedUrl=none (not verified) query=${check.query}`);
      continue;
    }
    withUrl++;
    const found = result.items.some(item => item.url === recordedUrl);
    if (found) verified++;
    lines.push(`${check.identifier} hits=${result.items.length} recordedUrlVerified=${found} query=${check.query}`);
  }
  lines.push(`SEARCH checked=${checks.length} recordedUrlVerified=${verified}/${withUrl} noRecordedUrl=${withoutUrl} recordedUrlNotInCurrentTop3=${withUrl - verified} (search rankings change; no official date inferred)`);
  return lines;
}

if (import.meta.main) {
  const evidence = JSON.parse(await readFile(new URL('../src/domains/coo-admin-dates.evidence.json', import.meta.url), 'utf8')) as {
    verifiedIssues: Array<{ identifier: string }>;
    research: { issueChecks: Check[] };
  };
  const checks = evidence.research.issueChecks;
  if (checks.length !== 29 || checks.some((check, index) => check.identifier !== evidence.verifiedIssues[index]?.identifier || !check.query)) {
    throw new Error('29 issue search queries do not match recorded issue identifiers');
  }
  for (const line of await recheckCooAdminLeads(checks, searchFirecrawl)) console.log(line);
}
