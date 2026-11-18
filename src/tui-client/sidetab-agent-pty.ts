import { resolveBackend, resolveBackendSpawn } from '../agent-mission/driver.js';
import type { TerminalSession, TerminalSessionRegistry } from '../terminal/session-registry.js';
import { classifyFrameState, type FrameState } from '../capture/frame-state-detect.js';

export type SidetabAgent = 'codex' | 'claude' | 'hermes';

export function isSidetabAgent(value: string): value is SidetabAgent {
  return value === 'codex' || value === 'claude' || value === 'hermes';
}

const brandFor = (agent: SidetabAgent) => agent === 'claude' ? 'claude-code' : agent;

/** Reuse agent-mission's subscription CLI and credential scrub for a visible PTY. */
export function sidetabAgentLaunch(agent: SidetabAgent, baseEnv: Record<string, string | undefined>) {
  const spec = resolveBackendSpawn(resolveBackend(agent), baseEnv);
  return {
    command: [spec.cmd, ...spec.args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' '),
    env: spec.env,
    unsetEnv: spec.unsetEnv,
    agentBrand: brandFor(agent),
  } as const;
}

export function sidetabAgentSession(registry: TerminalSessionRegistry, id: string): TerminalSession | undefined {
  const session = registry.get(id);
  if (!session || session.kind !== 'coding-agent' || !['codex', 'claude-code', 'hermes'].includes(session.agentBrand ?? '')) return undefined;
  return session;
}

export function readSidetabAgent(registry: TerminalSessionRegistry, id: string): string | undefined {
  const session = sidetabAgentSession(registry, id);
  return session?.preview.renderForLLM();
}

const claudeSendTails = new WeakMap<TerminalSession, Promise<void>>();

export function sendSidetabAgent(registry: TerminalSessionRegistry, id: string, input: string): Promise<boolean> {
  const session = sidetabAgentSession(registry, id);
  if (!session || session.state === 'exited' || !session.preview.isAlive || !input.trim() || input.includes('\0')) return Promise.resolve(false);
  if (session.agentBrand !== 'claude-code') return Promise.resolve(session.preview.write(input + '\r'));
  const prior = claudeSendTails.get(session) ?? Promise.resolve();
  const current = prior.then(async () => {
    if (registry.get(id) !== session || !session.preview.isAlive) return false;
    if (!session.preview.write(input)) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 250)); // Source: agent-mission/driver.ts submitSeparately delay
    if (registry.get(id) !== session || !session.preview.isAlive) return false;
    return session.preview.write('\r');
  }).catch(() => false);
  claudeSendTails.set(session, current.then(() => undefined));
  return current;
}

/**
 * HERDR-REPLACE-C1 (herdr «keys»): named keys an agent CLI asks for — confirm, cancel, move, interrupt. Only these
 * names are accepted; anything else is refused whole (nothing is written), so a typo never reaches the agent.
 */
// A null-prototype map: inherited names (constructor, __proto__, toString …) are never keys (#38356 REVIEW-1).
export const SIDETAB_AGENT_KEYS: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  'ctrl-c': '\x03', 'ctrl-d': '\x04',
});

/** Write the named keys in order to the agent PTY. Unknown name, no session or a dead PTY → false and nothing written. */
export function sendSidetabAgentKeys(registry: TerminalSessionRegistry, id: string, names: readonly string[]): boolean {
  const session = sidetabAgentSession(registry, id);
  if (!session || session.state === 'exited' || !session.preview.isAlive || names.length === 0) return false;
  // Own keys only, as a second guard beside the null prototype.
  const sequences = names.map((name) => (Object.hasOwn(SIDETAB_AGENT_KEYS, name.toLowerCase()) ? SIDETAB_AGENT_KEYS[name.toLowerCase()] : undefined));
  if (sequences.some((sequence) => sequence === undefined)) return false;
  return sequences.every((sequence) => session.preview.write(sequence!));
}

/** HERDR-REPLACE-C1 (herdr «status»): what the agent is doing, from its screen (the `pty state` classifier). */
export function sidetabAgentStatus(registry: TerminalSessionRegistry, id: string): FrameState | undefined {
  const session = sidetabAgentSession(registry, id);
  if (!session) return undefined;
  if (session.state === 'exited' || !session.preview.isAlive) return 'done';
  return classifyFrameState(session.preview.renderForLLM()).state;
}
