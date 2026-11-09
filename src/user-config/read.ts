import { existsSync, readFileSync } from 'node:fs';

/** Read the on-disk config envelope. Shape validation and normalization stay in user-config.ts. */
export function readUserConfigObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
