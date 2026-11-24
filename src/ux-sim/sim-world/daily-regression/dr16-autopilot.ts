// DR16 · SESSION-AUTOPILOT — a coordinator session starts in autopilot with the standing release goal, a person's
// «자율주행 꺼/시작» (fake model → autopilot_set tool call) flips the persisted state, a human turn pauses it and 10 quiet
// minutes resume it, and a publish-verified release rolls the goal to the next version. Universe-local files only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyRegressionScenario } from './scenarios.js';

export const dr16: DailyRegressionScenario = {
  id: 'DR16', prs: [],
  title: 'session autopilot: coordinator default ON (no volume stop) · tool on/off · human takeover + 10 min resume · release goal roll',
  async run(ctx) {
    const failures: string[] = [];
    const eq = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)} · observed ${JSON.stringify(actual)}`);
    };
    const { createAutopilot, readAutopilotState, resolveStandingGoal } = await import('../../../session-autopilot/autopilot.js');
    const { dispatchAutopilotTool } = await import('../../../session-autopilot/autopilot-tool.js');
    const rel = join(ctx.universeRoot, 'release');
    const publish = (v: string) => { mkdirSync(join(rel, v), { recursive: true }); writeFileSync(join(rel, v, 'release.json'), JSON.stringify({ version: v, prerelease: false, publishedAt: '2026-11-24T00:00:00.000Z' })); };
    publish('0.3.34');
    const file = join(ctx.universeRoot, 'OP', '.autopilot', 'state.json');
    let t = Date.parse('2026-11-24T06:00:00.000Z');
    const events: string[] = [];
    const cards: string[] = [];
    const pilot = createAutopilot({ file, now: () => t, coordinator: true,
      standingGoal: () => resolveStandingGoal({ hqRoot: ctx.universeRoot, ledgerRoot: ctx.universeRoot, packageVersion: '0.3.34-dev.0', now: t }), log: (e) => { events.push(e); },
      raiseDecision: (card) => { cards.push(card.title); return 'D-1'; }, postProgress: () => {} });
    pilot.refresh();
    eq('coordinator default goal', pilot.state().goal, '0.3.35 개발');
    eq('coordinator default on', pilot.state().on, true);
    eq('turn end arms a wake', pilot.turnEnded({ selfInitiated: true, failed: false })?.arm?.delayMs, 30 * 60_000);
    // A person: «자율주행 꺼» → the (fake) model emits autopilot_set({on:false}).
    await dispatchAutopilotTool('autopilot_set', { on: false }, { cwd: ctx.universeRoot, file, now: () => t });
    pilot.refresh();
    eq('off persisted', readAutopilotState(file)?.on, false);
    eq('off → no wake', pilot.turnEnded({ selfInitiated: true, failed: false }), { arm: null });
    await dispatchAutopilotTool('autopilot_set', { on: true }, { cwd: ctx.universeRoot, file, now: () => t });
    pilot.refresh();
    pilot.noteHuman();
    eq('human takeover', pilot.statusText(), '🚗 PAUSED · 사람 운전');
    t += 10 * 60_000;
    eq('auto-resume after 10 min', pilot.tick(), true);
    publish('0.3.35');
    pilot.tick();
    eq('goal rolled', pilot.state().goal, '0.3.36 개발');
    eq('events', events.filter((e) => ['on', 'off', 'pause', 'resume', 'goal-rolled'].includes(e)), ['on', 'pause', 'resume', 'goal-rolled']);
    eq('cards', cards, []);
    ctx.note('dr16-run', { goal: pilot.state().goal, events: events.length });
    return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') };
  },
};
