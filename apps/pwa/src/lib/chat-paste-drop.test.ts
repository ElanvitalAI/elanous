import { describe, expect, test } from 'bun:test';
import {
  extractClipboardFiles,
  extractDroppedFiles,
  hasDroppedFiles,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
} from './chat-paste-drop';

function file(name: string, type = 'image/png'): File {
  return new File(['bytes'], name, { type });
}

function clipboard(items: { kind: string; getAsFile: () => File | null }[], files: File[] = []) {
  return { items, files } as unknown as DataTransfer;
}

function item(value: File): { kind: string; getAsFile: () => File | null } {
  return { kind: 'file', getAsFile: () => value };
}

describe('extractClipboardFiles', () => {
  test('leaves text-only and HTML paste to the browser', () => {
    const text = { kind: 'string', getAsFile: () => { throw new Error('text was read as a file'); } };
    expect(extractClipboardFiles(clipboard([text]), 123)).toEqual({ files: [], tooLarge: 0, tooMany: 0 });
    expect(extractClipboardFiles(null, 123)).toEqual({ files: [], tooLarge: 0, tooMany: 0 });
  });

  test('extracts file items only, preserves file identity and names an unnamed screenshot', () => {
    const image = file('');
    const pdf = file('notes.pdf', 'application/pdf');
    const result = extractClipboardFiles(clipboard([
      { kind: 'string', getAsFile: () => null },
      item(image),
      { kind: 'file', getAsFile: () => null },
      item(pdf),
    ]), 1700);
    expect(result.files).toEqual([
      { file: image, filename: 'paste-1700.png' },
      { file: pdf, filename: 'notes.pdf' },
    ]);
    expect(result.tooLarge).toBe(0);
    expect(result.tooMany).toBe(0);
  });

  test('falls back to clipboard files when items are unavailable', () => {
    const screenshot = file('');
    expect(extractClipboardFiles(clipboard([], [screenshot]), 42).files).toEqual([
      { file: screenshot, filename: 'paste-42.png' },
    ]);
  });

  test('does not duplicate a clipboard file listed in both items and files', () => {
    const image = file('image.png');
    expect(extractClipboardFiles(clipboard([item(image)], [image]), 42).files).toEqual([
      { file: image, filename: 'image.png' },
    ]);
  });
});

describe('extractDroppedFiles', () => {
  test('accepts only dropped files, without renaming them', () => {
    const document = file('doc.txt', 'text/plain');
    expect(extractDroppedFiles({ files: [document], types: ['Files', 'text/plain'] } as unknown as DataTransfer))
      .toEqual({ files: [{ file: document, filename: 'doc.txt' }], tooLarge: 0, tooMany: 0 });
    expect(extractDroppedFiles({ files: [], types: ['text/plain'] } as unknown as DataTransfer))
      .toEqual({ files: [], tooLarge: 0, tooMany: 0 });
    expect(extractDroppedFiles(null)).toEqual({ files: [], tooLarge: 0, tooMany: 0 });
  });

  test('recognizes file drags without claiming text or URL drags', () => {
    expect(hasDroppedFiles({ types: ['text/uri-list', 'Files'] })).toBe(true);
    expect(hasDroppedFiles({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
    expect(hasDroppedFiles(null)).toBe(false);
  });
});

test('both transfer paths report oversized and excess files while retaining valid ones', () => {
  const oversized = file('large.bin');
  Object.defineProperty(oversized, 'size', { value: MAX_CHAT_FILE_BYTES + 1 });
  const accepted = Array.from({ length: MAX_CHAT_FILES + 2 }, (_, n) => file(`file-${n}.png`));
  const batch = [oversized, ...accepted];
  const pasted = extractClipboardFiles(clipboard(batch.map(item)), 1);
  const dropped = extractDroppedFiles({ files: batch } as unknown as DataTransfer);
  for (const result of [pasted, dropped]) {
    expect(result.files.map((entry) => entry.filename)).toEqual(
      accepted.slice(0, MAX_CHAT_FILES).map((entry) => entry.name),
    );
    expect(result.tooLarge).toBe(1);
    expect(result.tooMany).toBe(2);
  }
});

test('a file exactly at the byte limit is accepted', () => {
  const boundary = file('boundary.png');
  Object.defineProperty(boundary, 'size', { value: MAX_CHAT_FILE_BYTES });
  expect(extractDroppedFiles({ files: [boundary] } as unknown as DataTransfer).files)
    .toEqual([{ file: boundary, filename: 'boundary.png' }]);
});
