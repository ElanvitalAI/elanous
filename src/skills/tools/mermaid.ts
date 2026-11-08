import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: mermaid_render
//
// Turn mermaid syntax into a terminal-displayable diagram. Wraps the
// `mermaidtui` npm package (TypeScript, Unicode/ASCII output; v0.0.5
// covers flowchart LR/RL/TB/BT with labeled boxes + arrows). Probe-
// gated: absent if `mermaidtui` isn't resolvable.
//
// Output shape matches the opencode pattern the audit flagged —
// `output` is the model-facing summary (with truncation applied),
// `display` holds the full text for dashboard rendering.
//
// Image-based rendering (iTerm2 OSC 1337, Kitty graphics protocol)
// is designed in via the `format` param but not implemented at
// landing. The shape is: when format === 'image' and the terminal
// supports it, emit an inline-image escape sequence; else fall
// through to ascii. No architectural change needed to light that up.



export interface MermaidRenderArgs {
  source: string;
  format?: 'ascii' | 'unicode' | 'image' | 'auto';
  max_width?: number;
  max_height?: number;
}

export interface MermaidRenderResult {
  output: string;
  display: string;
  metadata: {
    lines: number;
    renderer: 'mermaidtui' | 'fallback';
    truncated?: { byHeight?: number; byWidth?: number };
    format: 'unicode' | 'ascii' | 'image-fallback';
  };
}

const DEFAULT_MAX_HEIGHT = 40;
const MAX_SOURCE_BYTES = 100_000;  // 100 KB — mermaid source should be tiny

export function buildMermaidRenderTool(): LLMToolSpec {
  return {
    name: 'MermaidRender',
    description:
      'Render mermaid syntax as a terminal-displayable diagram (flowchart LR/RL/TB/BT with ' +
      'labeled boxes + directed arrows). Use this instead of describing the diagram in prose ' +
      'when the user wants a visual. Pass mermaid source WITHOUT ```mermaid fences. Outputs ' +
      'Unicode boxes by default; pass format:"ascii" for ASCII-only terminals.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Mermaid source. No ```mermaid fences. Example: "flowchart LR\\n  A[Start] --> B[End]".',
        },
        format: {
          type: 'string',
          enum: ['ascii', 'unicode', 'image', 'auto'],
          description: 'ascii = ASCII-only; unicode = box-drawing chars (default); image = reserved for future inline-image protocols; auto = pick unicode unless $TERM is dumb.',
        },
        max_width: {
          type: 'integer',
          description: `Max columns. Defaults to terminal width (falls back to 120).`,
        },
        max_height: {
          type: 'integer',
          description: `Max rows before truncation. Default ${DEFAULT_MAX_HEIGHT}. Truncated output gets a "…+N more rows" footer.`,
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
  };
}

