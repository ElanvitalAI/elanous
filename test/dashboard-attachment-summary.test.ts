import { describe, expect, test } from 'bun:test';

import { renderDashboardAttachmentSummary } from '../src/dashboard/attachment-summary.js';
import type { Attachment } from '../src/context.js';

const pdfAttachment = {
  id: 1,
  token: '[PDF #1]',
  kind: 'pdf',
  sourcePath: '/tmp/a.pdf',
  filename: 'a.pdf',
  sizeBytes: 100,
  mtime: 1,
} as Attachment;

const imageAttachment = {
  id: 2,
  token: '[Image #2]',
  kind: 'image',
  sourcePath: '/tmp/b.png',
  filename: 'b.png',
  sizeBytes: 200,
  mtime: 1,
} as Attachment;

describe('renderDashboardAttachmentSummary', () => {
  test('formats new vs duplicate rows, tracks rows, and routes scratch updates', async () => {
    const lines: string[] = [];
    const tracked: string[] = [];
    const scratch: string[] = [];

    renderDashboardAttachmentSummary([
      { attachment: pdfAttachment, isNew: true },
      { attachment: pdfAttachment, isNew: false },
      { attachment: imageAttachment, isNew: true },
    ], {
      formatNewLine: (attachment) => `new:${attachment.token}`,
      formatExistingLine: (attachment) => `existing:${attachment.token}`,
      pushLine: (line) => {
        lines.push(line);
        return lines.length - 1;
      },
      trackRow: (row, attachmentId) => { tracked.push(`${row}:${attachmentId}`); },
      setScratchImage: async (sourcePath, filename) => { scratch.push(`image:${sourcePath}:${filename}`); },
      setScratchFile: (attachment) => { scratch.push(`file:${attachment.token}`); },
    });

    await Promise.resolve();

    expect(lines).toEqual([
      'new:[PDF #1]',
      'existing:[PDF #1]',
      'new:[Image #2]',
    ]);
    expect(tracked).toEqual(['0:1', '1:1', '2:2']);
    expect(scratch).toEqual(['file:[PDF #1]', 'image:/tmp/b.png:b.png']);
  });

  test('essential summary works without rich scratch preview handlers', () => {
    const lines: string[] = [];
    const tracked: string[] = [];
    renderDashboardAttachmentSummary([
      { attachment: pdfAttachment, isNew: true },
      { attachment: imageAttachment, isNew: true },
    ], {
      formatNewLine: (attachment) => `new:${attachment.token}`,
      formatExistingLine: (attachment) => `existing:${attachment.token}`,
      pushLine: (line) => { lines.push(line); return lines.length - 1; },
      trackRow: (row, id) => { tracked.push(`${row}:${id}`); },
    });
    expect(lines).toEqual(['new:[PDF #1]', 'new:[Image #2]']);
    expect(tracked).toEqual(['0:1', '1:2']);
  });
});
