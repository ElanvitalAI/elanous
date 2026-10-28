import { expect, test } from 'bun:test';
import { resolveDashboardChatMainSlashCommand } from './chat-main-slash-command.js';

test('/term new preserves shell quoting and whitespace inside the command', () => {
  expect(resolveDashboardChatMainSlashCommand(`/term new sh -c 'printf "a  b\\n"'`))
    .toEqual({ cmdLower: 'term', args: ['new', `sh -c 'printf "a  b\\n"'`] });
  expect(resolveDashboardChatMainSlashCommand('/terminal NEW codex -p seat'))
    .toEqual({ cmdLower: 'terminal', args: ['new', 'codex -p seat'] });
  expect(resolveDashboardChatMainSlashCommand('/term new'))
    .toEqual({ cmdLower: 'term', args: ['new'] });
});

test('/harness ask preserves the raw multiline ask tail', () => {
  const ask = '대상 경로: src/a.ts · src/b.ts\n수리 이유와 경계를 다음 줄에 적는다';
  expect(resolveDashboardChatMainSlashCommand(`/harness ask ${ask}`))
    .toEqual({ cmdLower: 'harness', args: ['ask', ask] });
});

test('other /harness commands keep whitespace tokenization', () => {
  expect(resolveDashboardChatMainSlashCommand('/harness list all'))
    .toEqual({ cmdLower: 'harness', args: ['list', 'all'] });
});
