// LOOP-AGENT v2 generic shell — proactive voice: one line when the KPI breaches / recovers, into the agent's own channel
// (`loop:<id>`) and the supervisors' room (`ws:supervisors`) — not mail to OP. Every line is also kept in the agent's
// outbox (<home>/speak.jsonl) so a line the els server did not take (server down · no voice registered) is not lost.
// The els door is `channel` action `loop-say` (host door / OP only · the loop must have a registered voice).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentHome } from './memory.js';

export const SUPERVISORS_CHANNEL = 'ws:supervisors';
const pending = new Set<Promise<unknown>>();

export function outboxSpeaker(stateRoot: string, id: string, now: () => Date = () => new Date()): (line: string) => void {
  return (line: string) => {
    try {
      const dir = agentHome(stateRoot, id);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'speak.jsonl'), `${JSON.stringify({ at: now().toISOString(), channel: `loop:${id}`, text: line.slice(0, 500) })}\n`);
    } catch { /* fail-soft: speaking never breaks a tick */ }
  };
}

export type ElsAsk = (request: Record<string, unknown>) => Promise<{ exitCode: number; message?: string }>;

/** Outbox ⊕ els channel (both channels); `ask` is the els socket request (injected in tests). */
export function elsSpeaker(stateRoot: string, id: string, ask: ElsAsk, channels: readonly string[] = [`loop:${id}`, SUPERVISORS_CHANNEL]): (line: string) => void {
  const keep = outboxSpeaker(stateRoot, id);
  return (line: string) => {
    keep(line);
    for (const channel of channels) {
      const p = ask({ op: 'channel', action: 'loop-say', channel, loop: id, body: line.slice(0, 2_000), refs: [`loop:${id}`] }).catch(() => undefined);
      pending.add(p); void p.finally(() => pending.delete(p));
    }
  };
}

/** Wait for the in-flight channel lines (the tick CLI calls this before it exits). */
export async function flushSpeakers(timeoutMs = 5_000): Promise<void> {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, timeoutMs))]);
}

/** The live speaker for `eln loop agent <id> tick` (`channels` default: loop:<id> ⊕ ws:supervisors). */
export function channelSpeaker(id: string, channels?: readonly string[]): (line: string) => void {
  const root = (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();
  const ask: ElsAsk = async (request) => {
    const { requestEls } = require('../els/client.js') as typeof import('../els/client.js');
    const { elsSocketPath } = require('../els/server.js') as typeof import('../els/server.js');
    return requestEls(elsSocketPath(), request as unknown as Parameters<typeof requestEls>[1], 3_000);
  };
  return channels ? elsSpeaker(root, id, ask, channels) : elsSpeaker(root, id, ask);
}
