import { expect, test } from 'bun:test';
import { resolveDashboardChatMainSubmitIntent } from './chat-main-submit-route.js';

test.each(['quit', 'exit', '종료', '그만'])('bare %s is submitted as ordinary chat text', (text) => {
  for (const stickyBackend of [null, 'codex']) {
    expect(resolveDashboardChatMainSubmitIntent(text, { stickyBackend })).toMatchObject({
      kind: 'submit-turn',
      route: stickyBackend ? 'sticky-acp' : 'plain',
      text,
    });
  }
});

test.each(['/quit', '/exit'])('%s remains an explicit slash control', (text) => {
  for (const stickyBackend of [null, 'codex']) {
    expect(resolveDashboardChatMainSubmitIntent(text, { stickyBackend })).toMatchObject({
      kind: 'control-turn',
      command: 'slash-command',
      commandText: text,
    });
  }
});
