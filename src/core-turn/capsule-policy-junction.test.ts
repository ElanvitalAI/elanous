// CAPSULE-A1 junction fidelity — JUD-B #128143 실행 재현 → terra r8 mustFix[1]·JUD-B #128197 계약 정밀화(r9).
// (1) 도구별 해석(terra r8 mustFix[1]): capsuleRequestedBackground는 도구 family가 실제 지원하는 공식 키만
//     읽는다 — agent(Agent/Task)=run_in_background(agent/types.ts W1.3 AgentSpawn) ·
//     shell(Bash/Shell/RunShell/WebTerminal/Terminal)=mode:'bg'(skills/tools/shell.ts asMode · A2 축).
//     mcp__*·harness·graph family는 이 접합부에 공식 배경 키가 없다 — fail-open false(mcp/server.ts의
//     run_in_background는 인바운드 MCP 표면 Agent 전용이고 이 접합부를 지나지 않는다 · 실제 Bash 스키마는
//     command+timeout뿐 — skills/tools/index.ts buildBashTool).
//     RED(수리 전): MCP 업무용 mode:'bg'·Agent mode:'bg'·harness/graph mode:'bg'가 전부 배경 요청으로 오판된다.
// (2) 실제 dispatch 인자 기록(JUD-B #128197): 판정 행은 dispatcher에 전달되는 인자(constraint 후)를 말한다 —
//     연구 제한이 Agent의 run_in_background를 false로 강제하면(constrainResearchToolArgs) 행도 sync.
//     RED(수리 전): 연구 턴 Agent(run_in_background:true)의 행이 detach/requested-background로 오판된다.
// (3) 설정 경계 격리(terra r8 mustFix[2]와 같은 정신): 시험은 setElanousConfigDir 고립 디렉터리에서 돈다 —
//     숙주 사용자 turn.syncCapMs(예: 5000)가 유효해도 기본 cap 10000 단언이 흔들리지 않는다.
// 행동 분리(실제 탈착)는 A2 쉘 호스트 배선 그대로 — 이 시험은 판정 행(judgment-only)만 단언한다.
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { capsuleRequestedBackground } from './capsule-policy.js';
import { runCoreTurn } from './run-core-turn.js';
import type { LLMProvider } from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';

interface Row { readonly event: string; readonly data: unknown }

const rowField = (data: unknown, key: string): unknown => {
  if (data !== null && typeof data === 'object') return (data as Record<string, unknown>)[key];
  if (typeof data === 'string') {
    try { return (JSON.parse(data) as Record<string, unknown>)[key]; } catch { return undefined; }
  }
  return undefined;
};

/** One real core turn dispatching exactly one tool call; returns THIS session's bound capsule-policy rows.
 * terra r8 mustFix[2] 정신 — 고립 config dir(빈 config)에서 돈다: 숙주 사용자 turn.syncCapMs와 무관하게
 * 기본 cap 경계를 잰다. opts.researchStub 은 연구 턴(스텝 axisCount 3)을 만들어 연구 제한 경로를 잰다. */
