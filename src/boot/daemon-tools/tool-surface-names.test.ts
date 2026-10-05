// turn 조립기 통일 Phase 3 — 데몬 toolSurface(c) 이름배열 골든룰 스냅샷 가드.
//
// 전체 아크의 골든룰("조립기 specs 이름배열 이행 전후 diff=0")은 각 서피스마다 이름배열 스냅샷을
// 전제한다 — a(telegram)=autonomous-tools.test, b(CLI/continuation)=coding-core-tools.test 는 있었으나
// c(데몬 toolSurface·PWA/iOS/discord/TUI 채팅의 라이브 표면)엔 이름배열 스냅샷이 전무했다. 여기서
// none/readonly/chat/webterm 4 서피스의 tool 이름배열을 못박아, Phase 4(코딩코어 실구현 병합·file_path↔
// path 스키마·대표 go-ahead) 및 향후 어떤 조립기 리팩토링에도 라이브 데몬 표면의 회귀망이 되게 한다.
//
// ⚠️ 환경 의존 통제: finance 팩은 cfg.finance.enabled 게이트(Phase 0)라 cfg 를 명시 주입해 결정화하고,
//    webterm 의 PtyShell* 는 ptyAvailable() 게이트라 조건부 단언한다. nest-cap 은 정상 테스트 프로세스
//    (미-nested)에서 off 이므로 delegate/자율tool 이 노출됨을 전제.

