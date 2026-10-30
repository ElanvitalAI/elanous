import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnElanous } from '../instance/spawn-elanous.js';

export interface ClassicMissionCliResult {
  ok: boolean;
  status: 'completed' | 'cancelled' | 'failed';
  interactionId?: string;
  path: string;
  content?: string;
  error?: string;
}
interface MissionStatus {
  missionId: string;
  status: 'running' | 'done' | 'completed' | 'cancelled' | 'failed';
  result?: string;
}

const MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Status is persisted by the CLI bridge; polling every 500 ms would launch up to
// 7,200 short-lived CLI processes for a one-hour mission. Five seconds keeps
// eventual completion observable without turning the dashboard into a process loop.
const POLL_MS = 5_000;
const MAX_WAIT_MS = 60 * 60 * 1_000;

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `process.argv[1]` belongs to the parent surface and can be a TUI-only
    // entry. Always route detached mission operations through the installed
    // CLI command, whose `mission` router owns run/status/cancel.
    const child = spawnElanous(args, { executable: 'eln',
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_FAST_ROUTER: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) { reject(new Error('Installed CLI streams could not be opened')); return; }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson<T>(result: { code: number | null; stdout: string; stderr: string }): T {
  if (result.code !== 0) throw new Error('Mission CLI command failed');
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error('Mission CLI returned invalid JSON'); }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface MissionCliConsumerDeps {
  runCli?: typeof runCli;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface StartedClassicMissionCliJob {
  ok: true;
  status: 'running';
  interactionId: string;
  path: string;
  startedAt: number;
  completion: Promise<ClassicMissionCliResult>;
}

export type StartClassicMissionCliResult = StartedClassicMissionCliJob | ClassicMissionCliResult;

export function redactMissionResultPath(text: string, path?: string): string {
  return path ? text.replaceAll(path, '[internal result]') : text;
}

export function isClassicMissionId(value: string): boolean {
  return MISSION_ID.test(value);
}

/** Explicitly cancel a detached sidetab mission; parent-turn aborts never call this. */
export async function cancelClassicMissionCli(interactionId: string, executeCli: typeof runCli = runCli): Promise<boolean> {
  if (!isClassicMissionId(interactionId)) return false;
  const result = parseJson<{ missionId: string; status: string; cancelled: boolean }>(
    await executeCli(['mission', 'cancel', interactionId, '--json']),
  );
  return result.missionId === interactionId && result.cancelled === true && result.status === 'cancelled';
}

/** Start a detached mission and return its identity immediately; poll results independently. */
export async function startClassicMissionCli(input: {
  agent: 'codex' | 'claude';
  prompt: string;
  onInteractionId?: (interactionId: string) => void;
}, deps: MissionCliConsumerDeps = {}): Promise<StartClassicMissionCliResult> {
  const executeCli = deps.runCli ?? runCli;
  const wait = deps.delay ?? delay;
  const now = deps.now ?? Date.now;
  const tempRoot = mkdtempSync(join(tmpdir(), 'elanous-classic-mission-'));
  const promptPath = join(tempRoot, 'prompt.txt');
  const outputPath = join(tempRoot, 'result.md');
  let interactionId: string | undefined;
  const startedAt = now();
  try {
    writeFileSync(promptPath, input.prompt, { encoding: 'utf8', mode: 0o600 });
    const launched = parseJson<{ missionId: string; status: 'running' }>(await executeCli([
      'mission', 'run', '--agent', input.agent, '--prompt-file', promptPath, '--out', outputPath, '--json',
    ]));
    if (!isClassicMissionId(launched.missionId) || launched.status !== 'running') throw new Error('Mission CLI returned an invalid interaction ID');
    interactionId = launched.missionId;
    try { input.onInteractionId?.(interactionId); } catch { /* telemetry must not interrupt mission startup */ }
    const completion = (async (): Promise<ClassicMissionCliResult> => {
      try {
        while (now() - startedAt < MAX_WAIT_MS) {
          const status: MissionStatus = parseJson<MissionStatus>(await executeCli(['mission', 'status', interactionId!, '--json']));
          if (status.missionId !== interactionId) throw new Error('Mission status did not match its interaction ID');
          // `eln mission status --json` exposes completed records as `done`.
          // Keep `completed` accepted for compatible bridges and existing callers.
          if (status.status === 'done' || status.status === 'completed') {
            if (typeof status.result !== 'string' || !status.result.trim()) throw new Error('Mission completed without a final answer');
            return { ok: true, status: 'completed', interactionId, path: outputPath, content: status.result };
          }
          if (status.status !== 'running') return {
            ok: false,
            status: status.status === 'cancelled' ? 'cancelled' : 'failed',
            interactionId,
            path: outputPath,
            error: 'Mission did not complete successfully',
          };
          await wait(POLL_MS);
        }
        await executeCli(['mission', 'cancel', interactionId!, '--json']).catch(() => undefined);
        return { ok: false, status: 'failed', interactionId, path: outputPath, error: 'Mission exceeded the sidetab time limit' };
      } catch {
        return { ok: false, status: 'failed', interactionId, path: outputPath, error: 'Mission CLI could not complete the request' };
      } finally {
        try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* temp cleanup cannot replace mission outcome */ }
      }
    })();
    return {
      ok: true,
      status: 'running',
      interactionId,
      path: outputPath,
      startedAt,
      completion,
    };
  } catch {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* temp cleanup cannot replace mission outcome */ }
    return { ok: false, status: 'failed', ...(interactionId ? { interactionId } : {}), path: outputPath, error: 'Mission CLI could not complete the request' };
  }
}
