import type { LLMToolSpec } from '../llm/tool-spec.js';

import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import { stripScreenAnsi } from '../harness/harness-screen.js';
import { dispatchToolByName } from './registry.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';
import { areAsideRemoteTargetsConfigured, getAsideRemoteRouter } from '../aside/remote-targets.js';

const SELECTION_MARKER = 'ELANOUS_CURRENT_SELECTION:';
const MAX_SELECTION_LENGTH = 10_000;

export interface AsideSelection {
  text: string;
  url: string;
}

export interface AsideSelectionResult extends Record<string, unknown> {
  output: string;
  selection: AsideSelection;
}

export type AsideToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolRuntimeContext,
) => Promise<unknown>;

export interface AsideSelectionArguments {
  target_id?: string;
  context?: string;
}

export const ASIDE_SELECTION_TOOL_SPEC: LLMToolSpec = {
  name: 'elanous_aside_selection',
  description: 'Read the text the person currently selected in the connected Aside browser and return it into this TUI turn with its source URL. Use when the person says “이것도 메모에” or asks to include the selected browser passage. Read-only; does not write a note.',
  parameters: { type: 'object', properties: { target_id: { type: 'string', description: 'Optional registered Aside target id.' }, context: { type: 'string', description: 'Optional target selection context.' } }, additionalProperties: false },
};

function outputText(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { output?: unknown }).output === 'string') {
    return (value as { output: string }).output;
  }
  if (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) {
    return (value as { content: unknown[] }).content
      .map(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text : '')
      .filter(Boolean).join('\n');
  }
  return '';
}

export function parseAsideSelectionOutput(output: string): AsideSelection {
  const cleanOutput = stripScreenAnsi(output);
  const markerAt = cleanOutput.indexOf(SELECTION_MARKER);
  if (markerAt < 0) throw new Error('Aside did not return a selected passage');
  const json = cleanOutput.slice(markerAt + SELECTION_MARKER.length).split(/\r?\n/, 1)[0]?.trim() ?? '';
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('Aside returned an invalid selection payload'); }
  if (!value || typeof value !== 'object' ||
      typeof (value as { text?: unknown }).text !== 'string' ||
      typeof (value as { url?: unknown }).url !== 'string') {
    throw new Error('Aside returned an invalid selection payload');
  }
  const selection = value as AsideSelection;
  if (!selection.text.trim()) throw new Error('Aside has no selected text');
  if (selection.text.length > MAX_SELECTION_LENGTH) throw new Error('Aside selection is too long');
  let url: URL;
  try { url = new URL(selection.url); } catch { throw new Error('Aside selection source URL is invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Aside selection source URL is invalid');
  return { text: selection.text, url: url.toString() };
}

export function createAsideSelectionRuntime(
  dispatch: AsideToolDispatcher = dispatchToolByName,
): ToolRuntime<AsideSelectionArguments, AsideSelectionResult> {
  return {
    id: 'elanous_aside_selection',
    spec: ASIDE_SELECTION_TOOL_SPEC,
    surfaces: ['tui'],
    async run(args: AsideSelectionArguments, ctx) {
      const callArgs = {
        title: 'Return the current page selection to the TUI turn',
        code: `await (async () => { const text = window.getSelection()?.toString() ?? ''; const url = location.href; console.log('${SELECTION_MARKER}' + JSON.stringify({ text, url })); })();`,
      };
      const remote = getAsideRemoteRouter();
      if (areAsideRemoteTargetsConfigured() && !remote) throw new Error('Aside targets are initializing');
      const result = remote
        ? await remote.call('aside.repl', callArgs, { ...(args.target_id ? { targetId: args.target_id } : {}), ...(args.context ? { context: args.context } : {}), capability: 'selection' })
        : await dispatch('aside.repl', callArgs, ctx);
      if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
        throw new Error('Aside could not read the selected passage');
      }
      const selection = parseAsideSelectionOutput(outputText(result));
      try {
        debug.log('aside.selection', 'returned', {
          selectedTextLength: selection.text.length,
          sourceUrlSha256: createHash('sha256').update(selection.url).digest('hex'),
        });
      } catch { /* selection telemetry must not block the model-facing result */ }
      return {
        selection,
        output: `현재 TUI 요청에 사용할 브라우저 선택 문장입니다:\n> ${selection.text}\n출처: ${selection.url}`,
      };
    },
  };
}

export const asideSelectionRuntime = createAsideSelectionRuntime();
