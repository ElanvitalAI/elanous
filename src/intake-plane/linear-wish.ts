import { fetchLinearIssues } from '../connectors/linear.js';
import { debug } from '../debug/log.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { CardStore } from '../task-cards/card-store.js';
import { createWishCard } from './wish-card.js';

export const LINEAR_WISH_KEY_MISSING = 'Linear 키가 없습니다 — elanous connector linear 로 먼저 등록하세요';

export async function scanLinearWishes({ teamKey, label = 'wish', store, deps = {} }: {
  teamKey: string;
  label?: string;
  store: CardStore;
  deps?: {
    getApiKey?: () => Promise<string | undefined>;
    fetchIssues?: typeof fetchLinearIssues;
  };
}): Promise<{ added: number; duplicate: number; failed: number }> {
  const apiKey = await (deps.getApiKey ?? (() => getSecretAsync('connector.linear.apiKey')))();
  if (!apiKey?.trim()) throw new Error(LINEAR_WISH_KEY_MISSING);
  let issues: Awaited<ReturnType<typeof fetchLinearIssues>>;
  try {
    issues = await (deps.fetchIssues ?? fetchLinearIssues)({ apiKey, teamKey, labelOrPrefix: label });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(apiKey, '[redacted]'));
  }
  let added = 0;
  let duplicate = 0;
  let failed = 0;
  for (const issue of issues) {
    try {
      const result = createWishCard({
        text: `${issue.title}\n\n${issue.body}\n\n${issue.url}`,
        source: 'linear', ref: issue.identifier ?? '',
      }, store);
      if (result.created) added++;
      else duplicate++;
    } catch {
      failed++;
    }
  }
  debug.log('intake.linear-wish', 'scanned', { teamKey, label, added, duplicate, failed });
  return { added, duplicate, failed };
}
