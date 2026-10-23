// TUI-MODEL-BADGE-ACTUAL (10-16 · 상태줄·/model 조각) — 배지는 «이번 턴 실제» 공급자·모델을 보이고,
// 폴백이면 «처음 → 실제» 를 보인다(#24·#66).
// 실물 경로: ACP 사용량 핸들러(dashboard/index.ts) → recordDashboardTurnExecution(acp-active-model.ts)
//   → statusModelActual(read-model) → createStatusProviderInfoReader(상태줄 리더)
//   → modelSegment(bar.ts 렌더) → buildStatusLine(mouse-wiring.ts).
// 무대: L2 격리 config-dir mock 무대 — 임시 HOME/config 로 실 생산 함수 체인을 그대로 지난다.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDashboardTurnExecution, resolveDashboardActiveModel } from '../dashboard/acp-active-model.js';
import { createDashboardMouseWiring } from '../dashboard/input/mouse-wiring.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { currentRouteExecution, setSessionModelPin } from '../llm/route-decision.js';
import { lookupLlmTierSpec } from '../model-tier/index.js';
import { stripAnsi } from '../tui.js';
import { reloadUserConfig } from '../user-config.js';
import { modelSegment, renderPrimaryStatus, renderStatusLines, type StatusModelInfo } from './bar.js';
import { createStatusProviderInfoReader, statusModelActual } from './status-provider-info.js';

const CODING = lookupLlmTierSpec('openai-codex', 'better').model;
const GROK = 'grok-4.3';
const CWD = '/tmp/badge-actual';
const plain = (s: string): string => stripAnsi(s);

let dir: string;
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  dir = mkdtempSync(join(tmpdir(), 'status-badge-actual-'));
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

test('TUI-MODEL-BADGE-ACTUAL: 폴백 턴이면 배지가 «처음 → 실제» 다', () => {
  const info: StatusModelInfo = {
    provider: 'openai-codex',
    model: CODING,
    actual: { provider: 'grok', model: GROK, fallbackFrom: CODING },
  };
  const badge = plain(modelSegment(info));
  expect(badge).toContain(`${CODING} → ${GROK}`);
  expect(badge).toMatch(/→ grok/);
});

test('TUI-MODEL-BADGE-ACTUAL: 배지의 «지금» 은 설정 모델이 아니라 이번 턴 실제 모델이다', () => {
  const info: StatusModelInfo = {
    provider: 'openai-codex',
    model: 'gpt-5.5-config',
    actual: { provider: 'grok', model: GROK },
  };
  const badge = plain(modelSegment(info));
  expect(badge).toContain(GROK);
  expect(badge).not.toContain('gpt-5.5-config');
  // 폴백이 아니면 화살표를 꾸미지 않는다.
  expect(badge).not.toContain('→');
});

test('TUI-MODEL-BADGE-ACTUAL: 상태줄 두 줄 렌더도 실제 실행을 쓴다(renderStatusLines)', () => {
  const lines = renderStatusLines({
    cwd: CWD,
    providerInfo: {
      provider: 'openai-codex',
      model: CODING,
      actual: { provider: 'grok', model: GROK, fallbackFrom: CODING },
    },
  }).map(plain);
  expect(lines[0]).toContain(`${CODING} → ${GROK}`);
});

test('TUI-MODEL-BADGE-ACTUAL: 생산 체인 — ACP 사용량이 적은 폴백이 상태줄 배지까지 온다', () => {
  // ① 턴 결정(ACP getActiveModel 본체) ② 실제 응답(ACP usage 핸들러가 부르는 기록)
  expect(resolveDashboardActiveModel('이 버그를 고쳐줘')).toBe(CODING);
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  expect(currentRouteExecution('dashboard')).toEqual({ model: GROK, provider: 'grok' });
  // ③ 상태줄 리더가 읽는 read-model ④ 리더(대시보드 buildStatusLine 이 부르는 그 리더) ⑤ 렌더
  const actual = statusModelActual('dashboard');
  expect(actual).toEqual({ model: GROK, provider: 'grok', fallbackFrom: CODING });
  const reader = createStatusProviderInfoReader();
  const primary = plain(renderPrimaryStatus({ cwd: CWD, providerInfo: reader(undefined, actual) }));
  expect(primary).toContain(`${CODING} → ${GROK}`);
});

test('TUI-MODEL-BADGE-ACTUAL: 대시보드 상태줄 빌더(buildStatusLine)까지 실제 실행이 도달한다', () => {
  expect(resolveDashboardActiveModel('이 버그를 고쳐줘')).toBe(CODING);
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  const wiring = createDashboardMouseWiring({
    termSize: () => ({ rows: 40, cols: 200 }),
    getRotation: () => [],
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: () => ({ dispose: () => {} }),
    redraw: () => {},
  });
  const reader = createStatusProviderInfoReader();
  const line = plain(wiring.buildStatusLine({ swd: CWD, providerInfo: reader(undefined, statusModelActual('dashboard')) }));
  expect(line).toContain(`${CODING} → ${GROK}`);
});

test('TUI-MODEL-BADGE-ACTUAL: 다음 턴 결정이 서면 지난 턴의 «→» 가 상태줄에 남지 않는다', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: false });
  expect(statusModelActual('dashboard')?.fallbackFrom).toBe(CODING);
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  expect(statusModelActual('dashboard')).toBeNull();
  const reader = createStatusProviderInfoReader();
  const primary = plain(renderPrimaryStatus({ cwd: CWD, providerInfo: reader(undefined, statusModelActual('dashboard')) }));
  expect(primary).not.toContain('→');
});

test('TUI-MODEL-BADGE-ACTUAL: 원격 턴은 실제 실행을 적지 않는다 — 거짓 «→» 를 만들지 않는다', () => {
  resolveDashboardActiveModel('이 버그를 고쳐줘');
  recordDashboardTurnExecution({ model: GROK, routeProvider: 'grok' }, { remote: true });
  expect(statusModelActual('dashboard')).toBeNull();
});

// ── 보존 계약 ─────────────────────────────────────────────────────────
// 이번 턴 실행이 없으면 배지·상태줄은 지금과 «같은» 값을 낸다(설정 공급자·모델 그대로).

test('보존: 이번 턴 실행이 없으면 배지는 설정 공급자·모델 그대로다', () => {
  const badge = plain(modelSegment({ provider: 'openai-codex', model: 'gpt-6-sol' }));
  expect(badge).toBe('gpt-6-sol');
  expect(plain(modelSegment({ provider: 'anthropic', model: '(none)' }))).toBe('anthropic');
});

test('보존: local 접두사·compact 절단 규칙은 그대로다', () => {
  expect(plain(modelSegment({ provider: 'local', model: 'qwen3.6-35b-a3b-ud-mlx' })))
    .toBe('local:qwen3.6-35b-a3b-ud-mlx');
  expect(plain(modelSegment({ provider: 'local', model: 'qwen3.6-35b-a3b-ud-mlx' }, { compact: true })))
    .toBe('local:qwen3.6-35b');
  expect(plain(modelSegment({ provider: 'openai-codex', model: 'claude-opus-4-6' }, { compact: true })))
    .toBe('claude-opus-4-6');
});

test('보존: 상태줄 구분자·세그먼트 순서는 그대로다(실행 정보가 없을 때)', () => {
  const primary = plain(renderPrimaryStatus({ cwd: CWD, providerInfo: { provider: 'openai-codex', model: 'gpt-6-sol' } }));
  expect(primary).toContain('gpt-6-sol');
  expect(primary.split('│')).toHaveLength(3);
});
