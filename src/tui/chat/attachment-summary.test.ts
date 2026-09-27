// ── attachment-summary tui/ 이전 shim 무결성 (RFC §6b · M2 · 2026-07-17) ──
//
// attachment-summary 를 dashboard/ → tui/chat/ 으로 이전했다. caller(dashboard/
// index.ts)가 아직 구경로로 import 하므로 shim 이 새 경로를 re-export 하는지 잠근다.

import { describe, it, expect } from 'bun:test';
import { renderDashboardAttachmentSummary as fromTui } from './attachment-summary.js';
import { renderDashboardAttachmentSummary as fromShim } from '../../dashboard/attachment-summary.js';

describe('attachment-summary — tui/ 이전 shim', () => {
  it('keeps essential attachment summary without scratch callbacks', () => {
    const lines: string[] = [];
    const rows: Array<[number, number]> = [];
    const attachment = { kind: 'image', id: 1, token: '[Image #1]', filename: 'image.png', sourcePath: '/tmp/image.png', sizeBytes: 8 };
    fromTui([{ attachment, isNew: true }] as Parameters<typeof fromTui>[0], {
      formatNewLine: (item) => item.token,
      formatExistingLine: () => 'existing',
      pushLine: (line) => { lines.push(line); return lines.length - 1; },
      trackRow: (row, id) => { rows.push([row, id]); },
    });
    expect(lines).toEqual(['[Image #1]']);
    expect(rows).toEqual([[0, 1]]);
  });
  it('tui/chat/ 가 렌더러를 export 한다', () => {
    expect(typeof fromTui).toBe('function');
  });

  it('구경로 shim(dashboard/) 이 동일 심볼을 re-export 한다(하위호환)', () => {
    expect(fromShim).toBe(fromTui);
  });
});
