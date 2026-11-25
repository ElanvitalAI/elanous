// SPACE-ADVISOR graph node (graphs/triggers/space-advisor-tc.yaml · recipe space-advisor-tick) — one advise run per tick.
// Prints one JSON line `{ outcome, ... }` and appends the window goal line to {stateRoot}/loops/space-advisor-<space>.jsonl.
// stage `live` writes outcomes and cards; any other stage is shadow (decide only).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { defaultMsgStorePath, openMsgStore } from '../../msg/msg-store.js';
import { loadFederationLadder, spawnHandDecision } from '../../msg/hand-raise-ladder.js';
import { liveAdvisorPorts, runAdvise } from './advisor-live.js';

interface Ctx { input?: { window?: string; stage?: string; space?: string; advisor?: string; vars?: { stateRoot?: string } } }

export function runAdvisorNode(ctx: Ctx): Record<string, unknown> {
  const input = ctx.input ?? {};
  const stateRoot = input.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot();
  const live = input.stage === 'live';
  const space = (input.space ?? 'TC').toUpperCase();
  const store = openMsgStore(defaultMsgStorePath());
  let run;
  try {
    const ports = liveAdvisorPorts();
    run = runAdvise(store, { ladder: loadFederationLadder(), now: () => Date.now(), raiseDecision: spawnHandDecision, coordinator: space,
      ...(input.advisor ? { advisor: input.advisor } : {}), live, ...(ports ? { ports } : {}) });
  } finally { store.close(); }
  const counts: Record<string, number> = {};
  for (const s of run.steps) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  mkdirSync(join(stateRoot, 'loops'), { recursive: true });
  appendFileSync(join(stateRoot, 'loops', `space-advisor-${space.toLowerCase()}.jsonl`), `${JSON.stringify({ goal: 'met', window: input.window ?? 'manual', live, counts })}\n`);
  return { outcome: 'ok', live, space, counts, learned: run.learned.length };
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    const ctx = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ctx : {};
    console.log(JSON.stringify(runAdvisorNode(ctx)));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
