import { SLASH_COMMANDS, type SlashCommand } from '../chat/index.js';
import { FEATURE_MATURITY, type Maturity } from './feature-maturity.js';

export interface TuiSlashAvailability {
  name: string;
  maturity: Maturity;
  telegram: boolean;
  discord: boolean;
}

/** Project canonical TUI commands onto the maturity map and bot-surface grade maps.
 * An absent bot grade means unavailable; a missing TUI grade is a registry error.
 */
export function deriveTuiSlashAvailability(
  commands: readonly Pick<SlashCommand, 'name'>[] = SLASH_COMMANDS,
  grades: {
    tuiSlash: Readonly<Record<string, Maturity>>;
    telegramCommand: Readonly<Record<string, Maturity>>;
    discordCommand: Readonly<Record<string, Maturity>>;
  } = FEATURE_MATURITY,
): TuiSlashAvailability[] {
  return commands.map(({ name }) => {
    if (!Object.hasOwn(grades.tuiSlash, name)) throw new Error(`TUI slash command /${name} has no maturity grade`);
    return {
      name,
      maturity: grades.tuiSlash[name]!,
      telegram: Object.hasOwn(grades.telegramCommand, name),
      discord: Object.hasOwn(grades.discordCommand, name),
    };
  });
}
