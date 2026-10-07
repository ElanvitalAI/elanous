import { afterEach, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../../chat/index.js';
import { FEATURE_MATURITY } from '../../maturity/feature-maturity.js';
import { setUserConfigOverlay } from '../../user-config.js';
import { buildEssentialHelpLines } from './help-from-registry.js';
import { HELP_GROUP_BY_NAME, HELP_GROUP_ORDER, HELP_OTHER_GROUP, HELP_VERB_GROUPS } from './help-groups.js';

const descriptions = [
  { name: 'help', description: 'Show help overlay' },
  { name: 'session', description: 'Session resume' },
  { name: 'model', description: 'Switch active model' },
  { name: 'ghost', description: 'A description alone must not create a command' },
  { name: 'bordered', description: '┌│╭╰ bordered description' },
  { name: 'odd│name', description: 'Should not become a different slash' },
];

afterEach(() => setUserConfigOverlay(null));

test('MAT1c default help audience reads tui config', () => {
  const names = ['help', 'research', 'debug', 'directive'];
  const descriptions = SLASH_COMMANDS.filter(({ name }) => names.includes(name));
  setUserConfigOverlay((config) => ({ ...config, raw: { ...config.raw, tui: { role: 'general', showBeta: true } } }));
  const lines = buildEssentialHelpLines({ names, descriptions, width: 80 }).join('\n');
  expect(lines).toContain('/help');
  expect(lines).toContain('/research');
  expect(lines).not.toContain('/debug');
  expect(lines).not.toContain('/directive');
});

test('MAT1c registered ungraded command appears for owner but not general or contributor', () => {
  const input = {
    names: ['ghost'],
    descriptions: [{ name: 'ghost', description: 'External registered slash' }],
    width: 80,
  };
  for (const role of ['general', 'contributor'] as const) {
    setUserConfigOverlay((config) => ({ ...config, raw: { ...config.raw, tui: { role } } }));
    expect(buildEssentialHelpLines(input).join('\n')).not.toContain('/ghost');
  }
  expect(buildEssentialHelpLines({ ...input, audience: { role: 'owner', showBeta: false } }))
    .toContain('/ghost  External registered slash');
});

test('MAT1c help defaults to owner and filters the same grades for general and contributor', () => {
  const names = SLASH_COMMANDS.map(({ name }) => name);
  const descriptions = SLASH_COMMANDS;
  const render = (audience?: { role: 'owner' | 'contributor' | 'general'; showBeta: boolean }) =>
    buildEssentialHelpLines({ names, descriptions, width: 110, audience }).join('\n');
  const listed = (text: string) => SLASH_COMMANDS.filter(({ name }) => new RegExp(`(?:^|\\s)/${name}(?:\\s|\\()`).test(text)).map(({ name }) => name);
  const owner = render();
  expect(listed(owner)).toEqual(names);
  const general = render({ role: 'general', showBeta: false });
  expect(listed(general)).toEqual(names.filter((name) => FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash] === 'stable'));
  expect(general).toContain('/help');
  expect(general).not.toContain('/research');
  expect(general).not.toContain('/debug');
  expect(general).not.toContain('/directive');
  const beta = render({ role: 'general', showBeta: true });
  expect(listed(beta)).toEqual(names.filter((name) => ['stable', 'beta'].includes(FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash])));
  expect(beta).toContain('/research');
  expect(beta).not.toContain('/debug');
  expect(beta).not.toContain('/directive');
  const contributor = render({ role: 'contributor', showBeta: false });
  expect(listed(contributor)).toEqual(names.filter((name) => FEATURE_MATURITY.tuiSlash[name as keyof typeof FEATURE_MATURITY.tuiSlash] !== 'ops'));
  expect(contributor).toContain('/research');
  expect(contributor).toContain('/debug');
  expect(contributor).not.toContain('/directive');
});

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

  const withGhost = buildEssentialHelpLines({ names: [...names, 'ghost'], descriptions, width: 80, audience: { role: 'owner', showBeta: false } });
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

test('groups registered aliases under their primary name once, alphabetically', () => {
  const commands = [
    { name: 'quit', aliases: ['q', 'exit'], description: 'Leave' },
    { name: 'model', aliases: ['m'], description: 'Switch active model' },
  ];
  const lines = buildEssentialHelpLines({
    names: ['exit', 'model', 'q', 'm', 'quit', 'model'], descriptions: commands, width: 80,
  });
  expect(lines.slice(1, lines.indexOf(''))).toEqual([
    '▸ 시작', '/model (m)  Switch active model', '▸ 그 밖', '/quit (q, exit)  Leave',
  ]);
  expect(lines.join('\n')).not.toContain('/m  ');
  expect(lines.join('\n')).not.toContain('/exit  ');
  expect(buildEssentialHelpLines({ names: ['quit', 'q'], descriptions: commands, width: 80 })[2]).toBe('/quit (q)  Leave');
});

