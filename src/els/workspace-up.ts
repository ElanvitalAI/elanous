import type { WorkspaceConfig } from './workspace-config.js';
import { workspacePlan } from './workspace-plan.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

type Snapshot = Parameters<typeof workspacePlan>[1];
type Deps = {
  request: (request: ElsRequest) => Promise<ElsResult>;
  open: (id: string, space: string) => Promise<ElsResult>;
  confirm: (question: string) => Promise<'approve' | 'deny' | 'timeout'>;
  print: (text: string) => void;
};

/** The displayed plan is the approval boundary; all writes use the existing server doors. */
export async function workspaceUp(config: WorkspaceConfig, deps: Deps): Promise<ElsResult> {
  const list = async (): Promise<Snapshot> => {
    const result = await deps.request({ op: 'ls' });
    if (result.exitCode) throw new Error(result.message);
    const state = JSON.parse(result.message) as Snapshot;
    if (!Array.isArray(state.workspaces) || !Array.isArray(state.tabs) || !Array.isArray(state.panes)) throw new Error('invalid server list');
    return state;
  };
  try {
    const before = await list();
    const plan = workspacePlan(config, before);
    deps.print(`Plan:\n${plan.map(line => `  ${line}`).join('\n')}\n`);
    if (await deps.confirm('Continue? [y/N] ') !== 'approve') return { exitCode: 1, message: 'els up: cancelled or confirmation unavailable; no changes' };
    const current = await list();
    if (JSON.stringify(workspacePlan(config, current)) !== JSON.stringify(plan)) return { exitCode: 1, message: 'els up: state changed; rerun to review the new plan' };
    if (plan.some(line => line.startsWith('!'))) return { exitCode: 1, message: 'els up: resolve seat problems in the plan first (duplicate or exited); no changes' };
    for (const [space, spec] of Object.entries(config.spaces)) {
      for (const id of spec.seats) {
        const seat = config.seats[id]!;
        const matches = current.panes.filter(p => p.seat === id);
        if (matches.length) continue; // no rename, adoption or moving existing panes
        if (seat.host !== 'local' || (seat.runtime !== 'eln' && (seat.model || seat.provider)) || seat.profile || seat.title !== id) return { exitCode: 1, message: `els up: ${id}: remote host, non-eln model, profile and custom title are not supported by els seat; stopped` };
        const opened = await deps.open(id, space);
        if (opened.exitCode) return { exitCode: opened.exitCode, message: `els up: ${id}: ${opened.message}; stopped (earlier changes remain)` };
        const outcome = JSON.parse(opened.message) as { existing?: boolean };
        if (outcome.existing) return { exitCode: 1, message: `els up: ${id} appeared after review; rerun to review its location (earlier changes remain)` };
        deps.print(`opened ${id} in ${space}\n`);
      }
      // Workspace is created by opening its first seat; do not manufacture shell panes.
      const after = await list();
      const ws = after.workspaces.find(w => w.name === space);
      if (!ws) return { exitCode: 1, message: `els up: workspace ${space} does not exist; tabs are not moved (earlier changes remain)` };
      if (ws.coordinatorSeat !== spec.coordinator) {
        const result = await deps.request({ op: 'coordinator', ws: ws.id, seat: spec.coordinator });
        if (result.exitCode) return { exitCode: result.exitCode, message: `els up: ${result.message}; stopped (earlier changes remain)` };
        deps.print(`${result.message}\n`);
      }
    }
    if (config.hq && current.hqCoordinatorSeat !== config.hq.coordinator) {
      // The server serializes this separate HQ door with other journal mutations.
      const request: ElsRequest = { op: 'hq-coordinator', seat: config.hq.coordinator };
      const result = await deps.request(request);
      if (result.exitCode) return { exitCode: result.exitCode, message: `els up: ${result.message}; stopped (earlier changes remain)` };
      deps.print(`${result.message}\n`);
    }
    return { exitCode: 0, message: 'els up: done' };
  } catch (error) { return { exitCode: 1, message: `els up: ${error instanceof Error ? error.message : String(error)}; stopped (earlier changes may remain)` }; }
}
