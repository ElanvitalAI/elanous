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
