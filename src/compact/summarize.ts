// /compact — Phase WF6.
//
// Summarises the current conversation via an LLM call, appends the
// summary to MEMORY.md's "Recent work" section, and returns a compact
// handle the dashboard uses to reset chat.history and seed the next
// session. Also called by ExitPlanMode's "handoff" path to transfer
// the drafted plan into a fresh session.

import { streamLLM, type LLMMessage } from '../llm.js';
import { redactSecretText, redactSecrets } from '../debug/secret-redaction.js';

const COMPACT_SYSTEM_PROMPT = `
You are performing a CONTEXT CHECKPOINT COMPACTION for another agent
that will resume this work.

First, think in a private <analysis>...</analysis> scratchpad about
the transcript's true goal, constraints, discoveries, and unfinished
work. Then emit only the final compact summary. Do not mention the
scratchpad.

Write the final summary in plain text with exactly these sections:

## Goal
- what the user asked for, including scope changes or constraints

## Instructions
- explicit user preferences, approvals, prohibitions, or process rules

## Discoveries
- facts learned from reading code, docs, tool output, or debugging

## Accomplished
- concrete work already completed, including files edited or decisions made

## In progress / next steps
- the work underway when the transcript ends, and the very next concrete step

## Commitments
- promises still open: what · to whom (the user, a seat, a PR) · by when — scheduled wakeups, reports owed,
  replies promised. Write "- none" when there are none.

## Relevant files / directories
- short path-oriented list with why each matters

Rules:
- Be concise and resume-oriented.
- No preamble, no markdown code fences, no meta commentary.
- Preserve important exact strings only when they matter for continuing.
`.trim();

export interface CompactOptions {
  /** How many trailing turns to keep after summarisation (besides the
   *  system messages which are always preserved). 0 = no raw turns
   *  kept, only the summary. Default 2 so the last user + assistant
   *  pair remains in-context for continuity. */
  preserveLastN?: number;
  /** Override the summariser's target model. When omitted, the same
   *  provider the chat loop is using picks up. */
  model?: string;
  /** Maximum seconds to wait for the summary — on timeout we return
   *  null and callers decide whether to abort /compact or proceed
   *  with an empty summary. Default 45s. */
  timeoutMs?: number;
}

export interface CompactResult {
  summary: string;
  /** How many source turns were folded in. */
  sourceTurns: number;
}

export interface CompactPartialOptions extends CompactOptions {
  /** Inclusive history index through which messages are compacted. */
  upToIndex: number;
}

export function getCompactSystemPrompt(): string {
  return COMPACT_SYSTEM_PROMPT;
}

/**
 * OP-LONG-SESSION-COMPACT (O4) — longest rendering of one tool call's arguments in the transcript. A promise often lives
 * only in a call (ScheduleWakeup reason · `eln msg post …`); dropping calls dropped it from the summary.
 * Source: one wakeup reason or one msg post command fits; tool results stay out (they are the bloat).
 */
export const COMPACT_TOOL_CALL_ARGS_MAX = 200;

function renderToolCall(block: { name?: unknown; input?: unknown }): string {
  let args = '';
  // JUD #38613 ⓒ-2: redact the STRUCTURE first — after JSON.stringify a newline is the two characters `\n`, so a secret
  // at the start of the second line of a multi-line command (`\nSERVICE_TOKEN=…` · `\nsk-…`) was no longer at a word
  // boundary and slipped past the text rules.
  try { args = JSON.stringify(redactSecrets(block.input ?? {})) ?? ''; } catch { args = ''; }
  // JUD #38613 ⓒ: tool arguments carry tokens (a Bash `curl -H "Authorization: Bearer …"`, `GH_TOKEN=…`, a URL with
  // user:password@) and the summary is written to disk (plan-mode handoff → MEMORY.md). Redact BEFORE the cut, so a
  // secret split by the cap is not left half-visible.
  args = redactSecretText(args).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@:"]+:[^\s\/@"]+@/gi, '$1***@');
  if (args.length > COMPACT_TOOL_CALL_ARGS_MAX) args = `${args.slice(0, COMPACT_TOOL_CALL_ARGS_MAX)}…`;
  return `[tool ${String(block.name ?? '?')}] ${args}`;
}

export function buildCompactTranscript(
  history: readonly LLMMessage[],
): string {
  return history
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content as any[])
          .filter((b) => b?.type === 'text' || b?.type === 'tool_use')
          .map((b) => (b?.type === 'tool_use' ? renderToolCall(b) : (b as any).text))
          .join('\n');
      return `${m.role.toUpperCase()}: ${content}`;
    })
    .join('\n\n');
}

export function stripCompactScratchpad(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>\s*/gi, '').trim();
}

function nonSystemCount(history: readonly LLMMessage[]): number {
  return history.filter((m) => m.role !== 'system').length;
}

async function compactHistorySlice(
  history: readonly LLMMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const sourceTurns = nonSystemCount(history);
  if (sourceTurns === 0) {
    return { summary: '', sourceTurns: 0 };
  }

  const textTurns = buildCompactTranscript(history);
  const req: LLMMessage[] = [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
    { role: 'user', content: `Transcript to summarise:\n\n${textTurns}` },
  ];

  let text = '';
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  try {
    text = await streamLLM(req, () => { /* no live echo */ }, {
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (err) {
    throw new Error(`compact summarise failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Date.now() > deadline) {
    throw new Error('compact summarise timed out');
  }

  return { summary: stripCompactScratchpad(text), sourceTurns };
}

export async function compactConversation(
  history: readonly LLMMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  return compactHistorySlice(history, opts);
}

export async function compactConversationPartial(
  history: readonly LLMMessage[],
  opts: CompactPartialOptions,
): Promise<CompactResult> {
  if (opts.upToIndex < 0) {
    return { summary: '', sourceTurns: 0 };
  }
  return compactHistorySlice(history.slice(0, opts.upToIndex + 1), opts);
}
