import { expect, test } from 'bun:test';
import { insideElsPane } from './nesting.js';

test('inside an els pane = the environment names THIS server\'s socket; anything else is the outermost frame', () => {
  const socket = '/home/u/.elanous/els/els.sock';
  const table: [string, Record<string, string | undefined>, boolean][] = [
    ['no variable (ssh login, plain terminal)', {}, false],
    ['empty', { ELANOUS_ELS_SOCKET: '' }, false],
    ['this server', { ELANOUS_ELS_SOCKET: socket }, true],
    ['another state dir\'s server', { ELANOUS_ELS_SOCKET: '/tmp/other/els/els.sock' }, false],
    ['same path with a trailing space', { ELANOUS_ELS_SOCKET: `${socket} ` }, false],
  ];
  for (const [label, env, expected] of table) expect([label, insideElsPane(env, socket)]).toEqual([label, expected]);
});
