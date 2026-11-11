import { expect, test } from 'bun:test';
import type { SidetabRow } from '../sidetab-core/model.js';
import {
  bindWorkspacePty, bindWorkspaceSidechatSession, createWorkspaceInputState,
  prepareWorkspaceInput, selectWorkspaceInput, setWorkspaceInputDraft,
  type CompleteTerminalObservation, type WorkspaceInputIntent,
} from '../sidetab-core/workspace-input.js';

function workspace(spaceId: string): SidetabRow {
  return { id: `workspace:${spaceId}`, kind: 'workspace', label: spaceId, badge: 'busy', spaceId };
}

function pty(spaceId: string, ptyId: string): SidetabRow {
  return { id: ptyId, kind: 'shell', label: ptyId, badge: 'busy', spaceId, ptyId,
    ownerPid: process.pid, ptyStartedAt: Date.now() - 1000, lastActivityAt: Date.now() };
}

function fullObservation(intent: Extract<WorkspaceInputIntent, { kind: 'terminal' }>, row: SidetabRow): CompleteTerminalObservation {
  return {
    target: intent.target,
    screen: '현재 화면: 승인 대기',
    transcript: '이전 출력: 빌드 시작\n현재 출력: 승인 대기',
    observedAt: new Date().toISOString(),
    activityAt: row.lastActivityAt!,
    coverage: 'full',
  };
}

test('fake workspace PTYs keep separate drafts and pin terminal input to the selected child', () => {
  const a = workspace('space-a');
  const b = workspace('space-b');
  const aPty = pty('space-a', 'pty:a');
  const bPty = pty('space-b', 'pty:b');
  let state = selectWorkspaceInput(createWorkspaceInputState(), a);
  state = bindWorkspacePty(state, aPty);
  state = setWorkspaceInputDraft(state, 'terminal', 'A 명령');
  state = selectWorkspaceInput(state, b);
  expect(() => bindWorkspacePty(state, aPty)).toThrow('active workspace');
  state = bindWorkspacePty(state, bPty);
  state = setWorkspaceInputDraft(state, 'terminal', 'B 명령');

  const fakeWrites: string[] = [];
  const submit = (intent: WorkspaceInputIntent): void => {
    if (intent.kind === 'terminal') fakeWrites.push(`${intent.target.ptyId}:${intent.text}`);
  };
  submit(prepareWorkspaceInput(state, 'terminal', [aPty, bPty]));
  state = selectWorkspaceInput(state, a);
  const aIntent = prepareWorkspaceInput(state, 'terminal', [aPty, bPty]);
  expect(aIntent).toMatchObject({ kind: 'terminal', text: 'A 명령', target: { ptyId: 'pty:a' }, requiresTakeover: true });
  submit(aIntent);
  expect(fakeWrites).toEqual(['pty:b:B 명령', 'pty:a:A 명령']);

  expect(() => prepareWorkspaceInput(state, 'terminal', [{ ...aPty, ownerPid: Number.MAX_SAFE_INTEGER }, bPty])).toThrow('target changed');
  expect(() => prepareWorkspaceInput(state, 'terminal', [{ ...aPty, ptyStartedAt: aPty.ptyStartedAt! + 1 }, bPty])).toThrow('target changed');
  expect(() => bindWorkspacePty(state, { ...aPty, ownerPid: undefined })).toThrow('live PTY');
  expect(() => bindWorkspacePty(state, { ...aPty, ptyStartedAt: undefined })).toThrow('live PTY');
  expect(() => prepareWorkspaceInput(state, 'terminal', [{ ...aPty, badge: 'exited' }, bPty])).toThrow('target changed');
});

test('fake sidechat sees full bound terminal transcript and never writes to the PTY', () => {
  const row = pty('space-a', 'pty:a');
  let state = selectWorkspaceInput(createWorkspaceInputState(), workspace('space-a'));
  state = bindWorkspacePty(state, row);
  state = setWorkspaceInputDraft(state, 'terminal', 'do not send to chat');
  state = setWorkspaceInputDraft(state, 'sidechat', '이 터미널의 미션을 이어서 수행해');
  state = bindWorkspaceSidechatSession(state, 'sidechat-session-a');
  const terminal = prepareWorkspaceInput(state, 'terminal', [row]);
  if (terminal.kind !== 'terminal') throw new Error('expected terminal intent');
  const observation = fullObservation(terminal, row);
  expect(() => prepareWorkspaceInput(state, 'sidechat', [row])).toThrow('full current observation');
  expect(() => prepareWorkspaceInput(state, 'sidechat', [row], {
    ...observation, target: { ...observation.target, ptyId: 'pty:other' },
  })).toThrow('full current observation');

  const fakePtyWrites: string[] = [];
  const fakeAgentInputs: string[] = [];
  const intent = prepareWorkspaceInput(state, 'sidechat', [row], observation);
  if (intent.kind === 'terminal') fakePtyWrites.push(intent.text);
  else fakeAgentInputs.push(`${intent.sessionId}:${intent.observation.transcript}:${intent.text}`);
  expect(fakePtyWrites).toEqual([]);
  expect(fakeAgentInputs).toEqual([
    'sidechat-session-a:이전 출력: 빌드 시작\n현재 출력: 승인 대기:이 터미널의 미션을 이어서 수행해',
  ]);
  expect(fakeAgentInputs[0]).not.toContain('do not send to chat');

  // Source: #36765 Terra review — a later PTY output or target rebind invalidates an old full capture.
  expect(() => prepareWorkspaceInput(state, 'sidechat', [{ ...row, lastActivityAt: row.lastActivityAt! + 1 }], observation))
    .toThrow('full current observation');
  const rebound = bindWorkspacePty(state, row);
  expect(() => prepareWorkspaceInput(rebound, 'sidechat', [row], observation)).toThrow('full current observation');
  expect(() => prepareWorkspaceInput(state, 'sidechat', [row], observation,
    Date.parse(observation.observedAt) + 30_001)).toThrow('full current observation');
});
