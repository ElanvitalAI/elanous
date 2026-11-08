import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4.3: KnowledgeWrite LLM tool ──


import { discoverObsidianVault, type ObsidianVault } from '../../auto-research/obsidian-bridge.js';
import { knowledgeWrite } from '../write.js';
import type { KnowledgeWriteInput, KnowledgeWriteResult } from '../types.js';

export interface KnowledgeWriteToolInput {
  rel_path: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  kind?: 'incident' | 'a3' | 'rca' | 'wiki' | 'repomap' | 'note';
  tags?: string[];
  overwrite?: boolean;
  strict_schema?: boolean;
}

export type KnowledgeWriteToolResult =
  | { output: string; ok: true; path: string; relPath: string; notices?: string[] }
  | { output: string; ok: false; reasonOneLine: string; errors: Extract<KnowledgeWriteResult, { ok: false }>['errors']; notices?: string[] };

export interface KnowledgeWriteDispatchOpts {
  vault?: ObsidianVault;
}

export async function dispatchKnowledgeWrite(
  input: KnowledgeWriteToolInput,
  opts: KnowledgeWriteDispatchOpts = {},
): Promise<KnowledgeWriteToolResult> {
  const vault = opts.vault ?? discoverObsidianVault();
  const notices: string[] = [];
  if (vault.isSimulated) notices.push(`vault fallback in use: ${vault.root}`);

  const coreInput: KnowledgeWriteInput = {
    rel_path: input.rel_path,
    body: input.body,
  };
  if (input.frontmatter) coreInput.frontmatter = input.frontmatter;
  if (input.kind) coreInput.kind = input.kind;
  if (input.tags) coreInput.tags = input.tags;
  if (input.overwrite !== undefined) coreInput.overwrite = input.overwrite;
  if (input.strict_schema !== undefined) coreInput.strict_schema = input.strict_schema;

  try {
    const result = knowledgeWrite(vault, coreInput);
    if (result.ok) {
      return {
        output: `KnowledgeWrite: wrote ${result.relPath}`,
        ok: true,
        path: result.path,
        relPath: result.relPath,
        ...(notices.length ? { notices } : {}),
      };
    }
    return {
      output: `KnowledgeWrite: schema rejected — ${result.reasonOneLine}`,
      ok: false,
      reasonOneLine: result.reasonOneLine,
      errors: result.errors,
      ...(notices.length ? { notices } : {}),
    };
  } catch (err) {
    return {
      output: `KnowledgeWrite failed: ${(err as Error).message}`,
      ok: false,
      reasonOneLine: (err as Error).message,
      errors: [],
      ...(notices.length ? { notices } : {}),
    } as KnowledgeWriteToolResult;
  }
}

export function buildKnowledgeWriteTool(): LLMToolSpec {
  return {
    name: 'KnowledgeWrite',
    description:
      'Write a markdown note to the Obsidian knowledge vault (or simulated fallback). Frontmatter is merged '
      + 'from the frontmatter field + kind + tags. If kind is provided and strict_schema (default true), the '
      + 'frontmatter is validated against the kind schema (required fields); mismatches return ok:false with '
      + 'structured errors and the file is NOT written. overwrite defaults to false.',
    parameters: {
      type: 'object',
      properties: {
        rel_path: {
          type: 'string',
          description: 'Vault-relative path, e.g. "Incidents/2026-04-19-A.md". No leading slash, no "..".',
        },
        body: {
          type: 'string',
          description: 'Markdown body (frontmatter is separately supplied).',
        },
        frontmatter: {
          type: 'object',
          description: 'Key/value fields merged into the rendered frontmatter block.',
          additionalProperties: true,
        },
        kind: {
          type: 'string',
          enum: ['incident', 'a3', 'rca', 'wiki', 'repomap', 'note'],
          description: 'Categorises the note; enables the kind schema (required fields per kind).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Merged into frontmatter.tags.',
        },
        overwrite: { type: 'boolean', description: 'Default false — throws when file exists.' },
        strict_schema: { type: 'boolean', description: 'Default true — enforces kind-specific required fields.' },
      },
      required: ['rel_path', 'body'],
      additionalProperties: false,
    },
  };
}
