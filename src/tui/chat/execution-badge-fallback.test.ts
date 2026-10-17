// TUI-MODEL-BADGE-ACTUAL (10-16 · 부분 착지) — 폴백으로 다른 모델이 응답하면 완료 배지가 «처음 → 실제» 를 보인다.
// 실물 경로: 결정 = resolveDashboardActiveModel(ACP getActiveModel 본체) · 실행 = recordDashboardTurnExecution
// (대시보드 runTurnUsageRuntime 이 부르는 것) · 배지 = resolveDashboardExecutionBadge(turn-finalize 가 부르는 것).
// 상태줄·/model «지금:» 의 원천 통일은 후속 칸 TUI-MODEL-BADGE-SOURCE · 원격 데몬 세션은 TUI-MODEL-BADGE-REMOTE.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDashboardTurnExecution, resolveDashboardActiveModel } from '../../dashboard/acp-active-model.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { reloadUserConfig } from '../../user-config.js';
import { lookupLlmTierSpec } from '../../model-tier/index.js';
import { currentRouteExecution, setSessionModelPin } from '../../llm/route-decision.js';
import { resolveDashboardExecutionBadge } from './execution-badge.js';

const CODING = lookupLlmTierSpec('openai-codex', 'better').model;
const GROK = 'grok-4.3';
let dir: string;
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  dir = mkdtempSync(join(tmpdir(), 'badge-fallback-'));
  setElanousConfigDir(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ llm: { provider: 'openai-codex', model: CODING, reasoningLevel: 'high' } }, null, 2));
  reloadUserConfig();
  setSessionModelPin('dashboard', null);
});

afterAll(() => {
  resetElanousConfigDir();
  reloadUserConfig();
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

test('폴백으로 grok 이 응답하면 완료 배지가 «처음 → 실제» 이고 생각 깊이를 붙이지 않는다', () => {
  expect(resolveDashboardActiveModel('이 버그를 고쳐줘')).toBe(CODING);
  expect(resolveDashboardExecutionBadge()).toStartWith(`🧠 ${CODING}`);
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  expect(currentRouteExecution('dashboard')).toEqual({ model: GROK, provider: 'grok' });
  expect(resolveDashboardExecutionBadge()).toBe(`🧠 ${CODING} → ${GROK}`);
  // 다음 턴의 결정이 서면 지난 턴의 실행은 지워진다(낡은 «→» 가 남지 않는다).
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  expect(currentRouteExecution('dashboard')).toBeNull();
  expect(resolveDashboardExecutionBadge()).not.toContain('→');
});

test('반증: 같은 모델이 응답하면 화살표를 꾸미지 않는다', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: CODING, routeProvider: 'openai-codex' }, { remote: false });
  expect(resolveDashboardExecutionBadge()).not.toContain('→');
});

test('로컬 폴백 턴 다음에 원격 턴이 오면 배지에 «→» 가 없다 — 지난 «A → B» 가 다시 보이지 않는다', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  expect(resolveDashboardExecutionBadge()).toContain('→');
  // 원격 턴 — 로컬 결정은 새로 서지 않고 원격 사용량만 들어온다.
  recordDashboardTurnExecution({ model: 'remote-model', routeProvider: 'grok' }, { remote: true });
  expect(currentRouteExecution('dashboard')).toBeNull();
  expect(resolveDashboardExecutionBadge()).not.toContain('→');
});

test('로컬 폴백 턴 → 모델 없는 원격 사용량 봉투 → 배지에 «→» 가 없다(model 은 선택 칸)', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  expect(resolveDashboardExecutionBadge()).toContain('→');
  recordDashboardTurnExecution({}, { remote: true });
  expect(currentRouteExecution('dashboard')).toBeNull();
  expect(resolveDashboardExecutionBadge()).not.toContain('→');
});

test('원격 데몬 세션·세션 위치 미상은 실행을 적지 않는다 — 로컬 결정과 짝지어 거짓 «→» 를 만들지 않는다', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: true });
  expect(currentRouteExecution('dashboard')).toBeNull();
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, null);
  expect(currentRouteExecution('dashboard')).toBeNull();
  expect(resolveDashboardExecutionBadge()).not.toContain('→');
});
