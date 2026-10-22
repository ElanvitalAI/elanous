export interface RootTuiEntry {
  readonly args: string[];
  readonly entry: 'classic' | 'next';
  readonly explicit: boolean;
  readonly error?: string;
}

/** A configured remote still needs the dashboard transport until next supports it. */
export function effectiveRootTuiEntry(root: RootTuiEntry, hasRemote: boolean): 'classic' | 'next' {
  return hasRemote && !root.explicit ? 'classic' : root.entry;
}

/** Extract a root TUI flag only from the launch-option prefix. */
export function extractRootTuiEntry(rawArgs: readonly string[]): RootTuiEntry {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === '--') break;
    if (arg === '--legacy') {
      const args = [...rawArgs.slice(0, i), ...rawArgs.slice(i + 1)];
      const other = extractRootTuiEntry(args);
      return other.explicit
        ? { args, entry: 'classic', explicit: true, error: 'elanous: choose only one of --legacy or --tui' }
        : { args, entry: 'classic', explicit: true };
    }
    if (arg === '--tui' || arg.startsWith('--tui=')) {
      const inline = arg.startsWith('--tui=');
      const value = inline ? arg.slice('--tui='.length) : rawArgs[i + 1];
      if (value !== 'classic' && value !== 'next') {
        return { args: [...rawArgs], entry: 'classic', explicit: true, error: 'elanous: --tui expects classic or next' };
      }
      const args = [...rawArgs.slice(0, i), ...rawArgs.slice(i + (inline ? 1 : 2))];
      const other = extractRootTuiEntry(args);
      return other.explicit
        ? { args, entry: value, explicit: true, error: 'elanous: choose only one of --legacy or --tui' }
        : { args, entry: value, explicit: true };
    }
    // These are the value-taking root launch flags still present here:
    // --config-dir/--test are removed during module initialization, while
    // --local, --continue and dashboard layout flags have no value.
    if (arg === '--resume' || arg === '--name' || arg === '--remote') {
      if (rawArgs[i + 1] && !rawArgs[i + 1]!.startsWith('-')) i++;
      continue;
    }
    if (!arg.startsWith('-')) break;
  }
  // Bare launch opens the classic dashboard; the next TUI is opt-in via `--tui next`.
  return { args: [...rawArgs], entry: 'classic', explicit: false };
}
