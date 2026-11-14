import { spawn } from 'node:child_process';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityContract,
  type GraphCapabilityProvider,
  type GraphCapabilityRegistry,
} from '../capabilities.js';

const MAX_TASK_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const ASIDE_EXEC_CONTRACT: GraphCapabilityContract = Object.freeze({
  id: 'aside.exec@1',
  input: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, timeoutMs: { type: 'number' } } },
  output: {
    type: 'object', required: ['sessionId', 'outcome', 'answer', 'links'],
    properties: {
      sessionId: { type: 'string' }, outcome: { type: 'string' }, answer: { type: 'string' },
      links: { type: 'array', items: { type: 'string' } },
    },
  },
});

export interface AsideExecResult {
  readonly sessionId: string;
  readonly outcome: string;
  readonly answer: string;
  readonly links: readonly string[];
}

function parseResult(raw: string): AsideExecResult | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || !item.sessionId.trim() || item.sessionId.length > 256) return undefined;
  if (item.outcome !== 'success' || typeof item.answer !== 'string' || item.answer.length > MAX_OUTPUT_BYTES) return undefined;
  if (!Array.isArray(item.links) || item.links.length > 100 || item.links.some((link) => typeof link !== 'string' || !/^https?:\/\//.test(link) || link.length > 2_048)) return undefined;
  return { sessionId: item.sessionId, outcome: item.outcome, answer: item.answer, links: item.links as string[] };
}

function execute(task: string, timeoutMs: number, signal?: AbortSignal): Promise<AsideExecResult | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return; }
    const child = spawn('aside', ['exec', '--json', task], {
      stdio: ['ignore', 'pipe', 'ignore'], shell: false, detached: true, windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: AsideExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      child.stdout?.destroy();
      child.unref();
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      finish();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop(); return; }
      chunks.push(chunk);
    });
    child.on('error', () => { if (!stopped) finish(); });
    child.on('close', (code) => { if (!stopped) finish(code === 0 ? parseResult(Buffer.concat(chunks).toString('utf8')) : undefined); });
    timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

/** Aside is invoked only when a graph explicitly requests this contract. */
export function createAsideCapabilityProvider(options: { platform?: NodeJS.Platform } = {}): GraphCapabilityProvider {
  return async (context) => {
    if (process.platform === 'win32' || options.platform === 'win32') return { ok: false, outcome: 'failed', error: 'Windows 미지원 · 0.3.18' };
    const input = context.nodeInput !== undefined ? context.nodeInput : context.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    const request = input as Record<string, unknown>;
    if (typeof request.task !== 'string' || !request.task.trim() || request.task.length > MAX_TASK_LENGTH) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > MAX_TIMEOUT_MS)) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    const result = await execute(request.task, (request.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS, context.signal);
    if (!result) return { ok: false, outcome: 'failed', error: 'Aside 연결 필요' };
    return { ok: true, outcome: 'done', result, evidence: { sessionId: result.sessionId } };
  };
}

export function createAsideCapabilityRegistry(): GraphCapabilityRegistry {
  const registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), ASIDE_EXEC_CONTRACT);
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'aside-bridge', provides: [ASIDE_EXEC_CONTRACT.id], tier: 'free', invoke: createAsideCapabilityProvider(),
  });
}
