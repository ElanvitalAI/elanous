// ELS-SKILL literals (OP #103395): `els --skill` exits 0 and prints the guide; its verb table is the real command table —
// captured verbs stay in it in order, new verbs may join without editing this file, hidden commands never appear; the pane env names verbatim.
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerElsCommands, skillVerbs } from '../cli/els-cli.js';
import { ELS_PANE_ENV } from './skill.js';

const sideOf = (): Command => {
  const program = new Command();
  registerElsCommands(program);
  return program.commands.find((command) => command.name() === 'side')!;
};

// Verbs captured when the guide was written (OP #103395) — they must stay in the table, in this order, as typed.
const CAPTURED_VERBS = [
  'els seat set <seat>', 'els supervisor on', 'els supervisor off', 'els supervisor status', 'els serve', 'els mcp serve', 'els acp serve',
  'els ls', 'els new [command...]', 'els read <pane>', 'els status <pane>', 'els grep <pattern>', 'els send <pane> <text>',
  'els do <pane> <text>', 'els snapshot <pane>', 'els record <pane>', 'els input <pane> <text>', 'els workspace list', 'els workspace create [command...]', 'els workspace close <workspace>',
  'els workspace move <workspace>', 'els tab list', 'els tab move <tab>', 'els attach <pane>', 'els pane list',
  'els pane read <pane>', 'els pane send-text <pane> <text>', 'els pane run <pane> <text>', 'els pane send-keys <pane> <keys...>',
  'els pane close <pane>', 'els import herdr',
];

test('the verb table keeps every captured verb in order and leaves hidden commands out', () => {
  const side = sideOf();
  const usages = skillVerbs(side).map((verb) => verb.usage);
  let cursor = 0;
  for (const verb of CAPTURED_VERBS) {
    const at = usages.indexOf(verb, cursor);
    expect({ verb, inOrder: at !== -1 }).toEqual({ verb, inOrder: true });
    cursor = at + 1;
  }
  expect(new Set(usages).size).toBe(usages.length);
  const hidden: string[] = [];
  const walk = (command: Command, prefix: string): void => {
    for (const child of command.commands) {
      const path = `${prefix} ${child.name()}`;
      if ((child as unknown as { _hidden?: boolean })._hidden || child.name().startsWith('_')) hidden.push(path);
      walk(child, path);
    }
  };
  walk(side, 'els');
  expect(hidden).toContain('els _wake-request');
  for (const path of hidden) expect(usages.filter((usage) => usage === path || usage.startsWith(`${path} `))).toEqual([]);
});

test('`els --skill` exits 0 and prints the guide: verbs from the table, the three pane env names, plain one-line rule, doors', async () => {
  const program = new Command();
  registerElsCommands(program);
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.exitCode = 0;
  try { await program.parseAsync(['side', '--skill'], { from: 'user' }); } finally { process.stdout.write = write; }
  expect(process.exitCode ?? 0).toBe(0);
  const text = out.join('');
  expect(ELS_PANE_ENV).toEqual(['ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET']);
  for (const name of ['ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET']) expect(text).toContain(`\`${name}\``);
  expect(text).toContain('| `els status <pane>` |');
  expect(text).toContain('| `els pane send-keys <pane> <keys...>` |');
  expect(text).toContain('**one line only**');
  expect(text).toContain('`els mcp serve`');
  expect(text).toContain('`els acp serve`');
  expect(text).not.toContain('_wake-request');
});

test('`els --help` ends with the pointer for agents', () => {
  expect(sideOf().helpInformation() + '').toBeDefined();
  let help = '';
  const side = sideOf();
  side.configureOutput({ writeOut: (chunk) => { help += chunk; } });
  side.outputHelp();
  expect(help.trimEnd().split('\n').at(-1)).toBe('Agents: run `els --skill` for the usage guide (verbs, rules, what not to do).');
});
