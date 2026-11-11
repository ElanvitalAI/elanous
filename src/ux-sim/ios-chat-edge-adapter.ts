import {
  edgeCreatorTouchMatchesPath,
  type EdgeCreatorSeed,
} from './edge-creator.js';

export type IOSChatEdgeId =
  | 'offline-send'
  | 'expired-token'
  | 'empty-sse'
  | 'long-response'
  | 'duplicate-send'
  | 'sse-disconnect'
  | 'permission-denied';

export interface IOSChatEdgeInput {
  readonly id: IOSChatEdgeId;
  readonly summary: string;
  readonly setup: string;
  readonly action: string;
  readonly expectedResult: string;
  readonly expectedInvariant: string;
  readonly touches: readonly string[];
  readonly severity: EdgeCreatorSeed['severity'];
  readonly plannerAxes: EdgeCreatorSeed['axes'];
}

/**
 * Manual iPhone chat edges from the SIM-VERIFY-DUO checklist, expressed as
 * planner inputs without changing the generic edge creator's axis contract.
 */
export const IOS_CHAT_EDGE_INPUTS: readonly IOSChatEdgeInput[] = [
  {
    id: 'offline-send',
    summary: 'an offline chat send remains recoverable after reconnect',
    setup: 'disconnect the test device from the test Nexus',
    action: 'send a non-sensitive test prompt, then reconnect',
    expectedResult: 'the pending message is retained and reaches the test Nexus after reconnect',
    expectedInvariant: 'offline-message-is-retained-until-reconnect',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat'],
    severity: 'S1',
    plannerAxes: { outcome: 'timeout', interruption: 'resume', mutation: 'append', environment: 'same-host' },
  },
  {
    id: 'expired-token',
    summary: 'an expired chat token is rejected and requests reauthentication',
    setup: 'expire or revoke the temporary test token',
    action: 'send a non-sensitive test prompt',
    expectedResult: 'the request receives 401 and the app asks for reauthentication',
    expectedInvariant: 'expired-token-fails-closed-with-401',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat', 'src/nexus'],
    severity: 'S1',
    plannerAxes: { outcome: 'fail', interruption: 'resume', mutation: 'receipt', environment: 'remote-user-missing' },
  },
  {
    id: 'empty-sse',
    summary: 'an empty chat SSE stream leaves a stable empty response state',
    setup: 'configure the test Nexus to end the chat SSE stream without events',
    action: 'send a non-sensitive test prompt',
    expectedResult: 'the app shows a stable empty response without an invalid message',
    expectedInvariant: 'empty-stream-does-not-create-invalid-message',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat', 'src/nexus'],
    severity: 'S2',
    plannerAxes: { outcome: 'unmeasured', interruption: 'node', mutation: 'none', environment: 'same-host' },
  },
  {
    id: 'long-response',
    summary: 'a long streamed chat response remains readable and scrollable',
    setup: 'configure a multi-paragraph test response',
    action: 'send a non-sensitive test prompt and scroll through the response',
    expectedResult: 'the full response remains readable and the latest content is reachable',
    expectedInvariant: 'long-response-renders-without-losing-content',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat'],
    severity: 'S2',
    plannerAxes: { outcome: 'ok', interruption: 'node', mutation: 'none', environment: 'same-host' },
  },
  {
    id: 'duplicate-send',
    summary: 'repeated submission of the same chat prompt does not duplicate effects',
    setup: 'connect to the test Nexus with a temporary test account',
    action: 'submit the same non-sensitive test prompt twice in quick succession',
    expectedResult: 'duplicate submissions do not create duplicate message effects',
    expectedInvariant: 'duplicate-send-does-not-duplicate-message-effect',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat', 'src/nexus'],
    severity: 'S1',
    plannerAxes: { outcome: 'fail', interruption: 'append', mutation: 'append', environment: 'same-host' },
  },
  {
    id: 'sse-disconnect',
    summary: 'a disconnected chat SSE stream reaches a recoverable interrupted state',
    setup: 'configure the test Nexus to close the stream after a partial event',
    action: 'send a non-sensitive test prompt and wait for the stream to close',
    expectedResult: 'the app exposes an interrupted state and preserves recoverable chat state',
    expectedInvariant: 'sse-disconnect-preserves-recoverable-chat-state',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat', 'src/nexus'],
    severity: 'S1',
    plannerAxes: { outcome: 'timeout', interruption: 'resume', mutation: 'append', environment: 'partial-shards' },
  },
  {
    id: 'permission-denied',
    summary: 'chat access denied by the server does not expose or append a response',
    setup: 'use a valid temporary test token without chat permission',
    action: 'send a non-sensitive test prompt',
    expectedResult: 'the request receives 403 and no response is exposed or appended',
    expectedInvariant: 'permission-denial-fails-closed-with-403',
    touches: ['apps/ios/ElanousiOS/ElanousiOS/Chat', 'src/nexus'],
    severity: 'S1',
    plannerAxes: { outcome: 'fail', interruption: 'resume', mutation: 'none', environment: 'remote-user-missing' },
  },
];

const IOS_CHAT_PLANNER_INCIDENT_IDS: Readonly<Record<IOSChatEdgeId, EdgeCreatorSeed['incidentId']>> = {
  'offline-send': 'E9',
  'expired-token': 'E10',
  'empty-sse': 'E11',
  'long-response': 'E12',
  'duplicate-send': 'E13',
  'sse-disconnect': 'E14',
  'permission-denied': 'E15',
};

export function adaptIOSChatEdgeInputs(inputs: readonly IOSChatEdgeInput[] = IOS_CHAT_EDGE_INPUTS): readonly EdgeCreatorSeed[] {
  const seen = new Set<IOSChatEdgeId>();
  return inputs.map((input) => {
    if (seen.has(input.id)) throw new Error(`duplicate iOS chat edge input: ${input.id}`);
    seen.add(input.id);
    if (!input.summary.trim() || !input.setup.trim() || !input.action.trim()
      || !input.expectedResult.trim() || !input.expectedInvariant.trim() || input.touches.length === 0)
      throw new Error(`incomplete iOS chat edge input: ${input.id}`);
    return {
      incidentId: IOS_CHAT_PLANNER_INCIDENT_IDS[input.id],
      summary: `[iOS chat:${input.id}] ${input.summary}; setup: ${input.setup}; action: ${input.action}; expected: ${input.expectedResult}`,
      touches: input.touches,
      severity: input.severity,
      axes: input.plannerAxes,
      invariant: input.expectedInvariant,
    };
  });
}

export function hasChangedIOSChatEdgeTouch(changedPaths: readonly string[]): boolean {
  return IOS_CHAT_EDGE_INPUTS.some((input) => input.touches.some((touch) => changedPaths
    .some((changedPath) => edgeCreatorTouchMatchesPath(touch, changedPath))));
}

export function isIOSChatEdgeSeed(seed: EdgeCreatorSeed): boolean {
  return seed.summary.startsWith('[iOS chat:');
}
