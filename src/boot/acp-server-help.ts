export function acpServerHelpText(): string {
  return `
ACP server (Agent Client Protocol)
  Usage: elanous --acp-server [--transport=stdio|unix-socket|websocket] [options]
  Example: elanous --acp-server --transport=websocket

  --transport=stdio|unix-socket|websocket  Connection transport (default: stdio)
  --socket-path=<path>                    Unix socket path (unix-socket only)
  --port=<number>                         Listening port (websocket only)
  --host=<host>                           Bind host (websocket only)
  --tool-cwd=<path>                       Default working directory for tools
  --no-auth                               Disable websocket token authentication

  Zed setup and connection check: docs/manual/MANUAL-zed-acp.md
`;
}
