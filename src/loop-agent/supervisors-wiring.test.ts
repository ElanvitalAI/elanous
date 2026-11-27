// SUPERVISOR-REVIVE-1127 wiring: every supervisor = card ⊕ body ⊕ mail seat ⊕ event-wake trigger ⊕ recipe — none is wake=none.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { canonicalMessageAddress } from '../msg/msg-store.js';
import { messageRouteFor } from '../loops/msg-address.js';
import { readTriggerDecl } from '../loops/trigger-registry.js';
import { loadCard } from './card.js';
import { hasBody, SUPERVISOR_BODIES } from './registry.js';
import { V2_AGENT_SEATS } from './seats.js';

const REPO = join(import.meta.dir, '../..');
const recipes = parse(readFileSync(join(REPO, 'graphs/triggers/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;

describe('supervisors on the v2 shell', () => {
  for (const id of SUPERVISOR_BODIES) {
    test(id, () => {
      const card = loadCard(id);
      expect(card.address).toBe(V2_AGENT_SEATS[id]!);
      expect(card.supervisor).toMatch(/^(OP|TC|RES|JUD)$/);
      expect(card.rights.actions).not.toEqual([]);
      expect(hasBody(id)).toBe(true);
      expect(canonicalMessageAddress(`loop:${id}`)).toBe(card.address);
      expect(messageRouteFor(card.address)).toMatchObject({ replyBody: 'agent' });
      // YAML-SUPERVISORS-RUNTIME: graphs/triggers/<id>-agent.yaml is only the tick shim — the trigger comes from agent.yaml
      const g = parse(readFileSync(join(REPO, 'graphs/triggers', `${id}-agent.yaml`), 'utf8')) as { graph_id: string; loop: { from_agent?: string; trigger?: unknown }; nodes: Array<{ recipe?: string }> };
      expect(g.graph_id).toBe(`${id}-agent`);
      expect(g.loop.from_agent).toBe(id);
      expect(g.loop.trigger).toBeUndefined(); // no second definition
      const decl = readTriggerDecl(`graphs/triggers/${id}-agent.yaml`, REPO);
      expect(!!decl.cron || !!decl.condition).toBe(true); // event wake, never wake=none
      expect(decl.goal.path).toBe(`{stateRoot}/loop-agents/${id}/last-tick.json`);
      expect(readFileSync(join(REPO, 'graphs/loop-agents', id, 'goal.yaml'), 'utf8').startsWith('# GENERATED from graphs/loop-agents/')).toBe(true);
      const recipe = g.nodes.find(n => n.recipe)!.recipe!.replace(/^cmd:/u, '');
      expect(recipes[recipe]!.command).toContain(`loop agent ${id} tick`);
    });
  }
  test('every supervisor starts live (SUPERVISOR-REVIVE · 0.3.38) · macrophage holds only the exact-PID reap', () => {
    for (const id of SUPERVISOR_BODIES) expect(loadCard(id).startLevel).toBe('live');
    expect(loadCard('macrophage').rights.actions).toEqual(['reap']);
  });
});
