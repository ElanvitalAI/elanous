import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDashboardControlManual } from '../src/chat/mode/manual.js';
import {
  _resetToolRuntimeRegistryForTest,
  getToolRuntime,
  registerAllDefaultToolRuntimes,
} from '../src/tool-runtime/index.js';
import { resetSearchLoopGuardForTest } from '../src/skills/tools/search-loop-guard';
import {
  armSessionQuickControl,
  buildSessionRuntimeSystemMessages,
  buildSessionRuntimeTurnSystemMessages,
  createSessionPostureState,
  buildSessionDashboardStatusLines,
  buildSessionSurfaceManualSections,
  buildSessionSurfaceStatusLines,
  dispatchSessionRuntimeTool,
  enterSessionControlMode,
  isSessionControlActive,
  parseSessionSurfaceSlash,
  resolveSessionPostureSnapshot,
  resolveDynamicSessionNativeToolSpecs,
  resolveSessionModeSnapshot,
  resolveSessionSurfaceStatus,
  resolveSessionInputModeFromChatMode,
  resolveSessionSurfaceProfile,
  resolveSessionSurfaceFromChatMode,
  resolveSessionTurnProfile,
  setSessionPreferredSurface,
  summarizeSessionSurface,
} from '../src/session-runtime/index.js';

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('session-runtime system messages', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'session-runtime-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'hello');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('injects only the git snapshot baseline when cwd is a repo', () => {
    const messages = buildSessionRuntimeSystemMessages({ cwd: repo });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('## Git Snapshot');
    expect(messages[0]?.content).toContain('Current branch: main');
  });

  test('returns no baseline message outside a git repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'session-runtime-outside-'));
    try {
      expect(buildSessionRuntimeSystemMessages({ cwd: outside })).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('session-runtime web-search surface routing', () => {
  // TUI-DIET-D1-TAIL — the legacy userText-driven host/runtime catalog tests that lived here
  // were removed with the `rich` branch they guarded; only the surface-routing guards remain.
  // ── web-search 노출/라우팅 분리 (근본 수복 2026-07-17) ──────────────
  // 노출(EXPOSURE)은 provider 명 포함 broad, surface flip 은 strong 신호만.
  // → provider 명(그록/gpt/claude)은 WebSearch 를 열되 coding surface 를 안
  //   flip → 코딩 오라우팅 없이 대표 원안(전 provider) 안전 수용.
  test('ROUTING — provider 명 언급은 surface 를 flip 하지 않는다(coding 유지)', () => {
    // 핵심 분리 보장: "gpt 로 이 에러 찾아봐" 는 WebSearch 를 열지만 surface 는
    // coding/turn 그대로 → 편집/셸 등 코딩 도구 유지. 모델명이 코딩/설정
    // 대화에 상시 등장해도 research 로 오라우팅되지 않는다.
    for (const userText of ['gpt 로 이 에러 봐줘', 'claude 로 이 코드 확인해줘', '제미나이로 정리해줘']) {
      expect(resolveSessionSurfaceProfile({ userText }).id).toBe('coding/turn');
    }
  });

  test('ROUTING — strong web 신호는 research/turn 으로 flip 한다', () => {
    // provider 명이 아닌 명시 web/research 어휘는 여전히 surface 를 flip.
    for (const userText of ['웹에서 최신 뉴스 검색해줘', '외부 자료 좀 찾아봐']) {
      expect(resolveSessionSurfaceProfile({ userText }).id).toBe('research/turn');
    }
  });
});

describe('session-runtime surface profiles', () => {
  test('defaults to coding/turn for ordinary coding requests', () => {
    const surface = resolveSessionSurfaceProfile({ userText: '이 함수 버그를 설명해줘' });
    expect(surface.id).toBe('coding/turn');
    expect(surface.executionStyle).toBe('turn');
  });

  test('normalizes legacy slash IDs to canonical turn profiles without changing profile defaults', () => {
    for (const [legacy, canonical] of [
      ['coding/chat', 'coding/turn'],
      ['research/chat', 'research/turn'],
    ] as const) {
      const legacyOutcome = parseSessionSurfaceSlash([legacy]);
      const canonicalOutcome = parseSessionSurfaceSlash([canonical]);
      expect(legacyOutcome).toEqual(canonicalOutcome);
      expect(legacyOutcome.kind).toBe('set');
      if (legacyOutcome.kind !== 'set' || canonicalOutcome.kind !== 'set') continue;

      const legacyProfile = resolveSessionSurfaceProfile({ preferredSurfaceId: legacyOutcome.surfaceId });
      const canonicalProfile = resolveSessionSurfaceProfile({ preferredSurfaceId: canonicalOutcome.surfaceId });
      expect(legacyProfile).toMatchObject({
        id: canonicalProfile.id,
        executionStyle: 'turn',
        baselineContexts: canonicalProfile.baselineContexts,
        defaultHostFamilyIds: canonicalProfile.defaultHostFamilyIds,
        defaultRuntimeFamilyIds: canonicalProfile.defaultRuntimeFamilyIds,
        defaultNativeFamilyIds: canonicalProfile.defaultNativeFamilyIds,
      });
    }
  });

  test('normalizes persisted legacy IDs through the direct profile resolver', () => {
    for (const [legacy, canonical] of [
      ['coding/chat', 'coding/turn'],
      ['research/chat', 'research/turn'],
    ] as const) {
      const legacyProfile = resolveSessionSurfaceProfile({ preferredSurfaceId: legacy });
      const canonicalProfile = resolveSessionSurfaceProfile({ preferredSurfaceId: canonical });

      expect(legacyProfile).toMatchObject({
        id: canonical,
        executionStyle: 'turn',
        baselineContexts: canonicalProfile.baselineContexts,
        defaultHostFamilyIds: canonicalProfile.defaultHostFamilyIds,
        defaultRuntimeFamilyIds: canonicalProfile.defaultRuntimeFamilyIds,
        defaultNativeFamilyIds: canonicalProfile.defaultNativeFamilyIds,
      });
      expect(canonicalProfile.id).toBe(canonical);
    }
  });

  test('resolves control/agent when control mode is active', () => {
    const surface = resolveSessionSurfaceProfile({
      userText: '현재 pane layout을 조정해줘',
      controlMode: true,
    });
    expect(surface.id).toBe('control/agent');
  });

  test('resolves research/agent for explicit deep research intent', () => {
    const surface = resolveSessionSurfaceProfile({
      userText: '여러 소스로 교차검증하면서 깊게 조사해줘',
    });
    expect(surface.id).toBe('research/agent');
  });

  test('resolves ops-ui/agent for local runtime ui intent', () => {
    const surface = resolveSessionSurfaceProfile({
      userText: '대시보드 pane layout과 widget 상태를 점검해줘',
    });
    expect(surface.id).toBe('ops-ui/agent');
  });

  test('resolves ops-fleet/agent for remote fleet intent', () => {
    const surface = resolveSessionSurfaceProfile({
      userText: '아이폰으로 알림 보내고 llm fleet 상태를 점검해줘',
    });
    expect(surface.id).toBe('ops-fleet/agent');
  });

  test('resolves surface from chat mode state for control turns', () => {
    const chatModeState = createSessionPostureState();
    enterSessionControlMode(chatModeState, { intent: 'pane 정리' });
    const surface = resolveSessionSurfaceFromChatMode({
      userText: '현재 pane layout을 조정해줘',
      chatModeState,
    });
    expect(surface.id).toBe('control/agent');
  });

  test('builds a turn profile from chat mode state', () => {
    const chatModeState = createSessionPostureState();
    enterSessionControlMode(chatModeState, { intent: 'pane 정리' });
    const profile = resolveSessionTurnProfile({
      userText: '현재 pane layout을 조정해줘',
      chatModeState,
    });
    expect(profile.surface.id).toBe('control/agent');
    expect(profile.activeIntent).toBe('pane 정리');
    expect(profile.surfaceSelectionMode).toBe('auto');
    expect(profile.shouldInjectControlManual).toBe(true);
    expect(profile.inputSource).toBeNull();
    expect(profile.inputSourceKind).toBeNull();
  });

  test('resolves control input mode from quick-control chat state', () => {
    const chatModeState = createSessionPostureState();
    armSessionQuickControl(chatModeState, '다음 턴만 제어');
    expect(resolveSessionInputModeFromChatMode({ chatModeState })).toBe('control');
    const profile = resolveSessionTurnProfile({
      userText: '다음 턴만 제어',
      chatModeState,
    });
    expect(profile.inputMode).toBe('control');
    expect(profile.shouldInjectControlManual).toBe(true);
  });

  test('builds a mode snapshot for status and hud rendering', () => {
    const general = resolveSessionModeSnapshot(createSessionPostureState());
    expect(general.surfaceSelectionMode).toBe('auto');
    expect(general.statusLabel).toBe('general · surface=auto');
    expect(general.hudLabel).toBe('GENERAL · auto');

    const chatModeState = createSessionPostureState();
    armSessionQuickControl(chatModeState, '다음 턴만 제어');
    setSessionPreferredSurface(chatModeState, 'research/agent');
    const control = resolveSessionModeSnapshot(chatModeState);
    expect(control.isControlActive).toBe(true);
    expect(control.preferredSurfaceId).toBe('research/agent');
    expect(control.surfaceSelectionMode).toBe('fixed');
    expect(control.statusLabel).toBe('control (다음 턴만 제어) · surface=fixed:research/agent');
    expect(control.hudLabel).toBe('CONTROL · 다음 턴만 제어 · fixed:research/agent');
  });

  test('builds a normalized posture snapshot from raw chat mode state', () => {
    const general = resolveSessionPostureSnapshot(createSessionPostureState());
    expect(general.persistentPosture).toBe('general');
    expect(general.activePosture).toBe('general');
    expect(general.isQuickControlArmed).toBe(false);

    const quick = createSessionPostureState();
    armSessionQuickControl(quick, '다음 턴만 제어');
    const quickPosture = resolveSessionPostureSnapshot(quick);
    expect(quickPosture.persistentPosture).toBe('general');
    expect(quickPosture.activePosture).toBe('control');
    expect(quickPosture.isQuickControlArmed).toBe(true);
    expect(quickPosture.activeIntent).toBe('다음 턴만 제어');
  });

  test('builds a surface status snapshot from posture state', () => {
    const general = resolveSessionSurfaceStatus({
      userText: '이 함수의 버그를 설명해줘',
      chatModeState: createSessionPostureState(),
    });
    expect(general.currentSurfaceId).toBe('coding/turn');
    expect(general.surfaceSelectionMode).toBe('auto');
    expect(general.preferredSurfaceId).toBeNull();
    expect(general.inputMode).toBe('general');

    const chatModeState = createSessionPostureState();
    setSessionPreferredSurface(chatModeState, 'ops-fleet/agent');
    const fixed = resolveSessionSurfaceStatus({
      userText: 'llm fleet 상태를 점검해줘',
      chatModeState,
    });
    expect(fixed.currentSurfaceId).toBe('ops-fleet/agent');
    expect(fixed.surfaceSelectionMode).toBe('fixed');
    expect(fixed.preferredSurfaceId).toBe('ops-fleet/agent');
    expect(fixed.inputMode).toBe('general');
  });

  test('formats surface status lines from snapshot', () => {
    const lines = buildSessionSurfaceStatusLines({
      mode: {
        rawMode: 'default',
        activeIntent: null,
        isControlActive: false,
        preferredSurfaceId: 'research/agent',
        surfaceSelectionMode: 'fixed',
        statusLabel: 'general · surface=fixed:research/agent',
        hudLabel: 'GENERAL · fixed:research/agent',
      },
      currentSurfaceId: 'research/agent',
      preferredSurfaceId: 'research/agent',
      surfaceSelectionMode: 'fixed',
      inputMode: 'general',
    });
    expect(lines).toEqual([
      'current surface: research/agent',
      'surface selection: fixed',
      'preferred surface: research/agent',
      'input mode: general',
    ]);
  });

  test('builds manual sections for a resolved surface in runtime', () => {
    const sections = buildSessionSurfaceManualSections({
      surface: resolveSessionSurfaceProfile({ controlMode: true }),
      surfaceSelectionMode: 'fixed',
      preferredSurfaceId: 'control/agent',
    }).join('\n');
    expect(sections).toContain('## Surface posture');
    expect(sections).toContain('- selection mode: fixed');
    expect(sections).toContain('- preferred surface: `control/agent`');
    expect(sections).toContain([
      '## Surface families (2)',
      'These families define the operator posture for the current surface before any extra intent-based tools are opened.',
      '',
      '- **ui-inspect** [host] — Read-only Elanous UI and pane/view inspection.',
      '  Tools: `view_getConfig`, `pane_getState`',
      '- **self-ops** [host] — Elanous self-awareness and autonomous-system observability (missions, ops, memory, sessions, schedules).',
      '  Tools: `ops_status`, `autopilot_missions`, `self_recall`, `memory_recall`, `session_manage`, `schedule_manage`, `fact_check`, `se_build`',
    ].join('\n'));
    expect(sections).toContain('## Conditional families (3)');
  });

  test('formats dashboard status lines from snapshot', () => {
    const lines = buildSessionDashboardStatusLines({
      mode: {
        rawMode: 'dashboard-control',
        activeIntent: 'pane 정리',
        isControlActive: true,
        preferredSurfaceId: 'control/agent',
        surfaceSelectionMode: 'fixed',
        statusLabel: 'control (pane 정리) · surface=fixed:control/agent',
        hudLabel: 'CONTROL · pane 정리 · fixed:control/agent',
      },
      currentSurfaceId: 'control/agent',
      preferredSurfaceId: 'control/agent',
      surfaceSelectionMode: 'fixed',
      inputMode: 'control',
    });
    expect(lines).toEqual([
      'surface: control/agent (fixed)',
      'mode: control (pane 정리) · surface=fixed:control/agent',
    ]);
  });

  test('parses surface slash through session-runtime contract', () => {
    expect(parseSessionSurfaceSlash([])).toEqual({ kind: 'status' });
    expect(parseSessionSurfaceSlash(['status'])).toEqual({ kind: 'status' });
    expect(parseSessionSurfaceSlash(['clear'])).toEqual({ kind: 'clear' });
    expect(parseSessionSurfaceSlash(['auto'])).toEqual({ kind: 'clear' });
    expect(parseSessionSurfaceSlash(['ops-agent'])).toEqual({
      kind: 'set',
      surfaceId: 'ops-ui/agent',
    });
    expect(parseSessionSurfaceSlash(['ops-fleet-agent'])).toEqual({
      kind: 'set',
      surfaceId: 'ops-fleet/agent',
    });
    expect(parseSessionSurfaceSlash(['nope'])).toEqual({
      kind: 'error',
      message: 'usage: /surface coding-agent|coding-chat|research-agent|research-chat|control-agent|ops-ui-agent|ops-fleet-agent|ops-agent|clear|status',
    });
  });
  test('preferred surface hint overrides intent-based resolution', () => {
    const chatModeState = createSessionPostureState();
    setSessionPreferredSurface(chatModeState, 'coding/agent');
    const codingAgent = resolveSessionSurfaceFromChatMode({
      userText: '일반적인 질문',
      chatModeState,
    });
    expect(codingAgent.id).toBe('coding/agent');
    const codingProfile = resolveSessionTurnProfile({
      userText: '일반적인 질문',
      chatModeState,
    });
    expect(codingProfile.surfaceSelectionMode).toBe('fixed');
    expect(codingProfile.preferredSurfaceId).toBe('coding/agent');

    setSessionPreferredSurface(chatModeState, 'research/agent');
    const researchAgent = resolveSessionSurfaceFromChatMode({
      userText: '이 함수 버그를 설명해줘',
      chatModeState,
    });
    expect(researchAgent.id).toBe('research/agent');

    setSessionPreferredSurface(chatModeState, 'ops-ui/agent');
    const opsUiAgent = resolveSessionSurfaceFromChatMode({
      userText: '현재 상태를 점검해줘',
      chatModeState,
    });
    expect(opsUiAgent.id).toBe('ops-ui/agent');

    setSessionPreferredSurface(chatModeState, 'ops/agent');
    const compatOpsAgent = resolveSessionSurfaceFromChatMode({
      userText: '현재 상태를 점검해줘',
      chatModeState,
    });
    expect(compatOpsAgent.id).toBe('ops-ui/agent');

    setSessionPreferredSurface(chatModeState, 'ops-fleet/agent');
    const opsFleetAgent = resolveSessionSurfaceFromChatMode({
      userText: 'llm fleet 상태를 점검해줘',
      chatModeState,
    });
    expect(opsFleetAgent.id).toBe('ops-fleet/agent');
  });

  test('session posture facade creates and mutates control posture state', () => {
    const chatModeState = createSessionPostureState();
    expect(isSessionControlActive(chatModeState)).toBe(false);
    enterSessionControlMode(chatModeState, { intent: 'pane 정리' });
    expect(isSessionControlActive(chatModeState)).toBe(true);
    expect(chatModeState.intent).toBe('pane 정리');
  });

  test('session posture facade stores preferred surfaces', () => {
    const chatModeState = createSessionPostureState();
    setSessionPreferredSurface(chatModeState, 'research/turn');
    expect(chatModeState.preferredSurfaceId).toBe('research/turn');
    setSessionPreferredSurface(chatModeState, 'ops/agent');
    expect(chatModeState.preferredSurfaceId).toBe('ops-ui/agent');
    setSessionPreferredSurface(chatModeState, null);
    expect(chatModeState.preferredSurfaceId).toBeNull();
  });
});

describe('session-runtime dynamic native tool exposure', () => {
  // From 2026-05-04 onward, the 6-entry CORE_NATIVE_FAMILY_IDS
  // (Read/Grep/Glob/ListDir/Edit/Write) are prepended to every
  // surface's native catalog. The expectations below all start with
  // the CORE block, then surface defaults / keyword-matched additions
  // (WebSearch, OmniSearch, WebFetch). Dedup keeps Read/Grep/Glob/
  // ListDir from doubling when the surface itself names them.
  const CORE = ['Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write'];

  test('exposes WebSearch for latest/current web lookup intent', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '이 라이브러리의 latest release를 웹에서 찾아봐',
      toolAvailability: { WebSearch: true, OmniSearch: false },
    });
    expect(specs.map(spec => spec.name)).toEqual([...CORE, 'WebSearch']);
  });

  test('keeps WebSearch deferred when no provider is available', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '이 라이브러리의 latest release를 웹에서 찾아봐',
      toolAvailability: { WebSearch: false, OmniSearch: false },
    });
    // CORE always survives; only WebSearch/OmniSearch gates miss.
    expect(specs.map(spec => spec.name)).toEqual(CORE);
  });

  test('exposes OmniSearch only for explicit research intent', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '여러 소스로 교차검증하면서 깊게 조사해줘',
      toolAvailability: { WebSearch: true, OmniSearch: true },
    });
    expect(specs.map(spec => spec.name)).toEqual([...CORE, 'OmniSearch']);
  });

  test('keeps OmniSearch deferred when multi-provider search is unavailable', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '여러 소스로 교차검증하면서 깊게 조사해줘',
      toolAvailability: { WebSearch: true, OmniSearch: false },
    });
    expect(specs.map(spec => spec.name)).toEqual(CORE);
  });

  test('exposes WebFetch for explicit url fetch intent', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: 'https://example.com 이 페이지 본문 가져와',
    });
    expect(specs.map(spec => spec.name)).toEqual([...CORE, 'WebFetch']);
  });

  test('research/agent surface opens WebFetch from generic page-reading wording', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '이 페이지 본문 읽어와',
      surfaceId: 'research/agent',
    });
    expect(specs.map(spec => spec.name)).toEqual([...CORE, 'WebFetch']);
  });

  test('ops-fleet/agent surface opens WebSearch from operational incident wording', () => {
    const specs = resolveDynamicSessionNativeToolSpecs({
      userText: '상태 페이지와 장애 현황을 확인해줘',
      surfaceId: 'ops-fleet/agent',
      toolAvailability: { WebSearch: true },
    });
    expect(specs.map(spec => spec.name)).toEqual([...CORE, 'WebSearch']);
  });
});

