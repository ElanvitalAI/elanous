import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildNativeToolPromptSummary,
  findNativeTool,
  listNativeToolDisplayNamesByKind,
  listNativeToolsForHost,
  nativeToolCatalog,
} from '../src/native-tool-catalog.js';
import type { NativeToolHost } from '../src/native-tool-catalog.js';
import { buildSkillToolDisciplinePrompt } from '../src/skills/tool-discipline-prompt.js';
import type { ToolHost } from '../src/tool-surface.js';
import { NATIVE_TOOL_HOSTS } from '../src/tool-surface.js';

type Assert<T extends true> = T;
type RejectsPlugin<T> = 'plugin' extends T ? false : true;
type _NativeToolHostRejectsPlugin = Assert<RejectsPlugin<NativeToolHost>>;
type _ToolHostRejectsPlugin = Assert<RejectsPlugin<ToolHost>>;
import { buildContextTools } from '../src/skills/tools/context.js';
import { getGlobalElementEventBus } from '../src/element-registry/index.js';

// Valid safety labels. Keep this list in sync with NativeToolSafety
// in src/native-tool-catalog.ts. Duplicated as a plain string set
// (not imported) so the test actually checks the runtime value of
// each entry against the contract, not a type cast.
const VALID_SAFETY = new Set([
  'read-only', 'mutating', 'network', 'process', 'agent', 'permission', 'debug',
]);

const CANONICAL_HOST_ORDER = NATIVE_TOOL_HOSTS;
// 🆕 'chat' (2026-09-07 · 대표) — PWA·안드로이드·iOS 챗이 «공통으로» 도는 표면.
//   ⛔ 서피스마다 값을 만들지 않는다 — 호스트를 가르는 기준은 「PTY 를 쓸 수 있나」이고
//      그 셋은 그 기준에서 «같다». 기기 구분은 `SessionSurface` 축이다.
//   ⭐ 이 배열이 «고정 계약»인 것은 의도다 — 호스트를 더하는 것은 LLM 어휘를 바꾸는 일이라
//      여기 와서 «결정»하게 만든다. 아래 「every advertised host produces catalog tools」가
//      그 결정을 ***배선까지*** 강제한다(어휘만 늘리면 LLM 이 빈 응답을 받는다).
const FIXED_NATIVE_TOOL_HOST_CONTRACT = ['skill', 'tui', 'mcp', 'chat', 'all'] as const;
const HOST_ORDER = new Map(CANONICAL_HOST_ORDER.map((host, index) => [host, index]));

