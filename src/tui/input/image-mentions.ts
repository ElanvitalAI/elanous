import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Submit-time image mentions (reference: grok-cli src/agent/vision-input.ts `extractImageSourcesFromPrompt`
 *  and src/utils/at-mentions.ts). A typed or pasted image path that never went through the picker or the
 *  paste hook still reaches the model as an image: «@/tmp/shot.png», «@shots/a.png», «@"/a/my shot.png"»,
 *  or a bare absolute / «~/» path ending in an image extension. Only existing regular files ≤ the size
 *  ceiling count; everything else stays plain text. */
export const IMAGE_MENTION_MAX_BYTES = 20 * 1024 * 1024;

/** Raster formats the REPL child turns into image input (repl/index.ts loadAttachment: png/jpg/jpeg/gif/webp). */
const IMAGE_ATTACH_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isImageAttachmentPath(path: string): boolean {
  return IMAGE_ATTACH_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

const QUOTED_AT = /(?:^|\s)@"([^"\n]+)"/g;
const UNQUOTED_AT = /(?:^|\s)@((?:[^\s"'\\]|\\ )+)/g;
const BARE_PATH = /(?:^|[\s("'])((?:\/|~\/)(?:[^\s"'()\\]|\\ )+?\.(?:png|jpe?g|gif|webp))(?=$|[\s)"'.,;:!?])/gi;

function resolveMention(raw: string, cwd: string): string {
  const path = raw.replace(/\\ /g, ' ');
  if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isAttachableImage(path: string): boolean {
  if (!isImageAttachmentPath(path)) return false;
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0 && st.size <= IMAGE_MENTION_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Absolute paths of existing images mentioned in `text`, in order, de-duplicated. */
export function imagePathMentions(text: string, cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string, relativeOk: boolean): void => {
    if (!relativeOk && !(raw.startsWith('/') || raw.startsWith('~/'))) return;
    const path = resolveMention(raw, cwd);
    if (seen.has(path) || !isAttachableImage(path)) return;
    seen.add(path);
    found.push(path);
  };
  for (const re of [QUOTED_AT, UNQUOTED_AT]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) consider(m[1]!.replace(/[.,;:!?)]+$/, ''), true);
  }
  BARE_PATH.lastIndex = 0;
  for (let m = BARE_PATH.exec(text); m !== null; m = BARE_PATH.exec(text)) consider(m[1]!, false);
  return found;
}
