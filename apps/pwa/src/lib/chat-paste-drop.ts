export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_FILES = 10;

export interface ChatFileExtraction {
  files: { file: File; filename: string }[];
  tooLarge: number;
  tooMany: number;
}

/** Classify a file batch without uploading or changing the transfer. */
function selectFiles(files: readonly { file: File; filename: string }[]): ChatFileExtraction {
  const result: ChatFileExtraction = { files: [], tooLarge: 0, tooMany: 0 };
  for (const entry of files) {
    if (entry.file.size > MAX_CHAT_FILE_BYTES) {
      result.tooLarge += 1;
    } else if (result.files.length >= MAX_CHAT_FILES) {
      result.tooMany += 1;
    } else {
      result.files.push(entry);
    }
  }
  return result;
}

/** Ignore text/HTML clipboard items so ordinary text paste retains its native behavior. */
export function extractClipboardFiles(
  data: Pick<DataTransfer, 'items' | 'files'> | null,
  timestamp: number,
): ChatFileExtraction {
  if (!data) return selectFiles([]);
  const files: File[] = [];
  if (data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else {
    files.push(...Array.from(data.files));
  }
  return selectFiles(files.map((file) => ({
    file,
    filename: file.name || `paste-${timestamp}.png`,
  })));
}

/** Drop payloads may also carry text or URLs; only DataTransfer.files is accepted. */
export function extractDroppedFiles(data: Pick<DataTransfer, 'files'> | null): ChatFileExtraction {
  return selectFiles(data ? Array.from(data.files, (file) => ({ file, filename: file.name })) : []);
}

/** For drag-over, avoid capturing ordinary text, URL, or element drags. */
export function hasDroppedFiles(data: Pick<DataTransfer, 'types'> | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'));
}
