import { stripScreenAnsi } from './harness-screen.js';

export type AsideRunStatus = {
  kind: 'ok' | 'not-running' | 'auth-timeout' | 'repl-error' | 'no-marker';
  hint?: string;
};

export function classifyAsideRun({ stdout, stderr, exitCode, timedOut = false }: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** We killed `aside` at our own timeout. */
  timedOut?: boolean;
}): AsideRunStatus {
  const diagnosticStdout = stripScreenAnsi(stdout).split(/\r?\n/).filter((line) => {
    try { JSON.parse(line.trim()); return false; } catch { return true; }
  }).join('\n');
  const diagnostics = `${diagnosticStdout}\n${stripScreenAnsi(stderr)}`;
  if (exitCode !== 0 && /Aside isn't running/i.test(diagnostics)) {
    return { kind: 'not-running', hint: 'Aside 브라우저가 안 떠 있음 — Aside 브라우저를 켜고 다시 · 또는 `aside exec --host <host>`' };
  }
  if (exitCode !== 0 && /daemon auth challenge/i.test(diagnostics) && /timeout|timed out/i.test(diagnostics)) {
    return { kind: 'auth-timeout', hint: 'Aside 인증 요청 시간 초과 — Aside 브라우저를 켜고 다시 · 또는 `aside exec --host <host>`' };
  }
  // Killed by our timeout with nothing printed: aside never answered — the browser daemon is not reachable.
  if (timedOut && !stripScreenAnsi(stdout).trim()) {
    return { kind: 'auth-timeout', hint: 'Aside 가 응답하지 않음 — Aside 브라우저가 떠 있는지 확인하고 다시 · 또는 `aside exec --host <host>`' };
  }
  const marker = stripScreenAnsi(stdout).trimEnd().match(/\[(ok|error)\s*\|[^\]]+\]\s*$/);
  if (marker?.[1] === 'error') return { kind: 'repl-error' };
  if (marker?.[1] === 'ok') return { kind: 'ok' };
  return { kind: 'no-marker' };
}
