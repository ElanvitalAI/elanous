// MAT1b — TUI slash suggestions use the same maturity source as PWA routes.
// Kept out of feature-maturity.ts: the PWA bundles that file, and this one
// needs the TUI command list.
import { SLASH_COMMANDS } from '../chat/index.js';
import { getUserConfig } from '../user-config.js';
import { FEATURE_MATURITY, type Maturity, type Role } from './feature-maturity.js';

export function readTuiSlashAudience(raw: unknown = getUserConfig().raw?.tui): { role: Role; showBeta: boolean } {
  const tui = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const role = tui.role === 'general' || tui.role === 'contributor' || tui.role === 'owner' ? tui.role : 'owner';
  return { role, showBeta: tui.showBeta === true };
}

export function slashMaturity(name: string): Maturity | undefined {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name || entry.aliases?.includes(name));
  if (!command) return undefined;
  return FEATURE_MATURITY.tuiSlash[command.name as keyof typeof FEATURE_MATURITY.tuiSlash];
}

/** Visibility of a TUI slash suggestion, not permission to execute a typed command.
 * general = stable (+ beta with showBeta) · contributor = stable·beta·tool · owner = all.
 * Registered commands without a maturity grade remain visible to owner only in picker/help;
 * unregistered names are never visible through this predicate. */
export function slashVisibleFor(name: string, role: Role, { showBeta }: { showBeta: boolean }): boolean {
  const grade = slashMaturity(name);
  if (!grade) return false;
  if (role === 'owner') return true;
  if (grade === 'stable') return true;
  if (role === 'contributor') return grade === 'beta' || grade === 'tool';
  return grade === 'beta' && showBeta;
}
