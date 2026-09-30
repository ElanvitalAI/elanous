import { expect, test } from 'bun:test';
import { displayedSlashCommandNames } from '../../chat/index.js';
import { buildDashboardSlashRegistry } from './index.js';
import { unknownSlashReply } from './unknown-slash-reply.js';

// Independent inventory copied from the retirement assertions in
// test/dashboard-slash-registry.test.ts (VW, rich UI, and D1e cases).
const retiredNames = [
  'acp-vw', 'claude-vw', 'pty-pane', 'pty-view', 'fullscreen', 'fs', 'view', 'window',
  'ui', 'workspace', 'ws', 'win', 'scratch', 'sc',
  'ctoggle', 'cache', 'perf', 'pty-list', 'ptys', 'sweep-tool-results',
  'budget', 'b', 'route', 'llm', 'browser-cdp', 'bcdp', 'dm', 'surf',
  'codex-vw', 'skill-triggers', 'triggers', 'git', 'memorize', 'mem-compact',
  'sim', 'simulator', 'turn-slider', 'turnslider', 'tslider', 'playground',
  'pg', 'branch', 'audit', 'substrate-stats', 'sst', 'usage', 'stats',
  'codex-setup', 'codex-init', 'hint', 'media', 'mv',
  'ask', 'say', 'dev', 'implement',
] as const;

test('moved slash names take priority over suggestions, /implement goes straight to ask', () => {
  const registered = ['implement', 'ask', 'help'];
  expect(unknownSlashReply('implement', registered)).toEqual([
    '/implement has moved; use /harness ask <무엇을 왜 고칠지 한 문장>',
  ]);
  expect(unknownSlashReply('ask', registered)).toEqual([
    '/ask has moved; use /harness ask <무엇을 왜 고칠지 한 문장>',
  ]);
  expect(unknownSlashReply('say', registered)).toEqual([
    '/say has moved; use /harness ask <무엇을 왜 고칠지 한 문장>',
  ]);
  expect(unknownSlashReply('dev', registered)).toEqual([
    '/dev has moved; use /harness dev <무엇을 왜 고칠지 한 문장>',
  ]);
});

test('retirement advice precedes near-match registered suggestions', () => {
  expect(unknownSlashReply('audit', ['audit', 'quit', 'help'])).toEqual([
    '/audit is retired; use /help',
  ]);
  expect(unknownSlashReply('scratch', ['scratch', 'help'])).toEqual([
    '/scratch is retired; use /help',
  ]);
});

test('only registered edit-distance ≤ 2 names are suggested, closest first, capped at three', () => {
  expect(unknownSlashReply('helo', ['yellow', 'hel', 'help', 'hello', 'held', 'help', 'hallo', 'scratch']))
    .toEqual([
      'Unknown command: /helo',
      'Did you mean: /hel, /held, /hello?',
      'Type /help for the list of commands.',
    ]);
  expect(unknownSlashReply('toString', ['help', 'quit'])).toEqual([
    'Unknown command: /tostring',
    'Type /help for the list of commands.',
  ]);
  expect(unknownSlashReply('zzzzzz', ['help', 'quit'])).toEqual([
    'Unknown command: /zzzzzz',
    'Type /help for the list of commands.',
  ]);
  expect(unknownSlashReply('budge', ['budget', 'badger', 'help'])).toEqual([
    'Unknown command: /budge',
    'Did you mean: /badger?',
    'Type /help for the list of commands.',
  ]);
});

test('every source-inventory retired name has advice and stays out of registration and picker', () => {
  const registered = new Set(buildDashboardSlashRegistry().names());
  const displayed = new Set(displayedSlashCommandNames());
  const moved = new Set(['ask', 'say', 'dev', 'implement']);
  const replacements: Record<string, string> = {
    ask: '/harness ask', say: '/harness ask', implement: '/harness ask', dev: '/harness dev',
    budget: '/tokens', b: '/tokens', usage: '/tokens', llm: '/model',
    memorize: '/memory', 'mem-compact': '/memory',
  };
  for (const name of retiredNames) {
    const [advice] = unknownSlashReply(name, [name, 'help']);
    expect(advice, name).toContain(moved.has(name) ? 'has moved; use ' : 'is retired; use ');
    expect(advice, name).toContain(replacements[name] ?? '/help');
    expect(registered.has(name), name).toBe(false);
    expect(displayed.has(name), name).toBe(false);
  }
});
