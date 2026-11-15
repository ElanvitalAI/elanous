export interface RootProviderFlags {
  readonly args: string[];
  readonly provider?: string;
  readonly model?: string;
  readonly error?: string;
}

type RegisteredRootOption = { readonly required?: boolean; readonly optional?: boolean; readonly short?: string; readonly long?: string };

/** Read value-taking flags from the registered root Commander options. */
export function rootValueOptionNames(options: readonly RegisteredRootOption[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const option of options) {
    if (!option.required && !option.optional) continue;
    if (option.short) names.add(option.short);
    if (option.long) names.add(option.long);
  }
  return names;
}

/** Only the root launch-option prefix owns these flags; subcommands keep theirs. */
export function extractRootProviderFlags(raw: readonly string[], rootValueOptions: ReadonlySet<string>): RootProviderFlags {
  const args: string[] = [];
  let provider: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (arg === '--') { args.push(...raw.slice(i)); break; }
    if (!arg.startsWith('-')) { args.push(...raw.slice(i)); break; }
    if (arg === '--provider' || arg.startsWith('--provider=') || arg === '--model' || arg.startsWith('--model=')) {
      const key = arg.startsWith('--provider') ? 'provider' : 'model';
      const inline = arg.includes('=');
      const value = inline ? arg.slice(arg.indexOf('=') + 1) : raw[++i];
      if (!value || value.startsWith('--')) return { args: [...raw], error: `elanous: --${key} requires a value` };
      if (key === 'provider') {
        if (provider !== undefined) return { args: [...raw], error: 'elanous: duplicate --provider' };
        provider = value;
      } else {
        if (model !== undefined) return { args: [...raw], error: 'elanous: duplicate --model' };
        model = value;
      }
      continue;
    }
    args.push(arg);
    if (rootValueOptions.has(arg)) {
      if (raw[i + 1] && !raw[i + 1]!.startsWith('-')) args.push(raw[++i]!);
    }
  }
  if (model && !provider) return { args, error: 'elanous: --model requires --provider' };
  return { args, ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}
