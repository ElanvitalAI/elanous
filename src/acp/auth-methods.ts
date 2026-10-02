// EN10a — ACP auth methods: a client that runs terminals gets a `terminal` method (it re-launches `elanous --acp-server --login`);
// an older client gets an agent method carrying Zed's `terminal-auth` meta, so «sign-in needed → run elanous login in a terminal» shows either way.
import type { AuthMethod, ClientCapabilities } from '@agentclientprotocol/sdk';

export const ACP_LOGIN_METHOD_ID = 'elanous-login';
/** Appended to the configured agent invocation (`elanous --acp-server`) by a terminal-auth client. */
export const ACP_LOGIN_ARG = '--login';
/** What the login step runs (the ChatGPT/Codex subscription sign-in). */
export const ACP_LOGIN_SUBCOMMAND = ['login', 'openai-codex'] as const;

export interface AcpLaunch { command: string; args: string[] }

/** How this process was started (bun + script, or a compiled binary) so a client can start the same thing. */
export function currentLaunch(argv: readonly string[] = process.argv, execPath = process.execPath): AcpLaunch {
  const script = argv[1];
  return script && /\.(?:m?js|ts)$/.test(script) ? { command: execPath, args: [script] } : { command: execPath, args: [] };
}

export function acpAuthMethods(client: ClientCapabilities | null | undefined, launch: AcpLaunch = currentLaunch()): AuthMethod[] {
  const name = 'Sign in to elanous';
  if (client?.auth?.terminal === true) {
    return [{ type: 'terminal', id: ACP_LOGIN_METHOD_ID, name, description: 'Opens a terminal to sign in with your ChatGPT (Codex) subscription', args: [ACP_LOGIN_ARG] }];
  }
  return [{
    id: ACP_LOGIN_METHOD_ID,
    name,
    description: `Run \`elanous ${ACP_LOGIN_SUBCOMMAND.join(' ')}\` in a terminal, then try again`,
    _meta: { 'terminal-auth': { command: launch.command, args: [...launch.args, ...ACP_LOGIN_SUBCOMMAND], label: 'elanous login' } },
  }];
}
