/**
 * OLD-DOOR-CLOSE — the three outside doors refuse a direct call.
 *
 * `elanous dev --ask`, `elanous self implement`, and `elanous self orchestrate`
 * stay callable from inside the harness. The harness marks those calls with
 * the same stamp ONEDOOR-1 uses for a door (`ELANOUS_HARNESS_ENTRANCE`) or with
 * the explicit internal flag `--harness-internal`. A terminal or seat session
 * carries neither, so it exits non-zero and is told where to go.
 */
import type { LaunchDoor } from '../harness/launch-stamp.js';

export const OLD_DOORS = ['dev-ask', 'self-implement', 'self-orchestrate'] as const;
export type OldDoor = (typeof OLD_DOORS)[number];

/** Same env ONEDOOR-1 already stamps onto a harness launch. */
export const OLD_DOOR_STAMP_ENV = 'ELANOUS_HARNESS_ENTRANCE';
/** Same meaning as the env, for a caller that can pass an argument but not an env. */
export const OLD_DOOR_STAMP_FLAG = '--harness-internal';

const STAMP_BY_DOOR: Readonly<Record<OldDoor, readonly string[]>> = {
  'dev-ask': ['dev-ask', 'cli-dev-ask', 'cli-drive', 'harness-say', 'cli-harness-say', 'harness-ask', 'cli-harness-ask', 'queue-tick', 'agent-mission', 'daemon-tool'],
  'self-implement': ['self-implement', 'cli-self-implement', 'nl-self-implement', 'daemon-self-implement', 'daemon-tool', 'harness-say', 'cli-harness-say', 'harness-ask', 'cli-harness-ask', 'queue-tick', 'agent-mission'],
  'self-orchestrate': ['self-orchestrate', 'cli-self-orchestrate', 'nl-self-orchestrate', 'cli-harness-orchestrate', 'harness-say', 'cli-harness-say', 'harness-ask', 'cli-harness-ask', 'queue-tick', 'agent-mission', 'daemon-tool'],
};

export interface OldDoorRefusal {
  readonly door: OldDoor;
  readonly caller: 'outside';
  readonly exitCode: 1;
  readonly message: string;
}

export function oldDoorStampAccepted(door: OldDoor, stamp: string | undefined | null): boolean {
  const value = stamp?.trim();
  if (!value) return false;
  return (STAMP_BY_DOOR[door] as readonly string[]).includes(value);
}

/** A harness-internal call carries the stamp in the environment or on the argv. Anything else is outside. */
export function isOldDoorInternalCall(
  door: OldDoor,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (argv.includes(OLD_DOOR_STAMP_FLAG)) return true;
  return oldDoorStampAccepted(door, env[OLD_DOOR_STAMP_ENV]);
}

/** Env a harness parent sets so the child door stays open. */
export function oldDoorInternalEnv(door: LaunchDoor | OldDoor): Record<string, string> {
  return { [OLD_DOOR_STAMP_ENV]: door };
}

const REPLACEMENT: Readonly<Record<OldDoor, string>> = {
  'dev-ask': 'elanous harness ask <goal.md>',
  'self-implement': 'elanous harness say "<sentence>"',
  'self-orchestrate': 'elanous harness say "<sentence>"',
};

const DOOR_LABEL: Readonly<Record<OldDoor, string>> = {
  'dev-ask': 'elanous dev --ask',
  'self-implement': 'elanous self implement',
  'self-orchestrate': 'elanous self orchestrate',
};

/** One line: the closed door, the harness door to use, and a command of the same meaning. */
export function oldDoorRefusalMessage(door: OldDoor): string {
  return `${DOOR_LABEL[door]} 는 닫혔습니다 — harness say / harness ask 로. 예: ${REPLACEMENT[door]}`;
}

export function refuseOldDoor(door: OldDoor): OldDoorRefusal {
  return { door, caller: 'outside', exitCode: 1, message: oldDoorRefusalMessage(door) };
}
