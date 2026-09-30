import type { Command } from 'commander';
import { constants, fstatSync, openSync, readFileSync, closeSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mintScopedToken } from '../auth/token-store.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { issueMcpPat, listMcpPats, revokeMcpPat } from '../mcp-gateway/pat-store.js';
import { startMcpGateway } from '../mcp-gateway/gateway.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';

function privateTokenFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('nexus token file must be a private regular file (0600)');
    const token = readFileSync(fd, 'utf8').trim();
    if (!token || /\s/.test(token)) throw new Error('invalid nexus token file');
    return token;
  } finally { closeSync(fd); }
}

export function issueMcpNexusToken(path: string): void {
  // The scoped token store belongs to the Primary. Never copy an admin token to the gateway VM.
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // Reserve the destination before minting: an existing file must not consume a scoped token.
  const fd = openSync(target, 'wx', 0o600);
  try {
    const token = mintScopedToken({ scope: 'mcp-public' }, { configDir: getElanousConfigDir() });
    writeFileSync(fd, `${token}\n`);
  } catch (error) {
    closeSync(fd);
    unlinkSync(target);
    throw error;
  }
  closeSync(fd);
}

function safeAction<Args extends unknown[]>(action: (...args: Args) => void | Promise<void>): (...args: Args) => Promise<void> {
  return async (...args) => {
    try { await action(...args); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  };
}

export function registerMcpGatewayCommands(mcp: Command): void {
  mcp.command('gateway')
    .description('Owner-PAT authenticated public MCP relay to the scoped NEXUS endpoint')
    .option('--host <host>', 'Bind host', '127.0.0.1')
    .option('--port <port>', 'Bind port', '31482')
    .option('--nexus-url <url>', 'NEXUS base URL. Default: the current daemon (elanous nexus show).')
    .option('--public-url <url>', 'Public HTTPS origin used in protected resource metadata')
    .option('--nexus-token-file <path>', 'Private file holding the mcp-public NEXUS token; use - for stdin')
    .action(safeAction(async (opts: { host: string; port: string; nexusUrl?: string; publicUrl?: string; nexusTokenFile?: string }) => {
      const port = Number(opts.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid gateway port');
      // 데몬 주소는 짐작하지 않는다 — 통합관제(daemon-endpoint)에 묻고, 모르면 멈춘다(대표 09-28).
      const nexusUrl = opts.nexusUrl ?? resolveDaemonEndpoint()?.baseUrl;
      if (!nexusUrl) throw new Error('daemon address unknown — pass --nexus-url or start the daemon (elanous nexus show)');
      if (!opts.publicUrl) throw new Error('--public-url <url> required for protected-resource metadata');
      if (!opts.nexusTokenFile) throw new Error('--nexus-token-file <path|-> required (no token argv)');
      if (opts.nexusTokenFile === '-' && process.stdin.isTTY) throw new Error('pipe the nexus token on stdin');
      const nexusToken = opts.nexusTokenFile === '-' ? (await Bun.stdin.text()).trim() : privateTokenFile(opts.nexusTokenFile);
      if (!nexusToken || /\s/.test(nexusToken)) throw new Error('invalid nexus token');
      const patRoot = effectiveInstanceRoot();
      const patFile = join(patRoot, 'mcp-gateway', 'pats.json');
      const fd = openSync(patFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('PAT store must be a private regular file (0600)');
      } finally { closeSync(fd); }
      listMcpPats(patRoot);
      const server = startMcpGateway({ host: opts.host, port, nexusUrl, nexusToken, patRoot, publicUrl: opts.publicUrl });
      process.stderr.write(`MCP gateway listening on ${server.hostname}:${server.port}\n`);
    }));

  const pat = mcp.command('token').description('Manage owner-only MCP personal access tokens');
  pat.command('issue <name>').option('--expires <duration>', 'Expiration, e.g. 30d')
    .action(safeAction((name: string, opts: { expires?: string }) => {
      if (opts.expires !== undefined && !/^[1-9]\d*d$/.test(opts.expires)) throw new Error('--expires must be a positive number of days (e.g. 30d)');
      const issued = issueMcpPat(name, opts.expires === undefined ? {} : { expiresDays: Number(opts.expires.slice(0, -1)) });
      process.stdout.write(`${issued.token}\n`);
    }));
  pat.command('list').action(safeAction(() => {
    for (const row of listMcpPats()) process.stdout.write(`${row.name}\t${row.createdAt}\t${row.expiresAt ?? '-'}\n`);
  }));
  pat.command('revoke <name>').action(safeAction((name: string) => {
    if (!revokeMcpPat(name)) throw new Error(`PAT not found: ${name}`);
  }));

  mcp.command('nexus-token').description('Issue a gateway-only NEXUS mcp-public token')
    .command('issue').requiredOption('--file <path>', 'Private output file (0600); raw token never printed')
    .action(safeAction((opts: { file: string }) => issueMcpNexusToken(opts.file)));
}
