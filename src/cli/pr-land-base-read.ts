import type { CmdRunner } from '../autopilot/pr-manager.js';

export const PR_LAND_BASE_READ_RETRIES = 2;
export const PR_LAND_BASE_READ_RETRY_DELAY_MS = 100;

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
    if (attempt <= PR_LAND_BASE_READ_RETRIES) await input.sleep(PR_LAND_BASE_READ_RETRY_DELAY_MS);
  }
  return { baseRefName: null, attempts: PR_LAND_BASE_READ_RETRIES + 1 };
}
