// SIM-WORLD supervisors · YAML-SUPERVISORS-RUNTIME (CEO 11-27 17:4x «9종 YAML 정의 최우선») — agent.yaml is the ONE runtime
// source of the nine supervisors: the REAL trigger registry (readTriggerDecl → registerTrigger on a temp registry) builds the
// trigger from agent.yaml `wake:`; an edit there (condition → cron · a new minute) changes the registered row; the tick shim
// with its own loop.trigger is refused; goal.yaml is what agent.yaml generates and a hand edit is a lint failure (never a
// runtime stop). Expectations are independent literals (rule 11).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardsRoot } from '../../../loop-agent/card.js';
import { lintSupervisor } from '../../../loop-agent/v3/supervisor.js';
import { openTriggerRegistry, readTriggerDecl, registerTrigger } from '../../../loops/trigger-registry.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const NINE = ['autopsy', 'hand-steward', 'macrophage', 'release-rocket', 'run-doctor', 'run-supervisor', 'silence-watch', 'train-manager', 'watchers-check'];
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** A temp `graphs/` tree (loop-agents/<id> ⊕ triggers) — the same layout the registry reads in the repo and an install. */
function tree(base: string, id: string): { root: string; agent: string; goal: string; shim: string; shimRel: string } {
  const root = mkdtempSync(join(base, 'yrt-'));
  mkdirSync(join(root, 'graphs', 'loop-agents'), { recursive: true });
  cpSync(join(cardsRoot(), id), join(root, 'graphs', 'loop-agents', id), { recursive: true });
  cpSync(join(REPO, 'graphs', 'triggers'), join(root, 'graphs', 'triggers'), { recursive: true });
  const shimRel = `graphs/triggers/${id}-agent.yaml`;
  return { root, agent: join(root, 'graphs', 'loop-agents', id, 'agent.yaml'), goal: join(root, 'graphs', 'loop-agents', id, 'goal.yaml'), shim: join(root, shimRel), shimRel };
}
/** Replace the agent.yaml `wake.trigger` block (everything between `  trigger:` and `  failure:`) with a cron wake. */
const toCron = (yaml: string, cron: string): string => yaml.replace(/^  trigger:\n(?:    .*\n)+(?=  failure:)/mu, `  trigger:\n    cron: '${cron}'\n`);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-YAML-RUNTIME',
    title: 'agent.yaml is the one runtime source: the real registry builds the trigger from wake: · condition → cron and a new minute in agent.yaml change the registered row · a shim with its own trigger is refused · goal.yaml drift is a lint failure, not a runtime stop',
    async run(ctx) {
      const seeds = [ctx.seed, ctx.seed + 1, ctx.seed + 2, ctx.seed + 3, ctx.seed + 4];
      for (const seed of seeds) {
        const id = NINE[seed % NINE.length]!;
        const t = tree(ctx.universeRoot, id);
        const db = openTriggerRegistry(join(t.root, 'state'));
        try {
          // ① as shipped: a condition wake from agent.yaml, the shell's goal file, no cron
          const d0 = readTriggerDecl(t.shimRel, t.root);
          if (d0.graphId !== `${id}-agent` || !d0.condition || d0.cron !== undefined || d0.goal.path !== `{stateRoot}/loop-agents/${id}/last-tick.json`)
            return fail('decl-from-agent-yaml', `seed ${seed} ${id}: ${JSON.stringify({ g: d0.graphId, cron: d0.cron, goal: d0.goal })}`);
          const r0 = registerTrigger(db, d0);
          if (!r0.created || r0.row.cron !== undefined) return fail('register', `seed ${seed} ${id}: ${JSON.stringify({ created: r0.created, cron: r0.row.cron })}`);
          // ② agent.yaml only: the wake becomes a cron → the registered trigger is a cron
          const cronA = `${seed} */2 * * *`;
          writeFileSync(t.agent, toCron(readFileSync(t.agent, 'utf8'), cronA));
          const r1 = registerTrigger(db, readTriggerDecl(t.shimRel, t.root), { update: true });
          if (!r1.updated || r1.row.cron !== cronA || r1.row.condition !== undefined) return fail('cron-not-registered', `seed ${seed} ${id}: ${JSON.stringify({ updated: r1.updated, cron: r1.row.cron, cond: !!r1.row.condition })} (want ${cronA})`);
          // ③ a new minute in agent.yaml → the row follows
          const cronB = `${(seed + 7) % 60} */2 * * *`;
          writeFileSync(t.agent, readFileSync(t.agent, 'utf8').replace(`cron: '${cronA}'`, `cron: '${cronB}'`));
          const r2 = registerTrigger(db, readTriggerDecl(t.shimRel, t.root), { update: true });
          if (r2.row.cron !== cronB) return fail('cron-change-lost', `seed ${seed} ${id}: row cron ${r2.row.cron} (want ${cronB})`);
          // ④ the shim with its own trigger = two definitions → the registry refuses and lint says so
          const shimText = readFileSync(t.shim, 'utf8');
          writeFileSync(t.shim, shimText.replace(`  from_agent: ${id}\n`, `  from_agent: ${id}\n  trigger: { cron: '0 * * * *' }\n`));
          let refused = '';
          try { readTriggerDecl(t.shimRel, t.root); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
          if (!/must not declare loop\.trigger/u.test(refused)) return fail('two-definitions-accepted', `seed ${seed} ${id}: «${refused}»`);
          const lint2 = lintSupervisor(id, join(t.root, 'graphs', 'loop-agents'));
          if (lint2.ok || !lint2.errors.some(e => /two trigger definitions/u.test(e))) return fail('lint-two-definitions', `seed ${seed} ${id}: ${JSON.stringify(lint2.errors).slice(0, 200)}`);
          writeFileSync(t.shim, shimText);
          // ⑤ goal.yaml is generated: a hand edit is a lint (parity) failure, but the tick path still runs agent.yaml
          writeFileSync(t.goal, readFileSync(t.goal, 'utf8').replace(/^  cooldown_min: (\d+)$/mu, (_m, n: string) => `  cooldown_min: ${Number(n) + 1}`));
          const strict = lintSupervisor(id, join(t.root, 'graphs', 'loop-agents'), { parity: true });
          const runtime = lintSupervisor(id, join(t.root, 'graphs', 'loop-agents'));
          if (strict.ok || !strict.errors.some(e => /goal\.yaml drift: .*rights/u.test(e))) return fail('goal-drift-unseen', `seed ${seed} ${id}: ${JSON.stringify(strict.errors).slice(0, 200)}`);
          if (!runtime.ok) return fail('drift-stopped-runtime', `seed ${seed} ${id}: ${JSON.stringify(runtime.errors).slice(0, 200)}`);
          ctx.recorder.event('sup:yaml-runtime', { seed, id, cron: [cronA, cronB] });
        } finally { db.close(); }
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-YAML-SHIPPED',
    title: 'the shipped nine: every shim names its agent and has no trigger · the registry decl comes from agent.yaml · goal.yaml is the generated card (parity lint clean)',
    async run() {
      for (const id of NINE) {
        const shim = readFileSync(join(REPO, 'graphs', 'triggers', `${id}-agent.yaml`), 'utf8');
        if (!shim.includes(`  from_agent: ${id}\n`) || /^  trigger:/mu.test(shim)) return fail('shim', `${id}: not a pure from_agent shim`);
        const d = readTriggerDecl(`graphs/triggers/${id}-agent.yaml`, REPO);
        if (!d.condition && !d.cron) return fail('no-wake', id);
        const l = lintSupervisor(id, cardsRoot(), { parity: true });
        if (!l.ok) return fail('lint', `${id}: ${l.errors.join(' · ').slice(0, 200)}`);
        if (!readFileSync(join(cardsRoot(), id, 'goal.yaml'), 'utf8').startsWith(`# GENERATED from graphs/loop-agents/${id}/agent.yaml`)) return fail('goal-not-generated', id);
      }
      return { ok: true };
    },
  },
];
