import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerAutopilotCommands } from './autopilot-cli.js';

// Literal baseline recorded from src/index.ts before extraction (Commander registration tree).
const expectedSubcommands = [
  "task-agent-action",
  "run",
  "rerun",
  "signal",
  "review",
  "rereflect",
  "merge",
  "list",
  "threads",
  "trace",
  "resources",
  "approve",
  "arm",
  "materialize",
  "cancel",
  "history",
  "pipeline",
  "briefing",
  "landing",
  "reconcile",
  "inject",
  "check",
  "escalate",
  "prepare-log",
  "decompose-crash",
  "decompose-stream",
  "promote",
  "freshness",
  "restart-daemon",
  "add-phase",
  "pause",
  "resume",
  "system-repair",
  "phases",
  "rebuild",
  "split",
  "skip",
  "revise",
  "revise-suggest",
  "insert-arc",
  "reorder-arc",
  "insert-phase",
  "delete-phase",
  "delete-arc",
  "decide",
  "link",
  "unlink",
  "maturity-split",
  "redesign",
  "negotiate"
];
const expectedFlags = {
  "autopilot": [],
  "task-agent-action": [],
  "run": [
    "-b, --backend <id>",
    "-i, --max-iterations <n>",
    "-w, --max-wallclock-ms <ms>",
    "-c, --max-output-chars <n>",
    "-d, --cwd <path>",
    "-v, --verbose",
    "-p, --auto-plan"
  ],
  "rerun": [
    "-f, --from <index>"
  ],
  "signal": [
    "--reason <r>",
    "--phase <id>"
  ],
  "review": [],
  "rereflect": [],
  "merge": [],
  "list": [
    "--status <s>",
    "--source <s>",
    "--json"
  ],
  "threads": [
    "--active",
    "--within <min>",
    "--json"
  ],
  "trace": [
    "--json"
  ],
  "resources": [
    "--json"
  ],
  "approve": [
    "--json"
  ],
  "arm": [
    "--command <c>",
    "--cron <expr>",
    "--prompt <p>",
    "--json"
  ],
  "materialize": [
    "--command <c>",
    "--cron <expr>",
    "--prompt <p>",
    "--json"
  ],
  "cancel": [
    "--json"
  ],
  "history": [
    "--full",
    "--json"
  ],
  "pipeline": [
    "--sub <s>",
    "--persist",
    "--to-stage <s>",
    "--n <k>",
    "--generation <g>",
    "--phase <p>",
    "--kind <k>",
    "--model <m>",
    "--effort <e>",
    "--append <t>",
    "--json"
  ],
  "briefing": [
    "--send",
    "--no-grounded",
    "--json"
  ],
  "landing": [
    "--json"
  ],
  "reconcile": [
    "--notify",
    "--json"
  ],
  "inject": [
    "--phase <p>",
    "--status <s>",
    "--pr <n>",
    "--note <t>",
    "--reusables <csv>",
    "--decisions <csv>",
    "--json",
    "--arc <name>"
  ],
  "check": [
    "--json"
  ],
  "escalate": [
    "--json"
  ],
  "prepare-log": [
    "--tail <n>",
    "--json"
  ],
  "decompose-crash": [
    "--limit <n>",
    "--json"
  ],
  "decompose-stream": [
    "--tail <n>",
    "-f, --follow"
  ],
  "promote": [
    "--from <dir>",
    "--repo <path>",
    "--with-tasks",
    "--yes"
  ],
  "freshness": [
    "--base <sha>",
    "--files <csv>",
    "--no-fetch"
  ],
  "restart-daemon": [
    "--env <e>",
    "--execute",
    "--force"
  ],
  "add-phase": [
    "--prompt <p>",
    "--json"
  ],
  "pause": [
    "--json"
  ],
  "resume": [
    "--json"
  ],
  "system-repair": [],
  "phases": [
    "--json"
  ],
  "rebuild": [
    "--json"
  ],
  "split": [
    "--json"
  ],
  "skip": [
    "--json"
  ],
  "revise": [
    "--json",
    "--pr <n>"
  ],
  "revise-suggest": [
    "--json",
    "--pr <n>"
  ],
  "insert-arc": [
    "--after <arc>",
    "--phases <refs>",
    "--intent <t>",
    "--json"
  ],
  "reorder-arc": [
    "--json"
  ],
  "insert-phase": [
    "--after <phase>",
    "--prompt <p>",
    "--json"
  ],
  "delete-phase": [
    "--json"
  ],
  "delete-arc": [
    "--json"
  ],
  "decide": [
    "-k, --kind <kind>",
    "--applies-to <t>",
    "--rationale <r>",
    "--actor <a>",
    "--arc <id>",
    "--json"
  ],
  "link": [
    "-r, --relation <kind>",
    "-n, --note <text>"
  ],
  "unlink": [
    "-r, --relation <kind>"
  ],
  "maturity-split": [
    "--apply"
  ],
  "redesign": [],
  "negotiate": []
};

describe('autopilot CLI extraction', () => {
  test('registers the same top-level name and every subcommand/option flag in original order', () => {
    const program = new Command();
    registerAutopilotCommands(program);
    expect(program.commands.map(command => command.name())).toEqual(['autopilot']);
    const autopilot = program.commands[0]!;
    expect(autopilot.name()).toBe('autopilot');
    expect(autopilot.commands.map(command => command.name())).toEqual(expectedSubcommands);
    const commands: [string, Command][] = [['autopilot', autopilot], ...autopilot.commands.map(command => [command.name(), command] as [string, Command])];
    expect(Object.fromEntries(commands.map(([name, command]) =>
      [name, command.options.map(option => option.flags)]))).toEqual(expectedFlags);
  });

  test('preserves run defaults and subcommand aliases in an isolated Command', () => {
    const program = new Command();
    registerAutopilotCommands(program);
    const autopilot = program.commands[0]!;
    const run = autopilot.commands.find(command => command.name() === 'run')!;
    expect(run.options.map(option => option.defaultValue)).toEqual(['claude', '1', '0', '0', undefined, undefined, undefined]);
    expect(autopilot.commands.find(command => command.name() === 'rerun')!.options[0]!.defaultValue).toBe('0');
    expect(autopilot.commands.find(command => command.name() === 'resources')!.aliases()).toEqual(['res']);
    expect(autopilot.commands.find(command => command.name() === 'briefing')!.aliases()).toEqual(['brief']);
    expect(autopilot.commands.find(command => command.name() === 'landing')!.aliases()).toEqual(['land']);
  });
});