describe('nativeToolCatalog', () => {
  test('contains the five shared read-only search tools', () => {
    const names = ['Grep', 'Glob', 'ListDir', 'AstGrep', 'Read'];
    for (const name of names) {
      const tool = findNativeTool(name);
      expect(tool?.safety).toEqual(expect.arrayContaining(['read-only']));
      expect(tool?.promptSummary).toBeTruthy();
    }
  });

  test('contains current skill native tools', () => {
    const aliases = new Set(nativeToolCatalog.flatMap(tool => tool.aliases));
    for (const name of ['Bash', 'Read', 'Edit', 'Grep', 'AstGrep', 'WebFetch', 'Agent']) {
      expect(aliases.has(name)).toBe(true);
    }
  });

  test('H5 P2 · TTY snapshot tools registered in catalog', () => {
    // Bootstrap (dashboard.ts) binds these dispatchers at startup; the
    // catalog drives LLM-visible tool listing, so missing entries
    // silently hide the tools even when bound.
    const aliases = new Set(nativeToolCatalog.flatMap((t) => t.aliases));
    expect(aliases.has('SnapshotPtyState')).toBe(true);
    expect(aliases.has('ListPtySnapshots')).toBe(true);
    expect(aliases.has('ComparePtySnapshots')).toBe(true);
  });

  test('indexes tools by id and alias', () => {
    expect(findNativeTool('ast_grep')?.displayName).toBe('AstGrep');
    expect(findNativeTool('AstGrep')?.id).toBe('ast_grep');
    expect(findNativeTool('missing')).toBeUndefined();
  });

  test('filters by host and default-enabled state', () => {
    const skillTools = listNativeToolsForHost('skill').map(tool => tool.id);
    expect(skillTools).toContain('bash');
    expect(skillTools).toContain('agent');
    expect(skillTools).toContain('ast_grep');
    expect(skillTools).toContain('persistent_grounding');
  });

  test('keeps host lists stable while daemon-only browser reads stay out of MCP', () => {
    const browserIds = ['browser_open', 'browser_screenshot', 'browser_close', 'browser_navigate', 'browser_read'];
    const idsFor = (host: NativeToolHost) => listNativeToolsForHost(host)
      .map(tool => tool.id)
      .filter(id => browserIds.includes(id));

    expect(NATIVE_TOOL_HOSTS).toEqual(FIXED_NATIVE_TOOL_HOST_CONTRACT);
    expect(idsFor('skill')).toEqual(browserIds);
    expect(idsFor('tui')).toEqual(['browser_navigate', 'browser_read']);
    expect(idsFor('mcp')).toEqual([]);
  });

  test('keeps RunDevHarness out of the default tui catalog while retaining SelfImplement', () => {
    const tuiTools = listNativeToolsForHost('tui').map(tool => tool.id);

    expect(tuiTools).toContain('self_implement');
    expect(tuiTools).not.toContain('run_dev_harness');
  });

  test('registers PersistentGrounding for every shared surface', () => {
    const tool = findNativeTool('PersistentGrounding');
    expect(tool).toEqual(expect.objectContaining({
      id: 'persistent_grounding',
      safety: ['read-only'],
      host: ['skill', 'tui'],
      promptSummary: expect.any(String),
    }));
    expect(findNativeTool('persistent_grounding')).toBe(tool);
  });

  test('guides goal-document requests to GoalAuthor instead of manual authoring', () => {
    const tool = findNativeTool('goal_author');
    expect(tool).toEqual(expect.objectContaining({
      id: 'goal_author',
      aliases: ['GoalAuthor', 'goal_author'],
      host: ['skill', 'tui'],
    }));
    expect(findNativeTool('GoalAuthor')).toBe(tool);
    expect(tool?.promptSummary).toContain('use when creating a goal document');
    expect(tool?.promptSummary).toContain('do not hand-write it');
    expect(tool?.promptSummary).toContain('nine-section');
    expect(tool?.promptSummary).toContain('1–3 minutes');
    expect(tool?.promptSummary).toContain('at least 300 seconds');
    expect(tool?.promptSummary).not.toContain('eight-section');
    expect(tool?.description).toContain('REQUIRED EVIDENCE');
    expect(tool?.description).not.toContain('eight sections');
  });

  test('builds prompt summary from catalog', () => {
    const summary = buildNativeToolPromptSummary('skill');
    expect(summary).toContain('`Bash`');
    expect(summary).toContain('`AstGrep`');
    expect(summary).toContain('`Agent(description, prompt, subagent_type?, run_in_background?, isolation?, team_name?)`');

    const prompt = buildSkillToolDisciplinePrompt();
    expect(prompt).toContain('You have these tools:');
    expect(prompt).toContain('DO NOT describe what they would do');
    // P0-b: discipline prompt now references catalog-derived names
    // rather than a hard-coded list — so adding Glob doesn't require
    // editing this file. Assert a minimum subset + structure.
    expect(prompt).toMatch(/Use [A-Z][A-Za-z]+(\/[A-Z][A-Za-z]+)+/);
    expect(prompt).toContain('Read');
    expect(prompt).toContain('Grep');
  });

  test('includes bounded exploration retry guidance', () => {
    const explorationGuidance = 'If a search is weak, inspect its results and search again using actual code identifiers or call-path terms.';
    expect(explorationGuidance.length).toBeLessThanOrEqual(200);
    for (const tool of nativeToolCatalog) {
      expect(explorationGuidance).not.toContain(tool.displayName);
    }
    expect(buildSkillToolDisciplinePrompt()).toContain(explorationGuidance);
  });
});

