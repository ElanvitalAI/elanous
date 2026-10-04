import type { SlashCommand } from '../chat/index.js';
import type { Maturity } from './feature-maturity.js';
import type { BotSurface } from './bot-command-maturity.js';

export interface BotSlashCatalogEntry {
  name: string;
  description: string;
  supported: boolean;
}

export interface BotSlashCatalog {
  commands: BotSlashCatalogEntry[];
  /** Null means this name is already handled, or is not in the catalog. */
  unsupportedReply(name: string): string | null;
}

/** The menu is a projection of registered core commands, not a second list of invented names.
 * A bot's actual handlers take precedence over maturity metadata: a grade describes
 * visibility, never whether an existing command can be dispatched. */
export function buildBotSlashCatalog(options: {
  surface: BotSurface;
  coreCommands: readonly Pick<SlashCommand, 'name' | 'description'>[];
  maturity: {
    tuiSlash: Readonly<Record<string, Maturity>>;
    telegramCommand: Readonly<Record<string, Maturity>>;
    discordCommand: Readonly<Record<string, Maturity>>;
  };
  handledCommands: readonly { name: string; description: string }[];
}): BotSlashCatalog {
  const { surface, coreCommands, maturity, handledCommands } = options;
  const grades = surface === 'telegram' ? maturity.telegramCommand : maturity.discordCommand;
  const validName = surface === 'telegram' ? /^[a-z0-9_]{1,32}$/ : /^[a-z0-9_-]{1,32}$/;
  const commands: BotSlashCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const command of handledCommands) {
    if (seen.has(command.name)) continue;
    commands.push({ name: command.name, description: command.description, supported: true });
    seen.add(command.name);
  }
  const limit = surface === 'telegram' ? 100 : 25;
  const candidateNames = new Set<string>();
  const candidates = coreCommands.filter((command) => {
    const name = command.name;
    const grade = Object.hasOwn(grades, name) ? grades[name] : undefined;
    if (seen.has(name) || candidateNames.has(name) || !validName.test(name) || grade === undefined || grade === 'broken' || grade === 'system') return false;
    candidateNames.add(name);
    return true;
  });
  if (commands.length + candidates.length > limit) {
    throw new Error(`${surface} command catalog exceeds ${limit} slots`);
  }
  for (const command of candidates) {
    const name = command.name;
    const description = command.description.replace(/\s+/g, ' ').trim();
    const suffix = ` (${surface === 'telegram' ? '텔레그램' : '디스코드'} 미지원)`;
    commands.push({ name, description: `${description.slice(0, 100 - suffix.length)}${suffix}`, supported: false });
    seen.add(name);
  }
  const unsupported = new Set(commands.filter((command) => !command.supported).map((command) => command.name));
  return {
    commands,
    unsupportedReply(name) {
      return unsupported.has(name) ? `/${name}은(는) ${surface === 'telegram' ? '텔레그램' : '디스코드'}에서 아직 지원되지 않습니다. TUI에서 /${name}을(를) 사용하세요.` : null;
    },
  };
}
