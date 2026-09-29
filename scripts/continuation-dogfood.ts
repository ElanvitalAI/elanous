#!/usr/bin/env bun
// §5-③ controlled dogfood — drives the NATIVE continuation stack the
// daemon uses (ContinuationScheduler → ContinuationDriver → bridge →
// turn-runner) against a scratch goal with a quick termination, using
// the real active LLM. Bounded: scratch dir + maxTurns cap + a
// single-file completion condition. Observes each tick's outcome.
//
// Run: bun run scripts/continuation-dogfood.ts

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverObsidianVault } from '../src/auto-research/obsidian-bridge.js';
import { dispatchResearchPlan } from '../src/auto-research/tools/research-plan.js';
import {
  dispatchEnterAutoMode,
  getAutoModeState,
  resetAutoModeForTest,
} from '../src/auto-research/auto-mode/index.js';
import { resolveGoalPaths } from '../src/auto-research/goal-paths.js';
import { buildContinuationDriverDeps } from '../src/dispatch/continuation-bridge.js';
import { ContinuationDriver } from '../src/dispatch/continuation-driver.js';
import { ContinuationScheduler } from '../src/dispatch/continuation-scheduler.js';
import type { ContinuationStepResult } from '../src/dispatch/continuation-driver.js';
import { makeContinuationRunTurn } from '../src/dispatch/continuation-turn-runner.js';
import { getUserConfig } from '../src/user-config.js';
import { envLiteral } from '../src/platform/env-literal.js';

const SLUG = 'continuation-demo';
const MAX_TICKS = 5;

resetAutoModeForTest();
const home = mkdtempSync(join(tmpdir(), 'cont-dogfood-'));
const vault = discoverObsidianVault({ env: envLiteral({ ELANOUS_OBSIDIAN_VAULT: join(home, 'vault') }), cwd: home });
const paths = resolveGoalPaths(vault, SLUG);
const summaryPath = join(paths.goalRoot, 'executive-summary.md');

const TERM = { kind: 'summary_written', path: 'executive-summary.md', minChars: 50 } as const;

console.log('loop-engineering §5-③ controlled dogfood');
console.log(`  vault    : ${vault.root}`);
console.log(`  goalRoot : ${paths.goalRoot}`);
console.log(`  provider : ${getUserConfig().llm.provider} / ${getUserConfig().llm.model}`);

await dispatchResearchPlan(
  { action: 'init', goal_slug: SLUG, mission: 'Loop-engineering one-liner summary', termination: TERM },
  { vault },
);

// Explicit plan so the agent knows exactly WHAT + WHERE — the loop-prompt
// injects this. The single completion condition is the summary file.
writeFileSync(
  join(paths.goalRoot, 'plan.md'),
  [
    '# Task',
    'Write a 2-3 sentence executive summary of what "loop engineering" is',
    '(designing self-running agent loops that prompt the agent for you,',
    'instead of typing prompts by hand) using the Write tool to this exact path:',
    '',
    `  ${summaryPath}`,
    '',
    'That single file (≥50 chars) is the ONLY completion condition. Write it, then stop.',
  ].join('\n'),
);

await dispatchEnterAutoMode({ goal_slug: SLUG }, { vault });
const s0 = getAutoModeState();
console.log(`  goal active: ${s0.active} (slug=${s0.goalSlug}, maxTurns=${s0.maxTurns})`);

const cfg = getUserConfig();
const runTurn = makeContinuationRunTurn(cfg);
// Holder avoids TS control-flow narrowing `last` to `never` (only
// assigned inside the onOutcome closure).
const obs: { last: ContinuationStepResult | null } = { last: null };

const scheduler = new ContinuationScheduler({
  isIdle: () => true, // demo: always idle so it drives to completion
  getActiveGoal: () => {
    const s = getAutoModeState();
    return s.active && s.goalSlug && s.terminationRule ? { goalSlug: s.goalSlug } : null;
  },
  makeDriver: (goal) => new ContinuationDriver(buildContinuationDriverDeps({
    goalSlug: goal.goalSlug,
    terminationRule: getAutoModeState().terminationRule!,
    runTurn,
    vault, // self-contained: resolve goalRoot against the scratch vault
    onAndon: (reason) => console.log(`  🛑 ANDON: ${reason}`),
    maxTurns: 4,
  })),
  onOutcome: (_slug, r) => { obs.last = r; },
});

for (let i = 1; i <= MAX_TICKS; i++) {
  console.log(`\n━━ tick ${i} ━━ (fires one autonomous ${cfg.llm.model} turn)`);
  const t0 = Date.now();
  await scheduler.tick();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const o = obs.last;
  console.log(`  outcome: ${o?.outcome ?? '(no goal)'} · turns=${o?.turns ?? 0} · ${dt}s`);
  if (o && (o.outcome === 'complete' || o.outcome === 'andon-no-progress' || o.outcome === 'max_turns')) break;
}

console.log('\n── result ──');
console.log(`  final outcome : ${obs.last?.outcome ?? '(none)'}`);
console.log(`  summary file  : ${existsSync(summaryPath) ? 'WRITTEN ✓' : 'missing ✗'}`);
if (existsSync(summaryPath)) {
  console.log(`  content       : ${readFileSync(summaryPath, 'utf-8').trim().slice(0, 180)}`);
}
process.exit(obs.last?.outcome === 'complete' ? 0 : 1);
