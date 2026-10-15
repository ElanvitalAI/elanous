// ── TUI-MODEL-SESSION-SCOPE (10-14) — /model 은 «이 세션» 핀이 기본이다 ──
//
// 10-14 21:33 OPT: `/model luna` 가 운영 config 의 llm.model 을 바꿨는데, codex 티어 정책이
// configuredModel 을 무시해 이후 모든 턴이 sol 로 돌았다(llm.route-decision source=legacy-default).
// 여기서 잠그는 것: ① 세션 핀이 다음 턴 결정을 explicit-pin·luna 로 만든다 ② config 파일은 그대로
// ③ --global 일 때만 파일에 쓰고, 그때도 이 세션은 바로 반영된다.
// ⛔ 다음 턴 결정은 «재현 헬퍼»가 아니라 실물 getActiveModel 본체(resolveDashboardActiveModel)로 잰다
//   (1R 리뷰 GOODHART — 재현 헬퍼는 실제 연결이 깨져도 초록이다).

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from './dashboard-handlers.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { getUserConfig, reloadUserConfig } from '../../user-config.js';
import { lookupLlmTierSpec } from '../../model-tier/index.js';
import { currentRouteDecision, sessionModelPin, setSessionModelPin } from '../../llm/route-decision.js';
import { resolveDashboardActiveModel } from '../acp-active-model.js';

const LUNA = lookupLlmTierSpec('openai-codex', 'budget').model;
const SOL = lookupLlmTierSpec('openai-codex', 'best').model;

let dir: string;
let configPath: string;
const savedXdg = process.env.XDG_CONFIG_HOME;

function ctx(lines: string[]): DashboardSlashContext {
  const id = (s: string) => s;
  return {
    chatLines: lines,
    pushChatLine: (s: string) => { lines.push(s); },
    pushDebugLine: () => {},
    accent: id, warning: id, error: id, success: id, muted: id, text: id, highlight: id, info: id,
    setChatScrollOffset: () => {},
    refreshReasoningHudSegment: () => {},
    draw: () => {},
  } as unknown as DashboardSlashContext;
}

function writeCfg(): void {
  writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openai-codex', model: SOL, reasoningLevel: 'high' } }, null, 2));
  reloadUserConfig();
}

/** The real ACP `getActiveModel` body: returns the model and records the surface's route decision. */
function nextTurnDecision(text: string) {
  const model = resolveDashboardActiveModel(text);
  const decision = currentRouteDecision('dashboard')!;
  expect(decision.model).toBe(model ?? '');
  return decision;
}

beforeAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  dir = mkdtempSync(join(tmpdir(), 'model-session-scope-'));
  configPath = join(dir, 'config.json');
  setElanousConfigDir(dir);
});

afterEach(() => {
  setSessionModelPin('dashboard', null);
});

afterAll(() => {
  resetElanousConfigDir();
  reloadUserConfig();
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

test('/model luna pins this session: the next turn is explicit-pin luna and config is untouched', async () => {
  writeCfg();
  const before = readFileSync(configPath, 'utf-8');
  // 전제 — 핀 없이는 정책이 configuredModel 을 무시하고 sol 을 고른다(10-14 결함의 모양).
  expect(nextTurnDecision('이 설계를 계획해줘')).toMatchObject({ model: SOL, source: 'legacy-default' });

  const lines: string[] = [];
  await buildDashboardSlashRegistry().dispatch('model', ['luna'], ctx(lines));

  expect(nextTurnDecision('이 설계를 계획해줘')).toMatchObject({ model: LUNA, source: 'explicit-pin' });
  expect(readFileSync(configPath, 'utf-8')).toBe(before);
  expect(getUserConfig().llm.model).toBe(SOL);
  expect(lines.join('\n')).toContain('이 세션만');
  expect(lines.join('\n')).not.toContain('실행 뱃지(#4442)');
});

test('/model luna --global writes config and still applies to this session at once', async () => {
  writeCfg();
  const lines: string[] = [];
  await buildDashboardSlashRegistry().dispatch('model', ['luna', '--global'], ctx(lines));
  expect(JSON.parse(readFileSync(configPath, 'utf-8')).llm.model).toBe(LUNA);
  // config 만으로는 codex 정책이 무시한다 — 이 세션은 핀으로 다음 턴에 바로 먹어야 한다(1R mf).
  expect(nextTurnDecision('이 설계를 계획해줘')).toMatchObject({ model: LUNA, source: 'explicit-pin' });
  expect(lines.join('\n')).toContain('전역');
  expect(lines.join('\n')).toContain('이 세션은 다음 턴부터');
});

test('/model reset drops the pin; a cross-provider choice needs --global and writes nothing', async () => {
  writeCfg();
  const before = readFileSync(configPath, 'utf-8');
  const registry = buildDashboardSlashRegistry();
  await registry.dispatch('model', ['luna'], ctx([]));
  await registry.dispatch('model', ['reset'], ctx([]));
  expect(sessionModelPin('dashboard')).toBeNull();

  const lines: string[] = [];
  await registry.dispatch('model', ['opus'], ctx(lines));
  expect(sessionModelPin('dashboard')).toBeNull();
  expect(readFileSync(configPath, 'utf-8')).toBe(before);
  expect(lines.join('\n')).toContain('--global');
});

test('/model 빠름 in session scope: the model line and the scope note both say the reasoning that stays (high)', async () => {
  writeCfg(); // reasoningLevel: high
  const lines: string[] = [];
  await buildDashboardSlashRegistry().dispatch('model', ['빠름'], ctx(lines));
  const modelLine = lines.find((l) => l.startsWith('모델:'))!;
  const scopeLine = lines.find((l) => l.includes('이 세션만'))!;
  expect(modelLine).toContain('생각 high 그대로');
  // 빠름 티어의 생각 깊이를 «바뀐 값»처럼 쓰지 않는다.
  const tierReasoning = lookupLlmTierSpec('openai-codex', 'budget').reasoningLevel;
  if (tierReasoning && tierReasoning !== 'high') expect(modelLine).not.toContain(`생각 ${tierReasoning}`);
  expect(scopeLine).toContain('생각 깊이는 그대로 high');
  expect(getUserConfig().llm.reasoningLevel).toBe('high');
});
