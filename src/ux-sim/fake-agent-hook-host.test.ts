import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAgentHookHost } from './fake-agent-hook-host.js';

const unreadMessages = [
  { id: 31, from: 'OP', to: 'ABSORB-1', body: '첫 번째', kind: 'report' },
  { id: 32, from: 'TC', to: 'ABSORB-1', body: '두 번째' },
  { id: 33, from: 'TC', to: 'MK', body: '다른 좌석 우편' },
];

describe('fake-agent-hook-host', () => {
  test('same-seat message ids are unique across initial inbox and later posts', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-agent-hook-host-duplicate-'));
    try {
      const duplicate = { ...unreadMessages[0]!, from: 'TC', to: 'absorb-1', body: '중복' };
      const duplicateError = `duplicate message id for ABSORB-1: #${duplicate.id}`;
      expect(() => createFakeAgentHookHost({ messages: [unreadMessages[0]!, duplicate], stateDir }))
        .toThrow(duplicateError);

      const host = createFakeAgentHookHost({ messages: unreadMessages, stateDir });
      expect(() => host.post({ ...duplicate, to: 'ABSORB-1' })).toThrow(duplicateError);
      host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: duplicate.id } });
      expect(() => host.post({ ...duplicate, to: 'ABSORB-1', body: 'ack 뒤 재사용' }))
        .toThrow(duplicateError);
      host.post({ ...duplicate, to: 'MK' });
      expect(host.unread('MK').map(message => message.id)).toEqual([unreadMessages[2]!.id, duplicate.id]);
      host.callMcp({ name: 'msg-ack', arguments: { seat: 'MK', id: duplicate.id } });
      expect(host.unread('MK').map(message => message.id)).toEqual([unreadMessages[2]!.id]);
      expect(host.unread('ABSORB-1').map(message => message.id)).toEqual([unreadMessages[1]!.id]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('Claude and Codex hook payloads inject unread mail once and MCP inbox ack clears it', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-agent-hook-host-'));
    try {
      const host = createFakeAgentHookHost({ messages: unreadMessages, stateDir });
      const cwd = '/tmp/elanous-hq/seats/ABSORB-1';
      const claude = JSON.parse(host.invokeHook({ event: 'user-prompt-submit', format: 'claude', cwd, sessionId: 'claude-1' })!);
      expect(claude.hookSpecificOutput.additionalContext).toContain('#31 OP→ABSORB-1 [report] 첫 번째');
      expect(host.invokeHook({ event: 'user-prompt-submit', format: 'claude', cwd, sessionId: 'claude-1' })).toBeNull();

      const codexStop = JSON.parse(host.invokeHook({ event: 'stop', format: 'codex', cwd, sessionId: 'codex-1' })!);
      expect(codexStop).toEqual({ decision: 'block', reason: '새 우편 2통(#31, #32) — 처리 후 ack' });
      expect(host.invokeHook({ event: 'stop', format: 'codex', cwd, sessionId: 'codex-1' })).toBeNull();
      const inbox = host.callMcp({ name: 'msg-inbox', arguments: { seat: 'ABSORB-1' } }) as typeof unreadMessages;
      expect(inbox.map(message => message.id)).toEqual([31, 32]);
      inbox[0]!.body = 'caller mutation';
      expect(host.unread('ABSORB-1')[0]!.body).toBe('첫 번째');
      expect(host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: 31 } })).toMatchObject({ status: 'acked' });
      expect(host.unread('ABSORB-1').map(message => message.id)).toEqual([32]);
      host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: 32 } });
      expect(host.callMcp({ name: 'msg-inbox', arguments: { seat: 'ABSORB-1' } })).toEqual([]);
      host.post({ id: 34, from: 'OP', to: 'ABSORB-1', body: 'ack 뒤 새 우편' });
      const changedStop = JSON.parse(host.invokeHook({ event: 'stop', format: 'codex', cwd, sessionId: 'codex-1' })!);
      expect(changedStop).toEqual({ decision: 'block', reason: '새 우편 1통(#34) — 처리 후 ack' });
      expect(host.invokeHook({ event: 'stop', format: 'codex', cwd, sessionId: 'codex-1' })).toBeNull();
      const changedBundle = JSON.parse(host.invokeHook({ event: 'user-prompt-submit', format: 'claude', cwd, sessionId: 'claude-1' })!);
      expect(changedBundle.hookSpecificOutput.additionalContext).toContain('#34 OP→ABSORB-1');
      expect(host.callMcp({ name: 'msg-inbox', arguments: { seat: 'ABSORB-1' } })).toHaveLength(1);
      host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: 34 } });
      const mkHook = JSON.parse(host.invokeHook({ event: 'user-prompt-submit', format: 'codex', cwd: '/tmp/elanous-hq/seats/MK', sessionId: 'mk-1' })!);
      expect(mkHook.hookSpecificOutput.additionalContext).toContain('#33 TC→MK');
      expect(mkHook.hookSpecificOutput.additionalContext).not.toContain('#31');
      expect(host.callMcp({ name: 'msg-inbox', arguments: { seat: 'MK' } })).toHaveLength(1);
      expect(() => host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: 33 } })).toThrow('message not found');
      expect(host.hookCalls().map(call => `${call.format}:${call.event}`)).toEqual([
        'claude:user-prompt-submit', 'claude:user-prompt-submit', 'codex:stop', 'codex:stop',
        'codex:stop', 'codex:stop', 'claude:user-prompt-submit', 'codex:user-prompt-submit',
      ]);
      expect(host.mcpCalls().map(call => call.name)).toEqual([
        'msg-inbox', 'msg-ack', 'msg-ack', 'msg-inbox', 'msg-inbox', 'msg-ack', 'msg-inbox', 'msg-ack',
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('MCP ack cannot acknowledge another seat message', () => {
    const host = createFakeAgentHookHost({ messages: [{ id: 8, from: 'OP', to: 'MK', body: 'private' }], stateDir: tmpdir() });
    expect(() => host.callMcp({ name: 'msg-ack', arguments: { seat: 'ABSORB-1', id: 8 } })).toThrow('message not found');
    expect(host.unread('MK')).toHaveLength(1);
  });
});
