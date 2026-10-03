export interface ElanousCard {
  kind: 'coo-admin' | 'release-schedule' | 'release-checklist';
  items: Array<{ title: string; due: string | null; daysLeft: number | null; state: string; owner: string; url?: string }>;
  meta?: Record<string, unknown>;
}

export function formatElanousCard(card: ElanousCard): string {
  return `\`\`\`elanous-card\n${JSON.stringify(card)}\n\`\`\``;
}

/** Reads every valid card block in a tool response; ignores unrelated prose and malformed blocks. */
export function parseElanousCard(text: string): ElanousCard[] {
  const cards: ElanousCard[] = [];
  for (const match of text.matchAll(/```elanous-card\r?\n([^\r\n]+)\r?\n```/g)) {
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (!value || typeof value !== 'object') continue;
      const card = value as Partial<ElanousCard>;
      if (!['coo-admin', 'release-schedule', 'release-checklist'].includes(card.kind ?? '') || !Array.isArray(card.items)) continue;
      if (!card.items.every(item => item && typeof item.title === 'string' &&
        (item.due === null || /^\d{4}-\d{2}-\d{2}$/.test(item.due)) &&
        (item.daysLeft === null || typeof item.daysLeft === 'number') &&
        typeof item.state === 'string' && typeof item.owner === 'string' &&
        (item.url === undefined || typeof item.url === 'string'))) continue;
      cards.push(card as ElanousCard);
    } catch { /* Other fenced content is not a card. */ }
  }
  return cards;
}
