import { expect, test } from 'bun:test';
import { filterSlashCommands, SLASH_COMMANDS } from './index.js';

test('persona is discoverable in the TUI slash picker with removal suggestion', () => {
  const matches = filterSlashCommands('persona', SLASH_COMMANDS);
  expect(matches[0]?.name).toBe('persona');
  expect(matches[0]?.description).toContain('이 대화의 페르소나 보기·고르기·빼기');
  expect(matches[0]?.subcommands).toContain('-');
});
