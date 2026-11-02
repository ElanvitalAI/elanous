import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

export type GrokProbeStage = 'spawn' | 'first-byte' | 'auth' | 'connect' | 'response' | 'exit';
export type GrokProbeClassification = 'success' | 'auth-rejected' | 'network' | 'timeout' | 'spawn-error' | 'unexpected-exit' | 'invalid-response';
export interface GrokLoginProbeResult { ok: boolean; classification?: GrokProbeClassification; reason?: string; stage?: GrokProbeStage; timeoutMs?: number; elapsedMs?: number; durationMs?: number }
export interface GrokAuthProbeResult { status: number | null; stdout?: string; stderr?: string; error?: Error; stage?: GrokProbeStage; timeoutMs?: number; elapsedMs?: number; durationMs?: number }
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
      // Keep detecting a credential label even before its delimiter arrives; truncating here could otherwise discard the key and expose a later `=value` chunk.
      if (/(?:authorization\s*:\s*(?:basic|bearer|token|apikey|api[- ]key)|\b[A-Z0-9_]*(?:api[_-]?key|api[_-]?token|access[_-]?key|secret|password|credential|auth[_-]?token|refresh[_-]?token)\b)/i.test(pendingStderrLine)) {
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
    const elapsedMs = Date.now() - startedAt;
    resolve({ ...result, stderr: capturedStderr(), stage: result.stage ?? stage, timeoutMs: Math.max(1, timeoutMs), elapsedMs, durationMs: elapsedMs });
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
  const elapsedMs = result.elapsedMs ?? result.durationMs;
  const diagnostics = { timeoutMs, ...(elapsedMs === undefined ? {} : { elapsedMs, durationMs: elapsedMs }) };
  const details = formatDiagnostics(stage, timeoutMs, elapsedMs, result.stderr);
  const timedOut = result.error?.name === 'TimeoutError' || /timed out|ETIMEDOUT/i.test(result.error?.message ?? '');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const authRejected = /login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(output);
  const networkFailure = /ECONN|ENOTFOUND|EHOST|network|connect(?:ion)? (?:refused|failed|timeout)|TLS|certificate/i.test(result.stderr ?? '');
  const finalStage = authRejected ? 'auth' : stage;
  let classification: GrokProbeClassification;
  let reason: string | undefined;
  if (timedOut) {
    classification = 'timeout';
    reason = `Grok subscribed-access probe timed out ${details}`;
  } else if (authRejected) {
    classification = 'auth-rejected';
    reason = `Grok login unavailable; run grok login ${formatDiagnostics('auth', timeoutMs, elapsedMs, result.stderr)}`;
  } else if (result.error) {
    classification = stage === 'spawn' ? 'spawn-error' : 'unexpected-exit';
    reason = stage === 'spawn'
      ? `grok CLI could not be started ${details}`
      : `Grok subscribed-access probe errored before a confirmed response ${details}`;
  } else if (result.status !== 0 && networkFailure) {
    classification = 'network';
    reason = `Grok subscribed-access probe exited ${result.status ?? 'without a status'} ${details}`;
  } else if (result.status !== 0) {
    classification = 'unexpected-exit';
    reason = `Grok subscribed-access probe exited ${result.status ?? 'without a status'} ${details}`;
  } else if (!/^OK\s*$/i.test((result.stdout ?? '').trim())) {
    classification = 'invalid-response';
    reason = `Grok subscribed-access probe did not return the expected OK reply ${details}`;
  } else {
    classification = 'success';
  }

  const probeResult: GrokLoginProbeResult = {
    ok: classification === 'success', classification, stage: finalStage, ...diagnostics,
    ...(reason ? { reason } : {}),
  };
  // Keep the runtime event useful for the isolated-TUI receipt while never
  // forwarding provider stderr, stdout, or the human-readable reason.
  try {
    debug.log('grok.auth-probe', 'grok-probe-result', {
      taskId: randomUUID(), ok: probeResult.ok, classification, stage: finalStage,
      timeoutMs, ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  } catch { /* diagnostics must never change login fallback behavior */ }
  return probeResult;
}

function classifyStage(stderr: string, stdout: string, fallback: GrokProbeStage): GrokProbeStage {
  if (/login required|not authenticated|unauthori[sz]ed|authentication failed/i.test(stderr)) return 'auth';
  // Stderr can contain pre-response network warnings; a response byte is a
  // stronger stage observation and successful exit/OK decides success.
  if (stdout) return 'response';
  if (/ECONN|ENOTFOUND|EHOST|network|connect(?:ion)? (?:refused|failed|timeout)|TLS|certificate/i.test(stderr)) return 'connect';
  return fallback;
}

function formatDiagnostics(stage: GrokProbeStage, timeoutMs: number, elapsedMs?: number, stderr?: string): string {
  const safeStderr = sanitizeStderr(stderr);
  return `(${stage}; timeout=${timeoutMs}ms${elapsedMs === undefined ? '' : `; elapsed=${elapsedMs}ms`}${safeStderr ? `; stderr: ${safeStderr}` : '; stderr: <empty>'})`;
}

function sanitizeStderr(stderr?: string): string {
  return (stderr ?? '')
    .replace(/(authorization\s*:\s*(?:basic|bearer|token|apikey|api[- ]key)\s+)\S+/gi, '$1[redacted]')
    .replace(/(?:[A-Z0-9_]*(?:api[_-]?key|api[_-]?token|access[_-]?key|secret|password|credential|auth[_-]?token|refresh[_-]?token))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi, '[redacted credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|xai|gsk|gh[pousr])-[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-500);
}
