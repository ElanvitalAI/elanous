// Pure MCP wire pieces shared by the eln MCP server and the els MCP server.
// Must not import any eln runtime module — els depends on this file alone.

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Canonical latest protocol version elanous will speak. Server and client
 *  both read this — do not duplicate the string elsewhere. */
export const MCP_PROTOCOL_VERSION_LATEST = '2025-11-25' as const;

/** Versions elanous can speak. `2024-11-05` stays so already-attached
 *  peers keep working; latest is the one new handshakes offer. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  MCP_PROTOCOL_VERSION_LATEST,
] as const;

export type McpSupportedProtocolVersion =
  (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Pure negotiation: echo a supported request, otherwise the latest we
 *  speak. Missing / malformed / unknown values are not JSON-RPC errors
 *  — they fall back, matching the initialize success path. */
export function negotiateMcpProtocolVersion(
  requested: unknown,
): McpSupportedProtocolVersion {
  if (
    typeof requested === 'string' &&
    (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested as McpSupportedProtocolVersion;
  }
  return MCP_PROTOCOL_VERSION_LATEST;
}
