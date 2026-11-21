// The bundled Nerd Font TTFs are ~2.5 MB each and only the web terminal uses them. They used to be preloaded for EVERY
// page from the root layout, so a bare webchat entry pulled 2.5 MB through the member's single relay connection next to the
// JS chunks (real pin 6ffc: first font body stalled 40 s, input box never appeared). The terminal components ask for the
// preload themselves, right before xterm measures glyphs.
const FONT_HREF = '/app/fonts/JetBrainsMonoNerdFontMono-Regular.ttf';

export function preloadTerminalFont(doc: Pick<Document, 'head' | 'querySelector' | 'createElement'> | undefined =
  typeof document === 'undefined' ? undefined : document): void {
  if (!doc?.head) return;
  try {
    if (doc.querySelector(`link[rel="preload"][href="${FONT_HREF}"]`)) return;
    const link = doc.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/ttf';
    link.href = FONT_HREF;
    link.crossOrigin = 'anonymous';
    doc.head.appendChild(link);
  } catch { /* a missing preload only means xterm re-measures once the @font-face fetch lands */ }
}
