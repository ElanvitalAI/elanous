import { resolveBackend, resolveBackendSpawn } from '../agent-mission/driver.js';
import type { TerminalSession, TerminalSessionRegistry } from '../terminal/session-registry.js';

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
