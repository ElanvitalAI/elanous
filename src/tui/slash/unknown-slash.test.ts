import { expect, test } from 'bun:test';
import { suggestSlashCommands, unknownSlashNotice } from './unknown-slash.js';

const known = ['/quit', '/exit', '/help', '/new', '/clear', '/status', '/st', '/session', '/model', '/provider', '/memory'];

test('a mistyped command is refused with suggestions instead of going to the model', () => {
  expect(unknownSlashNotice('/foo', known)).toEqual(['Unknown command: /foo · not sent to the model', 'See /help for the command list']);
  const notice = unknownSlashNotice('/stauts please', known)!;
  expect(notice[0]).toContain('/stauts');
  expect(notice[1]).toContain('/status');
  expect(suggestSlashCommands('/hel', known)).toContain('/help');
});

test('paths, double slash and prose are not commands and still reach the model', () => {
  for (const text of ['/Users/user/a.ts 읽어줘', '//help', '/', '/ foo', 'see /foo', '/1abc', '/a/b']) {
    expect(unknownSlashNotice(text, known)).toBeNull();
  }
});