describe('dashboard control manual', () => {
  test('summarizes control surface default families from session-runtime', () => {
    const summary = summarizeSessionSurface(resolveSessionSurfaceProfile({ controlMode: true }));
    expect(summary.surface.id).toBe('control/agent');
    expect(summary.defaultFamilies.map(family => family.id)).toEqual([
      'ui-inspect',
      'self-ops',
    ]);
    expect(summary.conditionalFamilies.map(family => family.id)).toEqual([
      'ui-mutate',
      'prompt-ops',
      'runtime-debug',
    ]);
  });

  test('summarizes ops-ui surface default families from session-runtime', () => {
    const summary = summarizeSessionSurface(resolveSessionSurfaceProfile({ preferredSurfaceId: 'ops-ui/agent' }));
    expect(summary.surface.id).toBe('ops-ui/agent');
    expect(summary.defaultFamilies.map(family => family.id)).toEqual([
      'ui-inspect',
      'self-ops',
    ]);
    expect(summary.conditionalFamilies.map(family => family.id)).toEqual([
      'ui-mutate',
      'prompt-ops',
      'runtime-debug',
    ]);
  });

  test('summarizes ops-fleet surface without local operator families', () => {
    const summary = summarizeSessionSurface(resolveSessionSurfaceProfile({ preferredSurfaceId: 'ops-fleet/agent' }));
    expect(summary.surface.id).toBe('ops-fleet/agent');
    expect(summary.defaultFamilies.map(family => family.id)).toEqual([
      'self-ops',
      'fleet-core',
    ]);
    expect(summary.conditionalFamilies.map(family => family.id)).toEqual([
      'fleet-team',
      'fleet-budget',
      'fleet-policy',
      'fleet-agent-room',
      'fleet-llm',
      'fleet-acp',
      'web-search',
    ]);
  });

  test('prefers live surface tools over raw catalog when provided', () => {
    const manual = buildDashboardControlManual({
      intent: 'pane를 정리해줘',
      surface: resolveSessionSurfaceProfile({ controlMode: true }),
      surfaceSelectionMode: 'fixed',
      preferredSurfaceId: 'control/agent',
      liveTools: [
        { name: 'pane_getState', description: 'Return active pane state.' },
        { name: 'view_getConfig', description: 'Return current view config.' },
      ],
      slashes: [],
      catalog: [],
    });
    expect(manual).toContain('## Surface posture');
    expect(manual).toContain('Operator posture for elanous runtime control.');
    expect(manual).toContain('- selection mode: fixed');
    expect(manual).toContain('- preferred surface: `control/agent`');
    expect(manual).toContain([
      '## Surface families (2)',
      'These families define the operator posture for the current surface before any extra intent-based tools are opened.',
      '',
      '- **ui-inspect** [host] — Read-only Elanous UI and pane/view inspection.',
      '  Tools: `view_getConfig`, `pane_getState`',
      '- **self-ops** [host] — Elanous self-awareness and autonomous-system observability (missions, ops, memory, sessions, schedules).',
      '  Tools: `ops_status`, `autopilot_missions`, `self_recall`, `memory_recall`, `session_manage`, `schedule_manage`, `fact_check`, `se_build`',
    ].join('\n'));
    expect(manual).toContain('## Conditional families (3)');
    expect(manual).toContain('- conditional families: `ui-mutate`, `prompt-ops`, `runtime-debug`');
    expect(manual).toContain('## Live tools (2)');
    expect(manual).toContain('- surface: `control/agent`');
    expect(manual).toContain('**pane_getState**');
    expect(manual).not.toContain('## Native tools');
  });

  test('uses surface posture without falling back to raw catalog when no live tools are provided', () => {
    const manual = buildDashboardControlManual({
      surface: resolveSessionSurfaceProfile({ controlMode: true }),
      slashes: [],
      catalog: [
        {
          id: 'read',
          displayName: 'Read',
          description: 'read',
          promptSummary: 'read prompt',
          surface: ['all'],
          defaultEnabled: true,
        },
      ],
    });
    expect(manual).toContain('## Surface posture');
    expect(manual).toContain([
      '## Surface families (2)',
      'These families define the operator posture for the current surface before any extra intent-based tools are opened.',
      '',
      '- **ui-inspect** [host] — Read-only Elanous UI and pane/view inspection.',
      '  Tools: `view_getConfig`, `pane_getState`',
      '- **self-ops** [host] — Elanous self-awareness and autonomous-system observability (missions, ops, memory, sessions, schedules).',
      '  Tools: `ops_status`, `autopilot_missions`, `self_recall`, `memory_recall`, `session_manage`, `schedule_manage`, `fact_check`, `se_build`',
    ].join('\n'));
    expect(manual).toContain('## Conditional families (3)');
    expect(manual).not.toContain('## Native tools');
    expect(manual).toContain('`runtime-debug`');
  });
});

