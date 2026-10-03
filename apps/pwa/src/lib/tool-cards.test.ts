import { describe, expect, test } from 'bun:test';
import { pushToolCards, type ChatBlock } from './chat-runtime';
import { extractElanousCards, type ElanousCardData } from './elanous-card';

const card: ElanousCardData = { kind: 'coo-admin', items: [{ title: '세금 신고', due: '2026-10-05', daysLeft: 3, state: 'open', owner: 'OP' }] };
const answer = `할 일 1건\n\`\`\`elanous-card\n${JSON.stringify(card)}\n\`\`\``;

describe('REL9p pushToolCards', () => {
  test('a tool answer with a card adds one text block that renders as that card', () => {
    const blocks: ChatBlock[] = [{ kind: 'tool_use', id: 't', name: 'coo_admin', status: 'done' }];
    expect(pushToolCards(blocks, { output: answer })).toBe(true);
    expect(blocks).toHaveLength(2);
    const added = blocks[1] as Extract<ChatBlock, { kind: 'text' }>;
    expect(extractElanousCards(added.text).cards).toEqual([card]);
  });
  test('the same card is not added twice; outputs without cards add nothing', () => {
    const blocks: ChatBlock[] = [];
    pushToolCards(blocks, answer);
    expect(pushToolCards(blocks, answer)).toBe(false);
    expect(pushToolCards(blocks, { output: 'plain' })).toBe(false);
    expect(blocks).toHaveLength(1);
  });
});