async function dispatchOneProbe(toolName: string, args: Record<string, unknown>, opts: {
  userText?: string;
  researchStub?: boolean;
  /** terra r9 mustFix[0] seam: scenario-scoped capsule-policy turn config injected into the junction. */
  capsulePolicyTurnConfig?: unknown;
  /** terra r10 mustFix[1] seam: scenario-pinned user-config FILE — the real loader reads it for this turn. */
  capsulePolicyTurnConfigPath?: string;
} = {}): Promise<readonly Row[]> {
  const sessionId = `a1-junction-${randomUUID().replaceAll('-', '')}`;
  const rows: Row[] = [];
  const originalLog = debug.log;
  let patched = false;
  const tools: LLMToolSpec[] = [{
    name: toolName,
    description: 'junction probe',
    parameters: { type: 'object', properties: {}, required: [] },
  }];
  if (opts.researchStub) {
    // 계약 시험 결정적 활성(수리 — 프로브 실측: 풀에 [Agent]만 있으면 research.route 이벤트 0건, researchTurn 꺼짐 →
    // 연구 제한 미적용 → 행 detach). 웹도구(WebSearch)가 풀에 있으면 structuredRouteEligible이 참이 되어
    // 문장 분류기와 무관하게 researchTurn이 결정적으로 켜진다(RESEARCH_ROUTE_WEB_TOOLS = WebSearch·OmniSearch·WebFetch).
    // 단 라우팅 표면 surfaceUserText는 ctx.userText 만 읽는다(selectSurfaceUserText — run-core-turn.ts: messages 는
    // 표면 후보가 아님) → 프로브가 userText 를 ctx 로 넘기지 않으면 이 조건도 거짓이 되어 researchTurn 이 꺼진다.
    tools.push({ name: 'WebSearch', description: 'research route eligibility probe', parameters: { type: 'object', properties: {}, required: [] } });
  }
  const provider: LLMProvider = {
    name: 'junction-fake', defaultModel: 'junction-fake', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      yield { type: 'tool_call' as const, id: 't_junction', name: toolName, args };
      yield { type: 'text' as const, delta: 'junction probe done' };
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const isoDir = mkdtempSync(join(tmpdir(), 'a1-junction-cfg-'));
  const savedOverride = getElanousConfigDirOverride();
  setElanousConfigDir(isoDir);
  try {
    try {
      (debug as { log: (category: string, event: string, data?: unknown) => void }).log =
        (category, event, data) => {
          if (category === 'turn-life') rows.push({ event, data });
          try { originalLog.call(debug, category, event, data); } catch { /* mirror must not break the seat */ }
        };
      patched = true;
    } catch { patched = false; /* rows stay empty; the test fails on the capture guard below */ }
    await runCoreTurn({
      sessionId,
      messages: [{ role: 'user', content: opts.userText ?? 'Dispatch one probe.' }],
      // 연구 턴 라우팅(researchRoute)은 표면 텍스트를 ctx.userText 에서만 읽는다(selectSurfaceUserText) —
      // messages 만 넘기면 surfaceUserText 가 undefined 로 structuredRouteEligible/researchTurn 이 거짓이 되고
      // enforceResearchToolAllowlist 도 꺼져 Agent 제한(run_in_background:false 강제)이 빠진다(실측: 행 detach).
      userText: opts.userText,
      tools,
      initialProvider: provider,
      signal: controller.signal,
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'probe done' }] }),
      capsulePolicyTurnConfig: opts.capsulePolicyTurnConfig,
      capsulePolicyTurnConfigPath: opts.capsulePolicyTurnConfigPath,
    }, opts.researchStub
      ? { runResearch: async () => ({ ok: true, output: 'stub research grounding output', sourceUrls: ['https://example.org/junction-probe'], axisCount: 3 }) }
      : {});
  } finally {
    clearTimeout(timer);
    try { (debug as { log: unknown }).log = originalLog; } catch { /* already immutable */ }
    if (savedOverride === undefined) resetElanousConfigDir(); else setElanousConfigDir(savedOverride);
    rmSync(isoDir, { recursive: true, force: true });
  }
  if (!patched) throw new Error('turn-life capture patch failed — the fidelity test cannot observe the junction');
  return rows.filter(row =>
    row.event === 'turn-life:capsule-policy'
    && rowField(row.data, 'sessionId') === sessionId
    && rowField(row.data, 'tool') === toolName);
}

test('junction fidelity (JUD-B #128143): Agent(run_in_background: true) 판정 행은 detach/requested-background — agent family 공식 배경 키', async () => {
  const rows = await dispatchOneProbe('Agent', { description: 'probe', prompt: 'Respond', run_in_background: true });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('agent');
  expect(rowField(row.data, 'mode')).toBe('detach');
  expect(rowField(row.data, 'reason')).toBe('requested-background');
}, 60_000);

