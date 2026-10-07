import type { SlashCommand } from '../../chat/index.js';
import { readTuiSlashAudience, slashMaturity, slashVisibleFor } from '../../maturity/tui-slash-maturity.js';
import type { Role } from '../../maturity/feature-maturity.js';
import { visibleWidth } from '../../tui.js';
import { HELP_GROUP_ORDER, helpGroupFor } from './help-groups.js';

const ESSENTIAL_KEYS = [
  ['Enter', 'Send message'],
  // U1 · 2026-10-02 — stopping and queueing while an answer streams were missing from help (same line count:
  // the modal has a row budget and falls back to the chat log when it is exceeded).
  ['Esc', 'Stop the answer (Esc again = rewind) · clear input / close help'],
  ['Ctrl+U', 'Clear text before cursor'],
  ['Ctrl+W', 'Delete previous word'],
  ['Ctrl+← / →', 'Move by word'],
  ['Delete', 'Delete next character'],
  ['Home / End', 'Move to start / end of line'],
  ['Ctrl+A / E', 'Move to start / end of line'],
  ['PgUp / PgDn', 'Scroll chat log'],
  ['Ctrl+↑', 'Recall a queued line (Enter while answering queues it)'],
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

/** Head line for one help group (never starts with `/`, so it can't read as a command). */
export function helpGroupHeading(group: string): string {
  return `▸ ${group}`;
}

/** Plain content for the dashboard modal; registration, not the picker, decides which slash names exist. */
export function buildEssentialHelpLines({
  names,
  descriptions,
  width,
  audience = readTuiSlashAudience(),
}: {
  names: readonly string[];
  descriptions: readonly Pick<SlashCommand, 'name' | 'aliases' | 'description'>[];
  width: number;
  audience?: { role: Role; showBeta: boolean };
}): string[] {
  const registered = new Set(names);
  const entries = descriptions
    .filter((command) => registered.has(command.name) &&
      ((audience.role === 'owner' && slashMaturity(command.name) === undefined) || slashVisibleFor(command.name, audience.role, { showBeta: audience.showBeta })))
    .map((command) => {
      const aliases = [...new Set(command.aliases ?? [])].filter((alias) => registered.has(alias) && alias !== command.name);
      const label = `/${command.name}${aliases.length ? ` (${aliases.join(', ')})` : ''}`;
      const description = command.description.replace(/\s+/g, ' ').trim()
        .replace(/^(?:(?:H\d+\s+P\d+|CV-\d+|Sprint\s+\d+|Showroom\s+v2)(?:\s*[·—:]\s*|\s+))+/i, '')
        .trim();
      return { label, name: command.name, description };
    })
    .filter(({ label, description }) => description && !/[│╭╮╰╯┌┐└┘─]/.test(label))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Reserve the longest label, 28 description characters, and an ellipsis
  // in each cell. Never trade a missing label for a shorter modal.
  const widestLabel = Math.max(0, ...entries.map(({ label }) => visibleWidth(label)));
  const readableCellWidth = widestLabel + 2 + 28 + 1;
  const columns = entries.length >= 40 && width >= 100
    ? Math.max(1, Math.floor(width / (readableCellWidth + 1)))
    : 1;
  const columnWidth = Math.floor(width / columns);
  // Task order (TUI-SLASH-DECIDE-NOW C): group head line, then that group's commands by name.
  // Empty groups print no head; unmapped commands land in «그 밖», so none disappears.
  const commandLines: string[] = [];
  for (const group of HELP_GROUP_ORDER) {
    const members = entries.filter(({ name }) => helpGroupFor(name) === group);
    if (members.length === 0) continue;
    commandLines.push(fitLine(helpGroupHeading(group), width));
    for (let start = 0; start < members.length; start += columns) {
      const cells = members.slice(start, start + columns).map(({ label, description }) => {
        const cellWidth = columnWidth - (columns > 1 ? 1 : 0);
        return visibleWidth(`${label}  `) > cellWidth ? '' : fitLine(`${label}  ${description}`, cellWidth);
      });
      commandLines.push(cells.map((cell, index) =>
        index === cells.length - 1 ? cell : cell + ' '.repeat(columnWidth - visibleWidth(cell)),
      ).join('').trimEnd());
    }
  }
  const keyItems = ESSENTIAL_KEYS.map(([key, description]) => `${key}  ${description}`);
  const keyLines: string[] = [];
  if (entries.length >= 40 && width >= 100) {
    let keyRow = '';
    for (const item of keyItems) {
      if (keyRow && visibleWidth(keyRow) + 2 + visibleWidth(item) > width) {
        keyLines.push(keyRow);
        keyRow = '';
      }
      keyRow += (keyRow ? '  ' : '') + fitLine(item, width);
    }
    if (keyRow) keyLines.push(keyRow);
  } else {
    keyLines.push(...keyItems.map((item) => fitLine(item, width)));
  }
  return [fitLine('Commands', width), ...commandLines, '', fitLine('Keys', width), ...keyLines];
}
