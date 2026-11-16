import { createHash } from 'node:crypto';
import { debug } from '../../debug/log.js';
import { APP_BUILD_MAX_FILES, APP_BUILD_MAX_REPAIRS, parsePlanningStage } from './contracts.js';
import { checkArchitectureDocument } from './architecture-check.js';

type PlanFile = { path: string; purpose: string; role: string; dependsOn: string[] };
type Architecture = { markdown: string; sections: Record<string, string> };
type Assumption = { statement: string; source: 'user' | 'assumed' };
type File = { path: string; content: string; sha256: string };
type Receipt = { path: string; attempt: number; status: 'provided' | 'generated' | 'reused' | 'rejected'; sha256?: string; reason?: string };
type Resume = { planDigest: string; files: File[] };
type Input = {
  assumptions: Assumption[]; architecture: Architecture; plan: PlanFile[]; seedRequested: boolean;
  maxFiles?: number; maxRepairAttempts?: number;
  budget?: { maxContextBytes?: number; maxTotalBytes?: number };
  resume?: Resume; signal?: AbortSignal;
};
type Deps = { callLLM: (prompt: string, options: { signal?: AbortSignal }) => Promise<string> };
type Result = { ok: true; files: File[]; receipts: Receipt[]; resume: Resume; buildComplete: false }
  | { ok: false; code: string; file?: string; attempt: number; lastError: string; files: File[]; receipts: Receipt[]; resume?: Resume };
// Match A's planning transport cap and the generic artifact writer's transport cap.
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PARALLEL_FILES = 3;
const bytes = (value: string): number => Buffer.byteLength(value);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Reject representative non-source replies equally for generated and resumed files.
 * This lexical check is not a syntax, test or whole-language correctness proof. */
