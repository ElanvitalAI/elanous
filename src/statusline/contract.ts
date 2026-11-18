// STATUSLINE-CONTRACT-V1 slice 1: the statusline.yaml contract as a JSON Schema (editors validate while typing), and
// the checks behind `eln statusline validate` / `preview`. The loader (load.ts) stays the authority: the schema only
// describes the same shape, and a test keeps the two in step.
import { readFileSync } from 'node:fs';
import { STATUSLINE_CONTRACT_VERSION, type StatuslineLoadIssue } from './load.js';
import { createNextTuiStatusline, judgeNextTuiStatusline, statuslineUserPath, type StatuslineBuild } from './next-tui.js';
import type { NextTuiStatusLineInput } from '../tui/chat/status-line.js';

const ID = { type: 'string', minLength: 1 } as const;
const IDS = { type: 'array', items: ID } as const;

/** JSON Schema (2020-12) of statusline.yaml, contract version 1. */
export const STATUSLINE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://elanous.ai/schema/statusline-1.json',
  title: 'Elanous status line',
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { const: STATUSLINE_CONTRACT_VERSION },
    $schema: { type: 'string' },
    position: { enum: ['bottom', 'above-input'] },
    bands: { type: 'object', additionalProperties: false,
      properties: { xs: { type: 'integer', minimum: 1 }, sm: { type: 'integer', minimum: 1 }, md: { type: 'integer', minimum: 1 } } },
    segments: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'source', 'field'],
      properties: {
        id: ID,
        source: { enum: ['session', 'provider', 'machines', 'seats', 'loops', 'git', 'alerts', 'build'] },
        field: ID,
        label: { type: 'string' },
        format: { enum: ['text', 'count', 'ratio', 'dot'] },
        when: ID,
      },
    } },
    rules: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'when'],
      properties: { id: ID, when: ID, color: ID, glyph: ID, hide: { type: 'boolean' }, segments: IDS,
        bands: { type: 'array', items: { enum: ['xs', 'sm', 'md', 'lg'] } } },
    } },
    layouts: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['band', 'lines', 'segments'],
      properties: {
        band: { enum: ['xs', 'sm', 'md', 'lg'] },
        lines: { enum: [1, 2] },
        segments: IDS, secondLine: IDS, drop: IDS,
        shorten: { type: 'object', additionalProperties: ID },
      },
    } },
  },
} as const;

/**
 * Issues for a file, judged exactly as the Next TUI judges it (judgeNextTuiStatusline: parse → merge over the default
 * → no two-line layout); empty only when the TUI would draw with it. A missing file is an issue (asked for by name).
 */
export function validateStatuslineFile(path: string, readText: (path: string) => string = (file) => readFileSync(file, 'utf8')): readonly StatuslineLoadIssue[] {
  let text: string;
  try { text = readText(path); } catch (error) {
    return [{ path: '', message: `cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` }];
  }
  const verdict = judgeNextTuiStatusline(text);
  return verdict.ok ? [] : verdict.issues;
}

export function formatStatuslineIssue(file: string, issue: StatuslineLoadIssue): string {
  // No line = the location is not known in this file (never a guessed «:1»).
  return `${file}${issue.line ? `:${issue.line}` : ' (location unknown)'}: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`;
}

// 출처: STATUSLINE-CONTRACT-V1 cell — the preview widths 40 (xs) · 80 (sm) · 140 (md) · 200 (lg).
export const STATUSLINE_PREVIEW_WIDTHS = [40, 80, 140, 200] as const;

/** A busy turn, so every band has something to fold: a running turn, a queue, a background task. */
const SAMPLE: Omit<NextTuiStatusLineInput, 'width'> = { turnState: 'running', model: 'gpt-sim', queued: 2, steering: 1, backgroundTasks: 1, elapsedMs: 95_000 };

/** The footer line at each width, drawn with the file (over the default) the way the Next TUI draws it. */
export function previewStatusline(options: {
  readonly path?: string; readonly widths?: readonly number[]; readonly build: StatuslineBuild; readonly cwd?: string;
}): { readonly warning?: string; readonly lines: readonly { readonly width: number; readonly line: string }[] } {
  const footer = createNextTuiStatusline({ build: options.build, cwd: () => options.cwd ?? process.cwd(), color: false,
    userPath: options.path ?? statuslineUserPath() });
  return {
    ...(footer.warning ? { warning: footer.warning } : {}),
    lines: (options.widths ?? STATUSLINE_PREVIEW_WIDTHS).map((width) => ({ width, line: footer.render({ ...SAMPLE, width } as NextTuiStatusLineInput).plain })),
  };
}
