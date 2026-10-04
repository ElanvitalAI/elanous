import { fetchLinearIssues } from '../connectors/linear.js';
import { debug } from '../debug/log.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { CardStore } from '../task-cards/card-store.js';
import { createWishCard } from './wish-card.js';

export const LINEAR_WISH_KEY_MISSING = 'Linear 키가 없습니다 — elanous connector linear 로 먼저 등록하세요';

type LinearWishDeps = {
  getApiKey?: () => Promise<string | undefined>;
  fetchIssues?: typeof fetchLinearIssues;
};

async function readLinearWishes(teamKey: string, options: { labelOrPrefix?: string; excludeLabel?: string }, deps: LinearWishDeps) {
  const apiKey = await (deps.getApiKey ?? (() => getSecretAsync('connector.linear.apiKey')))();
  if (!apiKey?.trim()) throw new Error(LINEAR_WISH_KEY_MISSING);
  try {
    return await (deps.fetchIssues ?? fetchLinearIssues)({ apiKey, teamKey, ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(apiKey, '[redacted]'));
  }
}

export interface LinearWishSuggestion { identifier: string; title: string; reason: string }

const WISH_PHRASES = [
  { pattern: /해\s*줘(?:요|라)?/, reason: '요청' },
  { pattern: /만들어(?:\s*줘(?:요)?)?/, reason: '제작' },
  { pattern: /원해(?:요)?/, reason: '희망' },
  { pattern: /있으면\s*좋겠다/, reason: '희망' },
];

export async function suggestLinearWishes({ teamKey, deps = {} }: {
  teamKey: string;
  deps?: LinearWishDeps;
}): Promise<LinearWishSuggestion[]> {
  const issues = await readLinearWishes(teamKey, { excludeLabel: 'wish' }, deps);
  return issues.flatMap(issue => {
    const match = WISH_PHRASES.find(({ pattern }) => pattern.test(`${issue.title}\n${issue.body}`));
    return match && issue.identifier
      ? [{ identifier: issue.identifier, title: Array.from(issue.title).slice(0, 40).join(''), reason: match.reason }]
      : [];
  });
}

export async function scanLinearWishes({ teamKey, label = 'wish', store, deps = {} }: {
  teamKey: string;
  label?: string;
  store: CardStore;
  deps?: LinearWishDeps;
}): Promise<{ added: number; duplicate: number; failed: number }> {
  const issues = await readLinearWishes(teamKey, { labelOrPrefix: label }, deps);
  let added = 0;
  let duplicate = 0;
  let failed = 0;
  for (const issue of issues) {
    try {
      const result = createWishCard({
        text: `${issue.title}\n\n${issue.body}\n\n${issue.url}`,
        source: 'linear', ref: issue.identifier ?? '',
        replyTo: { surface: 'linear', issueId: issue.ref },
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
