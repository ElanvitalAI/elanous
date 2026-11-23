import type { WorkspaceConfig } from './workspace-config.js';

/** Read-only first migration phase. Ambiguous titles are never adopted. */
export function workspacePlan(config: WorkspaceConfig, current: { hqCoordinatorSeat?: string; workspaces: { id: string; name: string; coordinatorSeat?: string }[]; tabs: { id: string; workspaceId: string; label: string }[]; panes: { tab: string; pane?: string; title: string; seat?: string | null; state?: string }[] }): string[] {
  const lines: string[] = [];
  const claimed = new Set<string>();
  if (config.hq) {
    if (current.hqCoordinatorSeat && current.hqCoordinatorSeat !== config.hq.coordinator)
      lines.push(`! HQ coordinator already assigned to ${current.hqCoordinatorSeat}; cannot assign ${config.hq.coordinator}`);
    else if (!current.hqCoordinatorSeat) lines.push(`* HQ coordinator = ${config.hq.coordinator}`);
  }
  for (const [space, spec] of Object.entries(config.spaces)) {
    const ws = current.workspaces.find(w => w.name === space);
    for (const id of spec.seats) {
      const matches = current.panes.filter(p => p.seat === id);
      if (matches.length > 1) { lines.push(`! duplicate seat ${id}: ${matches.map(p => p.tab).join(', ')} — close one`); matches.forEach(p => claimed.add(p.pane ?? p.tab)); continue; }
      const found = matches[0];
      if (!found) { const seat = config.seats[id]!; lines.push(`+ open seat ${id} in space ${space} (${seat.runtime} · ${seat.host})`); continue; }
      claimed.add(found.pane ?? found.tab);
      if (found.state === 'exited') { lines.push(`! seat ${id} has exited — resolve its tab before continuing`); continue; }
      const tab = current.tabs.find(t => t.id === found.tab);
      if (!ws || tab?.workspaceId !== ws.id) lines.push(`~ ${id} is outside ${space} — left in place (move out of scope)`);
      else lines.push(`= ok ${id} in ${space}`);
    }
    if (ws?.coordinatorSeat !== spec.coordinator) lines.push(`* coordinator ${space} = ${spec.coordinator}`);
  }
  for (const p of current.panes) if (!claimed.has(p.pane ?? p.tab)) lines.push(`? unlisted ${p.title} (${p.pane ?? p.tab}) — left open`);
  return lines;
}
