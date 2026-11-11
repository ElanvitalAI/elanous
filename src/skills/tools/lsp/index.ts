import type { LLMToolSpec } from '../../../llm/tool-spec.js';
// ── Lsp tool barrel + dispatcher ──
//
// Phase L2 surface: five operations (hover, goToDefinition,
// findReferences, documentSymbol, workspaceSymbol), TypeScript only,
// not registered in any LLM-facing catalog. See
// 내부 문서 `PLAN-lsp-phase-2` for the contract and
// 내부 문서 `ROADMAP-lsp-integration` for where L3+ take this.

import { fileURLToPath } from 'node:url';
import { debug } from '../../../debug/log.js';
import { getUserConfig } from '../../../user-config/reader.js';

import type { LLMToolDef } from '../../../plugins/core/types.js';
import { getSessionCwd } from '../../../session/working-dir.js';
import type {
  LspHoverResult, LspLocation, LspRange,
  LspDocumentSymbol, LspSymbolInformation, LspWorkspaceSymbol,
} from './types.js';
import { LspSymbolKind } from './types.js';
import {
  openDocument,
} from './typescript-server.js';
import { getLspClient, releaseLspClient } from './pool.js';
import {
  resolveLanguageForFile, resolveLanguageByName,
} from './server-registry.js';
import type { LspClient } from './client.js';

export { spawnLspClient, type LspClient, type SpawnLspClientOpts } from './client.js';
export {
  spawnTypescriptLspClient, typescriptLanguageServerBinary,
  languageIdForFile, openDocument,
  __resetTypescriptServerProbeCacheForTests,
} from './typescript-server.js';
export {
  getTypescriptClient, releaseTypescriptClient,
  getLspClient, releaseLspClient, disposeAllPooledClients,
  __resetLspPoolForTests,
} from './pool.js';
export {
  resolveLanguageByName, resolveLanguageForFile, probeLanguageBinary,
  installHintError,
  __resetServerRegistryForTests,
  type LspLanguageName, type LspLanguageEntry,
} from './server-registry.js';
export type {
  LspPosition, LspRange, LspLocation, LspHoverResult, LspMarkupContent,
  LspDocumentSymbol, LspSymbolInformation, LspWorkspaceSymbol,
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
} from './types.js';
export { LspSymbolKind } from './types.js';

/** Operations supported in the current phase. L2 ships five; L3 adds
 *  goToImplementation + call-hierarchy. Kept as a string-literal
 *  union so the runtime switch stays exhaustive. */
export type LspOperation =
  | 'hover'
  | 'goToDefinition'
  | 'findReferences'
  | 'documentSymbol'
  | 'workspaceSymbol';

const ALL_OPERATIONS: LspOperation[] = [
  'hover', 'goToDefinition', 'findReferences',
  'documentSymbol', 'workspaceSymbol',
];

/** Default head_limit for multi-result operations. Matches Grep's
 *  250 — see src/skills/tools/grep.ts. */
const DEFAULT_HEAD_LIMIT = 250;
const MAX_HEAD_LIMIT = 5_000;

export interface LspResult {
  /** Formatted tool_result string — header + body, matches Grep's
   *  output shape so the dashboard tool-body auto-fold applies. */
  output: string;
  operation: LspOperation;
  numResults: number;
  truncated: boolean;
}

