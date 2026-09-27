// ── Control tool runtimes ──

import {
  buildControlTools,
  dispatchControlToolToggle,
  dispatchControlPromptAppend,
  dispatchControlPromptClear,
} from '../skills/tools/control.js';
import type { ToolRuntime } from './types.js';

function asRuntime<Req extends Record<string, unknown>>(
  id: string,
  name: string,
  fn: (req: Req) => Promise<unknown>,
): ToolRuntime<Req, any> {
  const spec = buildControlTools().find(tool => tool.name === name);
  if (!spec) throw new Error(`missing control tool spec: ${name}`);
  return {
    id,
    spec,
    async run(req) {
      return fn(req) as Promise<any>;
    },
  };
}

export const controlToolToggleRuntime   = asRuntime('control_tool_toggle',   'ControlToolToggle',   dispatchControlToolToggle);
export const controlPromptAppendRuntime = asRuntime('control_prompt_append', 'ControlPromptAppend', dispatchControlPromptAppend);
export const controlPromptClearRuntime  = asRuntime('control_prompt_clear',  'ControlPromptClear',  dispatchControlPromptClear);

export const ALL_CONTROL_RUNTIMES: ToolRuntime<any, any>[] = [
  controlToolToggleRuntime,
  controlPromptAppendRuntime,
  controlPromptClearRuntime,
];
