// ── Capture Phase 0.5 — PNG encoder ──
//
// SVG → PNG rasterizer on top of `sharp` (already a first-order
// project dep for other image tasks). Async because sharp's pipeline
// is promise-based; the separate entry point (`captureImage()` in
// engine.ts) keeps the sync `capture()` path untouched for
// text/ansi/asciicast/svg formats.
//
// Scope:
//   - Plain SVG → PNG Buffer
//   - Caller can scale via `width` / `height` (fits-to; aspect preserved)
//   - Background transparency passes through when SVG has none
//
// Upstream benefit (§ROADMAP-capture-recording Phase 2+): `Screenshot`
// LLM tool returns PNG so Claude / GPT-4V / Gemini can read pane
// state VISUALLY — tmux status bars, htop gauges, btop graphs, neovim
// statuslines that ANSI strip would destroy.

// IMPORT-DIET-LAZY-SDK (2026-11-05): sharp(네이티브)는 실제로 그릴 때만 싣는다.

export interface SvgToPngOpts {
  /** Target PNG width in pixels; aspect preserved. Omit for SVG-native. */
  readonly width?: number;
  /** Target PNG height in pixels; aspect preserved. Omit for SVG-native. */
  readonly height?: number;
  /** Background color CSS string (e.g. "#1e1e1e") painted behind the
   *  SVG before PNG emit. Useful when the SVG is transparent and the
   *  consumer wants a solid frame. */
  readonly background?: string;
  /** PNG compression level 0-9. Higher = smaller + slower. sharp default 6. */
  readonly compressionLevel?: number;
}

export async function svgToPng(
  svg: string,
  opts: SvgToPngOpts = {},
): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  let pipe = sharp(Buffer.from(svg, 'utf8'));
  if (opts.width !== undefined || opts.height !== undefined) {
    pipe = pipe.resize({
      ...(opts.width !== undefined ? { width: opts.width } : {}),
      ...(opts.height !== undefined ? { height: opts.height } : {}),
      fit: 'inside',
    });
  }
  if (opts.background) {
    pipe = pipe.flatten({ background: opts.background });
  }
  pipe = pipe.png({
    compressionLevel: opts.compressionLevel ?? 6,
  });
  return pipe.toBuffer();
}
