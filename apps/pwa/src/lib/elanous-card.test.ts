import { describe, expect, test } from 'bun:test';
import { cardTextFromToolOutput, extractElanousCards, type ElanousCardData } from './elanous-card';

const card: ElanousCardData = {
  kind: 'coo-admin',
  items: [{ title: 'Report', due: '2026-10-12', daysLeft: 3, state: 'open', owner: 'OP', url: 'https://example.com/report' }],
};
const fence = (body: string) => `\`\`\`elanous-card\n${body}\n\`\`\`\n`;

describe('extractElanousCards', () => {
  test('extracts valid cards in order and removes only their full fences', () => {
    const second: ElanousCardData = { kind: 'release-schedule', items: [{ title: 'Deploy', due: null, daysLeft: null, state: 'cut', owner: 'TC' }] };
    const input = `Before\n${fence(JSON.stringify(card))}Between\n${fence(JSON.stringify(second))}After`;
    expect(extractElanousCards(input)).toEqual({ text: 'Before\nBetween\nAfter', cards: [card, second] });
  });

  test('keeps malformed JSON, unknown kinds and invalid items verbatim while extracting valid neighbors', () => {
    const malformed = fence('{"kind":"coo-admin","items":[');
    const unknown = fence('{"kind":"alien","items":[]}');
    const invalid = fence('{"kind":"coo-admin","items":[{"title":12}]}');
    const input = `${malformed}${unknown}${fence(JSON.stringify(card))}${invalid}`;
    expect(extractElanousCards(input)).toEqual({ text: malformed + unknown + invalid, cards: [card] });
  });

  test('preserves a three-backtick card example inside a four-backtick code fence', () => {
    const example = '````markdown\n' + fence(JSON.stringify(card)) + '````\n';
    const input = `Before\n${example}${fence(JSON.stringify(card))}After`;
    expect(extractElanousCards(input)).toEqual({ text: `Before\n${example}After`, cards: [card] });
  });

  test('keeps a three-backtick card example inside a tilde code fence', () => {
    const example = '~~~markdown\n' + fence(JSON.stringify(card)) + '~~~\n';
    expect(extractElanousCards(example)).toEqual({ text: example, cards: [] });
  });

  test('extracts a four-backtick card and leaves an invalid body with a shorter closing fence untouched', () => {
    const valid = '````elanous-card\n' + JSON.stringify(card) + '\n````\n';
    const invalid = '````elanous-card\n' + JSON.stringify(card) + '\n```\n````\n';
    expect(extractElanousCards(valid + invalid)).toEqual({ text: invalid, cards: [card] });
  });

  test('leaves incomplete fences, ordinary code blocks and text untouched', () => {
    const input = 'Hello\n```elanous-card\n{"kind":"coo-admin","items":[]}\n' +
      '```json\n{"kind":"coo-admin","items":[]}\n```\n';
    expect(extractElanousCards(input)).toEqual({ text: input, cards: [] });
    expect(extractElanousCards('plain markdown')).toEqual({ text: 'plain markdown', cards: [] });
  });

  test('rejects the old invented shape (kind tasks · dueDate) — only the server contract renders', () => {
    const old = fence('{"kind":"tasks","items":[{"title":"x","dueDate":"2026-10-01"}]}');
    expect(extractElanousCards(old).cards).toEqual([]);
    const missingOwner = fence('{"kind":"coo-admin","items":[{"title":"x","due":null,"daysLeft":null,"state":"open"}]}');
    expect(extractElanousCards(missingOwner).cards).toEqual([]);
  });
});

describe('cardTextFromToolOutput', () => {
  const block = `요약 한 줄\n${fence(JSON.stringify(card))}`;
  test('finds cards in a plain string, { output }, and MCP text content', () => {
    for (const raw of [block, { output: block }, { content: [{ type: 'text', text: block }] }]) {
      expect(extractElanousCards(cardTextFromToolOutput(raw)).cards).toEqual([card]);
    }
  });
  test('returns empty for outputs without a valid card', () => {
    expect(cardTextFromToolOutput(undefined)).toBe('');
    expect(cardTextFromToolOutput({ output: 'no card' })).toBe('');
    expect(cardTextFromToolOutput(fence('{broken'))).toBe('');
  });
});
