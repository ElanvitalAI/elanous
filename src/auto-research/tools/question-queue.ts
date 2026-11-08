import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P2: QuestionQueue LLM tool ──
//
// CRUD over <goal>/question-queue.md with the three-marker
// convention used by auto-research (A3 appendix):
//   - [ ] unanswered
//   - [x] answered
//   - [!] blocked
//
// Non-checkbox lines are preserved verbatim so the operator can add
// section headers / comments between questions. Index values returned
// by `list` are stable zero-based counters over checkbox lines only;
// non-checkbox lines do not consume index slots.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import {
  discoverObsidianVault,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import { resolveGoalPaths } from '../goal-paths.js';

export type QueueMark = 'unanswered' | 'answered' | 'blocked';

export type QuestionQueueAction = 'list' | 'add' | 'answer' | 'block' | 'reopen' | 'remove';

export interface QuestionQueueInput {
  action: QuestionQueueAction;
  goal_slug: string;
  text?: string;       // add
  index?: number;      // answer/block/reopen/remove
  filter?: QueueMark;  // list
}

export interface QueueEntry {
  index: number;
  mark: QueueMark;
  text: string;
}

// NB: declared as a `type` alias, not an `interface`. The
// ToolRuntime<Req, Out> contract constrains `Out extends ToolRunResult`
// where `ToolRunResult = { output: string } | Record<string, unknown>`.
// TS interfaces are "open" (declaration-mergeable) so they lack an
// implicit index signature and are NOT assignable to
// `Record<string, unknown>`; a closed object-literal `type` alias is.
export type QuestionQueueResult = {
  goal_slug: string;
  entries?: QueueEntry[];
  pending_count: number;
  answered_count: number;
  blocked_count: number;
  notices?: string[];
};

export interface QuestionQueueDispatchOpts {
  vault?: ObsidianVault;
}

export async function dispatchQuestionQueue(
  input: QuestionQueueInput,
  opts: QuestionQueueDispatchOpts = {},
): Promise<QuestionQueueResult> {
  if (!input.goal_slug) throw new Error('QuestionQueue: goal_slug is required');
  const vault = opts.vault ?? discoverObsidianVault();
  const paths = resolveGoalPaths(vault, input.goal_slug);
  const queuePath = paths.queue;

  ensureQueueFile(queuePath);

  const raw = readFileSync(queuePath, 'utf-8');
  const lines = raw.length === 0 ? [] : raw.split('\n');
  const state = buildState(lines);

  const notices: string[] = [];

  switch (input.action) {
    case 'list': {
      const filter = input.filter;
      const entries = filter ? state.entries.filter(e => e.mark === filter) : state.entries;
      return summarise(input.goal_slug, state, entries, notices);
    }
    case 'add': {
      const text = (input.text ?? '').trim();
      if (!text) throw new Error('QuestionQueue add: text is required');
      lines.push(`- [ ] ${text}`);
      writeQueue(queuePath, lines);
      const next = buildState(lines);
      notices.push(`added at index ${next.entries.length - 1}`);
      return summarise(input.goal_slug, next, next.entries, notices);
    }
    case 'answer':
    case 'block':
    case 'reopen': {
      const mark: QueueMark = input.action === 'answer' ? 'answered'
        : input.action === 'block' ? 'blocked'
        : 'unanswered';
      const lineIndex = resolveLineIndex(input, state);
      lines[lineIndex] = rewriteMarker(lines[lineIndex]!, mark);
      writeQueue(queuePath, lines);
      notices.push(`entry[${input.index}] → ${mark}`);
      const next = buildState(lines);
      return summarise(input.goal_slug, next, next.entries, notices);
    }
    case 'remove': {
      const lineIndex = resolveLineIndex(input, state);
      lines.splice(lineIndex, 1);
      writeQueue(queuePath, lines);
      notices.push(`entry[${input.index}] removed`);
      const next = buildState(lines);
      return summarise(input.goal_slug, next, next.entries, notices);
    }
  }
  throw new Error(`QuestionQueue: unknown action '${input.action}'`);
}

// ── Implementation ─────────────────────────────────────────────────────

interface ParsedQueue {
  entries: QueueEntry[];
  entryLineMap: number[];   // entries[i] lives on lines[entryLineMap[i]]
}

function buildState(lines: string[]): ParsedQueue {
  const entries: QueueEntry[] = [];
  const entryLineMap: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*-\s*\[([ xX!])\]\s+(.*)$/);
    if (!m) continue;
    const markChar = m[1]!.toLowerCase();
    const mark: QueueMark = markChar === 'x' ? 'answered'
      : markChar === '!' ? 'blocked'
      : 'unanswered';
    entries.push({
      index: entries.length,
      mark,
      text: m[2]!.trim(),
    });
    entryLineMap.push(i);
  }
  return { entries, entryLineMap };
}

function resolveLineIndex(input: QuestionQueueInput, state: ParsedQueue): number {
  if (typeof input.index !== 'number' || !Number.isInteger(input.index)) {
    throw new Error(`QuestionQueue ${input.action}: index (integer) is required`);
  }
  if (input.index < 0 || input.index >= state.entries.length) {
    throw new Error(`QuestionQueue ${input.action}: index ${input.index} out of range (${state.entries.length} entries)`);
  }
  return state.entryLineMap[input.index]!;
}

function rewriteMarker(line: string, mark: QueueMark): string {
  const char = mark === 'answered' ? 'x' : mark === 'blocked' ? '!' : ' ';
  return line.replace(/^(\s*-\s*\[)[ xX!](\])/, `$1${char}$2`);
}

function writeQueue(path: string, lines: string[]): void {
  // Preserve trailing newline when file ends with one.
  const body = lines.join('\n');
  const out = body.endsWith('\n') ? body : body + '\n';
  writeFileSync(path, out, 'utf-8');
}

function ensureQueueFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', 'utf-8');
  }
}

function summarise(
  slug: string,
  state: ParsedQueue,
  filtered: QueueEntry[],
  notices: string[],
): QuestionQueueResult {
  const pending = state.entries.filter(e => e.mark === 'unanswered').length;
  const answered = state.entries.filter(e => e.mark === 'answered').length;
  const blocked = state.entries.filter(e => e.mark === 'blocked').length;
  const out: QuestionQueueResult = {
    goal_slug: slug,
    entries: filtered,
    pending_count: pending,
    answered_count: answered,
    blocked_count: blocked,
  };
  if (notices.length > 0) out.notices = notices;
  return out;
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildQuestionQueueTool(): LLMToolSpec {
  return {
    name: 'QuestionQueue',
    description:
      'Maintain the open-question queue for a research goal. The queue lives at <goal>/question-queue.md as a '
      + 'markdown checkbox list with three markers: [ ] unanswered, [x] answered, [!] blocked. Use `add` to '
      + 'append a new question, `list` (optionally with filter) to inspect state, and answer/block/reopen/remove '
      + 'to update an entry by its zero-based index.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'answer', 'block', 'reopen', 'remove'],
        },
        goal_slug: { type: 'string', description: 'Goal directory slug.' },
        text: { type: 'string', description: 'Question text (add).' },
        index: { type: 'integer', description: 'Zero-based index of checkbox entry (answer/block/reopen/remove).' },
        filter: {
          type: 'string',
          enum: ['unanswered', 'answered', 'blocked'],
          description: 'Optional filter for list.',
        },
      },
      required: ['action', 'goal_slug'],
      additionalProperties: false,
    },
  };
}
