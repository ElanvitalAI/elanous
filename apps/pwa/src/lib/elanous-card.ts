// REL9p — ```elanous-card``` blocks that daemon tools (coo_admin · release) append to their
// human-readable answer. The shape is the server's contract (`src/domains/elanous-card.ts`,
// TC 10-02 17:08) — imported as a type so the two cannot drift again.
import type { ElanousCard } from '../../../../src/domains/elanous-card';

export type ElanousCardData = ElanousCard;
export type ElanousCardKind = ElanousCard['kind'];
export type ElanousCardItem = ElanousCard['items'][number];

const CARD_KINDS: readonly string[] = ['coo-admin', 'release-schedule', 'release-checklist'] satisfies ElanousCardKind[];
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function isCardData(value: unknown): value is ElanousCardData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return typeof card.kind === 'string' && CARD_KINDS.includes(card.kind)
    && Array.isArray(card.items)
    && card.items.every((item: unknown) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      return typeof row.title === 'string'
        && (row.due === null || (typeof row.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.due)))
        && (row.daysLeft === null || (typeof row.daysLeft === 'number' && Number.isFinite(row.daysLeft)))
        && typeof row.state === 'string' && typeof row.owner === 'string'
        && (row.url === undefined || typeof row.url === 'string');
    });
}

/** Preserve all unrecognized or incomplete fences so they remain visible as ordinary markdown. */
export function extractElanousCards(text: string): { text: string; cards: ElanousCardData[] } {
  const cards: ElanousCardData[] = [];
  const kept: string[] = [];
  let keptFrom = 0;
  let open: { marker: string; start: number; bodyStart: number; isCard: boolean } | undefined;

  for (const match of text.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const start = match.index;
    const content = line.replace(/\r?\n$/, '');

    if (!open) {
      const opening = FENCE_OPEN.exec(content);
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        open = {
          marker: opening[1],
          start,
          bodyStart: start + line.length,
          isCard: /^elanous-card[ \t]*$/.test(opening[2]),
        };
      }
      continue;
    }

    const closing = FENCE_CLOSE.exec(content);
    if (!closing || closing[1][0] !== open.marker[0] || closing[1].length < open.marker.length) continue;

    if (open.isCard) {
      try {
        const parsed: unknown = JSON.parse(text.slice(open.bodyStart, start));
        if (isCardData(parsed)) {
          cards.push(parsed);
          kept.push(text.slice(keptFrom, open.start));
          keptFrom = start + line.length;
        }
      } catch {
        // Leave the entire original fence unchanged when its JSON is malformed.
      }
    }
    open = undefined;
  }
  kept.push(text.slice(keptFrom));
  return { text: kept.join(''), cards };
}

/** Card fences found in a tool's raw output (string · `{ output }` · `{ text }` · MCP `{ content: [{ type: 'text', text }] }`).
 *  Returns only the valid card fences, re-serialized, or '' when there are none. The chat pill never shows a tool's
 *  output text, so this is how a card reaches the screen without depending on the model to copy it. */
export function cardTextFromToolOutput(rawOutput: unknown): string {
  const texts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') { texts.push(value); return; }
    if (depth > 2 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const record = value as Record<string, unknown>;
    for (const key of ['output', 'text', 'content', 'result']) if (key in record) visit(record[key], depth + 1);
  };
  visit(rawOutput, 0);
  const cards = texts.flatMap((text) => extractElanousCards(text).cards);
  return cards.map((card) => '```elanous-card\n' + JSON.stringify(card) + '\n```\n').join('');
}