export function buildLspTool(): LLMToolSpec {
  return {
    name: 'Lsp',
    description:
      'Language Server Protocol queries for structural / symbol-level code questions. ' +
      'Operations: hover (type+doc at position) · goToDefinition (where is X defined) · ' +
      'findReferences (who calls X) · documentSymbol (file outline) · ' +
      'workspaceSymbol (search by name across project). Use Lsp when Grep regex would ' +
      'produce false positives (comments, string literals) or when you need precise ' +
      'symbol resolution. Language is auto-detected from filePath extension; requires ' +
      'the matching language server on PATH: TypeScript/JavaScript → ' +
      '`typescript-language-server`, Python → `pyright-langserver`, Rust → ' +
      '`rust-analyzer`. Override binaries / extensions / enable flags via ' +
      'user-config.lsp.{typescript,python,rust}.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...ALL_OPERATIONS],
          description:
            'Which LSP operation to run. hover/goToDefinition/findReferences need ' +
            'filePath+line+character. documentSymbol needs filePath. workspaceSymbol ' +
            'needs query.',
        },
        filePath: {
          type: 'string',
          description: 'Absolute or session-cwd-relative path. Required for all ops except workspaceSymbol.',
        },
        line: {
          type: 'number',
          description: '1-indexed source line. Required for hover / goToDefinition / findReferences.',
        },
        character: {
          type: 'number',
          description: '1-indexed column (UTF-16 code units per LSP convention). Required for hover / goToDefinition / findReferences.',
        },
        query: {
          type: 'string',
          description: 'Symbol-name substring. Required for workspaceSymbol.',
        },
        head_limit: {
          type: 'number',
          description: `Max result rows for findReferences / workspaceSymbol (default ${DEFAULT_HEAD_LIMIT}, cap ${MAX_HEAD_LIMIT}).`,
        },
        offset: {
          type: 'number',
          description: 'Skip the first N results before applying head_limit. Use for pagination.',
        },
      },
      required: ['operation'],
    },
  };
}

/** Dispatch an Lsp operation. Opens a fresh typescript-language-server
 *  per call in L2; pooling arrives in L3 when dashboard/skill
 *  registration lands.
 *
 *  Argument validation runs BEFORE the server spawn so a bad call
 *  fails fast without paying the ~500ms handshake cost — and so a
 *  fail-soft "binary not installed" error doesn't mask a much more
 *  informative input-shape error that would guide the caller's retry. */
export async function dispatchLsp(args: Record<string, unknown>): Promise<LspResult> {
  const op = String(args.operation ?? '') as LspOperation;
  if (!ALL_OPERATIONS.includes(op)) {
    throw new Error(`Lsp: operation '${op}' not supported (available: ${ALL_OPERATIONS.join(', ')})`);
  }

  // Per-op input validation — throws before any server interaction.
  // We re-use the same parsers inside each `run*` to keep the point
  // of truth in one place; validating here just for error-ordering
  // semantics.
  switch (op) {
    case 'hover':
    case 'goToDefinition':
    case 'findReferences':
      requirePositionArgs(args);
      break;
    case 'documentSymbol':
      requireString(args.filePath, 'filePath');
      break;
    case 'workspaceSymbol':
      requireString(args.query, 'query');
      break;
  }

  if (debug.enabled) {
    debug.log('lsp.dispatch', op, {
      filePath: args.filePath, line: args.line, character: args.character,
      query: args.query,
    });
  }

  // L4 — resolve the language via the server-registry (config-driven).
  // filePath-anchored ops use the extension; workspaceSymbol falls back
  // to the configured default language.
  const cfg = getUserConfig();
  if (!cfg.lsp.enabled) {
    throw new Error('Lsp: disabled via user-config.lsp.enabled = false');
  }
  let entry;
  if (op === 'workspaceSymbol') {
    entry = resolveLanguageByName(cfg.lsp.workspaceSymbolLanguage);
    if (!entry) {
      throw new Error(
        `Lsp: workspaceSymbol default language '${cfg.lsp.workspaceSymbolLanguage}' ` +
        `is disabled in user-config.lsp.${cfg.lsp.workspaceSymbolLanguage}`,
      );
    }
  } else {
    const filePath = String(args.filePath ?? '');
    entry = resolveLanguageForFile(filePath);
    if (!entry) {
      throw new Error(
        `Lsp: no configured language serves '${filePath}'. ` +
        `Check user-config.lsp for per-language extension / enable settings.`,
      );
    }
  }

  const cwd = getSessionCwd();
  const client = await getLspClient(entry, cwd);
  try {
    switch (op) {
      case 'hover':           return await runHover(client, args);
      case 'goToDefinition':  return await runGoToDefinition(client, args);
      case 'findReferences':  return await runFindReferences(client, args);
      case 'documentSymbol':  return await runDocumentSymbol(client, args);
      case 'workspaceSymbol': return await runWorkspaceSymbol(client, args);
    }
  } finally {
    releaseLspClient(entry.language, cwd);
  }
}

