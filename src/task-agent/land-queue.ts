/** TA-LAND-AFTER-REVIEW: a configured queue adapter after exact-head review and remote changed gate. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReviewResultOutput } from './review-result-capture.js';

type CommandResult = { status: number; stdout: string; stderr: string };
export interface QueueLandingInput {
  card: string; pr: number; head: string; cwd: string; statePath: string; reviewResult: string;
  command: string; remote: string; entry: string; configDir: string;
}
export interface QueueLandingDeps {
  run?: (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
  read?: (path: string) => string;
}

async function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-4000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

/** The adapter owns no merge authority. Its only successful result is a confirmed queue row. */
export async function runQueuedLanding(input: QueueLandingInput, deps: QueueLandingDeps = {}): Promise<CommandResult> {
  const invoke = deps.run ?? run;
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const fail = (stage: string, reason: string): CommandResult => ({ status: 1, stdout: '', stderr: `${stage}: ${reason.slice(-500)}` });
  if (!/^[a-f0-9]{40}$/i.test(input.head) || !Number.isSafeInteger(input.pr) || input.pr < 1) return fail('input', 'invalid PR/head');
  if (!isAbsolute(input.command) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.remote)) return fail('config', 'land queue command/remote invalid');
  let review: ReturnType<typeof parseReviewResultOutput>;
  try { review = parseReviewResultOutput(read(input.reviewResult)); }
  catch (error) { return fail('review', String(error)); }
  if (!review || review.pr !== input.pr || review.head?.toLowerCase() !== input.head.toLowerCase()
    || review.reviewed !== true || !['pass', 'warn'].includes(review.verdict ?? '') || review.mustFix !== 0 || review.error) {
    return fail('review', `exact head #${input.pr} ${input.head.slice(0, 12)} PASS/WARN mf0 not proven`);
  }
  const git = async (args: string[]) => invoke(process.execPath, [input.entry, '--config-dir', input.configDir, 'git', ...args], input.cwd);
  const fetched = await git(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.status !== 0) return fail('base-fetch', fetched.stderr || fetched.stdout || `exit ${fetched.status}`);
  const base = await git(['rev-parse', '--verify', 'origin/main']);
  const baseHead = base.stdout.trim().split(/\s+/)[0];
  if (base.status !== 0 || !/^[a-f0-9]{40}$/i.test(baseHead ?? '')) return fail('base', 'origin/main commit unmeasured');
  const local = await git(['rev-parse', '--verify', 'HEAD']);
  if (local.status !== 0 || local.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== input.head.toLowerCase()) return fail('head', 'queue worktree HEAD differs from PR head');
  const safeCard = input.card.replace(/[^A-Za-z0-9._-]/g, '_');
  const artifact = join(dirname(input.statePath), 'land-queue-gates', `${safeCard}-${input.pr}-${input.head.slice(0, 12)}-${randomUUID()}`);
  mkdirSync(artifact, { recursive: true });
  const gate = await invoke(process.execPath, [input.entry, '--config-dir', input.configDir,
    'self', 'gate', '--changed', '--base', baseHead!, '--remote', input.remote, '--shards', '4', '--artifact-dir', artifact], input.cwd);
  if (gate.status !== 0) return fail('remote-changed-gate', gate.stderr || gate.stdout || `exit ${gate.status}`);
  let summary: Record<string, unknown>;
  try { summary = JSON.parse(read(join(artifact, 'summary.json'))) as Record<string, unknown>; }
  catch (error) { return fail('remote-changed-gate', `summary unreadable: ${String(error)}`); }
  if (summary.head40 !== input.head || summary.base40 !== baseHead || summary.remoteHost !== input.remote
    || summary.verdict !== 'passed' || summary.exitCode !== 0 || summary.introduced !== 0
    || summary.unknown !== 0 || summary.preconditionUnmet !== 0) {
    return fail('remote-changed-gate', 'summary does not prove this head/base/remote passed with zero unknown');
  }
  const fresh = await invoke('gh', ['pr', 'view', String(input.pr), '--json', 'headRefOid,state,isDraft'], input.cwd);
  let latest: { headRefOid?: unknown; state?: unknown; isDraft?: unknown };
  try { latest = JSON.parse(fresh.stdout) as typeof latest; }
  catch { return fail('pr-head', `current PR state unreadable: ${fresh.stderr || fresh.stdout || fresh.status}`); }
  if (fresh.status !== 0 || latest.state !== 'OPEN' || latest.isDraft !== false
    || typeof latest.headRefOid !== 'string' || latest.headRefOid.toLowerCase() !== input.head.toLowerCase()) {
    return fail('pr-head', `PR #${input.pr} changed after gate or is not ready`);
  }
  const enrolled = await invoke(input.command, [String(input.pr), input.cwd, '--review', input.reviewResult, '--expected-head', input.head], input.cwd,
    { ...process.env, LAND_RR_DIR: dirname(input.reviewResult) });
  if (enrolled.status !== 0 || !new RegExp(`^OK #${input.pr} head=${input.head.slice(0, 12)}(?:\\s|$)`, 'm').test(enrolled.stdout)) {
    return fail('land-enqueue-refused', enrolled.stdout || enrolled.stderr || `exit ${enrolled.status}`);
  }
  return { status: 0, stdout: `queued #${input.pr} head ${input.head.slice(0, 12)} gate ${artifact} · ${enrolled.stdout.slice(-250)}`, stderr: '' };
}
