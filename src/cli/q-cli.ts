import type { Command } from 'commander';
import { platform } from 'node:os';

const ZSH_INIT = `eln-q-widget() {
  local replacement
  print -n '⏳' >&2
  replacement=$(command eln q --raw -- "$BUFFER")
  local command_status=$?
  print -n '\\r\\033[K' >&2
  if (( command_status == 0 )) && [[ -n "$replacement" ]]; then
    BUFFER="$replacement"
    CURSOR=\${#BUFFER}
  else
    zle redisplay
  fi
}
zle -N eln-q-widget
: \${ELN_Q_KEY:=^G}
bindkey "$ELN_Q_KEY" eln-q-widget
`;

async function suggestCommand(request: string, onDelta?: (delta: string) => void): Promise<string> {
  const [{ getUserConfig }, llm, { llmQuery }, tierMap] = await Promise.all([
    import('../user-config.js'), import('../llm.js'), import('./llm-cli.js'), import('../model-tier/llm-tier-map.js'),
  ]);
  const config = getUserConfig();
  const selected = llm.decideProviderForConfig(config);
  const provider = selected.provider.startsWith('auto:') ? selected.provider.slice('auto:'.length) : selected.provider;
  const tier = tierMap.lookupLlmTierSpec(provider as never, 'budget');
  const prompt = [
    'Return exactly one executable shell command on a single line.',
    'Do not include an explanation, markdown fences, or surrounding quotes.',
    `OS: ${platform()}; shell: ${process.env.SHELL ?? 'unknown'}; cwd: ${process.cwd()}.`,
    `Request: ${request}`,
  ].join('\n');
  const result = await llmQuery({
    text: prompt, model: tier.model, onDelta,
    deps: {
      getUserConfig,
      decideProviderForConfig: llm.decideProviderForConfig,
      getProviderForConfig: llm.getProviderForConfig,
      streamLLM: llm.streamLLM,
      trimToBudget: (await import('../tokens.js')).trimToBudget,
    },
  });
  return result.reply;
}

export function parseSuggestion(reply: string): string {
  const lines = reply.split(/\r?\n/).map(part => part.trim()).filter(Boolean).filter(part => !/^```(?:\w+)?$/.test(part));
  if (lines.length !== 1) throw new Error('model must return exactly one command line without explanation');
  const command = lines[0]!.replace(/^```(?:\w+)?\s*/, '').replace(/```\s*$/, '').replace(/^\$\s*/, '').trim();
  if (!command || /^(?:command|명령)\s*:/i.test(command)) throw new Error('model did not return a command on the first line');
  if (/[\r\n]/.test(command)) throw new Error('model returned a multi-line command; refusing');
  if (/\\\s*$/.test(command)) throw new Error('model returned an incomplete continued command; refusing');
  return command;
}

/** Ask the configured shell to parse only. `-n` prevents command execution. */
export async function validateShellSyntax(command: string): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const shell = process.env.SHELL?.trim() || (platform() === 'win32' ? 'powershell.exe' : '/bin/sh');
  const basename = shell.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  let result: ReturnType<typeof spawnSync>;
  if (platform() === 'win32') {
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const parseOnly = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')),[ref]$tokens,[ref]$errors) > $null; if ($errors.Count -gt 0) { exit 2 }`;
    result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', parseOnly], { encoding: 'utf8', timeout: 3000 });
  } else {
    const startupFlags = basename === 'bash' ? ['--noprofile', '--norc'] : basename === 'zsh' ? ['-f'] : [];
    result = spawnSync(shell, [...startupFlags, '-n', '-c', command], { encoding: 'utf8', timeout: 3000 });
  }
  if (result.error) throw new Error(`shell syntax check could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error('model returned invalid shell syntax; refusing');
}

export interface QCommandDeps {
  suggest?: typeof suggestCommand;
  log?: (event: { durationMs: number; firstTokenMs: number | null }) => void;
}

export function registerQCommands(program: Command, deps: QCommandDeps = {}): void {
  program.command('shell-init <shell>')
    .description('Print optional shell integration for command-line suggestions')
    .action((shell: string) => {
      if (shell !== 'zsh') {
        console.error(`shell-init: unsupported shell ${shell}; currently supported: zsh`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(ZSH_INIT);
    });

  program.command('q <request...>')
    .description('Print one shell command for a natural-language request; never runs it')
    .option('--raw', 'Print only the command (for shell widgets)')
    .action(async (parts: string[]) => {
      const request = parts.join(' ').trim();
      if (!request) {
        console.error('q: provide a natural-language command request');
        process.exitCode = 2;
        return;
      }
      try {
        const startedAt = Date.now();
        let firstTokenAt: number | undefined;
        const reply = await (deps.suggest ?? suggestCommand)(request, () => {
          firstTokenAt ??= Date.now();
        });
        const command = parseSuggestion(reply);
        await validateShellSyntax(command);
        process.stdout.write(`${command}\n`);
        const logEvent = { durationMs: Date.now() - startedAt, firstTokenMs: firstTokenAt === undefined ? null : firstTokenAt - startedAt };
        if (deps.log) deps.log(logEvent);
        else {
          const debug = await import('../debug/log.js');
          debug.debug.log('cli.q', 'suggestion', logEvent);
        }
      } catch (error) {
        console.error(`q failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
