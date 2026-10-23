// ── Ops-turn guard in the per-model prompt addons (TUI-OPS-TURN-GUARD gap ②) ──
//
// The llm.ts half of gap ② is the phase allow list in
// src/llm/tool-loop-steered-rejection.ts (ACTION_PHASE_OPS_TOOLS /
// REPAIR_PHASE_READ_ONLY_OPS_TOOLS, consumed by PHASE_TOOL_SETS):
// read-only ops observation (`logs_query`, `PtyShellPoll`) stays runnable
// mid-ops-turn while write-capable ops tools (`schedule_manage`, `se_build`)
// stay phase-governed. This file locks the OTHER half — the prompt addons
// TOOL_DISCIPLINE_CODEX / TOOL_DISCIPLINE_GPT must tell the model the same
// split. One half without the other is a half-wired guard: an allow list the
// model was never told about, or an addon that implies ops observation is
// locked out.
//
// Routing fact that forces the rule into BOTH addons: gpt-6 generation ids
// stay in the 'gpt' family (getModelFamily never returns 'codex' for them —
// TUI-GPT6-GUARD-PARITY widens only the *behavior* predicate), so a gpt-6
// model running the codex behavior guards receives TOOL_DISCIPLINE_GPT.
// Codex-family ids receive TOOL_DISCIPLINE_CODEX. Both must carry the
// ops-turn guard instruction.

import { describe, expect, test } from 'bun:test';
import {
  ACTION_PHASE_OPS_TOOLS,
  REPAIR_PHASE_READ_ONLY_OPS_TOOLS,
} from '../llm/tool-loop-steered-rejection.js';
import {
  getModelFamily,
  getModelPromptAddon,
  usesCodexBehaviorGuards,
} from './prompts.js';

/** Every phrase the ops-turn-guard rule must name: the gap handle, both
 *  read-only tools that stay runnable, both write-capable tools that stay
 *  phase-governed, the rejection marker, and the phase-split words. */
const OPS_GUARD_MARKERS = [
  'TUI-OPS-TURN-GUARD',
  'logs_query',
  'PtyShellPoll',
  'schedule_manage',
  'se_build',
  'TOOL CALL REJECTED',
  'phase-governed',
  'mid-ops-turn',
] as const;

/** codex family ids → TOOL_DISCIPLINE_CODEX. */
const CODEX_MODELS = ['gpt-5.4-codex', 'codex-mini-latest', 'gpt-5.4'] as const;
/** gpt family ids — incl. the gpt-6 generation and the OpenRouter gateway
 *  path — → TOOL_DISCIPLINE_GPT. */
const GPT_MODELS = ['gpt-6-sol', 'gpt-4o', 'openrouter/openai/gpt-6-luna'] as const;

describe('TOOL_DISCIPLINE addons — ops-turn guard (TUI-OPS-TURN-GUARD gap ②)', () => {
  test('both codex and gpt addons instruct the ops-turn guard split', () => {
    for (const modelId of [...CODEX_MODELS, ...GPT_MODELS]) {
      const addon = getModelPromptAddon(modelId);
      for (const marker of OPS_GUARD_MARKERS) {
        expect(addon).toContain(marker);
      }
    }
  });

  test('ops-guard instruction matches the llm.ts phase allow lists', () => {
    // Read-only ops observation stays runnable mid-ops-turn.
    expect(ACTION_PHASE_OPS_TOOLS).toContain('logs_query');
    expect(ACTION_PHASE_OPS_TOOLS).toContain('PtyShellPoll');
    // Write-capable ops tools stay phase-governed — never allow-listed,
    // in either phase set.
    expect(ACTION_PHASE_OPS_TOOLS).not.toContain('schedule_manage');
    expect(ACTION_PHASE_OPS_TOOLS).not.toContain('se_build');
    expect(REPAIR_PHASE_READ_ONLY_OPS_TOOLS).not.toContain('schedule_manage');
    expect(REPAIR_PHASE_READ_ONLY_OPS_TOOLS).not.toContain('se_build');
  });

  test('every model that runs the codex behavior guards receives the ops-guard instruction', () => {
    for (const modelId of [
      ...CODEX_MODELS,
      'gpt-6-sol',
      'gpt-6-luna',
      'openrouter/openai/gpt-6-astra',
    ]) {
      expect(usesCodexBehaviorGuards(modelId)).toBe(true);
      expect(getModelPromptAddon(modelId)).toContain('TUI-OPS-TURN-GUARD');
    }
  });

  test('ops-guard rule does not weaken the STOP-on-rejection rule', () => {
    for (const modelId of [...CODEX_MODELS, ...GPT_MODELS]) {
      const addon = getModelPromptAddon(modelId);
      expect(addon).toContain('## Tool-call hygiene');
      expect(addon).toContain('DUPLICATE CALL');
      expect(addon).toContain('RUNTIME BLOCKED');
      expect(addon).toContain('TOOL CALL REJECTED');
      expect(addon).toContain('SYSTEM BUDGET NOTICE');
      expect(addon).toContain('— STOP.');
      // The new rule points a phase rejection back at the STOP rule instead
      // of licensing retries of the rejected write-capable tool.
      expect(addon).toContain('do not retry it');
    }
  });

  test('families outside codex/gpt keep the empty addon', () => {
    expect(getModelFamily('claude-opus-4-6')).toBe('claude');
    expect(getModelPromptAddon('claude-opus-4-6')).toBe('');
    expect(getModelFamily('grok-4')).toBe('grok');
    expect(getModelPromptAddon('grok-4')).toBe('');
    expect(getModelFamily('gemini-3-pro')).toBe('gemini');
    expect(getModelPromptAddon('gemini-3-pro')).toBe('');
    expect(getModelFamily('local:llama-3')).toBe('local');
    expect(getModelPromptAddon('local:llama-3')).toBe('');
    expect(getModelFamily('qwen/qwen3-coder-30b')).toBe('other');
    expect(getModelPromptAddon('qwen/qwen3-coder-30b')).toBe('');
    expect(getModelPromptAddon(undefined)).toBe('');
  });
});