test('junction fidelity: RunShell(mode:"bg") 판정 행은 detach — 쉘 축 공식 배경 관례(skills/tools/shell.ts asMode)', async () => {
  const rows = await dispatchOneProbe('RunShell', { command: 'sleep 5', mode: 'bg' });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('shell');
  expect(rowField(row.data, 'mode')).toBe('detach');
  expect(rowField(row.data, 'reason')).toBe('requested-background');
}, 60_000);

test('junction guard: 실제 Bash 스키마(command·timeout만 — 배경 키 없음)는 sync/capsule-sync-cap·10000 (skills/tools/index.ts buildBashTool)', async () => {
  const rows = await dispatchOneProbe('Bash', { command: 'echo probe', timeout: 30000 });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('shell');
  expect(rowField(row.data, 'mode')).toBe('sync');
  expect(rowField(row.data, 'reason')).toBe('capsule-sync-cap');
  expect(rowField(row.data, 'syncCapMs')).toBe(10000);
}, 60_000);

test('junction contract (JUD-B #128197): 연구 제한이 dispatch 인자를 run_in_background:false로 강제하면 판정 행도 sync — 행은 실제 dispatch 인자를 말한다', async () => {
  const rows = await dispatchOneProbe('Agent', { description: 'probe', prompt: 'Respond', run_in_background: true },
    { userText: 'Research the capsule policy junction coverage.', researchStub: true });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('agent');
  expect(rowField(row.data, 'mode')).toBe('sync');
  expect(rowField(row.data, 'reason')).toBe('capsule-sync-cap');
  expect(rowField(row.data, 'syncCapMs')).toBe(10000);
}, 60_000);

test('junction regression guard: 배경 요청 없는 Agent 호출은 그대로 sync/capsule-sync-cap·syncCapMs 10000 (A1 표본 기대 불변)', async () => {
  const rows = await dispatchOneProbe('Agent', { description: 'probe', prompt: 'Respond', run_in_background: false });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('agent');
  expect(rowField(row.data, 'mode')).toBe('sync');
  expect(rowField(row.data, 'reason')).toBe('capsule-sync-cap');
  expect(rowField(row.data, 'syncCapMs')).toBe(10000);
}, 60_000);

test('junction seam (terra r9 mustFix[0]): capsulePolicyTurnConfig 시나리오별 주입이 판정 행에 그대로 반영된다 — 전역 config dir 교체 없이', async () => {
  // 주입된 시나리오 turn 설정({ syncCapMs: 5000 })은 접합부 판정 행에 정확히 반영되어야 한다(시나리오별 주입).
  // RED(수리 전): 주입이 무시되고 고립 빈 config의 기본 cap 10000이 행에 남는다.
  const rows = await dispatchOneProbe('Bash', { command: 'echo probe', timeout: 30000 }, { capsulePolicyTurnConfig: { syncCapMs: 5000 } });
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[0]!;
  expect(rowField(row.data, 'kind')).toBe('shell');
  expect(rowField(row.data, 'mode')).toBe('sync');
  expect(rowField(row.data, 'reason')).toBe('capsule-sync-cap');
  expect(rowField(row.data, 'syncCapMs')).toBe(5000);
}, 60_000);

