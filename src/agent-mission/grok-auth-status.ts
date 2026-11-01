import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type GrokProbeStage = 'spawn' | 'first-byte' | 'auth' | 'connect' | 'response' | 'exit';
export interface GrokLoginProbeResult { ok: boolean; reason?: string; stage?: GrokProbeStage; durationMs?: number }
export interface GrokAuthProbeResult { status: number | null; stdout?: string; stderr?: string; error?: Error; stage?: GrokProbeStage; durationMs?: number }
export type GrokAuthProbe = (timeoutMs: number) => Promise<GrokAuthProbeResult> | GrokAuthProbeResult;

type ProbeChild = ReturnType<typeof spawn>;
type ProbeSpawner = typeof spawn;

export const runAuthProbe: (timeoutMs: number, spawnProcess?: ProbeSpawner) => Promise<GrokAuthProbeResult> = (timeoutMs, spawnProcess = spawn) => new Promise((resolve) => {
  const startedAt = Date.now();
  let stage: GrokProbeStage = 'spawn';
  let stdout = '';
  let stderr = '';
  let pendingStderrLine = '';
  let discardStderrLine = false;
  let settled = false;
  const capturedStderr = () => sanitizeStderr(`${stderr}${pendingStderrLine}`).slice(-8_000);
  const appendStderr = (chunk: string) => {
    let remaining = chunk;
    if (discardStderrLine) {
      const newline = remaining.indexOf('\n');
      if (newline < 0) return;
      remaining = remaining.slice(newline + 1);
      discardStderrLine = false;
    }
    const lines = `${pendingStderrLine}${remaining}`.split('\n');
    pendingStderrLine = lines.pop() ?? '';
    if (lines.length) stderr = sanitizeStderr(`${stderr}${lines.join('\n')}`).slice(-8_000);
    if (pendingStderrLine.length > 64_000) {
      if (/(?:authorization\s*:\s*(?:basic|bearer|token|apikey|api[- ]key)|(?:api[_-]?key|api[_-]?token|access[_-]?key|secret|password|credential|auth[_-]?token|refresh[_-]?token))\s*[:=]/i.test(pendingStderrLine)) {
        pendingStderrLine = '';
        discardStderrLine = true;
      } else {
        pendingStderrLine = pendingStderrLine.slice(-8_000);
      }
    }
  };
  const finish = (result: GrokAuthProbeResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ ...result, stderr: capturedStderr(), stage: result.stage ?? stage, durationMs: Date.now() - startedAt });
  };
  const child: ProbeChild = spawnProcess(join(homedir(), '.grok', 'bin', 'grok'), ['-p', 'reply with just OK'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('spawn', () => { stage = 'first-byte'; });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ status: null, stdout, stderr: capturedStderr(), stage: classifyStage(capturedStderr(), stdout, stage), error: new Error('Grok subscribed-access probe timed out') });
  }, Math.max(1, timeoutMs));
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stage = 'response'; stdout = `${stdout}${chunk}`.slice(-8_000); });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { appendStderr(chunk); stage = classifyStage(capturedStderr(), stdout, stage); });
  child.once('error', (error) => finish({ status: null, stdout, stderr, stage, error }));
  child.once('close', (status) => finish({ status, stdout, stderr, stage: classifyStage(stderr, stdout, 'exit') }));
});

/** Quick, credential-safe subscribed-access probe; whoami needs an interactive TTY in this CLI. */
export async function probeGrokLogin(run: GrokAuthProbe = runAuthProbe, timeoutMs = 45_000): Promise<GrokLoginProbeResult> {
  const result = await run(timeoutMs);
  const stage = result.stage ?? classifyStage(result.stderr ?? '', result.stdout ?? '', result.error ? 'first-byte' : 'exit');
  const duration = result.durationMs === undefined ? {} : { durationMs: result.durationMs };
  const details = formatDiagnostics(stage, result.durationMs, result.stderr);
  if (result.error?.name === 'TimeoutError' || /timed out|ETIMEDOUT/i.test(result.error?.message ?? '')) {
    return { ok: false, stage, ...duration, reason: `Grok subscribed-access probe timed out ${details}` };
  }
  if (result.error) return { ok: false, stage, ...duration, reason: `grok CLI could not be started ${details}` };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output)) {
    const reason = /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output)
      ? `Grok login unavailable; run grok login ${formatDiagnostics('auth', result.durationMs, result.stderr)}`
      : `Grok subscribed-access probe exited ${result.status ?? 'without a status'} ${details}`;
    return { ok: false, stage: /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output) ? 'auth' : stage, ...duration, reason };
  }
  if (!/^OK\s*$/i.test((result.stdout ?? '').trim())) return { ok: false, stage, ...duration, reason: `Grok subscribed-access probe did not return the expected OK reply ${details}` };
  return { ok: true, stage, ...duration };
}

function classifyStage(stderr: string, stdout: string, fallback: GrokProbeStage): GrokProbeStage {
  if (/login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(stderr)) return 'auth';
  if (/ECONN|ENOTFOUND|EHOST|network|connect(?:ion)? (?:refused|failed|timeout)|TLS|certificate/i.test(stderr)) return 'connect';
  // Stderr can contain pre-response warnings; only stdout proves that a reply
  // byte reached the caller.
  if (stdout) return 'response';
  return fallback;
}

function formatDiagnostics(stage: GrokProbeStage, durationMs?: number, stderr?: string): string {
  const safeStderr = sanitizeStderr(stderr);
  return `(${stage}${durationMs === undefined ? '' : ` after ${durationMs}ms`}${safeStderr ? `; stderr: ${safeStderr}` : '; stderr: <empty>'})`;
}

function sanitizeStderr(stderr?: string): string {
  return (stderr ?? '')
    .replace(/(authorization\s*:\s*(?:basic|bearer|token|apikey|api[- ]key)\s+)\S+/gi, '$1[redacted]')
    .replace(/(?:[A-Z0-9_]*(?:api[_-]?key|access[_-]?key|secret|password|credential|auth[_-]?token|refresh[_-]?token))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi, '[redacted credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|xai|gsk|gh[pousr])-[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-500);
}
