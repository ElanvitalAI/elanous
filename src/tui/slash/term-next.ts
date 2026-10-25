/** Read-only terminal view exposed to the Next TUI. Tests can inject an isolated fake. */
export interface NextTuiTermSession {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: 'running' | 'backgrounded' | 'completed' | 'killed' | 'exited';
  readonly cwd?: string;
  readonly exitCode?: number | null;
}

export interface NextTuiTermSlashContext {
  readonly chatLines: string[];
  readonly setChatScrollOffset: (value: number) => void;
  readonly sessions: { list(): readonly NextTuiTermSession[] | Promise<readonly NextTuiTermSession[]> };
}

const isLive = (session: NextTuiTermSession): boolean =>
  session.status === 'running' || session.status === 'backgrounded';

const unknownOrValue = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? 'unknown' : String(value);

function sessionLines(sessions: readonly NextTuiTermSession[]): string[] {
  if (sessions.length === 0) return ['  No terminal sessions.'];
  return sessions.map((session) => {
    const exit = isLive(session) ? 'not-exited' : unknownOrValue(session.exitCode);
    return `  ${session.status.padEnd(12)} ${session.id.slice(-8)} ${session.title} · cwd=${unknownOrValue(session.cwd)} · exitCode=${exit}`;
  });
}

function matrixLines(sessions: readonly NextTuiTermSession[]): string[] {
  if (sessions.length === 0) return ['  No terminal sessions.'];
  return [
    '  term:ID    character    transport   placement         groups     title',
    ...sessions.map((session) => {
      const dead = isLive(session) ? '' : ' exited';
      return `  ${session.id.padEnd(10)} ${session.kind.padEnd(12)} pty         pty               -          ${session.title}${dead}`;
    }),
  ];
}

/** Next TUI exposes only read-only terminal inventory and status. */
export async function handleNextTuiTermSlash(args: string[], context: NextTuiTermSlashContext): Promise<void> {
  const command = (args[0] ?? 'help').trim().toLowerCase();
  if (command === '' || command === 'help') {
    context.chatLines.push(
      '  /term help    Show Next TUI terminal commands.',
      '  /term list    List terminal sessions.',
      '  /term status  Show live/exited session counts.',
      '  /term matrix  Show terminal transport and liveness.',
      '  Unknown cwd or exit codes are shown as unknown.',
      '  Mutating terminal commands remain on the classic terminal surface.',
    );
  } else if (command === 'status') {
    const sessions = await context.sessions.list();
    const live = sessions.filter(isLive).length;
    const exited = sessions.length - live;
    context.chatLines.push(`  Terminal sessions: ${live} live · ${exited} exited.`);
  } else if (command === 'list' || command === 'matrix') {
    const sessions = await context.sessions.list();
    context.chatLines.push(...(command === 'list' ? sessionLines(sessions) : matrixLines(sessions)));
  } else {
    context.chatLines.push(`  Unsupported /term command in Next TUI: ${command}. Try /term help.`);
  }
  context.setChatScrollOffset(-1);
}

/** The entry point reaches this only for `/term` or `/terminal` input. */
export async function dispatchNextTermSlash(args: string[], context: NextTuiTermSlashContext): Promise<void> {
  await handleNextTuiTermSlash(args, context);
}
