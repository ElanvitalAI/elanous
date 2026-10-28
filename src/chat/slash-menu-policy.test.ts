import { expect, test } from 'bun:test';
import { displayedSlashCommandNames, filterSlashCommands, SLASH_COMMANDS, SLASH_MENU_POLICY } from './index.js';

test('the first-use slash menu exposes ten required and five reserve commands', () => {
  expect(SLASH_MENU_POLICY.required).toHaveLength(10);
  expect(SLASH_MENU_POLICY.reserve).toHaveLength(5);
  expect(new Set([...SLASH_MENU_POLICY.required, ...SLASH_MENU_POLICY.reserve]).size).toBe(15);
  for (const name of [...SLASH_MENU_POLICY.required, ...SLASH_MENU_POLICY.reserve]) {
    expect(SLASH_COMMANDS.find((command) => command.name === name)?.hidden).toBe(false);
  }
  expect(SLASH_COMMANDS.filter((command) => !command.hidden).map((command) => command.name).sort())
    .toEqual([...SLASH_MENU_POLICY.required, ...SLASH_MENU_POLICY.reserve].sort());
});

test('commands outside the 15-item policy are hidden from menu suggestions', () => {
  const names = (text: string) => filterSlashCommands(text, SLASH_COMMANDS).map((command) => command.name);
  expect(names('')).toContain('session');
  expect(names('ses')).toContain('session');
  expect(displayedSlashCommandNames()).toContain('session');
  expect(names('')).not.toContain('research');
  expect(displayedSlashCommandNames()).not.toContain('research');
  expect(names('')).toContain('status');
});
