import { describe, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../src/chat/index.js';

describe('ACP chat-mode slash', () => {
  test('/acp description reflects chat mode, not VW spawning', () => {
    const cmd = SLASH_COMMANDS.find(command => command.name === 'acp');
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/chat/i);
    expect(cmd!.description).not.toMatch(/inside a virtual window/i);
  });
});