// P0-a: every catalog entry must carry the metadata fields that
// downstream consumers (parallel planner, permission gater,
// capability checker) depend on. These tests prevent a silent
// "forgot to set safety" regression when Tier S / A tools land.
describe('nativeToolCatalog — metadata invariants', () => {
  test('every entry declares a closed-set kind', () => {
    const validKinds = new Set([
      // ⭐ 'plan'·'ask-user' 는 2026-08-14 레퍼런스(grok-build) 대조로 «추가»됐다.
      //   그 근거·경계는 NativeToolKind 정의부 주석이 canonical.
      'read', 'edit', 'write', 'list-dir', 'search', 'execute', 'web', 'delegate',
      'plan', 'ask-user', 'other',
    ]);
    for (const tool of nativeToolCatalog) {
      expect(validKinds.has(tool.kind)).toBe(true);
    }
  });

  test('classifies specified and obvious file/search tools by literal kind', () => {
    expect(findNativeTool('read')?.kind).toBe('read');
    expect(findNativeTool('edit')?.kind).toBe('edit');
    expect(findNativeTool('write')?.kind).toBe('write');
    expect(findNativeTool('list_dir')?.kind).toBe('list-dir');
    expect(findNativeTool('grep')?.kind).toBe('search');
    expect(findNativeTool('glob')?.kind).toBe('search');
    expect(findNativeTool('elanous_obsidian_search')?.kind).toBe('search');
    expect(findNativeTool('elanous_fs_list')?.kind).toBe('list-dir');
    expect(findNativeTool('elanous_fs_read')?.kind).toBe('read');
  });

  // ⛔ 이름을 「전수 분류를 검증한다」로 읽지 마라 — 이 테스트가 무는 것은
  //    ***「절이 참조할 여덟 칸이 각각 «비어 있지 않고» 대표 툴을 담는가」***다.
  //    전수 «의미» 분류는 이 축의 목표가 아니다(NativeToolKind 주석 참조).
  test('exposes every non-other kind bucket with its representative tools', () => {
    const namesByKind = listNativeToolDisplayNamesByKind(nativeToolCatalog);

    expect(namesByKind.read).toEqual(expect.arrayContaining(['Read', 'ElanousFsRead']));
    expect(namesByKind.edit).toContain('Edit');
    expect(namesByKind.write).toContain('Write');
    expect(namesByKind['list-dir']).toEqual(expect.arrayContaining(['ListDir', 'ElanousFsList']));
    expect(namesByKind.search).toEqual(expect.arrayContaining(['Grep', 'Glob', 'ElanousObsidianSearch']));
    expect(namesByKind.execute).toEqual(expect.arrayContaining(['Bash', 'RunShell']));
    expect(namesByKind.web).toEqual(expect.arrayContaining(['WebFetch', 'BrowserNavigate', 'BrowserRead', 'BrowserScreenshot', 'BrowserClose']));
    expect(namesByKind.delegate).toEqual(expect.arrayContaining(['Agent', 'AgentHandoff']));
    // ⭐ 위임 «본체»가 이 칸에 있어야 한다 — E3/E4 가 「위임처가 있나」를 이 칸으로 묻는다.
    //    이 넷이 other 로 새면 그 물음이 «항상 없다»로 답해 가드가 탈출구를 못 준다.
    expect(namesByKind.delegate).toEqual(expect.arrayContaining([
      'SelfImplement', 'SelfOrchestrate', 'SpawnCodingAgentHeadless', 'DriveCodingAgentHeadless',
    ]));
    // ⭐ 2026-08-14 레퍼런스 대조로 두 칸이 늘었다 — 종류로 참조할 자리가 생겼다는 뜻이다.
    expect(namesByKind.plan).toContain('UpdatePlan');
    expect(namesByKind['ask-user']).toContain('AskUserQuestion');
    expect(Object.values(namesByKind)).toHaveLength(10);
    for (const names of Object.values(namesByKind)) {
      expect(names.length).toBeGreaterThan(0);
    }
    expect(Object.values(namesByKind).flat().length).toBeGreaterThan(0);
  });

  test('classifies obvious execution, web, and delegation tools outside other', () => {
    const namesByKind = listNativeToolDisplayNamesByKind(nativeToolCatalog);
    const classifiedNames = Object.values(namesByKind).flat();

    expect(findNativeTool('run_shell')?.kind).toBe('execute');
    expect(findNativeTool('browser_navigate')?.kind).toBe('web');
    expect(findNativeTool('agent_handoff')?.kind).toBe('delegate');
    expect(classifiedNames).toEqual(expect.arrayContaining(['Bash', 'RunShell', 'BrowserNavigate', 'AgentHandoff']));
    expect(classifiedNames.filter(name => name === 'RunShell')).toHaveLength(1);
    expect(classifiedNames.filter(name => name === 'BrowserNavigate')).toHaveLength(1);
    expect(classifiedNames.filter(name => name === 'AgentHandoff')).toHaveLength(1);
  });

  test('groups display names by kind without other entries or input mutation', () => {
    const catalog = [
      findNativeTool('read')!,
      findNativeTool('edit')!,
      findNativeTool('write')!,
      findNativeTool('list_dir')!,
      findNativeTool('grep')!,
      findNativeTool('glob')!,
      findNativeTool('goal_author')!,
    ];
    const original = structuredClone(catalog);
    const namesByKind = listNativeToolDisplayNamesByKind(catalog);

    expect(namesByKind.read).toEqual(['Read']);
    expect(namesByKind.edit).toEqual(['Edit']);
    expect(namesByKind.write).toEqual(['Write']);
    expect(namesByKind['list-dir']).toEqual(['ListDir']);
    expect(namesByKind.search).toEqual(['Grep', 'Glob']);
    expect('other' in namesByKind).toBe(false);
    expect(Object.values(namesByKind).flat()).not.toContain('GoalAuthor');
    expect(catalog).toEqual(original);

    const moved = catalog.map(tool => tool.id === 'grep' ? { ...tool, kind: 'execute' as const } : tool);
    const movedNamesByKind = listNativeToolDisplayNamesByKind(moved);
    expect(movedNamesByKind.search).toEqual(['Glob']);
    expect(movedNamesByKind.execute).toEqual(['Grep']);
  });

  test('every entry declares at least one safety label', () => {
    for (const tool of nativeToolCatalog) {
      expect(tool.safety.length).toBeGreaterThan(0);
      for (const label of tool.safety) {
        expect(VALID_SAFETY.has(label)).toBe(true);
      }
    }
  });

  test('every entry has a typed supportsParallel flag', () => {
    for (const tool of nativeToolCatalog) {
      expect(typeof tool.supportsParallel).toBe('boolean');
    }
  });

  test('host arrays follow the NativeToolHost declaration order', () => {
    const outOfOrderToolIds = nativeToolCatalog
      .filter(({ host }) => host.some((value, index) =>
        index > 0 && HOST_ORDER.get(value)! < HOST_ORDER.get(host[index - 1])!,
      ))
      .map(({ id }) => id);

    if (outOfOrderToolIds.length > 0) {
      throw new Error(`host arrays must follow NativeToolHost declaration order; offending tool ids: ${outOfOrderToolIds.join(', ')}`);
    }
  });

  test('exposes the self-cognition ledger as read-only MCP tools', () => {
    const ids = ['self_recall', 'logs_query', 'ops_status', 'memory_recall'];
    const mcpTools = listNativeToolsForHost('mcp');

    expect(mcpTools.filter(tool => ids.includes(tool.id))).toEqual(
      expect.arrayContaining(ids.map(id => expect.objectContaining({
        id,
        host: ['mcp'],
        safety: ['read-only'],
        supportsParallel: true,
      }))),
    );
  });

  test('keeps the 200-entry catalog on the five-host vocabulary after six virtual-window tools retire', () => {
    const distribution = new Map<string, number>();
    for (const { host } of nativeToolCatalog) {
      const key = host.join(',');
      distribution.set(key, (distribution.get(key) ?? 0) + 1);
      expect(host).not.toContain('plugin');
    }

    expect(nativeToolCatalog).toHaveLength(200);
    expect([...distribution.entries()].sort()).toEqual([
      ['mcp', 16],
      ['skill', 48],
      ['skill,tui', 90],
      // 🆕 AskUserQuestion — 챗에서 띄운 자식이 사람에게 «되물을» 수 있어야 한다(2026-09-08).
      //   ⛔ #16003 이 SelfImplement 만 열고 이 짝을 안 열어서 챗 자식은 물을 도구가 없었다.
      ['skill,tui,chat', 1],
      ['skill,tui,mcp', 38],
      // 🆕 SelfImplement — 챗에서도 부를 수 있다(2026-09-07 · 대표).
      //   ⭐ 이 툴은 «헤드리스 자식»을 띄우므로 ***부르는 쪽에 PTY 가 필요 없다.***
      ['skill,tui,mcp,chat', 1],
      ['tui', 6],
    ]);
  });


  test('mutating tools are NOT marked parallel-safe', () => {
    // Concurrent mutation == race conditions. If a future catalog
    // entry declares `safety: ['mutating']` with supportsParallel
    // true, the parallel planner can race mutations of shared state.
    for (const tool of nativeToolCatalog) {
      if (tool.safety.includes('mutating')) {
        expect(tool.supportsParallel).toBe(false);
      }
    }
  });

  test('ids are unique and match kebab-or-snake convention', () => {
    const ids = nativeToolCatalog.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test('aliases are unique across the catalog', () => {
    // Two tools sharing an alias would make findNativeTool
    // non-deterministic based on iteration order. Catch early.
    const seen = new Set<string>();
    for (const tool of nativeToolCatalog) {
      for (const alias of tool.aliases) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  test('promptSummary is non-empty and begins with a backtick-quoted name', () => {
    // Convention baked in by existing entries — helps the skill
    // prompt render a clean comma-separated list.
    for (const tool of nativeToolCatalog) {
      expect(tool.promptSummary.length).toBeGreaterThan(0);
      expect(tool.promptSummary.startsWith('`')).toBe(true);
    }
  });
});

// P1: optional gate/probe/tier fields. These are no-ops for
// current entries (none use them yet) but asserting well-formedness
// catches typos and shape errors when P8–P14 land probe-gated tools.
describe('nativeToolCatalog — P1 optional fields', () => {
  const VALID_PROBE_KINDS = new Set(['env', 'cli', 'http', 'custom']);
  const VALID_ONFAIL = new Set(['hide', 'disable', 'warn']);
  const VALID_TIERS = new Set(['T1', 'T2', 'T3']);

  test('probe.kind is one of the four documented variants and carries the matching payload', () => {
    for (const tool of nativeToolCatalog) {
      if (!tool.probe) continue;
      expect(VALID_PROBE_KINDS.has(tool.probe.kind)).toBe(true);
      if (tool.probe.kind === 'env') {
        expect(typeof tool.probe.env).toBe('string');
        expect(tool.probe.env.length).toBeGreaterThan(0);
      }
      if (tool.probe.kind === 'cli') {
        expect(typeof tool.probe.cli.cmd).toBe('string');
        expect(tool.probe.cli.cmd.length).toBeGreaterThan(0);
      }
      if (tool.probe.kind === 'http') {
        expect(typeof tool.probe.http.url).toBe('string');
        expect(tool.probe.http.url.length).toBeGreaterThan(0);
      }
      if (tool.probe.kind === 'custom') {
        expect(typeof tool.probe.custom).toBe('function');
      }
    }
  });

  test('probe.onFail, when present, is one of hide/disable/warn', () => {
    for (const tool of nativeToolCatalog) {
      if (!tool.probe?.onFail) continue;
      expect(VALID_ONFAIL.has(tool.probe.onFail)).toBe(true);
    }
  });

  test('probe.ttlMs, when present, is a non-negative finite number or Infinity', () => {
    for (const tool of nativeToolCatalog) {
      if (tool.probe?.ttlMs === undefined) continue;
      const v = tool.probe.ttlMs;
      expect(typeof v).toBe('number');
      // Allow Infinity (permanent cache — common for env probes).
      expect(v >= 0).toBe(true);
    }
  });

  test('hintKeys, when present, is a non-empty array of unique non-empty strings', () => {
    for (const tool of nativeToolCatalog) {
      if (!tool.hintKeys) continue;
      expect(Array.isArray(tool.hintKeys)).toBe(true);
      expect(tool.hintKeys.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const key of tool.hintKeys) {
        expect(typeof key).toBe('string');
        expect(key.length).toBeGreaterThan(0);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  test('minTier, when present, is T1 / T2 / T3', () => {
    for (const tool of nativeToolCatalog) {
      if (!tool.minTier) continue;
      expect(VALID_TIERS.has(tool.minTier)).toBe(true);
    }
  });
});

// ── ContextToolsList host vocabulary matches the catalog ────────────
function contextToolsListHostEnum(): string[] {
  const spec = buildContextTools().find(t => t.name === 'ContextToolsList');
  if (!spec) throw new Error('ContextToolsList spec is missing');
  const params = spec.parameters as {
    properties?: { host?: { enum?: unknown }; surface?: unknown };
  };
  if ('surface' in (params.properties ?? {})) {
    throw new Error('ContextToolsList must not advertise the retired surface parameter');
  }
  const values = params.properties?.host?.enum;
  if (!Array.isArray(values)) {
    throw new Error('ContextToolsList.host must retain its enum');
  }
  return values as string[];
}

describe('ContextToolsList host enum — LLM vocabulary matches the catalog', () => {
  test('keeps the canonical vocabulary fixed to the RFC S7 contract', () => {
    expect(NATIVE_TOOL_HOSTS).toEqual(FIXED_NATIVE_TOOL_HOST_CONTRACT);
  });

  test('advertises the canonical native host vocabulary in order without surface', () => {
    expect(contextToolsListHostEnum()).toEqual([...FIXED_NATIVE_TOOL_HOST_CONTRACT]);
  });

  test('every advertised host produces catalog tools (except all)', () => {
    const dead = contextToolsListHostEnum()
      .filter(host => host !== 'all')
      .filter(host => listNativeToolsForHost(host as never).length === 0);
    if (dead.length > 0) {
      throw new Error(
        `ContextToolsList advertises hosts absent from the catalog: ${dead.join(', ')} — `
        + 'an LLM would receive an empty success response',
      );
    }
  });

  test('every catalog host is advertised by the host enum', () => {
    const advertisedHosts = new Set(contextToolsListHostEnum());
    const usedHosts = new Set(nativeToolCatalog.flatMap(t => t.host as readonly string[]));
    const unadvertised = [...usedHosts].filter(host => !advertisedHosts.has(host));
    if (unadvertised.length > 0) {
      throw new Error(
        `Catalog hosts omitted from ContextToolsList.host: ${unadvertised.join(', ')}`,
      );
    }
  });

  test('tool creation events publish host rather than the retired surface key', () => {
    const event = getGlobalElementEventBus().tail({ kinds: ['tool'], limit: 1 })[0];
    expect(event).toBeDefined();
    expect(event?.payload).toEqual(expect.objectContaining({ host: expect.any(Array) }));
    expect(event?.payload).not.toHaveProperty('surface');
  });
});

// ⭐ 레퍼런스(grok-build) 대조로 «추가»된 두 종류 — 2026-08-14.
//   그쪽 프롬프트는 툴을 이름이 아니라 종류로 참조한다:
//     "Managing task lists and tracking progress (${{ tools.by_kind.plan }})"
//     "Asking the user questions (${{ tools.by_kind.ask_user }})"
//   우리 어휘엔 그 두 칸이 없어 해당 툴이 `other` 로 떨어져 있었고,
//   `listNativeToolDisplayNamesByKind` 가 `other` 를 «건너뛰므로»
//   프롬프트가 그것을 종류로 부를 방법이 «원리상» 없었다.
describe('native tool kinds — plan · ask-user (grok-build 대조 이식)', () => {
  test('진행 추적 툴과 되묻기 툴이 other 가 아닌 «자기 종류»를 갖는다', () => {
    expect(findNativeTool('update_plan')?.kind).toBe('plan');
    expect(findNativeTool('UpdatePlan')?.kind).toBe('plan');
    expect(findNativeTool('ask_user_question')?.kind).toBe('ask-user');
    expect(findNativeTool('AskUserQuestion')?.kind).toBe('ask-user');
  });

  test('그래서 프롬프트가 두 종류를 «종류로» 부를 수 있다', () => {
    const entries = nativeToolCatalog.filter(
      (t) => t.id === 'update_plan' || t.id === 'ask_user_question',
    );
    const byKind = listNativeToolDisplayNamesByKind(entries);
    expect(byKind.plan).toEqual(['UpdatePlan']);
    expect(byKind['ask-user']).toEqual(['AskUserQuestion']);
  });

  test('⛔ plan-mode 진입·이탈은 «일부러» plan 종류가 아니다 — 모드 전환이지 진행 추적이 아니다', () => {
    // 레퍼런스도 이 둘만은 종류가 아니라 이름으로 부른다
    // (`GrokBuild:enter_plan_mode` · `GrokBuild:exit_plan_mode`).
    // ⛔ 리뷰 should-fix(#9068) — 존재를 «먼저» 단언한다. optional chaining 만 쓰면
    //    툴이 사라져도 undefined !== 'plan' 이라 «통과»한다: 부재를 만족으로 읽는 칸이 된다.
    for (const id of ['enter_plan_mode', 'exit_plan_mode'] as const) {
      const entry = findNativeTool(id);
      expect(entry).toBeDefined();
      expect(entry!.kind).not.toBe('plan');
    }
  });

  // ⭐ 대표 지시(2026-08-14): *"다른 프로바이더까지 영향 주는 부분은 grok 일 때에만 돌게"*.
  //   이 변경은 «어느 프로바이더의 프롬프트도» 바꾸지 않는다 — 그 사실을 사람의 주장이 아니라
  //   테스트가 말하게 한다. 두 칸을 «참조하는 지시문»이 생기는 순간 이 테스트가 빨강이 되고,
  //   그때 비로소 「프로바이더 게이팅이 필요한가」를 묻게 된다.
  test('새 두 칸은 아직 «어떤 프롬프트도» 참조하지 않는다 — 그러므로 프로바이더 무영향', () => {
    const source = readFileSync(
      new URL('../src/impl-discipline/system-prompt.ts', import.meta.url),
      'utf8',
    );
    // replaceDirective/replaceInlineToolNames 의 kinds 인자에 두 칸이 등장하지 않는다.
    expect(source).not.toContain("'plan'");
    expect(source).not.toContain("'ask-user'");
  });
});
