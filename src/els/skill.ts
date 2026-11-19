// ELS-SKILL (OP #103395 · orders/ELS-OP-SMALLWINS-1119.md 18:5x): `els --skill` — one page an agent reads the first time it
// lands in an els pane (the shape of `herdr --skill`). The text lives here once; the verb table is built from the real
// command table (els-cli.ts hands in every visible command), so a new verb shows up without anyone editing this file.

/** The variables els sets in every pane it starts (core.ts spawn env + the server's socket). */
export const ELS_PANE_ENV = ['ELANOUS_ELS_WS', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET'] as const;

export interface SkillVerb {
  /** As typed: `els pane send-keys <pane> <keys...>`. */
  readonly usage: string;
  /** The command's own one-line description. */
  readonly summary: string;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function elsSkillText(verbs: readonly SkillVerb[]): string {
  return [
    '---',
    'name: els',
    'description: "Control Elanous Side (els): workspaces, tabs and panes of shells and coding agents (eln, codex, claude, grok) on this machine and registered hosts. Use when the user mentions els or asks to inspect or drive another pane or agent from inside an els pane."',
    '---',
    '',
    '# els',
    '',
    'els is the Elanous side screen: one server owns every pane\'s PTY, and the `els` CLI talks to it.',
    'Panes live in tabs inside workspaces; a pane is a shell or an agent, and els recognises the agent running in it now.',
    'Most commands answer JSON — read ids and states from the answer instead of guessing them.',
    '',
    '## Am I inside els?',
    '',
    `A pane els started has ${ELS_PANE_ENV.map((name) => `\`${name}\``).join(', ')} set:`,
    '',
    '```bash',
    'test -n "${ELANOUS_ELS_SOCKET:-}" && echo "inside els pane ${ELANOUS_ELS_PANE} (workspace ${ELANOUS_ELS_WS})"',
    '```',
    '',
    'Outside an els pane, say so and do not drive other people\'s panes.',
    '',
    '## Verbs',
    '',
    '| command | what it does |',
    '|---|---|',
    ...verbs.map((verb) => `| \`${cell(verb.usage)}\` | ${cell(verb.summary)} |`),
    '',
    'Do not run bare `els` to explore: in a terminal it opens the whole screen. Use `els --help` and `els <group>` instead.',
    '',
    '## Sending text to a pane',
    '',
    '- `els status <pane>` first: send only when it says `idle` (and `input empty` if you must not mix with a half-typed line).',
    '- `els send` checks that the text arrived whole. A pane without bracketed paste takes **one line only** — a line break',
    '  or a control byte inside the text is refused, never typed (use a pane with bracketed paste for several lines).',
    '- `els do <pane> <text>` queues the line while a turn is running instead of typing over it.',
    '',
    '## Stalls and wake-ups',
    '',
    '- A working pane with no output (or the same tool on its working row) for the threshold mails OP once per stall',
    '  (`ELANOUS_ELS_STALL_MS`, default 5 min; 0 turns it off).',
    '- Mail for a seat can wake the eln in its pane; you do not need to poll for it.',
    '',
    '## Do not',
    '',
    '- Close, rename or move a pane, tab or workspace that is not yours without the person\'s yes.',
    '- Work around a refusal from the control door (`denied`, `held`, `rejected`): report it and stop.',
    '- Type into a pane whose turn is running, or send a person\'s credentials anywhere.',
    '',
    '## Other doors',
    '',
    '- `els mcp serve` — els as an MCP server (same allow list, audit and person-in-the-loop as the CLI).',
    '- `els acp serve` — els as an ACP agent.',
    '',
  ].join('\n');
}
