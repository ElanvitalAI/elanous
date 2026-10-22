import { CLI_HARNESS_RUN_ENTRANCE, describeEntranceCommand } from './entrance-registry.js';

/** Shared help text stays independent of the CLI execution graphs.
 * The deprecated harness help comes from the entrance registry so its
 * destination and status cannot drift from the declared entrance. */
export const HARNESS_RUN_REPLACEMENT = 'elanous harness say <objective>';
export const HARNESS_RUN_DEPRECATION_HELP = describeEntranceCommand(
  CLI_HARNESS_RUN_ENTRANCE,
  HARNESS_RUN_REPLACEMENT,
  '이 입구는 더 이상 실행되지 않습니다.',
).trimEnd();

/** `dev --plan` help points to this one replacement. */
export const DEV_PLAN_REPLACEMENT = 'elanous harness say';
export function formatDevPlanOptionHelp(replacement: string = DEV_PLAN_REPLACEMENT): string {
  return `은퇴한 staged 하니스 옵션 — 지정하면 명시적으로 거부됨 · 대응 문 \`${replacement}\``;
}
