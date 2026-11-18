import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry,
} from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';

const CONTRACT = 'bookforge.app-docs-pdf@1' as const;

export function createBookforgeAppDocsRegistry(pluginRoot: string): GraphCapabilityRegistry {
  if (!isAbsolute(pluginRoot)) throw new Error('bookforge plugin root must be absolute');
  const registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: CONTRACT,
    input: { type: 'object' },
    output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'bookforge-app-docs', provides: [CONTRACT], tier: 'free',
    invoke: context => runBookforgeAppDocs(pluginRoot, context),
  });
}

type RenderRun = { status: number | null; stdout: string; stderr: string; error?: Error; aborted: boolean };

/** Kill the isolated renderer process group so its Typst descendants cannot outlive graph cancellation. */
export async function runBoundedBookforgeProcess(command: string, args: string[], signal?: AbortSignal,
  timeoutMs = 10 * 60_000): Promise<RenderRun> {
  if (signal?.aborted) return { status: null, stdout: '', stderr: '', aborted: true,
    error: new Error('Bookforge render canceled before start') };
  const deadline = AbortSignal.timeout(timeoutMs);
  const bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (bound.aborted) return { status: null, stdout: '', stderr: '', aborted: true,
    error: new Error('Bookforge render deadline expired before start') };
  return await new Promise(resolveRun => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let size = 0; let failure: Error | undefined;
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const stop = (error: Error) => { failure ??= error; killGroup(); };
    const onAbort = () => stop(new Error(deadline.aborted ? 'Bookforge render deadline expired' : 'Bookforge render canceled'));
    bound.addEventListener('abort', onAbort, { once: true });
    if (bound.aborted) onAbort();
    const capture = (part: Buffer, stream: 'stdout' | 'stderr') => {
      size += part.byteLength;
      if (size > 128 * 1024) { stop(new Error('Bookforge renderer output exceeded 128 KiB')); return; }
      if (stream === 'stdout') stdout += part.toString('utf8');
      else stderr += part.toString('utf8');
    };
    child.stdout.on('data', (part: Buffer) => capture(part, 'stdout'));
    child.stderr.on('data', (part: Buffer) => capture(part, 'stderr'));
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      bound.removeEventListener('abort', onAbort);
      resolveRun({ status: failure || bound.aborted ? null : code, stdout, stderr,
        aborted: bound.aborted, ...(failure ? { error: failure } : {}) });
    });
  });
}

async function runBookforgeAppDocs(pluginRoot: string, context: InProcessHandlerContext): Promise<InProcessHandlerResult> {
  const input = context.graphInput;
  if (context.requires !== CONTRACT || !input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, outcome: 'failed', error: 'Bookforge graph input missing' };
  const { designPath, outDir, title } = input as Record<string, unknown>;
  if (typeof designPath !== 'string' || !isAbsolute(designPath)
    || typeof outDir !== 'string' || !isAbsolute(outDir)
    || typeof title !== 'string' || !title.trim())
    return { ok: false, outcome: 'failed', error: 'Bookforge requires absolute designPath, outDir and title' };
  const renderScript = resolve(import.meta.dir, '../../../skills/bookforge/render_app_docs.py');
  const run = await runBoundedBookforgeProcess('python3', [renderScript, '--design', designPath,
    '--out', outDir, '--title', title], context.signal);
  if (run.error || run.aborted) return { ok: false, outcome: 'failed',
    error: run.error?.message ?? 'Bookforge render canceled', evidence: { exit: run.status, aborted: run.aborted } };
  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(run.stdout.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid result');
    result = parsed as Record<string, unknown>;
  } catch { return { ok: false, outcome: 'failed', error: 'Bookforge renderer returned no result',
    evidence: { exit: run.status } }; }
  if (run.status !== 0 || result.ok !== true || typeof result.pdfPath !== 'string')
    return { ok: false, outcome: 'failed', error: String(result.error ?? 'Bookforge render failed'),
      evidence: { ...result, exit: run.status } };
  return { ok: true, outcome: 'done', result: { pdfPath: result.pdfPath, sourceSha256: result.sourceSha256,
    visualReviewRequired: true }, evidence: { projectPath: result.projectPath, sourceSha256: result.sourceSha256,
      exit: run.status } };
}
