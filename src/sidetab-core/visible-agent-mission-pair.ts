import type { VisibleMissionPty, VisibleMissionResult } from './visible-agent-mission.js';

export type VisibleMissionAgent = 'codex' | 'claude';

export interface VisibleMissionPairDeps<Pty extends VisibleMissionPty = VisibleMissionPty> {
  spawn(agent: VisibleMissionAgent): Pty | null;
  run(agent: VisibleMissionAgent, mission: string, pty: Pty): Promise<VisibleMissionResult>;
  dispose?(pty: Pty): void;
}

/** Spawn both visible agent PTYs before dispatching either mission, then collect both verified files. */
export async function runVisibleAgentMissionPair<Pty extends VisibleMissionPty>(
  deps: VisibleMissionPairDeps<Pty>,
  primaryAgent: VisibleMissionAgent,
  primaryMission: string,
  parallelMission: string,
): Promise<{ ok: boolean; codex: VisibleMissionResult | null; claude: VisibleMissionResult | null; error?: string }> {
  const agents: readonly [VisibleMissionAgent, VisibleMissionAgent] = [primaryAgent, primaryAgent === 'codex' ? 'claude' : 'codex'];
  const ptys = new Map<VisibleMissionAgent, Pty>();
  for (const agent of agents) {
    let pty: Pty | null;
    try { pty = deps.spawn(agent); }
    catch (error) {
      for (const started of ptys.values()) {
        try { deps.dispose?.(started); } catch { /* keep cleanup best-effort across the pair */ }
      }
      return { ok: false, codex: null, claude: null, error: `${agent} sidetab PTY could not start; neither mission was dispatched: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!pty) {
      for (const started of ptys.values()) {
        try { deps.dispose?.(started); } catch { /* keep cleanup best-effort across the pair */ }
      }
      return { ok: false, codex: null, claude: null, error: `${agent} sidetab PTY could not start; neither mission was dispatched` };
    }
    ptys.set(agent, pty);
  }

  const missions = new Map<VisibleMissionAgent, string>([[primaryAgent, primaryMission], [agents[1], parallelMission]]);
  const results = await Promise.all(agents.map(async (agent) => {
    const pty = ptys.get(agent)!;
    try { return [agent, await deps.run(agent, missions.get(agent)!, pty)] as const; }
    catch (error) {
      return [agent, { ok: false, path: '', promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false,
        error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  const byAgent = new Map(results);
  const codex = byAgent.get('codex')!;
  const claude = byAgent.get('claude')!;
  return { ok: codex.ok && claude.ok, codex, claude };
}
