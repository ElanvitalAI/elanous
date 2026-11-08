import type { Command } from 'commander';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export interface RelayPublicOptions { publicDomain?: string; publicServerId?: string; publicUserId?: string }

export interface RelayCommandOptions {
  readonly appKillSwitchDatabasePath?: string;
  readonly write?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
}

async function withAppKillSwitch<T>(options: RelayCommandOptions,
  run: (control: Awaited<ReturnType<typeof import('./app-kill-switch.js').createAppKillSwitch>>, operatorId: string) => T | Promise<T>): Promise<void> {
  let control: Awaited<ReturnType<typeof import('./app-kill-switch.js').createAppKillSwitch>> | undefined;
  try {
    const { createAppKillSwitch } = await import('./app-kill-switch.js');
    const databasePath = options.appKillSwitchDatabasePath ?? join(getElanousConfigDir(), 'relay', 'app-kill-switch.sqlite');
    control = createAppKillSwitch(databasePath, {
      authorizeReactivation: ({ actor }) => {
        const uid = process.getuid?.();
        if (actor.kind !== 'operator' || uid === undefined) return false;
        // The module opens only a current-user-owned database under a private directory.
        return actor.id === `uid-${uid}`;
      },
    });
    const operatorId = process.getuid === undefined ? 'unavailable-local-operator' : `uid-${process.getuid()}`;
    await run(control, operatorId);
  } catch (error) {
    (options.error ?? ((text: string) => process.stderr.write(text)))(`relay app-kill-switch: ${error instanceof Error ? error.message : String(error)}\n`);
    (options.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);
  } finally {
    control?.close();
  }
}

export function validateRelayPublicOptions(opts: RelayPublicOptions): void {
  if (opts.publicDomain && opts.publicDomain !== 'elanous.app') throw new Error('public domain must be elanous.app');
  if (!!opts.publicDomain !== (!!opts.publicServerId && !!opts.publicUserId)
    || (!!opts.publicServerId !== !!opts.publicUserId)) {
    throw new Error('--public-domain, --public-server-id, and --public-user-id must be supplied together');
  }
}

/** `elanous relay serve` — 릴레이 서버(R2 · 내부 문서 `RFC-mobile-relay-without-tailscale-2026-09-30` A5).
 *  index.ts 원문을 잘라 보는 시험(첫 `.command('serve')` = mcp)을 흔들지 않게 등록을 여기 둔다. */
export function registerRelayCommand(program: Command, options: RelayCommandOptions = {}): void {
  const relayCmd = program.command('relay').description('Encrypted WebSocket relay');
  relayCmd.command('serve')
    .description('Serve private relay connections and optionally the invited Nexus app public domain')
    .requiredOption('--trusted-host-keys <file>', 'JSON object of X25519-derived serverId to Ed25519 public key (base64url)')
    .option('--port <port>', 'Listening port', '8765')
    .option('--public-domain <domain>', 'Enable the single-host public app proxy for elanous.app (TLS must terminate at the local edge proxy)')
    .option('--public-server-id <id>', 'Pinned Nexus host serverId that receives its configured public user app hosts')
    .option('--public-user-id <id>', 'User label bound to this single Nexus host; multi-user dispatch belongs to the ops relay')
    .action(async (opts: { trustedHostKeys: string; port: string; publicDomain?: string; publicServerId?: string; publicUserId?: string }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid relay port');
      validateRelayPublicOptions(opts);
      const { loadTrustedHostKeys, startRelayServer } = await import('./relay-server.js');
      const relay = startRelayServer({ port, hostname: '127.0.0.1', trustedHostKeys: loadTrustedHostKeys(opts.trustedHostKeys),
        ...(opts.publicDomain ? { publicDomain: 'elanous.app' as const, publicServerId: opts.publicServerId!, publicUserId: opts.publicUserId! } : {}) });
      console.log(`relay listening on 127.0.0.1:${relay.port}${opts.publicDomain ? ' (public TLS edge required)' : ''}`);
      process.once('SIGINT', () => { relay.stop(); });
      process.once('SIGTERM', () => { relay.stop(); });
    });

  const killSwitch = relayCmd.command('app-kill-switch').description('Stop or reactivate one tenant app and record the action');
  killSwitch.command('down')
    .description('Persist one tenant app stop decision from an abuse or cost incident')
    .requiredOption('--user-id <id>', 'Tenant/user key')
    .requiredOption('--app-id <slug>', 'App slug')
    .requiredOption('--incident <type>', 'abuse-report or cost-spike')
    .requiredOption('--reason <text>', 'Audit reason')
    .requiredOption('--requested-by <id>', 'Incident reporter or guard identity for audit')
    .action(async (input: { userId: string; appId: string; incident: 'abuse-report' | 'cost-spike'; reason: string; requestedBy: string }) => {
      await withAppKillSwitch(options, (control) => {
        const event = control.applyIncident(input);
        (options.write ?? ((text: string) => process.stdout.write(text)))(`app kill switch state recorded: down · user=${event.userId} · app=${event.appId} · incident=${event.incident}\nrelay-server enforcement hook pending\n`);
      });
    });
  killSwitch.command('up')
    .description('Reactivate one stopped user app as an operator')
    .requiredOption('--user-id <id>', 'Tenant/user key')
    .requiredOption('--app-id <slug>', 'App slug')
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control, operatorId) => {
        const changed = control.reactivate({ userId: input.userId, appId: input.appId,
          actor: { kind: 'operator', id: operatorId } });
        (options.write ?? ((text: string) => process.stdout.write(text)))(`app kill switch state ${changed ? 'reactivated' : 'already up'} · user=${input.userId} · app=${input.appId} · relay-server enforcement hook pending\n`);
      });
    });
  killSwitch.command('status')
    .description('Read one tenant app kill-switch state')
    .requiredOption('--user-id <id>', 'Tenant/user key')
    .requiredOption('--app-id <slug>', 'App slug')
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control) => {
        (options.write ?? ((text: string) => process.stdout.write(text)))(`app kill switch recorded state: ${control.isDown(input.userId, input.appId) ? 'down' : 'up'} · user=${input.userId} · app=${input.appId}\n`);
      });
    });
  killSwitch.command('audit')
    .description('Read audit events for one tenant app')
    .requiredOption('--user-id <id>', 'Tenant/user key')
    .requiredOption('--app-id <slug>', 'App slug')
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control) => {
        const events = control.audit(input.userId, input.appId);
        (options.write ?? ((text: string) => process.stdout.write(text)))(`${JSON.stringify(events)}\n`);
      });
    });
}
