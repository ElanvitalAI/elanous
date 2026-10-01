// PLAN-codex-app-server-hermes-parity §5 Phase H1·5a (2026-05-16) —
// `elanous_skills_list` MCP tool. Mirrors the daemon-side ACP method
// `elanous/skills/list` (src/acp/server.ts:2241) but session-agnostic so
// the codex app-server can call it through the elanous-tools MCP server
// without first opening an ACP session. Enumerates configured skill roots
// and surfaces the first non-heading line of each SKILL.md as the
// description.
//
// Read-only · safe to parallelise. It is also exposed with skill_exec on
// shared child-agent surfaces: 7 days of chat.tool-call data recorded 1,267
// calls and zero skill_exec calls when exact installed names were undiscoverable.
// This intentionally reverses the former MCP-only/TUI-clutter decision.

import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { defaultSkillDirs } from '../user-config.js';
import { SKILLS_LIST_DESCRIPTION } from '../onboarding/entry-hints.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime } from './types.js';

export interface ElanousSkillsListArgs {
  /** Case-insensitive substring filter on skill name. Empty = all. */
  query?: string;
}

export interface ElanousSkillsListEntry {
  name: string;
  description: string;
}

export interface ElanousSkillsListResult extends Record<string, unknown> {
  /** LLM-facing one-line summary. */
  output: string;
  /** Primary skill root (첫 dir·단일 경로 계약 보존·back-compat). 다중 루트는 skillsDirs 참조. */
  skillsDir: string;
  /** ★ G9 P5b — 열거한 전체 skill root 목록(user-config skills.dirs 다중 루트). */
  skillsDirs: string[];
  entries: ElanousSkillsListEntry[];
  error?: string;
}

export function buildElanousSkillsListTool(): LLMToolSpec {
  return {
    name: 'elanous_skills_list',
    description: SKILLS_LIST_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on skill name. Empty = all.',
        },
      },
      additionalProperties: false,
    },
  };
}

/** Pure dispatcher — `skillsDir` override lets tests point at a tmp
 *  directory without monkey-patching `os.homedir`. */
export async function dispatchElanousSkillsList(
  args: ElanousSkillsListArgs = {},
  opts: { skillsDir?: string } = {},
): Promise<ElanousSkillsListResult> {
  // ★ G9 P5b — router/executor(getSkillIndex·P5a)와 동일한 user-config skill dir **전부**를 열거(다중 루트·
  //   first-wins). 종전 하드코딩 ~/.elanous/skills(빈 디렉토리) → codex app-server/iOS/PWA `$` 피커 빈 목록 버그.
  //   skillsDir override 는 테스트 격리용으로 그대로 우선(단일 dir).
  const dirs = opts.skillsDir ? [opts.skillsDir] : defaultSkillDirs();
  const skillsDir = dirs[0] ?? ''; // 단일 경로 계약 보존(첫 dir)·전체는 skillsDirs
  const label = dirs.join(', ');   // 표시용(다중 루트면 콤마 결합)
  const query = (args.query ?? '').toLowerCase();
  const seen = new Set<string>();
  const entries: ElanousSkillsListEntry[] = [];
  const errors: string[] = [];
  for (const dir of dirs) {
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      for (const d of dirents.filter((e) => e.isDirectory())) {
        if (seen.has(d.name)) continue; // 다중 루트 first-wins dedup(getSkillIndex 와 동일 정책)
        seen.add(d.name);
        let description = '';
        try {
          const md = await readFile(join(dir, d.name, 'SKILL.md'), 'utf8');
          const firstLine = md.split('\n').find((l) => l.trim().length > 0 && !l.startsWith('#'));
          description = firstLine ? firstLine.trim().slice(0, 80) : '';
        } catch { /* SKILL.md absent — blank description(ACP 핸들러와 동일) */ }
        entries.push({ name: d.name, description });
      }
    } catch (e) {
      errors.push(String(e instanceof Error ? e.message : e));
    }
  }
  let filtered = entries;
  if (query.length > 0) filtered = entries.filter((e) => e.name.toLowerCase().includes(query));
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  // 모든 dir 열거 실패(산출 0)면 실패 보고(단일 dir 부재 계약 보존).
  if (entries.length === 0 && errors.length > 0 && errors.length === dirs.length) {
    return { output: `(failed to enumerate ${label})`, skillsDir, skillsDirs: dirs, entries: [], error: errors.join('; ') };
  }
  // ★ partial-error 표면화(should-fix) — 일부 root 만 실패해도 error 로 노출(잘못된 config 은폐 방지).
  return {
    output: `${filtered.length} skill(s) under ${label}`,
    skillsDir, skillsDirs: dirs, entries: filtered,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

export const elanousSkillsListRuntime: ToolRuntime<
  ElanousSkillsListArgs,
  ElanousSkillsListResult
> = {
  id: 'elanous_skills_list',
  spec: buildElanousSkillsListTool(),
  async run(req) {
    return dispatchElanousSkillsList(req);
  },
};
