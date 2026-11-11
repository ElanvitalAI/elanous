import { buildMsgHookOutput, type MsgHookEvent, type MsgHookFormat, type MsgHookMessage } from '../msg/msg-hook.js';

export type FakeAgentHookMcpCall =
  | { readonly name: 'msg-inbox'; readonly arguments: { readonly seat: string } }
  | { readonly name: 'msg-ack'; readonly arguments: { readonly seat: string; readonly id: number } };

export interface FakeAgentHookHostOptions {
  readonly messages: readonly MsgHookMessage[];
  readonly stateDir: string;
}

export interface FakeAgentHookHost {
  post(message: MsgHookMessage): void;
  invokeHook(input: { event: MsgHookEvent; format: MsgHookFormat; cwd: string; sessionId: string }): string | null;
  callMcp(call: FakeAgentHookMcpCall): unknown;
  unread(seat: string): MsgHookMessage[];
  hookCalls(): Array<{ event: MsgHookEvent; format: MsgHookFormat }>;
  mcpCalls(): FakeAgentHookMcpCall[];
}

/** Claude/Codex hook payload host and in-memory MCP inbox. No process, network, or external send. */
export function createFakeAgentHookHost(options: FakeAgentHookHostOptions): FakeAgentHookHost {
  const messages: MsgHookMessage[] = [];
  const messageKeys = new Set<string>();
  const keyFor = (message: MsgHookMessage) => `${message.to.toUpperCase()}:${message.id}`;
  const append = (message: MsgHookMessage) => {
    const key = keyFor(message);
    if (messageKeys.has(key)) throw new Error(`duplicate message id for ${message.to.toUpperCase()}: #${message.id}`);
    messageKeys.add(key);
    messages.push({ ...message });
  };
  for (const message of options.messages) append(message);
  const acked = new Set<string>();
  const hooks: Array<{ event: MsgHookEvent; format: MsgHookFormat }> = [];
  const calls: FakeAgentHookMcpCall[] = [];
  const unread = (seat: string) => messages.filter(message => message.to.toUpperCase() === seat.toUpperCase() && !acked.has(`${seat.toUpperCase()}:${message.id}`));

  return {
    post(message) { append(message); },
    invokeHook(input) {
      hooks.push({ event: input.event, format: input.format });
      const seat = input.cwd.replaceAll('\\', '/').match(/(?:^|\/)elanous-hq\/seats\/([A-Za-z][A-Za-z0-9_-]*)(?:\/|$)/)?.[1]?.toUpperCase();
      return buildMsgHookOutput({ ...input, seat, messages: seat ? unread(seat) : [], stateDir: options.stateDir });
    },
    callMcp(call) {
      calls.push({ name: call.name, arguments: { ...call.arguments } } as FakeAgentHookMcpCall);
      if (call.name === 'msg-inbox') return unread(call.arguments.seat).map(message => ({ ...message }));
      const seat = call.arguments.seat.toUpperCase();
      const message = messages.find(row => row.id === call.arguments.id && row.to.toUpperCase() === seat);
      if (!message) throw new Error(`message not found for ${seat}: #${call.arguments.id}`);
      acked.add(`${seat}:${message.id}`);
      return { recipient: seat, id: message.id, status: 'acked' };
    },
    unread: seat => unread(seat).map(message => ({ ...message })),
    hookCalls: () => hooks.map(call => ({ ...call })),
    mcpCalls: () => calls.map(call => ({ name: call.name, arguments: { ...call.arguments } } as FakeAgentHookMcpCall)),
  };
}
