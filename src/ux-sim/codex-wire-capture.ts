/** Fetch-boundary mock for Codex Responses wire-contract tests. */
export type CodexWireCapture = {
  headers: Record<string, string>;
  body: any;
  wireJson: string;
};

export function installCodexWireCapture(
  calls: CodexWireCapture[],
  options: { cachedTokens?: number } = {},
): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const wireJson = String(init?.body);
    calls.push({ headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(wireJson), wireJson });
    const completed = options.cachedTokens === undefined ? '' : `data: ${JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 2048, output_tokens: 7, input_tokens_details: { cached_tokens: options.cachedTokens } } },
    })}\n\n`;
    const sse = `data: {"type":"response.output_text.delta","delta":"hi"}\n\n${completed}data: [DONE]\n\n`;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = prior; };
}
