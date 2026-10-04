// HQ-SEAT — steward «구조 모드»(rescue): after an HQ move the seat sessions are gone and the steward keeps
// the line live, but only for the four reversible, internal actions below (OP 10-04 10:22 · 대표 directive).
import { debug } from '../debug/log.js';

export type StewardMode = 'off' | 'shadow' | 'live' | 'rescue';

/** The whole rescue allow-list: launch queued goals · harvest finished runs · internal stuck alerts · decision cards. */
export const RESCUE_ALLOWED = ['launch', 'harvest', 'alert', 'decision-card'] as const;
export type RescueAllowedAction = typeof RESCUE_ALLOWED[number];
export type RescueAction = RescueAllowedAction | 'publish' | 'release-run' | 'external-post' | 'delete' | 'config-change' | 'git-force';

/** Shared, fail-closed policy for rescue and seat-loop live-safe decisions. */
export function isRescueAllowedAction(action: string): action is RescueAllowedAction {
  return (RESCUE_ALLOWED as readonly string[]).includes(action);
}

/** Launch semantics of a steward mode: rescue launches like live. */
export function launchModeOf(mode: StewardMode): 'off' | 'shadow' | 'live' {
  return mode === 'rescue' ? 'live' : mode;
}

/**
 * Rescue-mode action gate. Outside rescue the steward's own mode rules decide (returns true).
 * In rescue only RESCUE_ALLOWED pass; every decision is observed as steward.rescue/<action> or steward.rescue/refused.
 */
export function rescueAllows(mode: StewardMode | undefined, action: RescueAction, data: Record<string, unknown> = {}): boolean {
  if (mode !== 'rescue') return true;
  const allowed = isRescueAllowedAction(action);
  try { debug.log('steward.rescue', allowed ? action : 'refused', { action, ...data }); } catch { /* observation is fail-soft */ }
  return allowed;
}

export interface StewardModeStore {
  read: () => StewardMode;
  write: (mode: StewardMode) => void;
}

const MODES: readonly StewardMode[] = ['off', 'shadow', 'live', 'rescue'];

export function parseStewardMode(value: string): StewardMode | null {
  return (MODES as readonly string[]).includes(value) ? value as StewardMode : null;
}

/** `elanous steward mode [<mode>]` — HQ promotion sets rescue; a reattaching human seat sets shadow. */
export async function runStewardModeCli(value: string | undefined, opts: { json?: boolean }, store?: StewardModeStore): Promise<number> {
  const s = store ?? await defaultModeStore();
  const before = s.read();
  if (value === undefined) {
    console.log(opts.json ? JSON.stringify({ mode: before }) : before);
    return 0;
  }
  const mode = parseStewardMode(value);
  if (!mode) { console.error(`steward mode: unknown mode ${JSON.stringify(value)} (off|shadow|live|rescue)`); return 2; }
  s.write(mode);
  const after = s.read();
  try { debug.log('steward.rescue', 'mode-set', { before, after }); } catch { /* observation is fail-soft */ }
  if (after !== mode) { console.error(`steward mode: saved value did not stick (read ${after})`); return 1; }
  console.log(opts.json ? JSON.stringify({ before, mode: after }) : `steward mode ${before} → ${after}`);
  return 0;
}

async function defaultModeStore(): Promise<StewardModeStore> {
  const uc = await import('../user-config.js');
  return {
    read: () => (uc.getUserConfig().loops?.steward?.mode ?? 'shadow') as StewardMode,
    write: (mode) => {
      const cfg = uc.getUserConfig();
      uc.backupUserConfig(uc.userConfigPath());
      const loops = { ...(cfg.loops ?? {}) };
      loops.steward = { ...(loops.steward ?? {}), mode };
      uc.saveUserConfig({ ...cfg, loops });
      uc.reloadUserConfig();
    },
  };
}
