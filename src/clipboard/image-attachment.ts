import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { addAttachmentEx, type ContextRegistry } from '../context.js';
import { grabClipboardImage } from './index.js';

/** Capture the clipboard image and register it in the shared attachment contract. */
export async function registerClipboardImageAttachment(
  registry: ContextRegistry,
  capture: () => Promise<string | null> = grabClipboardImage,
) {
  const sourcePath = await capture();
  if (!sourcePath) return null;
  const stat = statSync(sourcePath);
  return addAttachmentEx(registry, {
    kind: 'image',
    sourcePath,
    filename: basename(sourcePath),
    sizeBytes: stat.size,
    mtime: Math.floor(stat.mtimeMs),
  });
}
