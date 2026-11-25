// DR16 · SESSION-AUTOPILOT — a coordinator session starts in autopilot with the standing release goal, a person's
// «자율주행 꺼/시작» (fake model → autopilot_set tool call) flips the persisted state, a human turn pauses it and 10 quiet
// minutes resume it, and a publish-verified release rolls the goal to the next version. AUTOPILOT-DYNAMIC-GOAL-FEED:
// standing goal → crown mail → goal swap → 3 duplicate ticks (one block) → crown closes → standing returns; 10 ordinary
// mails never move the goal. Universe-local files only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyRegressionScenario } from './scenarios.js';

export const dr16: DailyRegressionScenario = {
  id: 'DR16', prs: [],
  title: 'session autopilot: coordinator default ON (no volume stop) · tool on/off · human takeover + 10 min resume · release goal roll · three-tier goal feed',
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
    eq('keystroke keeps AUTO', pilot.statusText().startsWith('🚗 AUTO'), true);
    pilot.set({ on: true, hold: true }, 'tool');
    eq('explicit hold', pilot.statusText(), '🚗 PAUSED · 사람 운전');
    eq('resume', pilot.set({ on: true }, 'slash').ok, true);
    publish('0.3.35');
    pilot.tick();
    eq('goal rolled', pilot.state().goal, '0.3.36 개발 — 로스터 착지 · 초록 +10/h');
    eq('events', events.filter((e) => ['on', 'off', 'pause', 'resume', 'goal-rolled'].includes(e)), ['on', 'pause', 'resume', 'goal-rolled']); // pause = explicit hold
    eq('cards', cards, []);
    ctx.note('dr16-run', { goal: pilot.state().goal, events: events.length });
    // ── AUTOPILOT-DYNAMIC-GOAL-FEED: a fresh coordinator seat in the same universe ──
    const { withGoalFeed } = await import('../../../session-autopilot/dynamic-goal.js');
    const feedFile = join(ctx.universeRoot, 'OP2', '.autopilot', 'state.json');
    const derived: Array<Record<string, unknown>> = [];
    const seat = createAutopilot({ file: feedFile, now: () => t, coordinator: true,
      standingGoal: () => resolveStandingGoal({ hqRoot: ctx.universeRoot, ledgerRoot: ctx.universeRoot, packageVersion: '0.3.36-dev.0', now: t }),
      log: (e, d) => { if (e === 'goal-derived') derived.push(d); }, raiseDecision: () => 'D-2', postProgress: () => {} });
    seat.refresh();
    eq('feed: standing goal', seat.state().goal, '0.3.36 개발');
    for (let i = 0; i < 10; i += 1) seat.observeMail([{ msgId: 300 + i, crownDirective: null, text: `[from TC · request]\nmsg:${300 + i} · 리뷰 부탁 ${i}` }]);
    eq('feed: 10 ordinary mails → goal unchanged', seat.state().goal, '0.3.36 개발');
    const crown = { msgId: 400, crownDirective: '9001', text: '[from OPC · request · crown]\nmsg:400 · 데모 리허설 먼저' };
    seat.observeMail([crown]);
    eq('feed: crown → goal swap', seat.state().goal, '[지시] 데모 리허설 먼저');
    let turnInput: string[] = ['els-block', 'owner-check'];
    for (let tick = 0; tick < 3; tick += 1) { seat.observeMail([crown]); seat.tick(); turnInput = withGoalFeed(turnInput, seat.goalFeed()); }
    eq('feed: 3 duplicate ticks → one goal block at head', turnInput.filter((b) => b.includes('🎯 지금 골')).length, 1);
    eq('feed: head block', turnInput[0]?.split('\n')[1], '🎯 지금 골: [지시] 데모 리허설 먼저 (1급 골 · crown:9001)');
    eq('feed: close', seat.closeFirstClass(), true);
    turnInput = withGoalFeed(turnInput, seat.goalFeed());
    eq('feed: standing returns', seat.state().goal, '0.3.36 개발');
    eq('feed: head block after close', turnInput[0]?.split('\n')[1], '🎯 지금 골: 0.3.36 개발 (상시 골 · standing)');
    eq('feed: goal-derived log', derived.map((d) => `${d.tier}|${d.source}|${d.goal}`),
      ['standing|standing|0.3.36 개발', 'first-class|crown:9001|[지시] 데모 리허설 먼저', 'standing|standing|0.3.36 개발']);
    ctx.note('dr16-goal-feed', { derived, final: seat.state().goal, blocks: turnInput.length });
    return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') };
  },
};
