// Track X — other agents' search tools, emulated from their documented/source behaviour over the same corpus and the
// same neutral query plan (name pass + content pass, no expansion, no Read) so only the tool semantics differ.
// Sources: seat-state TC-H-POOL-2 static comparison + local ~/source/ref checkouts (paths in adapters.ts).
import { claudeCodeAdapter, codexAdapter, grokBuildAdapter, grokCliAdapter, hermesAdapter, openclawAdapter } from '../adapters.js';
import { DEFAULT_PIPELINE, runPipeline, type ToolAdapter } from '../plan.js';
import type { SearchStrategy } from '../types.js';

const x = (id: string, label: string, tool: ToolAdapter, source: string): SearchStrategy => ({ id, version: 1, track: 'X', label, source, run: (q, kit) => runPipeline(q, kit, tool, DEFAULT_PIPELINE) });

export const externalStrategies: SearchStrategy[] = [
  x('X-claude-code', 'Claude Code Grep/Glob (reference)', claudeCodeAdapter, 'Claude Code tool docs · eln port src/skills/tools/grep.ts, glob.ts'),
  x('X-codex', 'Codex CLI (rg via exec_command, 10k-token fold)', codexAdapter, 'codex-rs/core/gpt_5_codex_prompt.md:5 · codex-rs/core/src/tools/handlers/shell_spec.rs:52-59'),
  x('X-grok-cli', 'grok-cli grep (rg --json --hidden, 100 matches)', grokCliAdapter, 'grok-cli src/tools/grep.ts:6,26-42,139-175'),
  x('X-grok-build', 'grok-build grep (content, head 200, 5M/1000 col)', grokBuildAdapter, 'grok-build xai-grok-tools grep/mod.rs:52-128 · rg_runner.rs:29-115'),
  x('X-hermes', 'hermes-agent search_files (limit 50)', hermesAdapter, 'hermes-agent tools/file_tools.py:2804-2819 · tools/file_operations.py:3137-3363'),
  x('X-openclaw', 'OpenClaw (pi grep/find)', openclawAdapter, 'openclaw src/agents/embedded-agent-runner/tool-name-allowlist.ts:9 · pi-mono coding-agent tools (upstream, unverified)'),
];
