// The one place that decides the Obsidian vault a fresh install starts with.
// A configured `obsidian.vault` always wins over this; the default only matters when
// nothing is configured (first install, onboarding's pre-filled answer).
// ⛔ Keep it generic — it used to name the owner's personal vault, in three places that disagreed.
import { join } from 'path';

export type VaultEnv = Readonly<Record<string, string | undefined>>;

/** `<home>/Documents/Obsidian` — the default when neither config nor env names a vault. */
export function fallbackObsidianVault(home: string): string {
  return join(home, 'Documents', 'Obsidian');
}

/** `$OBSIDIAN_VAULT` when set (trimmed, non-empty), else `fallbackObsidianVault(home)`. */
export function defaultObsidianVault({ env, home }: { env: VaultEnv; home: string }): string {
  return env.OBSIDIAN_VAULT?.trim() || fallbackObsidianVault(home);
}