/** Tool definition with a bound handler, for registration on the
 *  dashboard `pluginHost` alongside other host tools (Read, Grep, Glob,
 *  …). Mirror of ast-grep's `buildAstGrepHostTool()` pattern so the
 *  dashboard surface stays internally consistent.
 *
 *  The name stays `Lsp` — opencode and claude-code both use a single
 *  surface-level name regardless of whether the model reaches it via
 *  dashboard chat or a skill run. */
export function buildLspHostTool(): LLMToolDef {
  const spec = buildLspTool();
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    handler: async (args) => dispatchLsp(args),
  };
}

// ── Operation implementations ──────────────────────────────────────

async function runHover(client: LspClient, args: Record<string, unknown>): Promise<LspResult> {
  const { filePath, line, character } = requirePositionArgs(args);
  const { absolutePath, uri } = await openDocument(client, filePath);
  const response = await client.request<LspHoverResult | null>('textDocument/hover', {
    textDocument: { uri },
    position: { line: line - 1, character: character - 1 },
  });
  return formatHoverResult(response, absolutePath, line, character);
}

async function runGoToDefinition(client: LspClient, args: Record<string, unknown>): Promise<LspResult> {
  const { filePath, line, character } = requirePositionArgs(args);
  const { absolutePath, uri } = await openDocument(client, filePath);
  const response = await client.request<LspLocation | LspLocation[] | null>(
    'textDocument/definition',
    { textDocument: { uri }, position: { line: line - 1, character: character - 1 } },
  );
  const locations = normaliseLocations(response);
  return formatLocationList(
    locations,
    `Definition · ${absolutePath}:${line}:${character}`,
    'goToDefinition',
  );
}

async function runFindReferences(client: LspClient, args: Record<string, unknown>): Promise<LspResult> {
  const { filePath, line, character } = requirePositionArgs(args);
  const { absolutePath, uri } = await openDocument(client, filePath);
  const response = await client.request<LspLocation[] | null>('textDocument/references', {
    textDocument: { uri },
    position: { line: line - 1, character: character - 1 },
    context: { includeDeclaration: true },
  });
  const locations = Array.isArray(response) ? response : [];
  return formatLocationList(
    locations,
    `References to ${absolutePath}:${line}:${character}`,
    'findReferences',
    readPagination(args),
  );
}

async function runDocumentSymbol(client: LspClient, args: Record<string, unknown>): Promise<LspResult> {
  const filePath = requireString(args.filePath, 'filePath');
  const { absolutePath, uri } = await openDocument(client, filePath);
  const response = await client.request<LspDocumentSymbol[] | LspSymbolInformation[] | null>(
    'textDocument/documentSymbol', { textDocument: { uri } },
  );
  const symbols = Array.isArray(response) ? response : [];
  return formatSymbolOutline(symbols, absolutePath);
}

async function runWorkspaceSymbol(client: LspClient, args: Record<string, unknown>): Promise<LspResult> {
  const query = requireString(args.query, 'query');
  const response = await client.request<LspWorkspaceSymbol[] | LspSymbolInformation[] | null>(
    'workspace/symbol', { query },
  );
  const symbols = Array.isArray(response) ? response : [];
  return formatWorkspaceSymbols(symbols, query, readPagination(args));
}

// ── Argument validators (shared across ops) ────────────────────────

