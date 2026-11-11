import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAutonomousToolSpecs } from '../src/agent/autonomous-tools.js';
import { toolSurface } from '../src/boot/daemon-tools/index.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { resolveDynamicSessionNativeToolSpecs, shouldExposeDevHarnessSessionTool } from '../src/session-runtime/index.js';
import { dispatchRunDevHarness, isDevHarnessModelSurfaceEnabled, buildRunDevHarnessTool } from '../src/skills/tools/dev-harness.js';
import { lookupEntrance } from '../src/self-dev/entrance-registry.js';
import type { RunHarnessOnSurfaceOptions } from '../src/harness/harness-membrane.js';
import { debug } from '../src/debug/log.js';
import { resetUserConfig } from '../src/user-config.js';
// ⛔⭐⭐ `toolSurface('chat'|'webterm')` 는 `src/boot/daemon-tools/index.ts:313` 에서
//   `require('../../agent/shared-app-tools.js')` 를 «동기»로 부른다. 그 모듈의 사슬은 최상위 await 을
//   품고 있어서, ***아직 평가되지 않았으면 Bun 이 던진다***:
//     TypeError: require() async module "…/shared-app-tools.ts" is unsupported. use "await import()" instead.
//   📏 2026-09-17 실측 — 운영은 «멀쩡하다»(실제 진입점으로 눌렀다):
//     좁은 맥락에서 바로 부르면          → chat ⛔ 던짐 · webterm ⛔ 던짐
//     `src/index.ts`(실제 진입점) 뒤     → chat ✅ 52개 · webterm ✅ 71개
//   ⇒ 🔑 ***운영이 사는 이유는 「들여오기 순서의 우연」이다*** — 아무도 그 모듈을 ESM 으로 정적 들여오지
//      않는다(`require` 두 자리뿐: `daemon-tools/index.ts:313` · `src/index.ts:9831`).
//   ⚠️ 그래서 이 시험은 그 전제를 «흉내»내지 않고 «명시»한다 — 아래 한 줄이 그 전제다.
//      ⛔ 이 줄을 지우면 이 시험은 다시 던진다. 근본 수리(의존을 명시적으로)가 오면 이 줄은 «사라져야» 한다.
import '../src/agent/shared-app-tools.js';

let configDir: string;

function writeConfig(modelSurface?: boolean): void {
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify(modelSurface === undefined ? {} : { tools: { runDevHarness: { modelSurface } } }),
  );
  resetUserConfig();
}

function names(specs: readonly { name: string }[]): string[] {
  return specs.map(spec => spec.name);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'dev-harness-model-surface-'));
  setElanousConfigDir(configDir);
  resetUserConfig();
});

afterEach(() => {
  resetUserConfig();
  resetElanousConfigDir();
  rmSync(configDir, { recursive: true, force: true });
});

describe('RunDevHarness model surface switch', () => {
  test('defaults off without removing SelfImplement or the direct dispatcher', () => {
    writeConfig();

    expect(isDevHarnessModelSurfaceEnabled()).toBe(false);
    expect(names(buildAutonomousToolSpecs())).not.toContain('RunDevHarness');
    expect(names(buildAutonomousToolSpecs())).toContain('SelfImplement');
    expect(names(buildAutonomousToolSpecs())).not.toContain('SolveMission');
    expect(names(toolSurface('webterm').specs)).not.toContain('RunDevHarness');
    expect(shouldExposeDevHarnessSessionTool('하니스로 구현해줘')).toBe(false);
    expect(names(resolveDynamicSessionNativeToolSpecs({
      userText: '하니스로 구현해줘',
      surfaceId: 'coding/agent',
    }))).not.toContain('RunDevHarness');
    expect(typeof dispatchRunDevHarness).toBe('function');
  });

  test('derives its description from the nl-run-dev-harness registry status and replacement', () => {
    const entrance = lookupEntrance('nl-run-dev-harness');
    const originalStatus = entrance.status;
    try {
      const retiredDescription = buildRunDevHarnessTool().description;
      expect(retiredDescription).toContain('DEPRECATED(nl-run-dev-harness)');
      expect(retiredDescription).toContain('SelfImplement');
      expect(retiredDescription).toContain('Use this tool when the user mentions the harness');

      (entrance as { status: typeof originalStatus }).status = 'live';
      const liveDescription = buildRunDevHarnessTool().description;
      expect(liveDescription).not.toContain('DEPRECATED');
      expect(liveDescription).toBe(retiredDescription.replace(/^⚠️ DEPRECATED\(nl-run-dev-harness\) — 대신 `SelfImplement` 를 쓰세요\. /, ''));
    } finally {
      (entrance as { status: typeof originalStatus }).status = originalStatus;
    }
  });

  test('records the exposure decision with enabled and source', () => {
    const records: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'dev-harness-model-surface-test',
      emit: record => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      writeConfig();
      isDevHarnessModelSurfaceEnabled();
      writeConfig(true);
      isDevHarnessModelSurfaceEnabled();
    } finally {
      off?.();
    }

    const exposure = records
      .filter(record => record.category === 'tools.surface' && record.event === 'dev-harness-exposure')
      .map(record => record.data);
    expect(exposure).toEqual([
      expect.objectContaining({ enabled: false, source: 'default' }),
      expect.objectContaining({ enabled: true, source: 'config' }),
    ]);
  });

  test('keeps the direct dispatch callable while the model surface is off', async () => {
    writeConfig();
    const received: RunHarnessOnSurfaceOptions[] = [];

    await dispatchRunDevHarness({ objective: 'direct CLI control path' }, undefined, {
      seamsFactory: () => ({}) as never,
      runHarness: (async (opts: RunHarnessOnSurfaceOptions) => {
        received.push(opts);
        return { ok: true, terminal: 'no-changes' as const, rounds: 0 };
      }) as never,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.objective).toBe('direct CLI control path');
  });

  test('restores every model surface when explicitly enabled', () => {
    writeConfig(true);

    expect(isDevHarnessModelSurfaceEnabled()).toBe(true);
    expect(names(buildAutonomousToolSpecs())).toEqual([
      'delegate_code_agent',
      'SelfImplement',
      'RunDevHarness',
    ]);
    expect(names(toolSurface('webterm').specs)).toContain('RunDevHarness');
    expect(names(toolSurface('webterm').specs)).toContain('SelfImplement');
    expect(names(toolSurface('webterm').specs)).not.toContain('SolveMission');
    expect(shouldExposeDevHarnessSessionTool('하니스로 구현해줘')).toBe(true);
    expect(names(resolveDynamicSessionNativeToolSpecs({
      userText: '하니스로 구현해줘',
      surfaceId: 'coding/agent',
    }))).toContain('RunDevHarness');
  });
});
