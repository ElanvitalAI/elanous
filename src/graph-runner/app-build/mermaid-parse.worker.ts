import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

// Mermaid's flowchart parser needs a DOMPurify-capable document in Bun.
// Keep the DOM and parser inside this owned Worker so abort/timeout can stop it.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  navigator: dom.window.navigator,
});
const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

type ParseRequest = { id: number; code: string };
type ParseReply = { kind: 'result'; id: number; ok: boolean; diagramType?: string; sourceSha256: string; error?: 'MERMAID_PARSE_ERROR' };
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (message: { kind: 'ready' } | ParseReply) => void;
};

scope.onmessage = async event => {
  const { id, code } = event.data;
  if (!Number.isInteger(id) || typeof code !== 'string') return;
  const sourceSha256 = createHash('sha256').update(code).digest('hex');
  try {
    const parsed = await mermaid.parse(code);
    scope.postMessage({ kind: 'result', id, ok: true, diagramType: parsed.diagramType, sourceSha256 });
  } catch {
    // Parser exceptions often echo source lines. Only an allowlisted code leaves the Worker.
    scope.postMessage({ kind: 'result', id, ok: false, error: 'MERMAID_PARSE_ERROR', sourceSha256 });
  }
};

scope.postMessage({ kind: 'ready' });
