import { expect, test } from 'bun:test';
import { GitHubMsgMirrorTransport } from './msg-mirror-github.js';

test('GitHub mirror adapter uses issues/comments and makes rotation linking idempotent', () => {
  const calls: string[][] = [];
  const comments = new Map<number, Array<{ body: string }>>([[41, []]]);
  const issues: Array<{ number: number; title: string; body: string }> = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    const path = args.find(value => value.startsWith('repos/owner/repo/')) ?? '';
    if (path.includes('/comments?')) return JSON.stringify([comments.get(Number(path.match(/issues\/(\d+)/)?.[1])) ?? []]);
    if (path.includes('/issues?state=')) return JSON.stringify([issues]);
    if (path.endsWith('/issues') && args.includes('-X') && args[args.indexOf('-X') + 1] === 'POST') {
      const title = args.find(value => value.startsWith('title='))!.slice('title='.length);
      const body = args.find(value => value.startsWith('body='))!.slice('body='.length);
      const issue = { number: 42, title, body };
      issues.unshift(issue);
      comments.set(42, []);
      return JSON.stringify(issue);
    }
    if (path.includes('/comments') && args.includes('POST')) {
      const number = Number(path.match(/issues\/(\d+)/)?.[1]);
      const body = args.find(value => value.startsWith('body='))!.slice('body='.length);
      comments.set(number, [...(comments.get(number) ?? []), { body }]);
      return JSON.stringify({ id: comments.get(number)!.length });
    }
    if (path.includes('/issues/41') && args.includes('PATCH')) return JSON.stringify({ state: 'closed' });
    throw new Error(`unexpected gh api call: ${args.join(' ')}`);
  };
  const transport = new GitHubMsgMirrorTransport(gh);
  const oldTarget = { repo: 'owner/repo', issueNumber: 41 };

  expect(transport.countComments(oldTarget)).toBe(0);
  const eventMarker = '<!-- elanous-msg-mirror:event:42 -->';
  comments.set(41, [{ body: `## incident · #41\n\nbody contains a marker-like string:\n${eventMarker}` }]);
  transport.beginTick();
  expect(transport.hasMarker(oldTarget, eventMarker)).toBe(false);
  comments.set(41, [{ body: `${eventMarker}\n## incident · #42` }]);
  transport.beginTick();
  expect(transport.hasMarker(oldTarget, eventMarker)).toBe(true);
  comments.set(41, []);
  transport.beginTick();
  const next = transport.createNextChannel(oldTarget, 'msg-mirror-rotate:owner/repo#41');
  expect(next).toEqual({ repo: 'owner/repo', issueNumber: 42 });
  expect(transport.createNextChannel(oldTarget, 'msg-mirror-rotate:owner/repo#41')).toEqual(next);
  transport.linkAndCloseChannel(oldTarget, next);
  transport.linkAndCloseChannel(oldTarget, next);

  expect(issues).toHaveLength(1);
  expect(issues[0]!.body).toContain('msg-mirror-rotate:owner/repo#41');
  expect(comments.get(41)).toHaveLength(1);
  expect(comments.get(41)![0]!.body).toContain('issues/42');
  expect(calls.some(args => args.includes('repos/owner/repo/issues/42/comments?per_page=100'))).toBe(false);
  expect(calls.filter(args => args.includes('repos/owner/repo/issues/41') && args.includes('PATCH'))).toHaveLength(2);
});
