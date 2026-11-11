import { describe, expect, test } from 'bun:test';

import { SLASH_COMMANDS } from '../src/chat/index.js';

describe('/tablet command registration', () => {
  test('SLASH_COMMANDS keeps tablet controls after retiring the preview modal', () => {
    const cmd = SLASH_COMMANDS.find(c => c.name === 'tablet');
    expect(cmd).toBeDefined();
    expect(cmd!.subcommands).toEqual(['on', 'off', 'toggle', 'auto', 'status']);
  });
});
