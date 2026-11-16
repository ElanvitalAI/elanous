import { createHash } from 'node:crypto';
import type { Code, Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const MAX_BLOCKS = 32;
const MAX_CODE_BYTES = 64 * 1024;
const PARSE_DEADLINE_MS = 15_000;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface MermaidBlock {
  index: number;
  code: string;
  kind: string;
  sourceSha256: string;
  begin: number;
  end: number;
  indent: string;
  eol: '\n' | '\r\n';
}
export interface MermaidParseIssue {
  index: number;
  kind: string;
  sourceSha256: string;
  code: 'MERMAID_PARSE_ERROR' | 'MERMAID_LABEL_POLICY_ERROR';
}
export interface MermaidReplacement { index: number; kind: string; code: string }
export interface MermaidParseOptions { workerUrl?: URL; deadlineMs?: number }

function grammarKind(code: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*/u.exec(code.trimStart())?.[0] ?? 'unknown';
}

/** Diagram identifiers are ASCII; non-ASCII display text belongs in double quotes or comments. */
function violatesLabelPolicy(code: string, kind: string): boolean {
  for (const line of code.split(/\r?\n/u)) {
    let quoted = false;
    let escaped = false;
    let commentAt = line.length;
    let headerColonAt = -1;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (quoted && escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && char === '%' && line[i + 1] === '%') { commentAt = i; break; }
      if (!quoted && char === ':' && headerColonAt < 0) headerColonAt = i;
      if (!quoted && char.charCodeAt(0) > 127) return true;
    }
    // Mermaid also accepts quoted Unicode *identifiers* in sequence and ERD
    // syntax. Quotes only exempt display text, not actor/entity/attribute IDs.
    const syntaxLine = line.slice(0, commentAt);
    const quotedUnicode = /"[^"\n]*[^\x00-\x7F"\n][^"\n]*"/u;
    if (kind === 'sequenceDiagram') {
      if (!quotedUnicode.test(syntaxLine)) continue;
      const declaration = /^\s*(?:create\s+)?(?:participant|actor)\s+(.+)$/u.exec(syntaxLine)?.[1];
      if (declaration) {
        if (quotedUnicode.test(declaration.split(/\s+as\s+/u)[0]!)) return true;
        continue; // Quoted text after `as` is a display alias, even if it contains a colon.
      }
      if (/^\s*(?:title|alt|opt|loop|par|critical|break|else|and|option|box)\b/iu.test(syntaxLine)) {
        continue; // These clauses carry a display caption, not an endpoint ID.
      }
      // Every supported message arrow has a colon-delimited body. Checking
      // the whole header covers --x, -->>, -), --) and future arrow spellings.
      if (headerColonAt < 0 || quotedUnicode.test(syntaxLine.slice(0, headerColonAt))) return true;
    }
    if (kind === 'erDiagram') {
      const relationHead = headerColonAt >= 0 && /[|}{]/u.test(syntaxLine.slice(0, headerColonAt))
        ? syntaxLine.slice(0, headerColonAt) : '';
      if (/(?:^|\s)"[^"\n]*[^\x00-\x7F"\n][^"\n]*"(?=\s|$)/u.test(relationHead)
        || /^\s*"[^"\n]*[^\x00-\x7F"\n][^"\n]*"\s*\{/u.test(syntaxLine)
        || /^\s*[A-Za-z_][A-Za-z0-9_]*\s+"[^"\n]*[^\x00-\x7F"\n][^"\n]*"(?:\s|$)/u.test(syntaxLine)) return true;
    }
  }
  return false;
}

function codeNodes(root: Root): Code[] {
  const found: Code[] = [];
  const visit = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') found.push(node);
      if ('children' in node) visit(node.children as RootContent[]);
    }
  };
  visit(root.children);
  return found;
}