describe('session-runtime turn system messages', () => {
  test('includes current surface and selection mode in turn-level system context', () => {
    const chatModeState = createSessionPostureState();
    setSessionPreferredSurface(chatModeState, 'research/agent');
    const profile = resolveSessionTurnProfile({
      userText: '이 함수 버그를 설명해줘',
      chatModeState,
    });
    const messages = buildSessionRuntimeTurnSystemMessages(profile);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('## Session Surface');
    expect(messages[0]?.content).toContain('Current surface: research/agent');
    expect(messages[0]?.content).toContain('Surface selection: fixed');
    expect(messages[0]?.content).toContain('Preferred surface: research/agent');
  });

  test('includes input source kind in turn-level system context when present', () => {
    const chatModeState = createSessionPostureState();
    const profile = resolveSessionTurnProfile({
      userText: '음성으로 다음 단계 진행',
      chatModeState,
      inputSource: {
        kind: 'voice',
        surface: 'dashboard-chat-main',
        mode: 'multi-turn',
        transcriptSource: 'voice',
        channel: 'dashboard',
      },
    });
    const messages = buildSessionRuntimeTurnSystemMessages(profile);
    expect(messages[0]?.content).toContain('Input source kind: voice');
  });

  test('adds surface-specific operational guidance for agent surfaces', () => {
    const codingState = createSessionPostureState();
    setSessionPreferredSurface(codingState, 'coding/agent');
    const codingMessages = buildSessionRuntimeTurnSystemMessages(resolveSessionTurnProfile({
      userText: '이 기능을 끝까지 구현해줘',
      chatModeState: codingState,
    }));
    expect(codingMessages).toHaveLength(2);
    expect(codingMessages[1]?.content).toContain('You are in `coding/agent`.');
    expect(codingMessages[1]?.content).toContain('Prefer repo-local evidence over web lookup');

    const researchState = createSessionPostureState();
    setSessionPreferredSurface(researchState, 'research/agent');
    const researchMessages = buildSessionRuntimeTurnSystemMessages(resolveSessionTurnProfile({
      userText: '최신 반응을 여러 소스로 조사해줘',
      chatModeState: researchState,
    }));
    expect(researchMessages).toHaveLength(2);
    expect(researchMessages[1]?.content).toContain('You are in `research/agent`.');
    expect(researchMessages[1]?.content).toContain('Prefer cited, current, cross-checked findings');

    const opsUiState = createSessionPostureState();
    setSessionPreferredSurface(opsUiState, 'ops-ui/agent');
    const opsUiMessages = buildSessionRuntimeTurnSystemMessages(resolveSessionTurnProfile({
      userText: '운영 상태를 점검해줘',
      chatModeState: opsUiState,
    }));
    expect(opsUiMessages).toHaveLength(2);
    expect(opsUiMessages[1]?.content).toContain('You are in `ops-ui/agent`.');
    expect(opsUiMessages[1]?.content).toContain('local operational oversight');

    const opsFleetState = createSessionPostureState();
    setSessionPreferredSurface(opsFleetState, 'ops-fleet/agent');
    const opsFleetMessages = buildSessionRuntimeTurnSystemMessages(resolveSessionTurnProfile({
      userText: '운영 상태를 점검해줘',
      chatModeState: opsFleetState,
    }));
    expect(opsFleetMessages).toHaveLength(2);
    expect(opsFleetMessages[1]?.content).toContain('You are in `ops-fleet/agent`.');
    expect(opsFleetMessages[1]?.content).toContain('status pages');
  });

  test('adds general scoped exploration guidance for structural analysis requests', () => {
    const chatModeState = createSessionPostureState();
    const profile = resolveSessionTurnProfile({
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      chatModeState,
    });
    const messages = buildSessionRuntimeTurnSystemMessages(
      profile,
      '현재 프로젝트에서 디버깅 구조 분석해주세요',
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('## Scoped Exploration Guidance');
    expect(messages[1]?.content).toContain('Do NOT start with broad project-root exploration');
    expect(messages[1]?.content).toContain('Infer likely subsystem keywords');
    expect(messages[1]?.content).toContain('identify 3-6 candidate files');
  });

  test('does not add scoped exploration guidance for general coding requests', () => {
    const chatModeState = createSessionPostureState();
    const profile = resolveSessionTurnProfile({
      userText: '이 함수 정의를 찾아줘',
      chatModeState,
    });
    const messages = buildSessionRuntimeTurnSystemMessages(profile, '이 함수 정의를 찾아줘');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('## Session Surface');
  });
});

describe('session-runtime dispatch', () => {
  beforeEach(() => {
    resetSearchLoopGuardForTest();
  });

  test('routes unresolved scheduler-named tools through plugin dispatch', async () => {
    const result = await dispatchSessionRuntimeTool('scheduler_tool', {}, {
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toBe('plugin-result');
  });

  test('routes native tool dispatch through the native registry layer', async () => {
    const result = await dispatchSessionRuntimeTool('WebSearch', { query: 'latest bun' }, {
      signal: undefined,
      dispatchNativeTool: async (name, args) => ({ name, args, via: 'native' }),
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toEqual({
      name: 'WebSearch',
      args: { query: 'latest bun' },
      via: 'native',
    });
  });

  test('dispatches coding native tools through the shared native registry', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'session-runtime-read-'));
    try {
      const file = join(repo, 'sample.ts');
      writeFileSync(file, 'export const ok = true;\n');
      const result = await dispatchSessionRuntimeTool('Read', { file_path: file }, {
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async () => 'runtime-result',
        dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
      });
      expect(result).toMatchObject({
        kind: 'text',
        truncated: false,
      });
      expect((result as any).output).toContain('export const ok = true;');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('blocks broad project-root ListDir during scoped structural analysis turns', async () => {
    const result = await dispatchSessionRuntimeTool('ListDir', { path: '.' }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toContain('RUNTIME BLOCKED');
    expect(result).toContain('broad project-root exploration');
  });

  test('blocks broad root-wide Grep during scoped structural analysis turns', async () => {
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: '.',
      glob: '*.{ts,tsx,js,json,md}',
      output_mode: 'files_with_matches',
    }, {
      userText: 'debugging architecture analysis',
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toContain('RUNTIME BLOCKED');
    expect(result).toContain('too wide');
  });

  test('blocks truly broad recursive root-scoped Grep globs during scoped structural analysis turns', async () => {
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'widget|layout|pane',
      path: '.',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 위젯 구조 분석해주세요',
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toContain('RUNTIME BLOCKED');
    expect(result).toContain('broad project-root exploration');
  });

  test('rewrites recursive root-scoped Grep globs into narrower subtree searches', async () => {
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: '.',
      glob: 'src/**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      signal: undefined,
      dispatchNativeTool: async (_name, rewrittenArgs) => rewrittenArgs,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toMatchObject({
      path: 'src',
      glob: '{debug/**,display/debug-*.ts,window/debug-*.ts,dashboard/**/*debug*.ts,dashboard/**/*trace*.ts,**/debug-*.ts,**/call-stack.ts,**/log.ts}',
      output_mode: 'files_with_matches',
    });
  });

  test('allows narrower path-scoped Grep during scoped structural analysis turns', async () => {
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '*.ts',
      output_mode: 'files_with_matches',
    }, {
      userText: 'debugging architecture analysis',
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toMatchObject({
      mode: 'files_with_matches',
    });
    expect((result as any).output).toContain('Found');
  });

  test('blocks repeated candidate-listing searches in the same scoped analysis turn until narrowing occurs', async () => {
    const plannerState = {
      phase: 'idle' as const,
      pendingCandidateScopeKey: null as string | null,
      suggestedCandidates: [] as string[],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    const first = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect((first as any).output).toContain('Found');
    expect(plannerState.suggestedCandidates.length).toBeGreaterThan(0);

    const blocked = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'dashboard|session-runtime|llm',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(blocked).toContain('candidate list already exists for this turn');
    expect(blocked).toContain('Read(file_path=');
  });

  test('Read clears the repeated candidate-listing guard for the same scoped analysis turn', async () => {
    const plannerState = {
      phase: 'idle' as const,
      pendingCandidateScopeKey: null as string | null,
      suggestedCandidates: [] as string[],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(plannerState.pendingCandidateScopeKey).not.toBeNull();
    expect(plannerState.suggestedCandidates.length).toBeGreaterThan(0);

    const readResult = await dispatchSessionRuntimeTool('Read', { file_path: __filename }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(readResult).toMatchObject({ kind: 'text' });
    expect(plannerState.phase).toBe('inspecting');
    expect(plannerState.pendingCandidateScopeKey).not.toBeNull();
    expect(plannerState.suggestedCandidates.length).toBeGreaterThan(0);
  });

  test('AstGrep clears the repeated candidate-listing guard for the same scoped analysis turn', async () => {
    const plannerState = {
      phase: 'idle' as const,
      pendingCandidateScopeKey: null as string | null,
      suggestedCandidates: [] as string[],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(plannerState.pendingCandidateScopeKey).not.toBeNull();

    const astResult = await dispatchSessionRuntimeTool('ast_grep_search', {
      pattern: 'console.log($ARG)',
      lang: 'typescript',
      path: __filename,
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'Found 1 AST match\n' + __filename + ':1:1: console.log(x)' }),
    });
    expect(String(astResult)).toContain('AST match');
    expect(plannerState.phase).toBe('inspecting');
  });

  test('codex auto-narrows repeated candidate-listing searches into Read on the top suggested candidate', async () => {
    const plannerState = {
      phase: 'listed' as const,
      pendingCandidateScopeKey: 'grep|src|**/*.{ts,tsx}|',
      suggestedCandidates: ['test/session-runtime.test.ts'],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'dashboard|session-runtime|llm',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      modelFamily: 'codex',
      searchPlannerState: plannerState,
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toMatchObject({ kind: 'text' });
    expect((result as any).output).toContain('[AUTO-NARROWED]');
    expect((result as any).output).toContain('Read(file_path=');
    expect((result as any).output).toContain(__filename);
    expect(plannerState.phase).toBe('inspecting');
    expect(plannerState.nextCandidateIndex).toBe(1);
  });

  test('remembers fallback candidates from generic files_with_matches output when no shortlist block is present', async () => {
    const plannerState = {
      phase: 'idle' as const,
      pendingCandidateScopeKey: null as string | null,
      suggestedCandidates: [] as string[],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    const result = await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      dispatchNativeTool: async () => ({
        mode: 'files_with_matches',
        output: 'Found 3 files\nsrc/debug/log.ts\nsrc/debug/call-stack.ts\nsrc/display/debug-surface.ts',
      }),
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect((result as any).output).toContain('Found 3 files');
    expect(plannerState.suggestedCandidates).toEqual([
      'src/debug/log.ts',
      'src/debug/call-stack.ts',
      'src/display/debug-surface.ts',
    ]);
    expect(plannerState.phase).toBe('listed');
    expect(plannerState.nextCandidateIndex).toBe(0);
  });

  test('merges shortlist candidates with fallback file paths from the same listing output', async () => {
    const plannerState = {
      phase: 'idle' as const,
      pendingCandidateScopeKey: null as string | null,
      suggestedCandidates: [] as string[],
      nextCandidateIndex: 0,
      maxAutoNarrowCandidates: 2,
    };
    await dispatchSessionRuntimeTool('Grep', {
      pattern: 'debug|trace|logger',
      path: 'src',
      glob: '**/*.{ts,tsx}',
      output_mode: 'files_with_matches',
    }, {
      userText: '현재 프로젝트에서 디버깅 구조 분석해주세요',
      searchPlannerState: plannerState,
      dispatchNativeTool: async () => ({
        mode: 'files_with_matches',
        output:
          'Found 4 files\n' +
          '[Suggested next Read/Lsp candidates]\n' +
          '- src/acp/tool-call-state.ts\n\n' +
          'src/acp/tool-call-state.ts\n' +
          'src/debug/log.ts\n' +
          'src/debug/call-stack.ts\n',
      }),
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(plannerState.suggestedCandidates).toEqual([
      'src/acp/tool-call-state.ts',
      'src/debug/log.ts',
      'src/debug/call-stack.ts',
    ]);
  });

  test('routes runtime tools before plugin fallback', async () => {
    const result = await dispatchSessionRuntimeTool('SomeRuntimeTool', { ok: true }, {
      getToolRuntime: () => ({ id: 'x', spec: { name: 'SomeRuntimeTool', description: '', parameters: { type: 'object' } }, run: async () => ({}) }),
      dispatchToolRuntime: async () => ({ output: 'runtime-result' }),
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toEqual({ output: 'runtime-result' });
  });

  test('falls back to plugin dispatch when no scheduler or runtime handles the tool', async () => {
    const result = await dispatchSessionRuntimeTool('plugin_tool', {}, {
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => 'runtime-result',
      dispatchPluginTool: async () => ({ ok: true, result: 'plugin-result' }),
    });
    expect(result).toBe('plugin-result');
  });
});

describe('ops-fleet runtime registration', () => {
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
  });

  test('registers budget, policy, agent-room, and llm fleet runtimes', () => {
    registerAllDefaultToolRuntimes();
    expect(getToolRuntime('budget_status')?.id).toBe('budget_status');
    expect(getToolRuntime('policy_decide')?.id).toBe('policy_decide');
    expect(getToolRuntime('agent_room_compose')?.id).toBe('agent_room_compose');
    expect(getToolRuntime('llm_list_nodes')?.id).toBe('llm_list_nodes');
    expect(getToolRuntime('llm_request_install')?.id).toBe('llm_request_install');
  });
});
