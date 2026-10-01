import type { Command } from 'commander';

/** `elanous relay serve` — 릴레이 서버(R2 · 내부 문서 `RFC-mobile-relay-without-tailscale-2026-09-30` A5).
 *  index.ts 원문을 잘라 보는 시험(첫 `.command('serve')` = mcp)을 흔들지 않게 등록을 여기 둔다. */
export function registerRelayCommand(program: Command): void {
  const relayCmd = program.command('relay').description('Encrypted WebSocket relay');
  relayCmd.command('serve')
    .description('Serve paired relay connections using operator-provisioned host signing keys')
    .requiredOption('--trusted-host-keys <file>', 'JSON object of X25519-derived serverId to Ed25519 public key (base64url)')
    .option('--port <port>', 'Listening port', '8765')
    .action(async (opts: { trustedHostKeys: string; port: string }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid relay port');
      const { loadTrustedHostKeys, startRelayServer } = await import('./relay-server.js');
      const relay = startRelayServer({ port, trustedHostKeys: loadTrustedHostKeys(opts.trustedHostKeys) });
      console.log(`relay listening on 127.0.0.1:${relay.port}`);
      process.once('SIGINT', () => { relay.stop(); });
      process.once('SIGTERM', () => { relay.stop(); });
    });
}
