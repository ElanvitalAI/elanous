import { expect, test } from 'bun:test';
import { createLiveWorld, LIVE_SCENARIOS, summarizeLiveObservations, summarizeLiveRuns, type ObservedLiveRun } from './op-behavior-live.js';

test('completion requires a valid decision, execution and evidence in order', async () => {
  const world = createLiveWorld(LIVE_SCENARIOS[0]!);
  expect(await world.dispatch('SimRecord', { stage: 'evidence', value: 'assign:TC' })).toMatchObject({ ok: false });
  expect(await world.dispatch('SimRecord', { stage: 'decision', value: 'assign:CX' })).toMatchObject({ ok: true });
  expect(await world.dispatch('SimRecord', { stage: 'execution', value: 'assign:TC' })).toMatchObject({ ok: false });
  expect(world.score()).toBe(false);
  expect(world.state.outcome).toBeUndefined();
  expect(await world.dispatch('SimRecord', { stage: 'execution', value: 'assign:CX' })).toMatchObject({ ok: true });
  expect(await world.dispatch('SimRecord', { stage: 'evidence', value: 'assign:CX' })).toMatchObject({ ok: true, observed: { owner: 'CX' } });
  expect(world.score()).toBe(false);
  for (const stage of ['decision', 'execution', 'evidence']) {
    expect(await world.dispatch('SimRecord', { stage, value: 'assign:TC' })).toMatchObject({ ok: true });
  }
  expect(world.score()).toBe(true);
  expect(world.state).toMatchObject({ owner: 'TC', operation: 'assign', target: 'TC', outcome: 'assign:TC' });
  await world.dispatch('SimRecord', { stage: 'decision', value: 'assign:CX' });
  expect(world.score()).toBe(false);
});

test('an empty or failing run cannot become a successful percentage', () => {
  expect(summarizeLiveRuns([])).toEqual({ completed: 0, total: 0, rate: null, errors: 0 });
  expect(summarizeLiveRuns([{ scenario: 'x', completed: false, events: [], state: {}, answer: 'done', provider: '', model: '', promptSha256: '', error: 'unavailable' }])).toEqual({ completed: 0, total: 1, rate: null, errors: 1 });
});

test('records human handoffs and final declared report without treating either as the hidden score', async () => {
  const world = createLiveWorld(LIVE_SCENARIOS[0]!);
  await world.dispatch('SimRecord', { stage: 'decision', value: 'handoff:human' });
  await world.dispatch('SimRecord', { stage: 'execution', value: 'handoff:human' });
  await world.dispatch('SimReport', { status: 'requested' });
  expect(world.observation()).toEqual({ declaredClosure: 'requested', toolHumanHandoffs: 1, reports: [{ status: 'requested', afterEvent: 2 }] });
  expect(world.score()).toBe(false);
  await world.dispatch('SimRecord', { stage: 'decision', value: 'assign:TC' });
  expect(world.observation().declaredClosure).toBeNull();
  await world.dispatch('SimReport', { status: 'verified' });
  expect(world.score()).toBe(false); // a declaration alone is not proof
});

test('missing observations and reports remain unknown, not zero', () => {
  const run: ObservedLiveRun = { scenario: 'roster', completed: false, events: [], state: {}, answer: '', provider: 'p', model: 'm', promptSha256: 'h' };
  expect(summarizeLiveObservations([run])).toEqual({ total: 1, observed: 0, reportCoverage: 0, declaredRequestedOrUnconfirmed: null, toolHumanHandoffs: null });
  run.observation = { declaredClosure: null, toolHumanHandoffs: 1, reports: [] };
  expect(summarizeLiveObservations([run])).toEqual({ total: 1, observed: 1, reportCoverage: 0, declaredRequestedOrUnconfirmed: null, toolHumanHandoffs: 1 });
  run.observation.declaredClosure = 'unconfirmed';
  expect(summarizeLiveObservations([run])).toEqual({ total: 1, observed: 1, reportCoverage: 1, declaredRequestedOrUnconfirmed: 1, toolHumanHandoffs: 1 });
});
