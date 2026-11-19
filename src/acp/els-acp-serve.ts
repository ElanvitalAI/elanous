// `els acp serve` — a stdio ACP shell over els (ELS-EXTERNAL-SURFACES §4 손 2, MCP 칸). Line-delimited JSON-RPC in,
// one answer per request; `runAcpServer` (src/acp/server.ts) owns the protocol. This glue owns exactly one thing:
// the principal. Every `session/prompt` turns into `backend.do(acpSessionPrincipal(ctx.sessionId), pane, ctx.userText)`
// through the one control door (§3.1): principal `acp-session:<sessionId>` — minted by the transport at session/new,
// never taken from the prompt — → authorize (default deny) → classify → execute → audit. A control refusal (`denied`)
// is a RequestError -32001 (§3.3), never a prompt answer.

import { RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { runAcpServer, type AcpTurnContext } from './server.js';
import { ELS_MCP_DENIED, type ElsMcpBackend, type ElsMcpPrincipal } from '../els/mcp-serve.js';

/** Made by the transport: `acp-session:<sessionId>` — the id the ACP server minted at session/new,
 *  never a value carried by the prompt. */
export function acpSessionPrincipal(sessionId: string): ElsMcpPrincipal {
  return { kind: 'acp-session', id: 'acp-session:' + sessionId };
}

/** Pump the ACP server over stdio (or injected Node streams, for tests). One prompt = one `do` through the door.
 *  Resolves when the input stream ends. */
export function serveElsAcpStdio(
  backend: ElsMcpBackend,
  pane: string,
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Promise<void> {
  const runTurn = async (ctx: AcpTurnContext) => {
    const principal = acpSessionPrincipal(ctx.sessionId);
    const result = await backend.do(principal, pane, ctx.userText);
    // A control refusal is a JSON-RPC error (-32001), not a prompt answer chunk.
    if (result.denied) throw new RequestError(ELS_MCP_DENIED, result.message, { reason: result.denied.reason });
    // AcpTurnContext.push takes the text; the server wraps it into the agent_message_chunk session/update.
    await ctx.push(result.message ?? '');
  };
  return runAcpServer({
    runTurn,
    requireSessionToolCwd: true,
    // Ops-Rules 22 (OP 92885): no extMethodAllowlist — ext methods are denied
    // by default; `els acp serve` exposes no PTY / control-door bypass surface.
    // Absent streams (production stdio): runAcpServer wires process.stdin/stdout itself.
    ...(input !== undefined && output !== undefined ? {
      stdioInput: (Readable as unknown as { toWeb: (s: unknown) => ReadableStream<Uint8Array> }).toWeb(input),
      stdioOutput: (Writable as unknown as { toWeb: (s: unknown) => WritableStream<Uint8Array> }).toWeb(output),
    } : {}),
  });
}
