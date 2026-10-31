import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMissionOutStore } from './mission-out.js';
import { recordAndDeliverMissionHandReply, recordHeadlessMissionHandReply, type MissionHandReplyTarget } from './mission-hand-reply.js';
import { createMissionLineStore, handleMissionLineRequest, type MissionLineEvent, type MissionLineInput } from './mission-line.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'mission-hand-reply-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test('headless HandReply records the matching answer/correction and never writes to PTY', async () => {
  const stateRoot = root();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(stateRoot, { id: () => id });
  store.create({ agent: 'codex', prompt: 'headless', cwd: '/repo', outputPath: join(stateRoot, 'out.tmp'), targetOutputPath: join(stateRoot, 'out.md') });
  await store.reply(id, 'Choose next step?', false, { kind: 'ask', defaults: 'inspect' });
  const result = await recordHeadlessMissionHandReply({ missionId: id, kind: 'correct', text: 'Stay in the existing scope.', replyTo: 1, scope: 'src/agent-mission', stop: true, priority: 'P0' }, store);
  expect(result).toMatchObject({ ok: true, recorded: true, delivered: false });
  expect(store.replies(id).at(-1)).toMatchObject({ kind: 'correct', replyTo: 1, state: 'correct 미적용(headless record-only)' });
});

test('late attempt mission-line is rejected before it can append an answer', async () => {
  const stateRoot = root();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(stateRoot, { id: () => id });
  store.create({ agent: 'codex', prompt: 'work', cwd: '/repo', outputPath: join(stateRoot, 'out.tmp'), targetOutputPath: join(stateRoot, 'out.md') });
  await store.reply(id, 'Which base? Options: main or release.', false, { kind: 'ask', defaults: 'main' });
  const authority = createMissionLineStore(stateRoot).issue({ missionId: id, attemptId: 'attempt-current', agent: 'codex', who: 'Codex', what: 'work' });
  const input: MissionLineInput = { lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', missionId: id, attemptId: 'attempt-old', agent: 'codex', type: 'answer', source: 'parent-hand-reply', text: 'stale answer', replyTo: 1 };
  const response = await handleMissionLineRequest(new Request(`http://nexus/v1/missions/${id}/line`, { method: 'POST', headers: { authorization: `Bearer ${authority.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }), stateRoot, async (line) => {
    const event = await store.reply(id, line.text, false, { kind: 'answer', replyTo: line.replyTo });
    return { ...line, sequence: event.sequence, createdAt: event.createdAt, done: event.done };
  }, () => {});
  expect(response?.status).toBe(401);
  expect(store.replies(id).some((event) => event.kind === 'answer')).toBe(false);
});

test('correction is recorded on its ask line then delivered to the bound PTY as the next-step instruction', async () => {
  const target: MissionHandReplyTarget = { missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'codex', token: 'token', nexusUrl: 'http://nexus', ptyId: 'pty-1', runId: 'run-1' };
  let recorded: Record<string, unknown> | undefined;
  let controlArgs: Parameters<typeof requestRemotePtyControl> | undefined;
  const postLine = async (input: Parameters<typeof import('./mission-line.js').postMissionLineEvent>[0]): Promise<MissionLineEvent> => {
    recorded = input as unknown as Record<string, unknown>;
    return { ...input, sequence: 2, createdAt: new Date(0).toISOString(), done: false };
  };
  const control = async (...args: Parameters<typeof requestRemotePtyControl>) => {
    controlArgs = args;
    return { status: 'success' } as Awaited<ReturnType<typeof requestRemotePtyControl>>;
  };
  const result = await recordAndDeliverMissionHandReply({ target, kind: 'correct', text: 'Stop broad research; edit only mission-out next.', actor: 'agent', replyTo: 1, runId: 'run-1', scope: 'src/agent-mission/mission-out.ts', stop: true, priority: 'P0' }, { postLine, control });
  expect(result).toMatchObject({ ok: true, recorded: true, delivered: true });
  expect(recorded).toMatchObject({ type: 'correct', replyTo: 1, scope: 'src/agent-mission/mission-out.ts', stop: true, priority: 'P0' });
  expect(controlArgs?.[0]).toBe('pty-1');
  expect(controlArgs?.[1]).toBe('input-text');
  expect(controlArgs?.[2]).toEqual({ chars: '[Elanous correction] Stop broad research; edit only mission-out next.\r' });
  expect(controlArgs?.[3]).toMatchObject({ actor: 'agent', requesterRunId: 'run-1' });
});

test('answer is recorded for the matching mission ask and consumed through the ask ledger', async () => {
  const target: MissionHandReplyTarget = { missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'codex', token: 'token', nexusUrl: 'http://nexus', ptyId: 'pty-1', runId: 'run-1' };
  let sent = false;
  let recorded: Parameters<typeof import('./mission-line.js').postMissionLineEvent>[0] | undefined;
  const postLine = async (input: Parameters<typeof import('./mission-line.js').postMissionLineEvent>[0]): Promise<MissionLineEvent> => {
    recorded = input;
    return { ...input, sequence: 3, createdAt: new Date(0).toISOString(), done: false };
  };
  const control = async (..._args: Parameters<typeof requestRemotePtyControl>) => { sent = true; return { status: 'success' } as Awaited<ReturnType<typeof requestRemotePtyControl>>; };
  const result = await recordAndDeliverMissionHandReply({ target, kind: 'answer', text: 'Use main.', actor: 'agent', replyTo: 2, runId: 'run-1' }, { postLine, control });
  expect(result).toMatchObject({ ok: true, recorded: true, delivered: false, delivery: 'ask-ledger' });
  expect(recorded).toMatchObject({ type: 'answer', replyTo: 2, source: 'parent-hand-reply', text: 'Use main.' });
  expect(sent).toBe(false);
});

test('an ingress rejection marked unapplied is never followed by PTY input', async () => {
  const target: MissionHandReplyTarget = { missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'codex', token: 'token', nexusUrl: 'http://nexus', ptyId: 'pty-1', runId: 'run-1' };
  let sent = false;
  const postLine = async (input: Parameters<typeof import('./mission-line.js').postMissionLineEvent>[0]): Promise<MissionLineEvent> => ({ ...input, state: 'correct 미적용(PTY/runId 불일치)', sequence: 4, createdAt: new Date(0).toISOString(), done: false });
  const control = async (..._args: Parameters<typeof requestRemotePtyControl>) => { sent = true; return { status: 'success' } as Awaited<ReturnType<typeof requestRemotePtyControl>>; };
  const result = await recordAndDeliverMissionHandReply({ target, kind: 'correct', text: 'Stay in scope.', actor: 'agent', replyTo: 2, runId: 'run-1', scope: 'src/agent-mission', stop: true, priority: 'P0' }, { postLine, control });
  expect(result).toMatchObject({ ok: false, recorded: true, delivered: false, reason: 'correct 미적용(PTY/runId 불일치)' });
  expect(sent).toBe(false);
});

test('correct with no PTY/run mapping is durably marked unapplied and never sent', async () => {
  const target: MissionHandReplyTarget = { missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'claude', token: 'token', nexusUrl: 'http://nexus' };
  let recorded: Record<string, unknown> | undefined;
  let sent = false;
  const postLine = async (input: Parameters<typeof import('./mission-line.js').postMissionLineEvent>[0]): Promise<MissionLineEvent> => {
    recorded = input as unknown as Record<string, unknown>;
    return { ...input, sequence: 1, createdAt: new Date(0).toISOString(), done: false };
  };
  const control = async (..._args: Parameters<typeof requestRemotePtyControl>) => {
    sent = true;
    return { status: 'success' } as Awaited<ReturnType<typeof requestRemotePtyControl>>;
  };
  const result = await recordAndDeliverMissionHandReply({ target, kind: 'correct', text: 'Narrow the task.', actor: 'agent', replyTo: 2, scope: 'src/agent-mission', stop: true, priority: 'P0' }, { postLine, control });
  expect(result).toMatchObject({ ok: false, recorded: true, delivered: false });
  expect(recorded?.state).toContain('correct 미적용');
  expect(sent).toBe(false);
});
