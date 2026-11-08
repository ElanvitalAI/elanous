import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── VW-term-infra Bundle B-2 · P6-1 + Bundle B-6 · P6-5 ──────────
//
// LLM-facing artifact tools:
//   - ListArtifacts({kind?})  — enumerate entries (B-2 foundation)
//   - GetArtifact({path})     — read body + meta (B-6 · P6-5)
//
// Both wrap the unified ArtifactStore so LLM can discover + inspect
// timelines / layouts / captures / blocks / attachments saved under
// `~/.elanous/artifacts/<kind>/` or surfaced via legacy providers.
//
// Security (GetArtifact): path must match an entry returned by
// `store.list()` · prevents directory traversal · listing cache is
// the whitelist.


import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type ArtifactStore,
} from '../artifact/index.js';
import { registerToolRuntime } from './registry.js';
import type { ToolRuntime } from './types.js';
import { withChordHint, type LLMToolSpecWithMirror } from './mirror-hints.js';

// ── Types ────────────────────────────────────────────────────────

export interface ArtifactRuntimeDeps {
  readonly store: ArtifactStore;
}

type Args = Record<string, unknown>;
type Out = { output: string };

// ── Tool spec ────────────────────────────────────────────────────

export function buildListArtifactsTool(): LLMToolSpecWithMirror {
  return withChordHint(
    {
      name: 'ListArtifacts',
      description:
        'List all artifacts saved under ~/.elanous/artifacts/ — timelines · '
        + 'layouts · captures · blocks · attachments. Pass `kind` to filter. '
        + 'Returns path + meta (kind · origin · createdAt · sizeBytes · '
        + 'description · tags) · sorted by createdAt ascending. Read-only. '
        + 'Mirrors the `^B a` chord.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [...ARTIFACT_KINDS],
            description: 'Artifact kind filter. Omit to list all kinds.',
          },
        },
      },
    },
    '^B a',
  );
}

// ── Dispatch ─────────────────────────────────────────────────────

export interface ListArtifactsOut {
  readonly artifacts: readonly {
    readonly path: string;
    readonly meta: import('../artifact/index.js').ArtifactMeta;
  }[];
  readonly total: number;
  readonly kindFilter?: ArtifactKind;
}

export function dispatchListArtifacts(
  raw: Args,
  deps: ArtifactRuntimeDeps,
): ListArtifactsOut {
  const kindRaw = raw.kind;
  const kind = typeof kindRaw === 'string'
    && ARTIFACT_KINDS.includes(kindRaw as ArtifactKind)
    ? (kindRaw as ArtifactKind)
    : undefined;

  const listings = kind ? deps.store.list(kind) : deps.store.list();
  return {
    artifacts: listings.map((l) => ({ path: l.path, meta: l.meta })),
    total: listings.length,
    ...(kind !== undefined ? { kindFilter: kind } : {}),
  };
}

// ── GetArtifact ──────────────────────────────────────────────────

export function buildGetArtifactTool(): LLMToolSpec {
  return {
    name: 'GetArtifact',
    description:
      'Fetch the body + meta for a single artifact by absolute path. '
      + '`path` MUST come from a prior `ListArtifacts` response — paths '
      + 'outside the known artifact roots are rejected. Text artifacts '
      + '(timeline/layout/block) return `body` as string · binary '
      + '(capture/attachment) return `bodyBase64` + `bytes`. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path · must appear in a recent ListArtifacts result.',
        },
      },
      required: ['path'],
    },
  };
}

export interface GetArtifactOut {
  readonly found: boolean;
  readonly path?: string;
  readonly meta?: import('../artifact/index.js').ArtifactMeta;
  readonly body?: string;
  readonly bodyBase64?: string;
  readonly bytes?: number;
  readonly note?: string;
}

export function dispatchGetArtifact(
  raw: Args,
  deps: ArtifactRuntimeDeps,
): GetArtifactOut {
  const path = typeof raw.path === 'string' ? raw.path : '';
  if (!path) {
    return { found: false, note: 'path is required' };
  }
  // Whitelist via listing — path must appear in the store's current list.
  const allowed = deps.store.list().some((l) => l.path === path);
  if (!allowed) {
    return {
      found: false,
      note: `path not in ListArtifacts results (unknown or outside artifact roots): ${path}`,
    };
  }
  try {
    const artifact = deps.store.get(path);
    const meta = artifact.meta;
    if (typeof artifact.body === 'string') {
      return {
        found: true,
        path: artifact.path,
        meta,
        body: artifact.body,
        bytes: Buffer.byteLength(artifact.body, 'utf8'),
      };
    }
    // Buffer (binary kinds)
    const buf = artifact.body as Buffer;
    return {
      found: true,
      path: artifact.path,
      meta,
      bodyBase64: buf.toString('base64'),
      bytes: buf.byteLength,
    };
  } catch (err) {
    return {
      found: false,
      note: `failed to read artifact: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

// ── Runtime ──────────────────────────────────────────────────────

let _depsRef: ArtifactRuntimeDeps | null = null;
let registered = false;

function requireDeps(): ArtifactRuntimeDeps {
  if (!_depsRef) {
    throw new Error(
      'artifact-runtimes: not registered — call registerArtifactRuntimes({store}) first',
    );
  }
  return _depsRef;
}

function stringify(obj: unknown): Out {
  return { output: JSON.stringify(obj) };
}

export function createListArtifactsRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'artifact_list',
    spec: buildListArtifactsTool(),
    async run(req) {
      return stringify(dispatchListArtifacts(req, requireDeps()));
    },
  };
}

export function createGetArtifactRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'artifact_get',
    spec: buildGetArtifactTool(),
    async run(req) {
      return stringify(dispatchGetArtifact(req, requireDeps()));
    },
  };
}

/** Idempotent registration — dashboard calls once after the
 *  `ArtifactStore` is created. Re-calling updates deps (test hot-
 *  reload) without duplicating registry entries. */
export function registerArtifactRuntimes(deps: ArtifactRuntimeDeps): void {
  _depsRef = deps;
  if (registered) return;
  registerToolRuntime(createListArtifactsRuntime());
  registerToolRuntime(createGetArtifactRuntime());
  registered = true;
}

/** Test-only — wipe registration + deps. */
export function __resetArtifactRuntimesForTest(): void {
  _depsRef = null;
  registered = false;
}
