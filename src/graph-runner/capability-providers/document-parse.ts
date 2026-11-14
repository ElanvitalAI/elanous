import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { extractPdfBytes } from '../../extractors.js';
import { MEDIA_STORE_MAX_FILE_BYTES } from '../../nexus/api/media-store.js';
import { resolveUpstageApiKeyAsync, runUpstageOcr } from '../../ocr/upstage.js';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityProvider,
  type GraphCapabilityRegistry,
} from '../capabilities.js';

export const DOCUMENT_PARSE_CONTRACT = 'absorb.document-parse@1' as const;
export const DOCUMENT_AI_DISCONNECTED = '문서 AI 미연결' as const;

type Scrap = Record<string, unknown>;
export interface DocumentParseOptions {
  /** Explicit test seam; production resolves the canonical shared credential slot. */
  apiKey?: string;
  resolveApiKey?: () => Promise<string | null>;
  /** Trusted storage root. A member-supplied mediaRef is never interpreted as a path. */
  mediaRoot?: string;
  fetchImpl?: typeof fetch;
  /** Test seam for a parser exception; production uses the shared Upstage client. */
  parseDocument?: typeof runUpstageOcr;
}

/** Opaque scrap media IDs are resolved only below a verified member's directory. */
export async function resolveOwnedPdfBytes(
  mediaRef: string,
  memberId: string,
  root: string = join(elanousStateRoot(), 'absorb-media'),
): Promise<Uint8Array | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(memberId)) return null;
  const match = /^scraps\/([A-Za-z0-9][A-Za-z0-9._-]*\.pdf)$/.exec(mediaRef);
  if (!match) return null;
  const memberDir = join(root, memberId);
  const scrapsDir = join(memberDir, 'scraps');
  try {
    for (const directory of [root, memberDir, scrapsDir]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const target = join(scrapsDir, match[1]!);
    if (!(await realpath(target)).startsWith((await realpath(memberDir)) + sep)) return null;
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MEDIA_STORE_MAX_FILE_BYTES) return null;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function record(value: unknown): Scrap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Scrap : {};
}

function structure(markdown: string, text: string) {
  const source = markdown.trim() || text.trim();
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '') ?? null;
  const tables: string[][][] = [];
  const paragraphs: string[] = [];
  let table: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
      if (!cells.every(cell => /^:?-{2,}:?$/.test(cell))) table.push(cells);
    } else {
      if (table.length) tables.push(table);
      table = [];
      if (!/^#{1,6}\s/.test(line)) paragraphs.push(line);
    }
  }
  if (table.length) tables.push(table);
  return { title, tables, paragraphs };
}

/** Keeps the original member-owned scrap and adds source evidence before storage. */
export function createDocumentParseProvider(options: DocumentParseOptions = {}): GraphCapabilityProvider {
  return async context => {
    const scrap = record(context.graphInput ?? context.input);
    if (scrap.kind !== 'pdf') {
      return { ok: true, outcome: 'done', result: { scrap }, evidence: { mode: 'pass-through' } };
    }
    const mediaRef = scrap.mediaRef;
    const memberId = context.verifiedOwnerId;
    if (typeof mediaRef !== 'string' || !memberId) {
      return { ok: false, outcome: 'failed', error: 'pdf_media_ref_required' };
    }
    const inputOwner = record(scrap.context).memberId;
    if (inputOwner !== memberId) return { ok: false, outcome: 'failed', error: 'owner_mismatch' };
    try {
      const file = await resolveOwnedPdfBytes(mediaRef, memberId, options.mediaRoot);
      if (!file) return { ok: false, outcome: 'failed', error: 'pdf_media_not_owned_or_missing' };
      const key = options.apiKey ?? await (options.resolveApiKey ?? resolveUpstageApiKeyAsync)();
      if (key) {
        try {
          const parsed = await (options.parseDocument ?? runUpstageOcr)({
            file, filename: basename(mediaRef), mimeType: 'application/pdf', model: 'document-parse',
            apiKey: key, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
          if (parsed.ok && (parsed.markdown.trim() || parsed.text.trim())) {
            const source = structure(parsed.markdown, parsed.text);
            return { ok: true, outcome: 'done', result: { scrap: { ...scrap,
              text: parsed.text || parsed.markdown, documentSource: source, documentAiStatus: 'connected',
            } }, evidence: { mode: 'document-parse', status: 'connected' } };
          }
        } catch { /* parser fault is a disconnected document AI, not a failed owned read */ }
      }
      const local = await extractPdfBytes(file);
      const source = structure('', local.text);
      return { ok: true, outcome: 'done', result: { scrap: { ...scrap,
        text: local.text, documentSource: source, documentAiStatus: DOCUMENT_AI_DISCONNECTED,
      } }, evidence: { mode: 'local-pdf-text', status: DOCUMENT_AI_DISCONNECTED,
        pages: local.meta?.pages ?? null, truncated: local.truncated } };
    } catch {
      return { ok: false, outcome: 'failed', error: 'pdf_extraction_failed' };
    }
  };
}

export function createDocumentParseRegistry(options: DocumentParseOptions = {}): GraphCapabilityRegistry {
  const contract = { id: DOCUMENT_PARSE_CONTRACT, input: { type: 'object' as const },
    output: { type: 'object' as const, required: ['scrap'], properties: { scrap: { type: 'object' as const } } } };
  const registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract);
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'absorb-document-parse', provides: [DOCUMENT_PARSE_CONTRACT], tier: 'byok',
    invoke: createDocumentParseProvider(options),
  });
}
