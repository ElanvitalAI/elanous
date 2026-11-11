import { expect, test } from 'bun:test';
import { resolveDashboardChatMainSubmitIntent } from './chat-main-submit-route.js';

test.each(['quit', 'exit', '종료', '그만'])('bare %s is submitted as ordinary chat text', (text) => {
  expect(resolveDashboardChatMainSubmitIntent(text, { stickyBackend: null })).toMatchObject({
    kind: 'submit-turn',
    route: 'plain',
    text,
  });
});

test.each(['/quit', '/exit'])('%s remains an explicit slash control', (text) => {
  expect(resolveDashboardChatMainSubmitIntent(text, { stickyBackend: null })).toMatchObject({
    kind: 'control-turn',
    command: 'slash-command',
    commandText: text,
  });
});
