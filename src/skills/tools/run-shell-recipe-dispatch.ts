import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nexusRootDir } from '../../nexus/paths.js';
import { appendExecution } from './run-shell-recipe-execution-ledger.js';
import { debug } from '../../debug/log.js';
import { isLocalRead, spawnGateway, type RunShellGatewayGrant } from '../../shell-primitive/spawn-gateway.js';
import { requestRunShellApproval, RUNSHELL_PUBLIC_KEY_ENV } from '../../tui-client/next-runshell-approval.js';
import { authorizeSignedRecipe, readSignedRecipe } from './run-shell-signed-recipe.js';
import { recipeHash } from './run-shell-recipe-ledger.js';
import type { RunShellDispatchResult } from './shell.js';

/** The only product entry point accepts an id, never caller-supplied command data. */
export async function dispatchSignedRecipe(id: string, timeoutMs: number, signal?: AbortSignal, sessionId?: string): Promise<RunShellDispatchResult> {
  const started = Date.now();
  const result = (outcome: RunShellDispatchResult['outcome'], exitCode: number | null, stdout = '', stderr = '', truncated = false): RunShellDispatchResult => ({
    output: `RunShell recipe ${id} outcome=${outcome}`, outcome, exitCode, stdout, stderr, truncated,
    elapsedMs: Date.now() - started, approvalKey: `recipe:${id}`, sandboxed: false, sandboxTool: 'none',
  });
  if (signal?.aborted) return result('aborted', null);
  let child: ReturnType<typeof spawnGateway>;
  let ledgerPath: string | undefined;
  let runId: string | undefined;
  let auditStarted = false;
  const finishAudit = (outcome: string, exitCode: number | null) => {
    if (auditStarted && ledgerPath && runId) appendExecution(ledgerPath, { runId, phase: 'finish', at: new Date().toISOString(), outcome, exitCode });
  };
  try {
    const envelope = readSignedRecipe(id);
    // Authenticate before displaying a card; the gateway rechecks immediately before spawn.
    const recipe = authorizeSignedRecipe(envelope);
    let grant: RunShellGatewayGrant | undefined;
    if (!isLocalRead(recipe.argv[0]!, recipe.argv.slice(1), recipe.cwd)) {
      const publicKeyPem = process.env[RUNSHELL_PUBLIC_KEY_ENV];
      const callerSeat = process.env.ELANOUS_TRACK;
      if (!publicKeyPem || !callerSeat || !sessionId) return result('denied', null);
      const approval = await requestRunShellApproval(process, { argv: recipe.argv, cwd: recipe.cwd,
        bytesSha256: recipe.bytesSha256, callerSeat, sessionId }, signal);
      if (!approval || signal?.aborted) return result(signal?.aborted ? 'aborted' : 'denied', null);
      grant = { approval, publicKeyPem, callerSeat, sessionId, executablePath: recipe.argv[0]!, signal };
    }
    if (signal?.aborted) return result('aborted', null);
    const dir = join(nexusRootDir(), 'runshell-recipes');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('unsafe recipe ledger directory');
    ledgerPath = join(dir, 'executions.jsonl');
    runId = randomUUID();
    appendExecution(ledgerPath, { runId, phase: 'start', at: new Date().toISOString(), recipeId: id, epoch: recipe.epoch,
      recipeSha256: recipeHash(recipe), argv: recipe.argv,
      approval: grant ? { cardId: grant.approval.payload.cardId, signerKeySha256: createHash('sha256').update(grant.publicKeyPem).digest('hex'), status: 'presented' } : null });
    auditStarted = true;
    child = spawnGateway(recipe.argv[0]!, recipe.argv.slice(1), { cwd: recipe.cwd }, undefined, grant, envelope);
    // External root/operating-user writes are not locked against spawn in v1.
    debug.log('shell.recipe', 'spawn', { recipeId: id, epoch: envelope.recipe.epoch, revocationRace: true });
  } catch (error) {
    try { finishAudit('denied', null); } catch { /* preserve incomplete start for recovery */ }
    debug.log('shell.recipe', 'denied', { recipeId: id, reason: error instanceof Error ? error.message : 'unknown' });
    return result('denied', null, '', 'signed recipe unavailable or denied');
  }
  return await new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, timedOut = false, aborted = false;
    const append = (which: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString('utf8');
      const remaining = Math.max(0, 65536 - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
      if (Buffer.byteLength(text) > remaining) truncated = true;
      if (which === 'stdout') stdout += Buffer.from(text).subarray(0, remaining).toString('utf8');
      else stderr += Buffer.from(text).subarray(0, remaining).toString('utf8');
    };
    child.stdout?.on('data', data => append('stdout', data));
    child.stderr?.on('data', data => append('stderr', data));
    const cancel = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    let done = false;
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const outcome = timedOut ? 'timeout' : aborted ? 'aborted' : error ? 'spawn-error' : 'exit';
      try { finishAudit(outcome, code); } catch {
        resolve(result('spawn-error', null, stdout, 'recipe execution audit unavailable', truncated));
        return;
      }
      debug.log('shell.recipe', 'finish', { recipeId: id, outcome, exitCode: code, revocationRace: true });
      resolve(result(outcome, code, stdout, error ? error.message : stderr, truncated));
    };
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code));
  });
}
