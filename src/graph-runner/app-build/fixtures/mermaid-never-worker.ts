import { createHash } from 'node:crypto';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; code: string }>) => void) | null;
  postMessage: (message: unknown) => void;
};
scope.onmessage = event => {
  const { id, code } = event.data;
  const sourceSha256 = createHash('sha256').update(code).digest('hex');
  if (code.includes('PROTOCOL_BAD_BOOL')) scope.postMessage({ kind: 'result', id, ok: 'true', diagramType: 'flowchart', sourceSha256 });
  if (code.includes('PROTOCOL_BAD_DIAG')) scope.postMessage({ kind: 'result', id, ok: false, error: 'UNEXPECTED', sourceSha256 });
  // All other inputs deliberately receive no result for the deadline test.
};
scope.postMessage({ kind: 'ready' });