import { describe, test, expect, spyOn } from 'bun:test';
import type { UserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { buildFinanceTools } from '../../domains/finance-tools.js';
import { toolSurface } from './index.js';
import * as ptyRegistry from '../../pty-shell/registry.js';
import { ptyAvailable } from '../../pty-shell/registry.js';
import { isDevHarnessModelSurfaceEnabled } from '../../skills/tools/dev-harness.js';

// finance 게이트를 결정화하는 최소 cfg(구조적 부분집합 — financeEnabled 는 finance.enabled 만 읽음).
const financeOff = { finance: { enabled: false } } as unknown as UserConfig;
const financeOn = { finance: { enabled: true } } as unknown as UserConfig;

const READONLY = ['Read', 'Grep', 'WebSearch', 'Plan', 'MarkStepDone'];
// chat = readonly + 코딩코어 편집/실행(Edit/Write/Bash) + delegate + L2 core(schedule_manage…mission_decide).
const CHAT_CORE = [
  ...READONLY,
  'Edit', 'Write', 'Bash', 'delegate_code_agent',
  'SelfImplement', 'AskUserQuestion', 'AcpSessionCreate', 'AcpSessionSend', 'AcpSessionClose',
  'AcpSessionList', 'AcpSessionResume', 'AcpSessionSpawnSub', 'AcpSessionStartBackground',
  'AcpSessionStatus', 'AcpSessionCancel', 'AcpSessionJoin', 'AcpPlanThenExecute',
  'schedule_manage', 'session_manage', 'memory_recall', 'fact_check', 'self_recall', 'context_now',
  'autopilot_missions', 'ops_status', 'se_build', 'logs_query', 'mission_decide', 'coo_admin',
  // SYNC1 ① #23007 — owner-only read tools; names are listed, dispatch refuses without a server-verified owner (like release_change).
  'release_status', 'release_change', 'ops_seats', 'decisions_pending', 'proact_meter', 'elanous_skills_list', 'skill_exec',
];
const CHAT_PTY_EXTRA = ['ElanousHold', 'PtyControl'];
// webterm 이 chat 위에 항상 더하는 것(pty 무관) — 자율tool 3종(nest-cap off 전제) + 웹터미널/카메라.
const WEBTERM_ALWAYS_EXTRA = [
  // ⭐ 2026-08-27 (#13417) — 자율(ACP) 턴이 브라우저를 «읽기»로 몰 수 있게 데몬 표면이 담는다.
  //    ⛔ BrowserOpen · BrowserScreenshot · BrowserClose 는 safety:['process'] 라 «담지 않는다».
  //    근거·머리말 = src/tool-surface.ts · src/boot/daemon-tools/index.ts
  'BrowserNavigate', 'BrowserRead',
  ...(isDevHarnessModelSurfaceEnabled() ? ['RunDevHarness'] : []), 'SolveMission',
  'WebTerminalList', 'WebTerminalSnapshot', 'WebTerminalInput', 'WebTerminalScreenshot',
  'LiveCameraFrame',
];
// pty 가용 시 webterm 이 추가로 더하는 PtyShell/헤드리스 코딩/relay.
const WEBTERM_PTY_EXTRA = [
  'PtyShellStart', 'PtyShellPoll', 'PtyShellSend', 'PtyShellKill', 'PtyShellList',
  'PtyShellSnapshot', 'PtyShellResize', 'PtyShellScreenshot',
  'SpawnCodingAgentHeadless', 'DriveCodingAgentHeadless', 'RelayShellPrompt',
];

describe('daemon toolSurface — Phase 3 골든룰(이름배열 diff=0·서피스 c)', () => {
  test("'none' 서피스 = 빈 카탈로그", () => {
    expect(toolSurface('none').specs.map((s) => s.name)).toEqual([]);
  });

  test('each daemon catalog records complete membership with its own surface and static assembler reference', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const catalogs = (['none', 'readonly', 'chat', 'webterm'] as const).map((kind) =>
        toolSurface(kind, financeOff),
      );
      const events = log.mock.calls.filter(([category, name]) =>
        category === 'capability.resolve' && name === 'tool-catalog-assembled',
      );

      expect(events).toHaveLength(catalogs.length);
      for (const [index, catalog] of catalogs.entries()) {
        const event = events[index];
        expect(event?.[2]).toEqual({
          sessionId: null,
          surface: 'daemon-tools',
          assembler: toolSurface.name,
          toolCount: catalog.specs.length,
          tools: catalog.specs.map((spec) => spec.name),
        });
        expect((event?.[2] as { surface: string }).surface).not.toBe('tui-dashboard');
        expect(event?.[3]).toEqual({
          compact: { arrayMax: Number.MAX_SAFE_INTEGER, stringMax: Number.MAX_SAFE_INTEGER },
        });
      }
    } finally {
      log.mockRestore();
    }
  });

  test("'readonly' 서피스 = Read/Grep/WebSearch/Plan/MarkStepDone (cfg/pty/nest 무관·완전 고정)", () => {
    expect(toolSurface('readonly', financeOff).specs.map((s) => s.name)).toEqual(READONLY);
  });

  test("'chat' 서피스(finance off) = readonly + Edit/Write/Bash/delegate + L2 core (PTY 가용·불가 각각 정확히)", () => {
    for (const available of [false, true]) {
      const pty = spyOn(ptyRegistry, 'ptyAvailable').mockReturnValue(available);
      try {
        const names = toolSurface('chat', financeOff).specs.map((s) => s.name);
        expect(names).toEqual([...CHAT_CORE, ...(available ? CHAT_PTY_EXTRA : [])]);
      } finally {
        pty.mockRestore();
      }
    }
  });

  test("'chat' finance 게이트 — off 는 finance_ 없음 / on 은 finance_quote 노출(Phase 0 게이팅)", () => {
    const off = toolSurface('chat', financeOff).specs.map((s) => s.name);
    const on = toolSurface('chat', financeOn).specs.map((s) => s.name);
    expect(off.some((n) => n.startsWith('finance_'))).toBe(false);
    expect(on).toContain('finance_quote');
    // shared-app-tools contract: core, then the complete finance pack, then skill discovery/execution.
    expect(on).toEqual([
      ...CHAT_CORE.slice(0, -2),
      ...buildFinanceTools().specs.map((spec) => spec.name),
      'elanous_skills_list', 'skill_exec',
      ...off.slice(CHAT_CORE.length),
    ]);
  });

  test("'webterm' ⊇ 'chat' + 자율tool/웹터미널 (+ pty 가용 시 PtyShell·헤드리스)", () => {
    const chat = toolSurface('chat', financeOff).specs.map((s) => s.name);
    const wt = toolSurface('webterm', financeOff).specs.map((s) => s.name);
    // webterm includes the entire chat catalog as its ordered prefix.
    expect(wt.slice(0, chat.length)).toEqual(chat);
    for (const n of WEBTERM_ALWAYS_EXTRA) expect(wt).toContain(n);
    const extra = wt.filter((n) => !chat.includes(n));
    const expectedExtra = ptyAvailable()
      ? [...WEBTERM_ALWAYS_EXTRA, ...WEBTERM_PTY_EXTRA]
      : WEBTERM_ALWAYS_EXTRA;
    expect(extra).toEqual(expectedExtra);
  });
});
