import { describe, expect, test } from 'bun:test';
import { formatSidetabLines } from './list.js';
import type { SidetabRow } from '../../sidetab-core/model.js';

type PreviewRow = SidetabRow & { readonly previewSource: string };

describe('Next TUI agent sidechat', () => {
  const rows: PreviewRow[] = [
    { id: 'pty:shell', kind: 'shell', label: 'shell', badge: 'idle', previewSource: 'shell output' },
    { id: 'pty:agent', kind: 'codex', label: 'codex', badge: 'busy', previewSource: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' },
  ];

  test('shows the selected agent conversation beside the parent chat with an attach cue', () => {
    const lines = formatSidetabLines(rows, 1, 28, 14);
    expect(lines.join('\n')).toContain('agent chat · Enter attach');
    expect(lines.join('\n')).toContain('↳ seven');
    expect(lines.join('\n')).toContain('↳ two');
    expect(lines.join('\n')).not.toContain('↳ one');
    expect(lines.join('\n')).not.toContain('shell output');
    expect(lines.some((line) => line.includes('› busy codex'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(14); // Source: #37132 terminal height for full agent sidechat
    expect(lines.every((line) => Bun.stringWidth(line) <= 28)).toBe(true);
  });

  test('preserves an agent row and the new action in a short terminal', () => {
    const lines = formatSidetabLines(rows, 1, 16, 7);
    expect(lines.some((line) => line.includes('› busy codex'))).toBe(true);
    expect(lines.some((line) => line.includes('+ new'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(7); // Source: #37132 short terminal viewport
  });

  test('keeps the ordinary shell preview at three lines', () => {
    const shell: PreviewRow = { ...rows[0]!, previewSource: 'one\ntwo\nthree\nfour' };
    const lines = formatSidetabLines([shell], 0, 20, 12);
    expect(lines.join('\n')).toContain('↳ two');
    expect(lines.join('\n')).not.toContain('↳ one');
    expect(lines.join('\n')).not.toContain('agent chat');
  });
});
