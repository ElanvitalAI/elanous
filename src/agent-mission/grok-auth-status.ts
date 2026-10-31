import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GrokLoginProbeResult { ok: boolean; reason?: string }
export type GrokAuthProbe = (timeoutMs: number) => Promise<{ status: number | null; stdout?: string; stderr?: string; error?: Error }> | { status: number | null; stdout?: string; stderr?: string; error?: Error };

const runAuthProbe: GrokAuthProbe = (timeoutMs) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (result: { status: number | null; stdout?: string; stderr?: string; error?: Error }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const child = spawn(join(homedir(), '.grok', 'bin', 'grok'), ['-p', 'reply with just OK'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ status: null, stdout, stderr, error: new Error('Grok subscribed-access probe timed out') });
  }, Math.max(1, timeoutMs));
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-8_000); });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  child.once('error', (error) => finish({ status: null, stdout, stderr, error }));
  child.once('close', (status) => finish({ status, stdout, stderr }));
});

/** Quick, credential-safe subscribed-access probe; whoami needs an interactive TTY in this CLI. */
export async function probeGrokLogin(run: GrokAuthProbe = runAuthProbe, timeoutMs = 45_000): Promise<GrokLoginProbeResult> {
  const result = await run(timeoutMs);
  if (result.error?.name === 'TimeoutError' || /timed out|ETIMEDOUT/i.test(result.error?.message ?? '')) {
    return { ok: false, reason: 'Grok subscribed-access probe timed out' };
  }
  if (result.error) return { ok: false, reason: 'grok CLI could not be started' };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output)) {
    const reason = /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output)
      ? 'Grok login unavailable; run grok login'
      : `Grok subscribed-access probe exited ${result.status ?? 'without a status'}`;
    return { ok: false, reason };
  }
  if (!/^OK\s*$/i.test((result.stdout ?? '').trim())) return { ok: false, reason: 'Grok subscribed-access probe did not return the expected OK reply' };
  return { ok: true };
}
