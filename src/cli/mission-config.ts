// `elanous config mission <get|set|reset|mode>` — thin wrapper around
// the generic `config set llm.missionRouting.…` so users don't have to
// memorise dotted paths or hand-craft JSON for a 6-mission table.
//
// Sub-commands:
//   elanous config mission get [<mission>]
//   elanous config mission set <mission> <provider> [<model>]
//   elanous config mission reset [<mission>]
//   elanous config mission mode <auto|manual>
//
// Pure helpers are exported so unit tests can drive the surface without
// spawning a subprocess — the index.ts Commander wiring is the only
// piece that calls saveUserConfig/reloadUserConfig.

import type { MissionRoutingConfig } from '../user-config/types.js';

export type MissionKind = 'plan' | 'build' | 'review' | 'research' | 'quick' | 'vision';

export const MISSION_KINDS: ReadonlyArray<MissionKind> = [
  'plan', 'build', 'review', 'research', 'quick', 'vision',
];

function isMissionKind(s: string): s is MissionKind {
  return (MISSION_KINDS as readonly string[]).includes(s);
}

export interface MissionConfigOutcome {
  /** Updated config slice for callers that persist (or undefined for read-only). */
  next?: MissionRoutingConfig;
  /** Lines to emit to stdout. */
  lines: string[];
  /** Non-zero on user error (unknown mission, missing arg). */
  exitCode: number;
}

/** Read current routing slice and produce stdout lines.
 *  - `mission` undefined → render the full table
 *  - `mission` set → render only that row */
export function describeMissionRouting(
  current: MissionRoutingConfig | undefined,
  mission?: string,
): MissionConfigOutcome {
  if (mission !== undefined && !isMissionKind(mission)) {
    return {
      lines: [`unknown mission '${mission}' — expected one of: ${MISSION_KINDS.join(', ')}`],
      exitCode: 1,
    };
  }
  const lines: string[] = [];
  lines.push(`mode: ${current?.mode ?? 'auto'}`);
  const missions = current?.missions ?? {};
  const targets = mission ? [mission as MissionKind] : [...MISSION_KINDS];
  for (const k of targets) {
    const e = missions[k];
    if (e) {
      lines.push(`${k}: ${e.provider}${e.model ? ` (${e.model})` : ''}`);
    } else {
      lines.push(`${k}: <default>`);
    }
  }
  return { lines, exitCode: 0 };
}

export function setMissionEntry(
  current: MissionRoutingConfig | undefined,
  mission: string,
  provider: string,
  model: string | undefined,
): MissionConfigOutcome {
  if (!isMissionKind(mission)) {
    return {
      lines: [`unknown mission '${mission}' — expected one of: ${MISSION_KINDS.join(', ')}`],
      exitCode: 1,
    };
  }
  const trimmedProvider = provider.trim();
  if (trimmedProvider.length === 0) {
    return { lines: ['provider required'], exitCode: 1 };
  }
  const next: MissionRoutingConfig = {
    ...(current ?? {}),
    missions: { ...(current?.missions ?? {}) },
  };
  next.missions![mission] = {
    provider: trimmedProvider,
    model: model && model.trim().length > 0 ? model.trim() : undefined,
  };
  return {
    next,
    lines: [`set ${mission} → ${trimmedProvider}${model ? ` (${model})` : ''}`],
    exitCode: 0,
  };
}

export function resetMissionEntry(
  current: MissionRoutingConfig | undefined,
  mission: string | undefined,
): MissionConfigOutcome {
  if (mission === undefined) {
    // Reset everything — clear missions slot, leave mode untouched.
    if (current?.missions === undefined && current?.mode === undefined) {
      return { lines: ['mission routing already at defaults'], exitCode: 0 };
    }
    return { next: { mode: current?.mode }, lines: ['reset all missions → defaults'], exitCode: 0 };
  }
  if (!isMissionKind(mission)) {
    return {
      lines: [`unknown mission '${mission}' — expected one of: ${MISSION_KINDS.join(', ')}`],
      exitCode: 1,
    };
  }
  if (!current?.missions?.[mission]) {
    return { lines: [`${mission} already at default`], exitCode: 0 };
  }
  const nextMissions = { ...current.missions };
  delete nextMissions[mission];
  const next: MissionRoutingConfig = { ...current };
  if (Object.keys(nextMissions).length === 0) delete next.missions;
  else next.missions = nextMissions;
  return { next, lines: [`reset ${mission} → default`], exitCode: 0 };
}

export function setMissionMode(
  current: MissionRoutingConfig | undefined,
  mode: string,
): MissionConfigOutcome {
  if (mode !== 'auto' && mode !== 'manual') {
    return { lines: [`unknown mode '${mode}' — expected 'auto' or 'manual'`], exitCode: 1 };
  }
  const next: MissionRoutingConfig = { ...(current ?? {}), mode };
  return { next, lines: [`mode → ${mode}`], exitCode: 0 };
}
