import type { LLMToolSpec } from '../../llm.js';
import type { SidetabRow } from './list.js';

export const NEXT_SIDETAB_TOOL_NAME = 'NextSidetab';
const CALL = 'elanous.sidetab.call';
const RESULT = 'elanous.sidetab.result';

export type NextSidetabAction = 'list' | 'switch' | 'attach' | 'detach' | 'new' | 'kill';
export interface NextSidetabRequest {
  action: NextSidetabAction;
  target?: string;
  character?: 'shell' | 'elanous';
  confirm?: boolean;
}
export interface NextSidetabCall { type: typeof CALL; callId: string; request: NextSidetabRequest }
export interface NextSidetabResult { type: typeof RESULT; callId: string; result: unknown }
export type NextSidetabHandler = (request: NextSidetabRequest) => Promise<unknown>;
export interface NextSidetabHostDeps {
  rows(): readonly SidetabRow[] | Promise<readonly SidetabRow[]>;
  selected(): number;
  switchSession(row: SidetabRow): Promise<unknown>;
  attach(row: SidetabRow): Promise<unknown>;
  detach(): unknown;
  spawn(character: 'shell' | 'elanous'): unknown;
  kill(row: SidetabRow): unknown;
}
export interface NextSidetabIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export const nextSidetabToolSpec: LLMToolSpec = {
  name: NEXT_SIDETAB_TOOL_NAME,
  description: 'Control the Next TUI side tab: list/view sessions and PTYs, switch sessions, attach or detach, start a local shell or elanous PTY, or kill a PTY. Ask the user to confirm before calling kill with confirm=true. Starting coding agents is not supported.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'attach', 'detach', 'new', 'kill'] },
      target: { type: 'string', description: 'Optional exact or partial row id/label; required for targeted actions.' },
      character: { type: 'string', enum: ['shell', 'elanous'], description: 'Only used with action=new.' },
      confirm: { type: 'boolean', description: 'Must be true only after the user explicitly confirmed killing the selected PTY.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export function isNextSidetabCall(value: unknown): value is NextSidetabCall {
  const call = value as Partial<NextSidetabCall> | null;
  return Boolean(call && call.type === CALL && typeof call.callId === 'string'
    && call.request && typeof call.request === 'object');
}

export async function answerNextSidetabCall(handler: NextSidetabHandler, call: NextSidetabCall): Promise<NextSidetabResult> {
  try { return { type: RESULT, callId: call.callId, result: await handler(call.request) }; }
  catch (error) {
    return { type: RESULT, callId: call.callId, result: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export function createNextSidetabHostHandler(deps: NextSidetabHostDeps): NextSidetabHandler {
  return async (request) => {
    if (!request || !['list', 'switch', 'attach', 'detach', 'new', 'kill'].includes(request.action)) {
      return { error: '지원하지 않는 사이드탭 동작입니다' };
    }
    if (request.action === 'new') {
      if (request.character !== 'shell' && request.character !== 'elanous') return { error: 'character는 shell 또는 elanous여야 합니다' };
      return deps.spawn(request.character);
    }
    if (request.action === 'detach') return deps.detach();
    const rows = await deps.rows();
    if (request.action === 'list') return rows.map(({ id, label, kind, badge, sessionId }) => ({ id, label, kind, badge, ...(sessionId ? { sessionId } : {}) }));
    const target = request.target?.trim();
    const exact = target ? rows.find((item) => item.id === target)
      ?? rows.find((item) => item.label.toLowerCase() === target.toLowerCase()) : undefined;
    const partial = target && !exact ? rows.filter((item) => item.label.toLowerCase().includes(target.toLowerCase())) : [];
    if (partial.length > 1) return { error: `사이드탭 항목이 여러 개 일치합니다: ${target}` };
    const row = exact ?? partial[0] ?? (target ? undefined : rows[deps.selected()]);
    if (!row) return { error: target ? `사이드탭 항목을 찾지 못했습니다: ${target}` : '선택된 사이드탭 항목이 없습니다' };
    if (request.action === 'switch') return row.kind === 'tui' ? deps.switchSession(row) : { error: 'Next TUI 세션만 전환할 수 있습니다' };
    if (request.action === 'attach') return deps.attach(row);
    if (row.currentProcess) return { error: '현재 TUI 세션은 사이드탭에서 종료할 수 없습니다' };
    if (request.confirm !== true) return { needsConfirmation: true, message: `PTY 종료 확인 필요: ${row.label}` };
    return deps.kill(row);
  };
}

export function createReplNextSidetabTool(
  proc: NextSidetabIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): { spec: LLMToolSpec; dispatch: (args: Record<string, unknown>) => Promise<unknown> } | null {
  if (env.ELANOUS_NEXT_TUI_SIDETAB_IPC !== '1' || typeof proc.send !== 'function') return null;
  const send = proc.send.bind(proc);
  const waiting = new Map<string, (result: unknown) => void>();
  let sequence = 0;
  const listener = (message: unknown): void => {
    const result = message as Partial<NextSidetabResult> | null;
    if (!result || result.type !== RESULT || typeof result.callId !== 'string') return;
    const resolve = waiting.get(result.callId);
    if (!resolve) return;
    waiting.delete(result.callId);
    resolve(result.result);
  };
  proc.on('message', listener);
  return {
    spec: nextSidetabToolSpec,
    dispatch: (args) => new Promise((resolve) => {
      const callId = `s${++sequence}`;
      const timer = setTimeout(() => {
        if (!waiting.delete(callId)) return;
        resolve({ error: 'Next TUI did not answer the side-tab request' });
      }, timeoutMs);
      waiting.set(callId, (result) => { clearTimeout(timer); resolve(result); });
      try {
        send({ type: CALL, callId, request: args as unknown as NextSidetabRequest } satisfies NextSidetabCall);
      } catch (error) {
        waiting.delete(callId);
        clearTimeout(timer);
        resolve({ error: `Next TUI IPC send failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }),
  };
}

export function registerNextSidetabReplTool(
  specs: LLMToolSpec[],
  dispatchByName: Map<string, (args: Record<string, unknown>) => Promise<unknown>>,
  proc: NextSidetabIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const tool = createReplNextSidetabTool(proc, env);
  if (!tool) return;
  specs.push(tool.spec);
  dispatchByName.set(tool.spec.name, tool.dispatch);
}