/** Offsets refer to the original JS string; never normalize the Markdown before slicing. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  if (typeof markdown !== 'string') throw new Error('MERMAID_INPUT_INVALID');
  const root = unified().use(remarkParse).parse(markdown) as Root;
  const nodes = codeNodes(root);
  if (nodes.length > MAX_BLOCKS) throw new Error('MERMAID_INPUT_BUDGET');
  return nodes.map((node, index) => {
    const start = node.position?.start;
    const finish = node.position?.end;
    if (start?.offset === undefined || finish?.offset === undefined) throw new Error('MERMAID_FENCE_UNSUPPORTED');
    const raw = markdown.slice(start.offset, finish.offset);
    const open = raw.indexOf('\n') + 1;
    const close = raw.lastIndexOf('\n');
    if (open <= 0 || close < open) throw new Error('MERMAID_FENCE_UNSUPPORTED');
    const eol: '\n' | '\r\n' = raw[open - 2] === '\r' ? '\r\n' : '\n';
    const begin = start.offset + open;
    const end = start.offset + close - (raw[close - 1] === '\r' ? 1 : 0);
    const indent = ' '.repeat(start.column - 1);
    const body = markdown.slice(begin, end);
    const code = body.split(eol).map(line => {
      if (!line.startsWith(indent)) throw new Error('MERMAID_FENCE_UNSUPPORTED');
      return line.slice(indent.length);
    }).join(eol);
    if (code !== node.value || Buffer.byteLength(code) > MAX_CODE_BYTES) throw new Error('MERMAID_FENCE_UNSUPPORTED');
    return { index, code, kind: grammarKind(code), sourceSha256: digest(code), begin, end, indent, eol };
  });
}

type WorkerReply = { kind: 'ready' } | {
  kind: 'result'; id: number; ok: boolean; diagramType?: string; sourceSha256: string; error?: string;
};

/** One isolated parser Worker per validation. Abort and deadline terminate that Worker. */
export function parseMermaidBlocks(blocks: readonly MermaidBlock[], signal?: AbortSignal,
  options: MermaidParseOptions = {}): Promise<MermaidParseIssue[]> {
  if (signal?.aborted) return Promise.reject(new Error('MERMAID_PARSE_ABORTED'));
  if (blocks.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerUrl ?? new URL('./mermaid-parse.worker.ts', import.meta.url), { type: 'module' });
    const issues: MermaidParseIssue[] = [];
    let sent = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(issues);
    };
    const abort = (): void => finish(new Error('MERMAID_PARSE_ABORTED'));
    const timer = setTimeout(() => finish(new Error('MERMAID_PARSE_TIMEOUT')), options.deadlineMs ?? PARSE_DEADLINE_MS);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('MERMAID_PARSE_WORKER_ERROR'));
    worker.onmessageerror = () => finish(new Error('MERMAID_PARSE_WORKER_ERROR'));
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (settled) return;
      const reply = event.data;
      if (reply?.kind === 'ready') {
        if (sent !== 0) return finish(new Error('MERMAID_PARSE_PROTOCOL_ERROR'));
        worker.postMessage({ id: blocks[0]!.index, code: blocks[0]!.code });
        sent = 1;
        return;
      }
      const expected = blocks[sent - 1];
      if (!expected || reply?.kind !== 'result' || reply.id !== expected.index || reply.sourceSha256 !== expected.sourceSha256) {
        return finish(new Error('MERMAID_PARSE_PROTOCOL_ERROR'));
      }
      if (typeof reply.ok !== 'boolean' || (reply.ok
        ? typeof reply.diagramType !== 'string' || reply.error !== undefined
        : reply.error !== 'MERMAID_PARSE_ERROR' || reply.diagramType !== undefined)) {
        return finish(new Error('MERMAID_PARSE_PROTOCOL_ERROR'));
      }
      if (!reply.ok || violatesLabelPolicy(expected.code, expected.kind)) issues.push({ index: expected.index, kind: expected.kind,
        sourceSha256: expected.sourceSha256,
        code: reply.ok ? 'MERMAID_LABEL_POLICY_ERROR' : 'MERMAID_PARSE_ERROR' });
      if (sent === blocks.length) return finish();
      worker.postMessage({ id: blocks[sent]!.index, code: blocks[sent]!.code });
      sent++;
    };
    if (signal?.aborted) abort();
  });
}

/** Replace only failed fence bodies; all other Markdown bytes stay at their original offsets. */
export function replaceFailedMermaidBlocks(markdown: string, failed: readonly MermaidBlock[],
  replacements: readonly MermaidReplacement[]): string {
  if (replacements.length !== failed.length) throw new Error('MERMAID_REPLACEMENT_INVALID');
  const all = extractMermaidBlocks(markdown);
  for (let i = 0; i < failed.length; i++) {
    const source = failed[i]!;
    const replacement = replacements[i]!;
    if (all[source.index]?.sourceSha256 !== source.sourceSha256 || replacement.index !== source.index
      || replacement.kind !== source.kind || grammarKind(replacement.code) !== source.kind
      || Buffer.byteLength(replacement.code) > MAX_CODE_BYTES) throw new Error('MERMAID_REPLACEMENT_INVALID');
  }
  let result = markdown;
  const expectedBodies = new Map<number, string>();
  for (const replacement of [...replacements].sort((a, b) => b.index - a.index)) {
    const source = all[replacement.index]!;
    const normalized = replacement.code.replace(/\r\n?/gu, '\n').split('\n').join(source.eol);
    const body = normalized.split(source.eol).map(line => source.indent + line).join(source.eol);
    expectedBodies.set(replacement.index, normalized);
    result = result.slice(0, source.begin) + body + result.slice(source.end);
  }
  let after: MermaidBlock[];
  try { after = extractMermaidBlocks(result); }
  catch { throw new Error('MERMAID_REPLACEMENT_INVALID'); }
  if (after.length !== all.length || all.some(source => {
    const current = after[source.index];
    const expectedBody = expectedBodies.get(source.index);
    return !current || current.kind !== source.kind || (expectedBody === undefined
      ? current.sourceSha256 !== source.sourceSha256 : current.code !== expectedBody);
  })) throw new Error('MERMAID_REPLACEMENT_INVALID');
  return result;
}