function validSourceContent(content: unknown): content is string {
  if (typeof content !== 'string' || !content.trim() || content.includes('\0')) return false;
  const visible = content.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/^[ \t]*(?:\/\/|#|--)[^\r\n]*$/gmu, '').trim();
  if (!visible) return false;
  // Instructions/prose are classified only without code tokens. Never reject a
  // Python/JS statement merely because identifiers or string literals say "done".
  if (/[=(){};]/u.test(visible) || /(?:^|\n)\s*(?:import|export|from|def|class|function|const|let|var|return)\b/u.test(visible)) return true;
  if (!visible.split(/\r?\n/u).every(line => !line.trim() || /^[\p{L}\p{N}\s'".,!?？…。:\-]+$/u.test(line))) return true;
  const prose = visible.replace(/\s+/gu, ' ').trim();
  return !/^(?:TODO|FIXME|TBD|\.\.\.)(?:\b|$)/iu.test(prose)
    && !/^(?:which|what|should|would|could|can|is|are|do|does|will|how|when|where|who|why)\s/iu.test(prose)
    && !/(?:까요|나요|습니까|할까)[?？.!。\s]*$/u.test(prose)
    && !/^(?:done|completed|complete|finished)[.!\s]*$/iu.test(prose)
    && !/^successfully\s+(?:created|completed|finished|implemented|written)\b/iu.test(prose)
    && !/^(?:I(?:'ve| have)?\s+(?:created|completed|finished|implemented|written)\b|(?:(?:the|your|requested)\s+)?(?:file|code|implementation|task|generation|deployment)\b.*\b(?:created|completed|complete|finished|done)\b)/iu.test(prose)
    && !/^(?:(?:요청하신|해당|모든|새)\s*)?(?:(?:파일|코드|구현|작업|생성|수정|배포|애플리케이션)[\s\S]*)?(?:완료했습니다|완료하였습니다|완료되었습니다|완료됐습니다|생성했습니다|작성했습니다|수정했습니다|끝났습니다)[.!。\s]*$/u.test(prose);
}

async function modelReply(deps: Deps, prompt: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled');
  let cancel: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([deps.callLLM(prompt, { signal }), aborted]);
  } finally { if (cancel) signal?.removeEventListener('abort', cancel); }
}

/** Pure generation only. Each explicit invocation permits at most n repairs per file;
 * resuming is a new bounded invocation that revalidates/reuses only a completed prefix.
 * Digests bind supplied bytes, not trusted provenance/owner/approval. Host code owns
 * deadlines, materialization, sandbox tests, issuer grants and publication. */
export async function generatePlannedFiles(input: Input, deps: Deps): Promise<Result> {
  const files: File[] = [];
  const receipts: Receipt[] = [];
  let planDigest: string | undefined;
  const fail = (code: string, file?: string, attempt = 0): Result => {
    debug.log('app-build.files', 'blocked', { code, path: file, attempt, completed: files.length, planDigest });
    return { ok: false, code, file, attempt, lastError: code, files, receipts,
      ...(planDigest ? { resume: { planDigest, files: files.map(file => ({ ...file })) } } : {}) };
  };
  if (!input || !deps || typeof deps.callLLM !== 'function' || typeof input.seedRequested !== 'boolean') return fail('INVALID_INPUT');
  const seedRequested = input.seedRequested;
  const signal = input.signal;
  const model = { callLLM: deps.callLLM.bind(deps) };
  const maxFiles = input.maxFiles ?? APP_BUILD_MAX_FILES;
  const repairs = input.maxRepairAttempts ?? APP_BUILD_MAX_REPAIRS;
  const maxContext = input.budget?.maxContextBytes ?? MAX_CONTEXT_BYTES;
  const maxBytes = input.budget?.maxTotalBytes ?? MAX_ARTIFACT_BYTES;
  if ([[maxFiles, APP_BUILD_MAX_FILES], [repairs, APP_BUILD_MAX_REPAIRS], [maxContext, MAX_CONTEXT_BYTES], [maxBytes, MAX_ARTIFACT_BYTES]]
    .some(([value, cap]) => !Number.isSafeInteger(value) || value! < 0 || value! > cap!) || !maxFiles || !maxContext || !maxBytes) return fail('INVALID_BUDGET');
  let assumptions: Assumption[];
  let architecture: Architecture;
  let plan: PlanFile[];
  try {
    const a = parsePlanningStage('assumptions', { assumptions: input.assumptions }) as { assumptions: Assumption[] };
    const d = parsePlanningStage('architecture', input.architecture) as Architecture;
    const p = parsePlanningStage('file-plan', { plan: input.plan }, { seedRequested }) as { plan: PlanFile[] };
    // Copy only contracted fields: mutable caller objects are never retained across awaits.
    assumptions = a.assumptions.map(item => ({ statement: item.statement, source: item.source }));
    architecture = { markdown: d.markdown, sections: { ...d.sections } };
    plan = p.plan.map(item => ({ path: item.path, purpose: item.purpose, role: item.role, dependsOn: [...item.dependsOn] }));
    if (plan.length > maxFiles || !checkArchitectureDocument({ ...architecture, files: plan.map(file => file.path) }).ok) return fail('INVALID_PLAN');
    const context = JSON.stringify({ assumptions, architecture, plan, seedRequested });
    if (bytes(context) > maxContext) return fail('CONTEXT_BUDGET');
    planDigest = digest(context);
  } catch { return fail('INVALID_PLAN'); }
  const emit = (receipt: Receipt): void => {
    receipts.push(receipt);
    debug.log('app-build.files', receipt.status, { ...receipt, planDigest, completed: files.length, total: plan.length });
  };
  let totalBytes = 0;
  const accept = (file: File): void => { files.push(file); totalBytes += bytes(file.path) + bytes(file.content); };
  if (input.resume) {
    const resume = input.resume;
    if (resume.planDigest !== planDigest || !Array.isArray(resume.files) || resume.files.length > plan.length) return fail('INVALID_RESUME');
    const checked: File[] = [];
    let size = 0;
    for (const [index, file] of resume.files.entries()) {
      if (!file || file.path !== plan[index]?.path || !validSourceContent(file.content) || file.sha256 !== digest(file.content)
        || (file.path === 'ARCHITECTURE.md' && file.content !== architecture.markdown)) return fail('INVALID_RESUME');
      size += bytes(file.path) + bytes(file.content);
      if (size > maxBytes) return fail('INVALID_RESUME');
      checked.push({ path: file.path, content: file.content, sha256: file.sha256 });
    }
    for (const file of checked) { accept(file); emit({ path: file.path, attempt: 0, status: 'reused', sha256: file.sha256 }); }
  }
  type Generated = { ok: true; file: File; receipts: Receipt[] }
    | { ok: false; code: string; path: string; attempt: number; receipts: Receipt[] };
  const completed = new Map(files.map(file => [file.path, file]));
  const pendingReceipts = new Map<string, Receipt[]>();
  const generate = async (item: PlanFile, taskSignal?: AbortSignal): Promise<Generated> => {
    const events: Receipt[] = [];
    const rejected = (code: string, attempt = 0): Generated => ({ ok: false, code, path: item.path, attempt, receipts: events });
    if (taskSignal?.aborted) return rejected('CANCELLED');
    // A's rendered architecture is provided, not regenerated by a model.
    if (item.path === 'ARCHITECTURE.md') return { ok: true,
      file: { path: item.path, content: architecture.markdown, sha256: digest(architecture.markdown) },
      receipts: [{ path: item.path, attempt: 0, status: 'provided', sha256: digest(architecture.markdown) }] };
    // Snapshot only completed declared dependencies. Other concurrent tasks cannot
    // supply unfinished source or mutate this prompt across awaits.
    const dependencies = plan.filter(file => item.dependsOn.includes(file.path)).map(file => completed.get(file.path)!);
    let lastError = '';
    for (let attempt = 1; attempt <= repairs + 1; attempt++) {
      if (taskSignal?.aborted) return rejected('CANCELLED', attempt - 1);
      const prompt = JSON.stringify({ instruction: 'Generate exactly this planned source file. Return only JSON {path,content}, no extra fields, questions, completion prose or placeholders. Do not execute anything.',
        file: item, assumptions, architecture, seedRequested, dependencies,
        ...(seedRequested ? { seedRuntimeContract: item.role === 'database'
          ? 'Export one DB_PATH constant from this database module. Resolve it under the trusted ELANOUS_APP_DATA_DIR when the host supplies that private writable directory, with an application-root fallback for local runs. The seed and startup backend must import this same constant; neither may define another default database path or rely on process cwd.'
          : item.role === 'seed'
          ? 'Export an idempotent initializer that inserts missing synthetic rows only and preserves user changes. Import DB_PATH from the database module and use its schema. Do not define a second path or rely on running this file as a standalone command.'
          : item.role === 'backend'
            ? 'If this is the declared runtime.startCommand entry, invoke the seed initializer during module or documented host startup before exporting a read handler. The host may import the exported fetch handler, so an import.meta.main-only seed is insufficient. Import DB_PATH from the database module and use the same connection configuration as the initializer; do not define a second default path.'
            : item.role === 'test'
              ? 'For the declared kind=seed test, execute the actual startup initialization path against a fresh database, assert the application list API returns at least one item, then restart or initialize again and assert no duplicates or overwritten user changes. Use an in-process handler when the sandbox cannot listen.'
              : undefined } : {}), previousError: lastError || undefined });
      if (bytes(prompt) > maxContext) return rejected('CONTEXT_BUDGET', attempt - 1);
      let text: string;
      try { text = await modelReply(model, prompt, taskSignal); }
      catch {
        if (taskSignal?.aborted) return rejected('CANCELLED', attempt);
        lastError = 'MODEL_CALL_FAILED'; emit({ path: item.path, attempt, status: 'rejected', reason: lastError }); continue;
      }
      if (taskSignal?.aborted) return rejected('CANCELLED', attempt);
      try {
        if (typeof text !== 'string' || bytes(text) > MAX_CONTEXT_BYTES) throw new Error('response');
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response');
        const file = value as Record<string, unknown>;
        if (Object.keys(file).sort().join(',') !== 'content,path' || file.path !== item.path
          || !validSourceContent(file.content)) throw new Error('response');
        if (bytes(item.path) + bytes(file.content) > maxBytes) return rejected('ARTIFACT_BUDGET', attempt);
        const generated = { path: item.path, content: file.content, sha256: digest(file.content) };
        events.push({ path: item.path, attempt, status: 'generated', sha256: generated.sha256 });
        return { ok: true, file: generated, receipts: events };
      } catch { lastError = 'FILE_OUTPUT_INVALID'; emit({ path: item.path, attempt, status: 'rejected', reason: lastError }); }
    }
    return rejected(lastError || 'REPAIR_EXHAUSTED', repairs + 1);
  };
  while (files.length < plan.length) {
    if (signal?.aborted) return fail('CANCELLED', plan[files.length]!.path);
    const ready = plan.filter(item => !completed.has(item.path) && item.dependsOn.every(path => completed.has(path))).slice(0, MAX_PARALLEL_FILES);
    if (!ready.length) return fail('INVALID_PLAN');
    const abort = new AbortController();
    const taskSignal = ready.length > 1 ? signal ? AbortSignal.any([signal, abort.signal]) : abort.signal : signal;
    const batch: { failure?: Extract<Generated, { ok: false }> } = {};
    const results = await Promise.all(ready.map(async item => {
      const result = await generate(item, taskSignal);
      // Cancel sibling waits before starting another wave; preserve the initiating
      // failure rather than replacing it with a sibling's cancellation outcome.
      if (!result.ok && !batch.failure) { batch.failure = result; abort.abort(); }
      return result;
    }));
    for (const result of results) {
      if (result.ok) {
        completed.set(result.file.path, result.file);
        pendingReceipts.set(result.file.path, result.receipts);
      } else for (const receipt of result.receipts) emit(receipt);
    }
    // Out-of-order successes may unblock dependencies, but only the original
    // contiguous plan prefix is checkpointed. The digest/resume schema is unchanged.
    while (files.length < plan.length) {
      const file = completed.get(plan[files.length]!.path); if (!file) break;
      if (totalBytes + bytes(file.path) + bytes(file.content) > maxBytes) return fail('ARTIFACT_BUDGET', file.path);
      accept(file);
      // Success is observable only after these bytes enter the trusted prefix.
      // Buffered siblings discarded on failure/budget overflow never emit success.
      for (const receipt of pendingReceipts.get(file.path) ?? []) emit(receipt);
      pendingReceipts.delete(file.path);
    }
    if (batch.failure) return fail(signal?.aborted ? 'CANCELLED' : batch.failure.code, batch.failure.path, batch.failure.attempt);
  }
  return { ok: true, files, receipts, resume: { planDigest: planDigest!, files: files.map(file => ({ ...file })) }, buildComplete: false };
}
