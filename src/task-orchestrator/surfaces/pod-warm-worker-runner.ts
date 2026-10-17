/** Deterministic file runner for a dedicated Linux warm Pod PID namespace. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { WarmWorkerRunFile } from './pod-warm-worker-runtime.js';

/** Pure namespace inventory; the production call always uses the kernel /proc mount. */
export function warmPodNamespaceResidue(procRoot: string, selfPid: number): number[] {
  return readdirSync(procRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => Number(entry.name))
    .filter(pid => pid !== 1 && pid !== selfPid && existsSync(join(procRoot, String(pid))))
    .sort((a, b) => a - b);
}

function assertWarmPod(request: WarmWorkerRunFile): void {
  if (process.platform !== 'linux' || !process.env.WARM_WORKER_ID
    || request.env.WARM_WORKER_ID !== process.env.WARM_WORKER_ID
    || !process.env.WARM_BRIDGE_UID || request.env.WARM_BRIDGE_UID !== process.env.WARM_BRIDGE_UID
    || !process.env.WARM_POD_UID || request.env.WARM_POD_UID !== process.env.WARM_POD_UID)
    throw new Error('warm runner unsupported outside Linux Pod worker');
  let init: string;
  let selfNamespace: string;
  let initNamespace: string;
  try {
    init = readFileSync('/proc/1/comm', 'utf8').trim();
    selfNamespace = readlinkSync('/proc/self/ns/pid');
    initNamespace = readlinkSync('/proc/1/ns/pid');
  }
  catch { throw new Error('warm runner PID namespace unmeasured'); }
  if (init !== 'sleep' || process.pid === 1 || !/^pid:\[\d+\]$/.test(selfNamespace)
    || selfNamespace !== initNamespace) throw new Error('warm runner unsupported PID namespace');
}

function stopGroup(pgid: number | undefined): boolean {
  if (!pgid) return false;
  try { process.kill(-pgid, 'SIGKILL'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code === 'EPERM') return false;
    throw error;
  }
  return true;
}

/** A lingering process anywhere in this dedicated namespace fences the whole Pod. */
export async function runWarmWorkerFile(request: WarmWorkerRunFile): Promise<number> {
  assertWarmPod(request);
  if (Date.now() >= request.deadlineAt) return 124;
  if (warmPodNamespaceResidue('/proc', process.pid).length > 0) return 124;
  const output = Bun.file(request.logPath).writer();
  output.write(`[warm-worker] file=${request.file}\n[warm-worker] cut=${request.cutSha} attempt=${request.attemptId}\n`);
  if (Date.now() >= request.deadlineAt) { await output.end(); return 124; }
  const child = spawn('bun', ['run', 'scripts/test-deterministic.ts', request.file, '--reporter=junit', `--reporter-outfile=${request.junitPath}`],
    { cwd: request.cwd, env: request.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', chunk => output.write(chunk));
  child.stderr?.on('data', chunk => output.write(chunk));
  let timedOut = false;
  let expire!: () => void;
  const expired = new Promise<number>(resolve => { expire = () => resolve(124); });
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!stopGroup(child.pid)) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    expire();
  }, Math.max(0, request.deadlineAt - Date.now()));
  try {
    const closed = new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done(signal ? 124 : code ?? 1));
    });
    const rc = await Promise.race([closed, expired]);
    const residueBeforeStop = warmPodNamespaceResidue('/proc', process.pid).length > 0;
    if (!stopGroup(child.pid)) child.kill('SIGKILL');
    const residueAfterStop = warmPodNamespaceResidue('/proc', process.pid).length > 0;
    if (residueBeforeStop || residueAfterStop || timedOut || Date.now() >= request.deadlineAt) return 124;
    return rc;
  } finally {
    clearTimeout(timeout);
    if (!stopGroup(child.pid)) child.kill('SIGKILL');
    await output.end();
    if (existsSync(request.junitPath)) {
      const digest = createHash('sha256').update(readFileSync(request.junitPath)).digest('hex');
      appendFileSync(request.logPath, `\n[warm-worker] junit-sha256=${digest}\n`);
    }
  }
}