export async function dispatchMermaidRender(
  rawArgs: Record<string, unknown>,
  rendererOverride?: RendererFn,
): Promise<MermaidRenderResult> {
  const args = validate(rawArgs);

  // Strip ``` mermaid fences defensively — even though we say "no
  // fences" in the schema description, models pass them ~40% of the
  // time. This is cheaper than re-rolling a failed tool call.
  const source = args.source
    .replace(/^\s*```(?:mermaid)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();

  const renderer = rendererOverride ?? await loadRenderer();
  if (!renderer) {
    // Probe should have hidden this tool via catalog.onFail='hide',
    // but if the user calls it anyway, return a structured error.
    throw new Error('mermaidtui is not installed — run `bun add mermaidtui` to enable MermaidRender');
  }

  const format = resolveFormat(args.format);
  // image-fallback renders as unicode but labels itself differently
  // in metadata so the caller/test can distinguish "I asked for an
  // image but got a text fallback" from "I asked for text outright".
  const asciiMode = format === 'ascii';

  let rendered: string;
  try {
    rendered = renderer(source, { ascii: asciiMode });
  } catch (err) {
    throw new Error(`mermaid render failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Truncate by width + height.
  const maxWidth = args.max_width && args.max_width > 0
    ? args.max_width
    : terminalWidth();
  const maxHeight = args.max_height && args.max_height > 0
    ? args.max_height
    : DEFAULT_MAX_HEIGHT;

  const lines = rendered.split('\n');
  const truncMeta: { byHeight?: number; byWidth?: number } = {};

  let widthTruncated = 0;
  const widthCapped = lines.map(line => {
    if (line.length <= maxWidth) return line;
    widthTruncated++;
    return line.slice(0, maxWidth - 1) + '…';
  });
  if (widthTruncated > 0) truncMeta.byWidth = widthTruncated;

  let finalLines = widthCapped;
  if (widthCapped.length > maxHeight) {
    const dropped = widthCapped.length - maxHeight;
    finalLines = [...widthCapped.slice(0, maxHeight), `…+${dropped} more row${dropped === 1 ? '' : 's'}`];
    truncMeta.byHeight = dropped;
  }

  const full = rendered;
  const truncated = finalLines.join('\n');

  return {
    output: truncated,
    display: full,
    metadata: {
      lines: lines.length,
      renderer: 'mermaidtui',
      // Report the resolved format verbatim (including 'image-fallback')
      // so callers can tell inline-image was requested but not supported.
      format,
      truncated: Object.keys(truncMeta).length > 0 ? truncMeta : undefined,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

type RendererFn = (source: string, opts?: { ascii?: boolean }) => string;
let cachedRenderer: RendererFn | null | undefined = undefined;

async function loadRenderer(): Promise<RendererFn | null> {
  if (cachedRenderer !== undefined) return cachedRenderer;
  try {
    // mermaidtui ships ESM-only JS without .d.ts, so the dynamic
    // import is typed as `any`. Narrowing via cast + runtime check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('mermaidtui');
    const fn = mod?.renderMermaidToTui;
    if (typeof fn !== 'function') { cachedRenderer = null; return null; }
    cachedRenderer = fn as RendererFn;
    return cachedRenderer;
  } catch {
    cachedRenderer = null;
    return null;
  }
}

/** Probe-compatible sync check. Used by the catalog entry's
 *  `probe: { kind: 'custom', custom: mermaidRendererAvailable }`. */
export function mermaidRendererAvailable(): boolean {
  try {
    require.resolve('mermaidtui');
    return true;
  } catch {
    return false;
  }
}

function resolveFormat(requested: MermaidRenderArgs['format']): 'ascii' | 'unicode' | 'image-fallback' {
  if (requested === 'ascii') return 'ascii';
  if (requested === 'unicode') return 'unicode';
  if (requested === 'image') {
    // Image protocols not implemented at P8. Fall back to unicode
    // so the model still gets a visible diagram.
    return 'image-fallback';
  }
  // 'auto' or unspecified: unicode unless dumb terminal.
  const term = process.env.TERM ?? '';
  if (term === 'dumb' || term === '') return 'ascii';
  return 'unicode';
}

function terminalWidth(): number {
  const stdout = process.stdout as NodeJS.WriteStream;
  const cols = stdout.columns;
  if (typeof cols === 'number' && cols > 0) return cols;
  return 120;
}

function validate(raw: Record<string, unknown>): MermaidRenderArgs {
  const source = raw.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error(`'source' is required and must be non-empty mermaid syntax`);
  }
  if (Buffer.byteLength(source, 'utf-8') > MAX_SOURCE_BYTES) {
    throw new Error(`'source' exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  const format = raw.format;
  if (format !== undefined && !['ascii', 'unicode', 'image', 'auto'].includes(format as string)) {
    throw new Error(`'format' must be one of ascii|unicode|image|auto`);
  }
  const maxWidth = raw.max_width;
  if (maxWidth !== undefined && (typeof maxWidth !== 'number' || maxWidth <= 0)) {
    throw new Error(`'max_width' must be a positive number`);
  }
  const maxHeight = raw.max_height;
  if (maxHeight !== undefined && (typeof maxHeight !== 'number' || maxHeight <= 0)) {
    throw new Error(`'max_height' must be a positive number`);
  }
  return {
    source,
    format: format as MermaidRenderArgs['format'] | undefined,
    max_width: maxWidth as number | undefined,
    max_height: maxHeight as number | undefined,
  };
}
