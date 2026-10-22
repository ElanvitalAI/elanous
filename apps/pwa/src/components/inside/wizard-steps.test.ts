import { expect, test } from 'bun:test';
import type { WizardStepEvent } from '@/lib/inside-events';
import { wizardTimeline } from './wizard-steps';

const event = (step: WizardStepEvent['step'], wizardId = 'one', detail?: unknown): WizardStepEvent => ({
  ts: '2026-10-03T09:00:00Z', wizardId, step, text: `${step} message`, ...(detail === undefined ? {} : { detail }),
});
const steps: WizardStepEvent['step'][] = ['request', 'research', 'draft', 'validate', 'install', 'done'];
const labels = ['요청', '조사', '초안', '검증', '설치', '끝'];

test('no wizard events yields no timeline', () => {
  expect(wizardTimeline([])).toEqual([]);
});

test('request and research show six ordered steps, past done, latest now, future todo, and event text/time', () => {
  const rows = wizardTimeline([event('request'), event('research')]);
  expect(rows.map(row => row.step)).toEqual(steps);
  expect(rows.map(row => row.label)).toEqual(labels);
  expect(rows.map(row => row.state)).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[0]).toMatchObject({ text: 'request message', at: '2026-10-03T09:00:00Z' });
  expect(rows[1]).toMatchObject({ text: 'research message', at: '2026-10-03T09:00:00Z' });
  expect(rows[2]).not.toHaveProperty('text');
  expect(rows[2]).not.toHaveProperty('at');
});

test('done makes all six steps done, including a previous failed attempt', () => {
  expect(wizardTimeline([event('validate', 'one', { ok: false }), event('done')]).map(row => row.state)).toEqual(Array(6).fill('done'));
});

test('validate detail.ok false marks validation failed, including when it is the latest event', () => {
  expect(wizardTimeline([event('request'), event('validate', 'one', { ok: false })]).map(row => row.state))
    .toEqual(['done', 'done', 'done', 'failed', 'todo', 'todo']);
  expect(wizardTimeline([event('validate', 'one', { ok: true })])[3].state).toBe('now');
});

test('only the last wizard ID contributes events even if the earlier ID has more events', () => {
  const rows = wizardTimeline([event('request', 'one'), event('research', 'one'), event('done', 'one'), event('request', 'two')]);
  expect(rows.map(row => row.state)).toEqual(['now', 'todo', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[1]).not.toHaveProperty('text');
});

test('repeated events for one step use its latest text and timestamp', () => {
  const rows = wizardTimeline([event('request'), { ...event('request'), text: '새 요청', ts: '2026-10-03T09:01:00Z' }]);
  expect(rows[0]).toMatchObject({ state: 'now', text: '새 요청', at: '2026-10-03T09:01:00Z' });
});

const at = (step: WizardStepEvent['step'], ts: string, text = `${step} message`, wizardId = 'one'): WizardStepEvent =>
  ({ ts, wizardId, step, text });

test('조각 2/4 — 부모 SW-UI-WIZARD(상)를 중 이하로 나눈 몫: 사전순과 시각순이 어긋난 배열도 request 완료·research 진행 중·나머지 대기를 유지한다', () => {
  const rows = wizardTimeline([
    at('research', '2026-10-03T09:00:00.900Z'),
    at('request', '2026-10-03T09:00:00Z'),
  ]);
  expect(rows.map(row => row.state)).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[0]).toMatchObject({ step: 'request', text: 'request message', at: '2026-10-03T09:00:00Z' });
  expect(rows[1]).toMatchObject({ step: 'research', text: 'research message', at: '2026-10-03T09:00:00.900Z' });
  expect(rows[2]).not.toHaveProperty('text');
  expect(rows[2]).not.toHaveProperty('at');
});

test('같은 단계의 문면·시각은 배열 위치가 아니라 가장 늦은 ts 의 이벤트를 따른다', () => {
  const rows = wizardTimeline([
    at('request', '2026-10-03T09:00:00.900Z', '나중에 기록된 요청'),
    at('research', '2026-10-03T09:00:01Z'),
    at('request', '2026-10-03T09:00:00Z', '먼저 기록된 요청'),
  ]);
  expect(rows[0]).toMatchObject({ state: 'done', text: '나중에 기록된 요청', at: '2026-10-03T09:00:00.900Z' });
  expect(rows[1]).toMatchObject({ state: 'now' });
});

test('최신 위저드는 배열 끝이 아니라 가장 늦은 ts 의 이벤트 소유자다', () => {
  const rows = wizardTimeline([
    at('research', '2026-10-03T09:00:01Z', '2건 조사', 'two'),
    at('done', '2026-10-03T09:00:00Z', 'installed', 'one'),
  ]);
  expect(rows.map(row => row.state)).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[1]).toMatchObject({ text: '2건 조사' });
});

test('실측 발신 형식(밀리초 ts·실제 문면)의 request·research 한 건이 순서·상태·문면·시각·대기로 표시된다', () => {
  const rows = wizardTimeline([
    at('request', '2026-10-21T12:58:44.100Z', '플러그인 요청: 트렌드 리포트'),
    { ...at('research', '2026-10-21T12:58:45.500Z', '3건 조사'), detail: { sources: [], unavailable: [] } },
  ]);
  expect(rows.map(row => row.step)).toEqual(steps);
  expect(rows.map(row => row.state)).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
  expect(rows[0]).toMatchObject({ step: 'request', label: '요청', text: '플러그인 요청: 트렌드 리포트', at: '2026-10-21T12:58:44.100Z' });
  expect(rows[1]).toMatchObject({ step: 'research', label: '조사', text: '3건 조사', at: '2026-10-21T12:58:45.500Z' });
  expect(rows[2]).toMatchObject({ step: 'draft', label: '초안', state: 'todo' });
  expect(rows[2]).not.toHaveProperty('text');
  expect(rows[2]).not.toHaveProperty('at');
});
