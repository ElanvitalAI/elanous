import { expect, test } from 'bun:test';
import type { Message } from '../msg/msg-store.js';
import { runGuardedMsgMirrorWorld } from '../msg/outbound-guard-world.js';
import type { MsgMirrorTickOptions, MsgMirrorState } from '../msg/msg-mirror-runner.js';
import type { OutboundGuardProvenance } from '../ux-sim/outbound-guard-sim.js';
import { runGuardedReleaseStageWorld } from './outbound-guard-world.js';
import type { ReleaseStageMailInput } from './stage-mail.js';

const simulated: OutboundGuardProvenance = { universe: 'test', source: 'sim', device: 'outbound-guard-world', scenario: 'release-and-msg' };
const real: OutboundGuardProvenance = { universe: 'test', source: 'real' };
// Source: deterministic fixture IDs and UTC times keep the fake release and mirror worlds isolated from live state.
const MIRROR_ISSUE = 42;
const MESSAGE_ID = 1;
const START_TIME = '2026-11-10T00:00:00.000Z';
const MESSAGE_TIME = '2026-11-10T00:30:00.000Z';
const TICK_TIME = '2026-11-10T01:00:00.000Z';

test('simulated release stage mail is blocked before the injected mailbox, while real mail is delivered', () => {
  const delivered: string[] = [];
  const input = { runId: 'release-1', nodeId: 'gate', state: 'ok' as const };
  const emit = (mail: ReleaseStageMailInput) => { delivered.push(mail.runId); };
  const blocked = runGuardedReleaseStageWorld(simulated, input, emit);
  expect(blocked.decision.allowed).toBe(false);
  expect(blocked.observations).toMatchObject([{ type: 'sim.leak-blocked', actionKind: 'release-stage-mail', source: 'sim' }]);
  expect(delivered).toEqual([]);
  const mixed = runGuardedReleaseStageWorld({ ...real, causedBy: [simulated] }, input, emit);
  expect(mixed.decision).toMatchObject({ allowed: false, reason: 'source-not-real' });
  expect(mixed.observations).toMatchObject([{ type: 'sim.leak-blocked', source: 'sim', universe: 'test' }]);
  expect(delivered).toEqual([]);
  const allowed = runGuardedReleaseStageWorld(real, input, emit);
  expect(allowed).toMatchObject({ decision: { allowed: true }, delivered: true, observations: [] });
  expect(delivered).toEqual(['release-1']);
});

test('simulated and untagged message mirror ticks never reach fake GitHub or advance the cursor', async () => {
  const effects: string[] = [];
  let state: MsgMirrorState | null = { version: 1, target: { repo: 'owner/repo', issueNumber: MIRROR_ISSUE }, messageCursor: 0,
    summaryWindowEnd: START_TIME };
  const message: Message = { id: MESSAGE_ID, from: 'TC', to: 'OP', kind: 'incident', body: 'fake incident', createdAt: MESSAGE_TIME };
  const options: MsgMirrorTickOptions = {
    nowMs: Date.parse(TICK_TIME),
    source: { latestId: () => MESSAGE_ID, listAfter: () => [message], listWindow: () => [] },
    state: { read: () => state, write: next => { effects.push('state-write'); state = next; } },
    transport: {
      countComments: () => 0, hasMarker: () => false,
      postComment: () => { effects.push('github-comment'); },
      createNextChannel: target => target, linkAndCloseChannel: () => { effects.push('github-close'); },
    },
  };
  for (const provenance of [simulated, undefined, { ...real, causedBy: [simulated] }]) {
    const blocked = await runGuardedMsgMirrorWorld(provenance, options);
    expect(blocked.decision.allowed).toBe(false);
    expect(blocked.observations).toMatchObject([{ type: 'sim.leak-blocked', actionKind: 'msg-mirror-github' }]);
  }
  expect(effects).toEqual([]);
  expect(state?.messageCursor).toBe(0);
  const allowed = await runGuardedMsgMirrorWorld(real, options);
  expect(allowed.decision.allowed).toBe(true);
  expect(allowed.result).toMatchObject({ status: 'synced', posted: 1, sourceCursor: MESSAGE_ID });
  expect(effects).toContain('github-comment');
});
