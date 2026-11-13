import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  answerMemberBoardSessionCall, isMemberBoardSessionCall, requestMemberBoardSession,
} from './next-member-board-session.js';

test('Next child receives only the authenticated session supplied by its host', async () => {
  const ipc = new EventEmitter() as EventEmitter & { send?: (message: unknown) => void };
  const session = { nexusUrl: 'https://nexus.example.test', sessionToken: 'test-session' };
  ipc.send = (message) => {
    if (isMemberBoardSessionCall(message)) ipc.emit('message', answerMemberBoardSessionCall(() => session, message));
  };
  expect(await requestMemberBoardSession(ipc as unknown as typeof process, 100)).toEqual(session);
  ipc.send = (message) => {
    if (isMemberBoardSessionCall(message)) ipc.emit('message', answerMemberBoardSessionCall(null, message));
  };
  expect(await requestMemberBoardSession(ipc as unknown as typeof process, 100)).toBeUndefined();
});
