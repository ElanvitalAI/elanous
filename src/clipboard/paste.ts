/** Shared TUI paste decision: image attachment wins, otherwise paste clipboard text. */
export type ClipboardPaste<T> =
  | { readonly kind: 'image'; readonly value: T }
  | { readonly kind: 'text'; readonly text: string; readonly imageDetected: boolean }
  | { readonly kind: 'empty'; readonly imageDetected: boolean };

export interface ClipboardPasteDeps<T> {
  readonly hasImage?: () => Promise<boolean>;
  readonly attachImage?: () => Promise<T | null>;
  readonly readText: () => Promise<string | null>;
}

/** Keeps classic and next TUI on the same image-first, text-fallback contract. */
export async function readClipboardPaste<T>(deps: ClipboardPasteDeps<T>): Promise<ClipboardPaste<T>> {
  let imageDetected = false;
  if (deps.attachImage && deps.hasImage) {
    try { imageDetected = await deps.hasImage(); } catch { imageDetected = false; }
    if (imageDetected) {
      try {
        const value = await deps.attachImage();
        if (value !== null) return { kind: 'image', value };
      } catch { /* preserve the existing text fallback when image capture fails */ }
    }
  }
  let text: string | null = null;
  try { text = await deps.readText(); } catch { text = null; }
  return text ? { kind: 'text', text, imageDetected } : { kind: 'empty', imageDetected };
}
