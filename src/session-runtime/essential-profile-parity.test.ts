import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionRuntimeToolSpecs, type SessionSurfaceId } from './index.js';
import { resetUserConfig } from '../user-config.js';
import { findNativeTool, isNativeToolModelExposed } from '../native-tool-catalog.js';
import { registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import { listToolRuntimes } from '../tool-runtime/registry.js';
import { CORE_TOOL_SPECS } from '../domains/core-tools.js';


function withModelSurfaceConfig<T>(config: object, callback: () => T): T {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), 'session-runtime-model-surface-'));
  try {
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify(config));
    process.env.XDG_CONFIG_HOME = xdg;
    resetUserConfig();
    return callback();
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetUserConfig();
    rmSync(xdg, { recursive: true, force: true });
  }
}

function withDefaultModelSurface<T>(callback: () => T): T {
  return withModelSurfaceConfig({}, callback);
}
// ⛔⭐ 여기를 고치는 사람에게 — **짝이 하나 더 있다**: `test/session-runtime-essential-catalog.test.ts`
//    가 고정 목록 전체를 이름으로 못 박는다. 그 파일은 저장소 루트 `test/` 에 있어서
//    **변경 파일 스코프 게이트가 안 본다** ⇒ 여기만 고치면 그 자는 조용히 깨진 채 머지된다.
//    실측: `#7349`·`#7352` 가 25분 사이에 «각각» 같은 형태로 깼다(수리 = `#7351`·이 PR).
// RunDevHarness는 user config가 정확히 true일 때만 모델 표면에 노출된다. 이 기본 목록은
// 격리된 빈 config에서 조립하므로 explicit-only 정책을 literal expectation으로 지킨다.
// ⛔ 2026-08-19 — SelfOrchestrate 는 «은퇴»했다(대표 "self implement 만 남겨주세요. 그게 통합 방향입니다").
//   능력은 self_implement 에 «이미» 흡수돼 있다(goals·decompose·concurrency… 스펙 선언 ⊕ :467 배선).
//   🔄 되돌리기 = native-tool-catalog.ts 의 defaultEnabled 한 줄.
// The eight in-process ops-ledger runtimes are deliberately in the fixed
// essential TUI catalog: an OP turn must be able to replace the corresponding
// RunShell CLI calls.
// TUI-DIET-D1-TAIL — the legacy rich coding profiles are gone, so the former
// «essential-only vs rich» parity checks became membership checks on essential alone.
const EXPECTED_ESSENTIAL_MEMBERS = [
  'SelfImplement',
  'MsgList', 'MsgPost', 'MsgAck',
  'ChecklistList', 'ChecklistAdd', 'ChecklistSet', 'ChecklistEdit', 'ChecklistMove',
  'PersistentGrounding',
];
const PARITY_GUARD = 'The essential fixed catalog changed; if intentional, update this test with the reason. This guard makes the change visible rather than forbidding it.';

function toolNames(
  preferredSurfaceId?: SessionSurfaceId,
  config: object = {},
  userText = '',
): string[] {
  return withModelSurfaceConfig(config, () => {
    registerAllDefaultToolRuntimes();
    return buildSessionRuntimeToolSpecs({
      userText,
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
      optionalTools: [],
      preferredSurfaceId,
    }).map(spec => spec.name);
  });
}

describe('essential fixed catalog and coding profile parity', () => {
  const essentialNames = withDefaultModelSurface(() => toolNames());

  it('exposes the registered logs_query host tool in essential mode and honors availability', () => {
    registerAllDefaultToolRuntimes();
    const runtimes = listToolRuntimes('tui');
    const hostTools = CORE_TOOL_SPECS.map(spec => ({
      ...spec,
      handler: async () => ({}),
    }));
    const logsSpec = CORE_TOOL_SPECS.find(spec => spec.name === 'logs_query');
    expect(logsSpec).toBeDefined();
    const essentialWithLogs = buildSessionRuntimeToolSpecs({
      userText: '최근 로그를 조회해줘',
      hostTools,
      runtimeTools: runtimes,
      optionalTools: [],
    });
    expect(essentialWithLogs.find(spec => spec.name === 'logs_query')).toMatchObject({
      name: logsSpec?.name,
      description: logsSpec?.description,
      parameters: logsSpec?.parameters,
    });
    expect(essentialWithLogs.filter(spec => spec.name === 'logs_query')).toHaveLength(1);

    const withoutLogs = buildSessionRuntimeToolSpecs({
      userText: '최근 로그를 조회해줘',
      hostTools: hostTools.filter(tool => tool.name !== 'logs_query'),
      runtimeTools: runtimes,
      optionalTools: [],
    });
    expect(essentialWithLogs.filter(spec => spec.name !== 'logs_query'))
      .toEqual(withoutLogs);

    const unavailable = buildSessionRuntimeToolSpecs({
      userText: '최근 로그를 조회해줘',
      hostTools,
      runtimeTools: runtimes,
      optionalTools: [],
      toolAvailability: { logs_query: false },
    });
    expect(unavailable.map(spec => spec.name)).not.toContain('logs_query');

  });

  it('a dev-harness phrase drops Edit and Write from the essential TUI tool list and keeps SelfImplement', () => {
    const currentEssentialNames = toolNames();
    const harnessNames = toolNames(undefined, {}, '하니스로 구현해줘: src/ux-sim/fault-pool-cap.ts');
    expect(harnessNames).not.toContain('Edit');
    expect(harnessNames).not.toContain('Write');
    expect(harnessNames).toContain('SelfImplement');
    expect(harnessNames).toEqual(currentEssentialNames.filter(name => name !== 'Edit' && name !== 'Write'));

    const ordinaryNames = toolNames(undefined, {}, '이 파일을 확인해줘');
    expect(ordinaryNames).toEqual(currentEssentialNames);
  });

  it('honors catalog explicit-only policy while retaining SelfImplement', () => {
    const selfImplement = findNativeTool('SelfImplement');
    if (!selfImplement || !isNativeToolModelExposed(selfImplement) || !essentialNames.includes('SelfImplement')) {
      throw new Error(`${PARITY_GUARD} essential catalog must include catalog-exposed SelfImplement`);
    }
    if (essentialNames.includes('RunDevHarness')) {
      throw new Error(`${PARITY_GUARD} default config must not expose explicit-only RunDevHarness`);
    }
  });

  it('keeps SelfImplement, eight ops-ledger tools, and PersistentGrounding in the essential catalog', () => {
    const missing = EXPECTED_ESSENTIAL_MEMBERS.filter(name => !essentialNames.includes(name));
    if (missing.length > 0) {
      throw new Error(`${PARITY_GUARD} essential catalog is missing: ${missing.join(', ')}`);
    }
  });

  it('classifies PersistentGrounding as a delegate without changing essential exposure', () => {
    const persistentGrounding = findNativeTool('persistent_grounding');
    expect(persistentGrounding?.kind).toBe('delegate');
    expect(essentialNames).toContain('PersistentGrounding');
  });

});