test('strips leading internal markers only in rendered descriptions', () => {
  const marked = ['H6 P4 · Agent room', 'H5 P3: cross-agent handoff', 'CV-12 — Show flows',
    'Sprint 7   Build flows', 'Showroom v2 — multi-LLM lanes'];
  const descriptions = marked.map((description, index) => ({ name: `item${index}`, description }));
  const lines = buildEssentialHelpLines({ names: descriptions.map(({ name }) => name), descriptions, width: 80 });
  expect(lines.slice(1, lines.indexOf(''))).toEqual([
    '▸ 그 밖',
    '/item0  Agent room', '/item1  cross-agent handoff', '/item2  Show flows',
    '/item3  Build flows', '/item4  multi-LLM lanes',
  ]);
  expect(descriptions.map(({ description }) => description)).toEqual(marked);
});

test('at the 160-column modal content width a long registered label among 60 commands retains 28 description characters', () => {
  const text = 'The first twenty eight letters of this long command description continue beyond the row';
  const commands: Array<{ name: string; aliases?: string[]; description: string }> =
    Array.from({ length: 59 }, (_, index) => ({ name: `item${index}`, description: text }));
  commands.push({ name: 'long-command-label', aliases: ['alternate'], description: text });
  const lines = buildEssentialHelpLines({ names: commands.flatMap(({ name, aliases }) => [name, ...(aliases ?? [])]), descriptions: commands, width: 160 });
  const commandText = lines.slice(1, lines.indexOf('')).join('\n');
  for (const { name, aliases } of commands) {
    const label = `/${name}${aliases?.length ? ` (${aliases.join(', ')})` : ''}`;
    expect(commandText).toContain(`${label}  ${text.slice(0, 28)}`);
  }
  expect(lines.every((line) => Bun.stringWidth(line) <= 160)).toBe(true);
  expect(commandText).toContain('…');
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

test('TUI-SLASH-DECIDE-NOW C: group order is 시작, the seven verbs, then 그 밖 — /model, /decide and /now under their groups', () => {
  expect(HELP_GROUP_ORDER).toEqual(['시작', '지켜보기', '조사하기', '판단하기', '만들기', '실행하기', '확인하기', '기억하기', '그 밖']);
  expect([...HELP_VERB_GROUPS]).toEqual(['지켜보기', '조사하기', '판단하기', '만들기', '실행하기', '확인하기', '기억하기']);
  const names = SLASH_COMMANDS.flatMap(({ name, aliases }) => [name, ...(aliases ?? [])]);
  const lines = buildEssentialHelpLines({ names, descriptions: SLASH_COMMANDS, width: 80, audience: { role: 'owner', showBeta: true } });
  const commands = lines.slice(1, lines.indexOf(''));
  const heads = commands.filter((line) => line.startsWith('▸ ')).map((line) => line.slice(2));
  expect(heads).toEqual([...HELP_GROUP_ORDER]);
  const groupOf = (name: string) => {
    const at = commands.findIndex((line) => new RegExp(`^/${name}(?:\\s|\\()`).test(line));
    expect(at).toBeGreaterThan(-1);
    return commands.slice(0, at).filter((line) => line.startsWith('▸ ')).at(-1)!.slice(2);
  };
  expect(groupOf('model')).toBe('시작');
  expect(groupOf('help')).toBe('시작');
  expect(groupOf('status')).toBe('시작');
  expect(groupOf('decide')).toBe('판단하기');
  expect(groupOf('now')).toBe('지켜보기');
  expect(groupOf('harness')).toBe('만들기');
  expect(groupOf('memory')).toBe('기억하기');
  expect(groupOf('provider')).toBe(HELP_OTHER_GROUP);
  // Inside a group: name order.
  const start = commands.slice(commands.indexOf('▸ 시작') + 1, commands.indexOf('▸ 지켜보기')).map((line) => line.split(/[ (]/)[0]);
  expect(start).toEqual([...start].sort((a, b) => a.localeCompare(b)));
});

test('TUI-SLASH-DECIDE-NOW C: every registered command sits in exactly one group — none disappears', () => {
  const names = SLASH_COMMANDS.flatMap(({ name, aliases }) => [name, ...(aliases ?? [])]);
  for (const width of [80, 152]) {
    const lines = buildEssentialHelpLines({ names, descriptions: SLASH_COMMANDS, width, audience: { role: 'owner', showBeta: true } });
    const commandText = lines.slice(1, lines.indexOf('')).join('\n');
    for (const { name } of SLASH_COMMANDS) {
      // At 80 columns each row holds one command, so a command line starts with its label.
      if (width === 80) expect(commandText.match(new RegExp(`^/${name}(?:\\s|\\()`, 'gm'))?.length).toBe(1);
      else expect(commandText).toMatch(new RegExp(`(?:^|\\s)/${name}(?:\\s|\\()`, 'm'));
    }
  }
  // The table names only real commands or the planned /new; it never invents a slash.
  const known = new Set([...SLASH_COMMANDS.map(({ name }) => name), 'new']);
  expect([...HELP_GROUP_BY_NAME.keys()].filter((name) => !known.has(name))).toEqual([]);
  // A command missing from the table falls into 그 밖, and empty groups print no head.
  const lone = buildEssentialHelpLines({ names: ['zz-unmapped'], descriptions: [{ name: 'zz-unmapped', description: 'Unmapped' }], width: 80, audience: { role: 'owner', showBeta: false } });
  expect(lone.slice(1, lone.indexOf(''))).toEqual(['▸ 그 밖', '/zz-unmapped  Unmapped']);
});
