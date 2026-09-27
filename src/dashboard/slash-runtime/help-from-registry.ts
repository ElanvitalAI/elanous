import type { SlashCommand } from '../../chat/index.js';
import { visibleWidth } from '../../tui.js';

const ESSENTIAL_KEYS = [
  ['Enter', 'Send message'],
  ['Esc', 'Clear input / close help modal'],
  ['Ctrl+U', 'Clear text before cursor'],
  ['Ctrl+W', 'Delete previous word'],
  ['Ctrl+← / →', 'Move by word'],
  ['Delete', 'Delete next character'],
  ['Home / End', 'Move to start / end of line'],
  ['Ctrl+A / E', 'Move to start / end of line'],
  ['PgUp / PgDn', 'Scroll chat log'],
  ['Ctrl+↑', 'Recall sent line while streaming'],
] as const;

function fitLine(text: string, width: number): string {
  text = text.replace(/[│╭╮╰╯┌┐└┘─]/g, '');
  const max = Math.max(0, Math.floor(width));
  if (visibleWidth(text) <= max) return text;
  if (max === 0) return '';
  let fitted = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (visibleWidth(fitted + segment) > max - 1) break;
    fitted += segment;
  }
  return fitted + '…';
}

/** Plain content for the dashboard modal; registration, not the picker, decides which slash names exist. */
export function buildEssentialHelpLines({
  names,
  descriptions,
  width,
}: {
  names: readonly string[];
  descriptions: readonly Pick<SlashCommand, 'name' | 'aliases' | 'description'>[];
  width: number;
}): string[] {
  const descriptionsByName = new Map<string, string>();
  for (const command of descriptions) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      descriptionsByName.set(name, command.description);
    }
  }
  const entries = [...new Set(names)]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      // Removing border glyphs from a name would invent a different, unregistered slash.
      if (/[│╭╮╰╯┌┐└┘─]/.test(name)) return [];
      const description = descriptionsByName.get(name)?.replace(/\s+/g, ' ').trim();
      return description ? [{ name, description }] : [];
    });
  // Pack alphabetically in reading order across columns; the handler checks
  // the modal's row budget and uses scrollable chat if the result outgrows it.
  const longestName = Math.max(22, ...entries.map(({ name }) => visibleWidth(`/${name}  `) + 1));
  const columns = Math.max(1, Math.min(Math.ceil(entries.length / 20), Math.floor(width / longestName)));
  const columnWidth = Math.floor(width / columns);
  const commandLines: string[] = [];
  for (let start = 0; start < entries.length; start += columns) {
    const cells = entries.slice(start, start + columns).map(({ name, description }) => {
      const cellWidth = columnWidth - (columns > 1 ? 1 : 0);
      if (visibleWidth(`/${name}  `) > cellWidth) return '';
      return fitLine(`/${name}  ${description}`, cellWidth);
    });
    commandLines.push(cells.map((cell, index) =>
      index === cells.length - 1 ? cell : cell + ' '.repeat(columnWidth - visibleWidth(cell)),
    ).join('').trimEnd());
  }
  return [
    fitLine('Commands', width),
    ...commandLines,
    '',
    fitLine('Keys', width),
    ...ESSENTIAL_KEYS.map(([key, description]) => fitLine(`${key}  ${description}`, width)),
  ];
}
