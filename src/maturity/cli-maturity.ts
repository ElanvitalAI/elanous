import type { Command } from 'commander';
import { program } from '../index.js';
import { FEATURE_MATURITY, type Maturity, type Role } from './feature-maturity.js';

/** Commander owns aliases; the table contains canonical command names only. */
export function cliRootMaturity(name: string, commands: readonly Command[] = program.commands): Maturity | undefined {
  const command = commands.find((entry) => entry.name() === name || entry.aliases().includes(name));
  const canonical = command?.name() ?? name;
  return Object.prototype.hasOwnProperty.call(FEATURE_MATURITY.cliRoot, canonical)
    ? FEATURE_MATURITY.cliRoot[canonical as keyof typeof FEATURE_MATURITY.cliRoot]
    : undefined;
}

export function cliRootVisibleFor(name: string, role: Role, { showAll }: { showAll: boolean }, commands: readonly Command[] = program.commands): boolean {
  const grade = cliRootMaturity(name, commands);
  if (!grade || grade === 'system') return false;
  if (showAll || role === 'owner') return true;
  return grade === 'stable' || (role === 'contributor' && (grade === 'beta' || grade === 'tool'));
}

/** Only help is filtered: Commander still dispatches explicitly typed commands. */
export function filterCliRootHelp(commands: readonly Command[], role: Role, showAll: boolean): { shown: number; hidden: number } {
  let shown = 0;
  let hidden = 0;
  for (const command of commands) {
    const grade = cliRootMaturity(command.name(), commands);
    if (!grade) throw new Error(`cliRoot 에 등급 없는 명령: ${command.name()}`);
    const visible = cliRootVisibleFor(command.name(), role, { showAll }, commands);
    (command as Command & { _hidden: boolean })._hidden = !visible;
    if (visible) shown++;
    else hidden++;
  }
  return { shown, hidden };
}
