import { expect, test } from 'bun:test';
import { buildEssentialHelpLines } from './help-from-registry.js';

const descriptions = [
  { name: 'help', description: 'Show help overlay' },
  { name: 'session', description: 'Session resume' },
  { name: 'model', description: 'Switch active model' },
  { name: 'ghost', description: 'A description alone must not create a command' },
  { name: 'bordered', description: '┌│╭╰ bordered description' },
  { name: 'odd│name', description: 'Should not become a different slash' },
];

test('lists only registered, described commands in name order and essential keys without borders', () => {
  const names = ['session', 'help', 'model'];
  const lines = buildEssentialHelpLines({ names, descriptions, width: 80 });
  expect(lines.filter((line) => line.startsWith('/'))).toEqual([
    '/help  Show help overlay',
    '/model  Switch active model',
    '/session  Session resume',
  ]);
  expect(lines.join('\n')).not.toContain('/ghost');
  expect(lines.slice(lines.indexOf('Keys') + 1).map((line) => line.split('  ')[0])).toEqual([
    'Enter', 'Esc', 'Ctrl+U', 'Ctrl+W', 'Ctrl+← / →', 'Delete',
    'Home / End', 'Ctrl+A / E', 'PgUp / PgDn', 'Ctrl+↑',
  ]);
  expect(lines.join('\n')).not.toMatch(/[│╭╰┌┐└┘─]/);

  const withGhost = buildEssentialHelpLines({ names: [...names, 'ghost'], descriptions, width: 80 });
  expect(withGhost).toContain('/ghost  A description alone must not create a command');
  expect(withGhost.join('\n')).not.toMatch(/[│╭╰┌┐└┘─]/);

  const withBorders = buildEssentialHelpLines({ names: ['bordered', 'odd│name'], descriptions, width: 80 });
  expect(withBorders.join('\n')).not.toMatch(/[│╭╰┌┐└┘─]/);
  expect(withBorders.join('\n')).not.toContain('/oddname');

  const compact = buildEssentialHelpLines({ names: ['session', 'help', 'model'], descriptions, width: 70 });
  expect(compact.filter((line) => line.startsWith('/'))).toEqual([
    '/help  Show help overlay', '/model  Switch active model', '/session  Session resume',
  ]);
});

test('large registry preserves every sorted command and key even beyond a modal viewport', () => {
  const names = Array.from({ length: 101 }, (_, index) => `command${String(index).padStart(3, '0')}`);
  const descriptions = names.map((name) => ({ name, description: 'Description' }));
  for (const width of [110, 152]) {
    const lines = buildEssentialHelpLines({ names, descriptions, width });
    const orderedNames = lines.join('\n').match(/\/command\d{3}  /g)?.map((entry) => entry.slice(1, -2));
    expect(orderedNames).toEqual(names);
    expect(lines.at(-1)).toContain('Ctrl+↑  ');
    expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true);
  }
});

test('never truncates a slash name into an unregistered command', () => {
  const lines = buildEssentialHelpLines({
    names: ['session', 'help'],
    descriptions,
    width: 5,
  });
  expect(lines.filter((line) => line.startsWith('/'))).toEqual([]);
});

test('truncates long descriptions to terminal columns without splitting a grapheme', () => {
  const lines = buildEssentialHelpLines({
    names: ['session'],
    descriptions: [{ name: 'session', description: '한국어 🧑‍💻 session resume description' }],
    width: 20,
  });
  const command = lines.find((line) => line.startsWith('/session'))!;
  expect(command).toEndWith('…');
  expect(Bun.stringWidth(command)).toBeLessThanOrEqual(20);
  expect(command).not.toContain('\ufffd');
});
