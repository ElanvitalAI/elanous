// ELS-PANE-AGENT-DETECT (OP #102878): what a pane runs NOW, not what it was started with. A shell pane where someone
// runs eln / codex / claude / grok is that agent from then on, and a shell again when it exits. The els server reads the
// foreground process group of each PTY (its shell's tpgid) from one `ps -A -o pid=,tpgid=,args=` snapshot a second.
// Pure: the snapshot text and the shell pids come in; the kind and the foreground command line go out.

import { detectRuntime } from './runtime-adapters/index.js';

export type PaneKind = 'shell' | 'eln' | 'codex' | 'claude' | 'grok' | 'other';

export interface Foreground { readonly kind: PaneKind; readonly command: readonly string[]; readonly pid: number }

/** The kind of a command line: the first word past the runtime wrappers decides (never an argument). ELS-RUNTIME-ADAPTERS:
 *  each runtime's adapter recognises its own executable (src/els/runtime-adapters/); none = «other». */
export function kindOfCommand(command: readonly string[]): PaneKind {
  return detectRuntime({ cmdline: command }) ?? 'other';
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
