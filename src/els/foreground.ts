// ELS-PANE-AGENT-DETECT (OP #102878): what a pane runs NOW, not what it was started with. A shell pane where someone
// runs eln / codex / claude / grok is that agent from then on, and a shell again when it exits. The els server reads the
// foreground process group of each PTY (its shell's tpgid) from one `ps -A -o pid=,tpgid=,args=` snapshot a second.
// Pure: the snapshot text and the shell pids come in; the kind and the foreground command line go out.

export type PaneKind = 'shell' | 'eln' | 'codex' | 'claude' | 'grok' | 'other';

export interface Foreground { readonly kind: PaneKind; readonly command: readonly string[]; readonly pid: number }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'pwsh', 'dash', 'ksh', 'tcsh', 'csh']);
const ELN = new Set(['eln', 'elanous', 'elanous.mjs']);
const AGENT_KIND: Readonly<Record<string, PaneKind>> = { codex: 'codex', claude: 'claude', grok: 'grok' };
// 출처: src/els/space-tabs-view.ts WRAPPERS (#38438 review must[2]) — runtime wrappers are skipped to the real executable.
const WRAPPERS = new Set(['bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno']);
const baseName = (part: string): string => (part.split('/').pop() ?? part).replace(/^-/, '');   // «-zsh» = a login shell

/** The kind of a command line: the first word past the runtime wrappers decides (never an argument). */
export function kindOfCommand(command: readonly string[]): PaneKind {
  let at = 0;
  while (at + 1 < command.length && WRAPPERS.has(baseName(command[at]!))) at++;
  const exe = baseName(command[at] ?? '');
  if (SHELLS.has(exe)) return 'shell';
  if (ELN.has(exe)) return 'eln';
  return AGENT_KIND[exe] ?? 'other';
}

/** `ps -A -o pid=,tpgid=,args=` text → pid → (foreground group of its terminal, its command line). */
export function parsePs(text: string): Map<number, { readonly tpgid: number; readonly args: readonly string[] }> {
  const table = new Map<number, { tpgid: number; args: string[] }>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), { tpgid: Number(match[2]), args: match[3]!.trim().split(/\s+/) });
  }
  return table;
}

/** A pane's foreground: its shell's terminal foreground group leader. Unknown pid / no terminal → undefined. */
export function foregroundOf(shellPid: number, table: ReturnType<typeof parsePs>): Foreground | undefined {
  const shell = table.get(shellPid);
  if (!shell || shell.tpgid <= 0) return undefined;
  const leader = table.get(shell.tpgid);
  const command = leader?.args ?? shell.args;
  return { kind: kindOfCommand(command), command, pid: leader ? shell.tpgid : shellPid };
}