test('junction real-loading seam (terra r10 mustFix[1]): capsulePolicyTurnConfigPath 로 실제 로더가 fixture 파일을 읽어 판정 행에 반영 — 전역 config dir 교체 없이', async () => {
  // fixture user-config 파일(JUD #123019 — 운영 config 복사 아님)을 시험 임시 디렉터리에 쓰고 그 경로를
  // 이 턴에 핀하면 실제 설정 로딩 경로(readUserConfigObject — 파일 읽기 → JSON 파싱 → `.turn` 추출)가
  // 돌아야 한다. 주입 객체가 로딩을 우회하면 설정 로딩 회귀를 놓친다(terra r10 mustFix[1]).
  // 5000·10000은 독립 리터럴(JUD-B #127560 교리 — 제품 상수 미수입).
  // RED(수리 전): 경로 핀이 접합부에 없어 고립 빈 config의 기본 cap 10000이 행에 남는다.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'a1-junction-pinned-'));
  const fixturePath = join(fixtureDir, 'config.json');
  writeFileSync(fixturePath, JSON.stringify({ turn: { syncCapMs: 5000 } }), 'utf-8');
  try {
    const rows = await dispatchOneProbe('Bash', { command: 'echo probe', timeout: 30000 },
      { capsulePolicyTurnConfigPath: fixturePath });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(rowField(row.data, 'kind')).toBe('shell');
    expect(rowField(row.data, 'mode')).toBe('sync');
    expect(rowField(row.data, 'reason')).toBe('capsule-sync-cap');
    expect(rowField(row.data, 'syncCapMs')).toBe(5000);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}, 60_000);

test('capsuleRequestedBackground — 도구 family별 공식 키만 해석(terra r8 mustFix[1] · fail-open · 엄격 일치)', () => {
  // agent family(Agent/Task): run_in_background(agent/types.ts W1.3)만 — Agent 스키마에 mode 키는 없다.
  expect(capsuleRequestedBackground('Agent', { run_in_background: true })).toBe(true);
  expect(capsuleRequestedBackground('Task', { run_in_background: true, prompt: 'x', max_turns: 20 })).toBe(true);
  expect(capsuleRequestedBackground('Agent', { run_in_background: true, mode: 'inline' })).toBe(true);
  expect(capsuleRequestedBackground('Agent', { mode: 'bg' })).toBe(false);
  // shell family(Bash/Shell/RunShell/WebTerminal/Terminal): mode:'bg'(skills/tools/shell.ts)만 —
  // 실제 Bash 스키마는 command·timeout뿐이므로 생산에서 배경 키를 만들 수 없다.
  expect(capsuleRequestedBackground('RunShell', { command: 'sleep 5', mode: 'bg' })).toBe(true);
  expect(capsuleRequestedBackground('Shell', { command: 'x', mode: 'bg' })).toBe(true);
  expect(capsuleRequestedBackground('Bash', { command: 'ls', timeout: 30000 })).toBe(false);
  expect(capsuleRequestedBackground('RunShell', { run_in_background: true })).toBe(false);
  expect(capsuleRequestedBackground('Bash', { run_in_background: true })).toBe(false);
  // mcp family: 아웃바운드 외부 MCP 도구 스키마는 임의 — 이 접합부에 공식 배경 키가 없다(fail-open).
  // 업무용 mode:'bg'·run_in_background:true를 배경 요청으로 오인하지 않는다(terra r8 mustFix[1] 예시).
  expect(capsuleRequestedBackground('mcp__x__deploy', { mode: 'bg' })).toBe(false);
  expect(capsuleRequestedBackground('mcp__x__deploy', { run_in_background: true })).toBe(false);
  expect(capsuleRequestedBackground('mcp__a1_sample__probe', { probe: 'mcp' })).toBe(false);
  // harness·graph family: 공식 배경 키 없음 — fail-open false.
  expect(capsuleRequestedBackground('RunDevHarness', { mode: 'bg' })).toBe(false);
  expect(capsuleRequestedBackground('RunDevHarness', { run_in_background: true })).toBe(false);
  expect(capsuleRequestedBackground('RunGraph', { mode: 'bg' })).toBe(false);
  // capsule 아님(Read)·형태 가드: 문자열 truthy·대소문자·비객체 전부 요청이 아니다.
  expect(capsuleRequestedBackground('Read', { run_in_background: true, mode: 'bg' })).toBe(false);
  expect(capsuleRequestedBackground('Agent', { run_in_background: 'true' })).toBe(false);
  expect(capsuleRequestedBackground('RunShell', { mode: 'BG' })).toBe(false);
  expect(capsuleRequestedBackground('Agent', {})).toBe(false);
  expect(capsuleRequestedBackground('Agent', null)).toBe(false);
  expect(capsuleRequestedBackground('Agent', undefined)).toBe(false);
  expect(capsuleRequestedBackground('Agent', 'bg')).toBe(false);
});
