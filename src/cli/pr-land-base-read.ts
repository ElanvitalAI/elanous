import type { CmdRunner } from '../autopilot/pr-manager.js';

export const PR_LAND_BASE_READ_RETRIES = 2;
/** Increasing backoff: 1s after the first unreadable read, 3s after the second (OPT #24215). */
export const PR_LAND_BASE_READ_RETRY_DELAYS_MS = [1_000, 3_000] as const;
/** Fixed ceiling: no retry sleep ever exceeds the last scheduled delay. */
export const PR_LAND_BASE_READ_RETRY_DELAY_CAP_MS = 3_000;

/** Backoff for the sleep that follows `attempt`; the schedule stops growing at the cap. */
export function prLandBaseReadRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), PR_LAND_BASE_READ_RETRY_DELAYS_MS.length) - 1;
  return Math.min(PR_LAND_BASE_READ_RETRY_DELAYS_MS[index], PR_LAND_BASE_READ_RETRY_DELAY_CAP_MS);
}

export interface PrBaseReadResult {
  baseRefName: string | null;
  attempts: number;
}

/** Retry only an unreadable GitHub base response; a readable non-main base is a real retarget. */
export async function readPrBaseNameWithRetry(input: {
  pr: string;
  cwd: string;
  run: CmdRunner;
  sleep: (ms: number) => Promise<void>;
  onUnreadable?: (attempt: number, stderr: string | undefined) => void;
}): Promise<PrBaseReadResult> {
  for (let attempt = 1; attempt <= PR_LAND_BASE_READ_RETRIES + 1; attempt += 1) {
    const viewed = input.run('gh', ['pr', 'view', input.pr, '--json', 'baseRefName,url'], { cwd: input.cwd });
    let baseRefName: string | null = null;
    try {
      if (viewed.ok) {
        const parsed: unknown = JSON.parse(viewed.out);
        const name = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { baseRefName?: unknown }).baseRefName : undefined;
        if (typeof name === 'string' && name.trim()) baseRefName = name.trim();
      }
    } catch { /* Retry unreadable responses; do not treat them as main. */ }

    if (baseRefName !== null) return { baseRefName, attempts: attempt };
    input.onUnreadable?.(attempt, viewed.err);
    if (attempt <= PR_LAND_BASE_READ_RETRIES) await input.sleep(prLandBaseReadRetryDelayMs(attempt));
  }
  return { baseRefName: null, attempts: PR_LAND_BASE_READ_RETRIES + 1 };
}
