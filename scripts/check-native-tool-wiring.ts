#!/usr/bin/env bun
// HT3 — wiring lint for the native tool catalog.
//
// Docs reference: 내부 문서 `MANUAL-llm-tool-prompt-harness` §10 + 부록 F.
//
// A native tool needs 3 registrations that have to stay in sync:
//   (1) catalog entry in src/native-tool-catalog.ts  (declares aliases +
//       surfaces)
//   (2) skill-runner dispatch map entry  (surface 'skill')
//   (3) dashboard.ts pluginTools wiring  (surface 'tui')
//
// Drift between (1) and (2)/(3) is subtle — the LLM sees the tool but
// the call lands on "unknown tool" at runtime. This script scans the
// source files and reports gaps. Exits non-zero when any issue is
// found so it can be wired into CI.
//
// Usage:
//   bun run check:tool-wiring              # informational (exit 0 always)
//   bun run check:tool-wiring -- --strict  # exit 1 on any issue (for CI)
//   bun run check:tool-wiring -- --verbose
//
// Heuristic: regex scan for the PascalCase alias. This misses catalog
// entries that dispatch via ElementRegistry / ACP / plugin-host
// (there are ~60 such entries in the current tree). The baseline
// drift is recorded — tighten by adding them to SKIP_TOOLS below or
// routing them through the skill-runner dispatch map.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';
import { TUI_SOURCE_DIRS, tuiSourceText } from '../test/helpers/dashboard-source.js';

const verbose = process.argv.includes('--verbose');
const strict  = process.argv.includes('--strict');

/** Tools whose dispatch lives outside the skill-runner PascalCase
 *  map — element-registry, ACP, plugin-host bridge, runtime-internal
 *  PTY tools, etc. Keep this list tight; when a new tool is added
 *  through a conventional dispatch path, remove it here.
 *
 *  TODO(HT3): migrate these to uniform dispatch so the list can shrink. */
const SKIP_TOOLS: ReadonlySet<string> = new Set([
  // Shell / run
  'bash', 'run_shell',
  // Element registry context tools (dispatched through a prefix router)
  'dashboard_state', 'context_workspace', 'context_windows_list',
  'context_window_detail', 'context_pane_detail', 'context_ptys_list',
  'context_pty_detail', 'context_sessions_list', 'context_jobs_list',
  'context_widgets_list', 'context_plugins_list', 'context_tools_list',
  'context_events_tail', 'context_bootstrap',
  // Element registry control tools
  'control_window_resize', 'control_pane_resize', 'control_pane_layout',
  'control_tool_toggle', 'control_prompt_append', 'control_prompt_clear',
  // Terminal pipe / rechar — dispatched inside terminal-matrix
  'terminal_recharacter', 'terminal_pipe_to_channel',
  'terminal_unpipe_from_channel', 'terminal_pipe_list',
  // Meta tool handled by gate runtime, not skill-runner map
  'set_tool_hint',
]);

// ⛔⭐⭐⭐ 2026-08-04 — 이 파일은 «두 겹으로» 죽어 있었다:
//   ⓐ 카탈로그 필드 개명(#6928 surface → host)을 안 따라가 `entry.surface.includes` 가 «던졌다».
//      ⇒ 오늘 아침 TUI 를 매 턴 죽인 #6950 과 «같은 형태»다.
//   ⓑ 그런데 «아무도 이 스크립트를 부르지 않아»(package.json 에만 있고 게이트·CI 호출 0건)
//      그 죽음이 한 번도 산출로 나오지 않았다.
//   ⇒ ⭐ 그래서 이 PR 은 ⓐ만 고치고, 「도는지」를 test/tool-wiring-checker.test.ts 로 «묶었다».
//   ⛔ 아래 검출 «방법»(registry.ts 안의 문자열 찾기)이 지금도 옳은지는 «안 쟀다» —
//      런타임 등록(tool-runtime/*-runtimes.ts)으로 바뀐 뒤 오탐일 수 있다(실측 1건: shell_list).
//      ⇒ 그러므로 이 스크립트가 내는 issue 수는 «결함 수가 아니라 이 자로 잰 수»다. 분류는 후속.
const root = resolve(import.meta.dir, '..');
const skillDispatchSrc = readFileSync(resolve(root, 'src/tool-runtime/registry.ts'), 'utf8');
const tuiSrc   = tuiSourceText(root); // TUI 소스 묶음(src/dashboard/** ⊕ src/tui/**) — 경로 무관

interface Issue { tool: string; surface: string; kind: 'missing' | 'extra'; detail: string; }

const issues: Issue[] = [];
let checked = { skill: 0, tui: 0 };

for (const entry of nativeToolCatalog) {
  if (SKIP_TOOLS.has(entry.id)) continue;
  const pascal = entry.aliases.find(a => /^[A-Z]/.test(a));
  if (!pascal) continue;

  if (entry.host.includes('skill')) {
    checked.skill++;
    // Look for `<PascalCase>:` or `'<PascalCase>':` inside the dispatch
    // map. The regex boundary excludes partial matches (`Foo:` vs `FooBar:`).
    const rx = new RegExp(`\\b${pascal}:\\s*async`, 'g');
    if (!rx.test(skillDispatchSrc)) {
      issues.push({
        tool: entry.id,
        surface: 'skill',
        kind: 'missing',
        detail: `tool-runtime/registry.ts has no dispatch for alias "${pascal}" (catalog lists host:'skill')`,
      });
    }
  }

  if (entry.host.includes('tui')) {
    checked.tui++;
    const rx = new RegExp(`\\b${pascal}\\b`);
    if (!rx.test(tuiSrc)) {
      issues.push({
        tool: entry.id,
        surface: 'tui',
        kind: 'missing',
        detail: `TUI source bundle (${TUI_SOURCE_DIRS.join(' + ')}) does not mention alias "${pascal}" (catalog lists host:'tui')`,
      });
    }
  }
}

console.log(`[check-native-tool-wiring] scanned ${nativeToolCatalog.length} catalog entries (skipped ${SKIP_TOOLS.size} via SKIP_TOOLS).`);
if (verbose) {
  console.log(`  skill-surface checks: ${checked.skill}`);
  console.log(`  tui-surface checks: ${checked.tui}`);
}

if (issues.length === 0) {
  console.log(`[check-native-tool-wiring] OK — ${nativeToolCatalog.length} tools, wiring consistent (skipped ${SKIP_TOOLS.size} via SKIP_TOOLS).`);
  process.exit(0);
}

console.error(`[check-native-tool-wiring] ${issues.length} issue(s):`);
for (const i of issues) {
  console.error(`  × ${i.tool} [${i.surface}]: ${i.detail}`);
}
if (strict) {
  console.error(`[check-native-tool-wiring] --strict mode: failing with exit 1`);
  process.exit(1);
}
console.log(`[check-native-tool-wiring] informational mode (no --strict) — exit 0`);
process.exit(0);