function requirePositionArgs(args: Record<string, unknown>): {
  filePath: string; line: number; character: number;
} {
  const filePath = requireString(args.filePath, 'filePath');
  const line = Number(args.line);
  const character = Number(args.character);
  if (!Number.isFinite(line) || !Number.isFinite(character)) {
    throw new Error('Lsp: line and character must be numeric');
  }
  if (line < 1 || character < 1) {
    throw new Error(
      `Lsp: line and character are 1-indexed (received line=${args.line}, character=${args.character})`,
    );
  }
  return { filePath, line, character };
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Lsp: ${name} is required`);
  }
  return v;
}

function readPagination(args: Record<string, unknown>): { headLimit: number; offset: number } {
  const headLimit = clampInt(args.head_limit, DEFAULT_HEAD_LIMIT, 1, MAX_HEAD_LIMIT);
  const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { headLimit, offset };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── Formatters ─────────────────────────────────────────────────────

/** Flatten LSP Hover's polymorphic `contents` field to plain text.
 *  Spec v3.17 keeps `MarkedString[]` for backward compat — we accept
 *  all three shapes. Empty / null → `(no info)` marker so the LLM
 *  gets a clear signal rather than a blank body. */
export function formatHoverResult(
  response: LspHoverResult | null,
  absolutePath: string,
  line: number,
  character: number,
): LspResult {
  const header = `Hover · ${absolutePath}:${line}:${character}`;
  if (!response || response.contents == null) {
    return { output: `${header}  (no info)`, operation: 'hover', numResults: 0, truncated: false };
  }
  const text = flattenHoverContents(response.contents).trim();
  if (!text) {
    return { output: `${header}  (no info)`, operation: 'hover', numResults: 0, truncated: false };
  }
  return { output: `${header}\n\n${text}`, operation: 'hover', numResults: 1, truncated: false };
}

function flattenHoverContents(contents: LspHoverResult['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map(c => typeof c === 'string' ? c : c.value).join('\n\n');
  }
  return contents.value;
}

function normaliseLocations(r: LspLocation | LspLocation[] | null): LspLocation[] {
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Shared formatter for goToDefinition / findReferences. Formats each
 *  Location as `path:line:col-line:col` (1-indexed in output) and
 *  honours head_limit + offset. */
export function formatLocationList(
  locations: LspLocation[],
  header: string,
  operation: 'goToDefinition' | 'findReferences',
  page: { headLimit: number; offset: number } = { headLimit: DEFAULT_HEAD_LIMIT, offset: 0 },
): LspResult {
  if (locations.length === 0) {
    return {
      output: `${header}\n\n(no results)`,
      operation,
      numResults: 0,
      truncated: false,
    };
  }

  const sorted = [...locations].sort((a, b) => {
    if (a.uri !== b.uri) return a.uri.localeCompare(b.uri);
    return a.range.start.line - b.range.start.line;
  });
  const start = Math.min(page.offset, sorted.length);
  const end = Math.min(start + page.headLimit, sorted.length);
  const window = sorted.slice(start, end);
  const truncated = end < sorted.length;

  const countLine = `${sorted.length} result${sorted.length === 1 ? '' : 's'}` +
    (truncated ? ` (showing ${start + 1}-${end})` : '');
  const rows = window.map(loc => formatLocationRow(loc));
  const footer = truncated
    ? `\n\n[... ${sorted.length - end} more — offset:${end} to paginate ...]`
    : '';

  return {
    output: `${header}\n\n${countLine}\n${rows.join('\n')}${footer}`,
    operation,
    numResults: sorted.length,
    truncated,
  };
}

function formatLocationRow(loc: LspLocation): string {
  const path = fileUriToPath(loc.uri);
  const r = loc.range;
  return `${path}:${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1}`;
}

function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try { return fileURLToPath(uri); }
    catch { return uri.slice('file://'.length); }
  }
  return uri;
}

/** Format documentSymbol response. Handles both the hierarchical
 *  DocumentSymbol[] shape (preferred) and the flat SymbolInformation[]
 *  fallback some servers still return. Output flattens deeper than
 *  two levels to keep the listing grep-friendly — a 10-deep nested
 *  class tree would become unreadable otherwise. */
export function formatSymbolOutline(
  symbols: Array<LspDocumentSymbol | LspSymbolInformation>,
  absolutePath: string,
): LspResult {
  if (symbols.length === 0) {
    return {
      output: `Symbols in ${absolutePath}\n\n(no symbols)`,
      operation: 'documentSymbol',
      numResults: 0,
      truncated: false,
    };
  }

  const isHierarchical = 'range' in symbols[0]! && 'selectionRange' in symbols[0]!;
  const rows: string[] = [];
  let totalCount = 0;

  if (isHierarchical) {
    for (const s of symbols as LspDocumentSymbol[]) {
      rows.push(renderDocumentSymbol(s, ''));
      totalCount += 1 + (s.children?.length ?? 0);
      for (const c of s.children ?? []) rows.push(renderDocumentSymbol(c, '  '));
    }
  } else {
    // SymbolInformation — no children, render flat with container
    // names as a dim prefix.
    for (const s of symbols as LspSymbolInformation[]) {
      const container = s.containerName ? `${s.containerName}.` : '';
      const r = s.location.range;
      rows.push(
        `${kindLabel(s.kind)} ${container}${s.name} (${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1})`,
      );
      totalCount++;
    }
  }

  const header = `Symbols in ${absolutePath} · ${totalCount} symbol${totalCount === 1 ? '' : 's'}`;
  return {
    output: `${header}\n\n${rows.join('\n')}`,
    operation: 'documentSymbol',
    numResults: totalCount,
    truncated: false,
  };
}

function renderDocumentSymbol(s: LspDocumentSymbol, indent: string): string {
  const r = s.range;
  return `${indent}${kindLabel(s.kind)} ${s.name} (${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1})`;
}

function kindLabel(kind: LspSymbolKind): string {
  return (LspSymbolKind[kind] ?? 'symbol').toLowerCase();
}

/** Format workspace/symbol results — sorted by name, honouring
 *  pagination. A symbol's location may be "lazy" (just uri) in LSP
 *  v3.17; those render without line/col. */
export function formatWorkspaceSymbols(
  symbols: Array<LspWorkspaceSymbol | LspSymbolInformation>,
  query: string,
  page: { headLimit: number; offset: number } = { headLimit: DEFAULT_HEAD_LIMIT, offset: 0 },
): LspResult {
  if (symbols.length === 0) {
    return {
      output: `Workspace symbols matching "${query}"\n\n(no results)`,
      operation: 'workspaceSymbol',
      numResults: 0,
      truncated: false,
    };
  }

  const start = Math.min(page.offset, symbols.length);
  const end = Math.min(start + page.headLimit, symbols.length);
  const window = symbols.slice(start, end);
  const truncated = end < symbols.length;

  const header = `Workspace symbols matching "${query}" · ${symbols.length} result${symbols.length === 1 ? '' : 's'}` +
    (truncated ? ` (showing ${start + 1}-${end})` : '');

  const rows = window.map(s => {
    const container = s.containerName ? `  (${s.containerName})` : '';
    const loc = s.location;
    if ('range' in loc) {
      const path = fileUriToPath(loc.uri);
      const r = loc.range;
      return `${kindLabel(s.kind)} ${s.name}${container}  ${path}:${r.start.line + 1}:${r.start.character + 1}`;
    }
    // Lazy location — URI only.
    return `${kindLabel(s.kind)} ${s.name}${container}  ${fileUriToPath(loc.uri)}`;
  });

  const footer = truncated
    ? `\n\n[... ${symbols.length - end} more — offset:${end} to paginate ...]`
    : '';

  return {
    output: `${header}\n\n${rows.join('\n')}${footer}`,
    operation: 'workspaceSymbol',
    numResults: symbols.length,
    truncated,
  };
}

// Helpers kept at the bottom so the op implementations read top-down.
export { fileUriToPath };
