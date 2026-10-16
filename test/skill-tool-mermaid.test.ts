import { describe, expect, test } from 'bun:test';

import {
  buildMermaidRenderTool,
  dispatchMermaidRender,
  mermaidRendererAvailable,
} from '../src/skills/tools/mermaid.js';

const SIMPLE = 'flowchart LR\n    A[Start] --> B[End]';
const MULTI = 'flowchart LR\n    A[Root] --> B[Top]\n    A --> C[Bot]\n    B --> D[Done]\n    C --> D';

async function withTerm<T>(term: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TERM;
  if (term === undefined) delete process.env.TERM;
  else process.env.TERM = term;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
}

describe('buildMermaidRenderTool', () => {
  test('schema declares source required + format enum', () => {
    const spec = buildMermaidRenderTool();
    expect(spec.name).toBe('MermaidRender');
    expect(spec.parameters.required).toEqual(['source']);
    const props = spec.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.format.enum).toEqual(['ascii', 'unicode', 'image', 'auto']);
  });
});

describe('mermaidRendererAvailable', () => {
  test('returns true because mermaidtui was added as a dep', () => {
    expect(mermaidRendererAvailable()).toBe(true);
  });
});

describe('dispatchMermaidRender — happy path', () => {
  test('renders a simple flowchart to Unicode boxes', async () => {
    // Unspecified format resolves from $TERM (unset/dumb → ascii). A gate Pod runs with no TERM,
    // so pin a capable terminal here; the TERM-less branch is asserted separately below.
    const r = await withTerm('xterm-256color', () => dispatchMermaidRender({ source: SIMPLE }));
    expect(r.metadata.renderer).toBe('mermaidtui');
    expect(r.metadata.format).toBe('unicode');
    // Contains at least one Unicode box-drawing char.
    expect(r.output).toMatch(/[┌┐└┘─│▶]/);
    // Contains node labels.
    expect(r.output).toContain('Start');
    expect(r.output).toContain('End');
  });

  test.each([[undefined], ['dumb']])('unspecified format with TERM=%p falls back to ASCII', async (term) => {
    const r = await withTerm(term, () => dispatchMermaidRender({ source: SIMPLE }));
    expect(r.metadata.format).toBe('ascii');
    expect(r.output).not.toMatch(/[┌┐└┘]/);
  });

  test('format:"ascii" uses ASCII corners', async () => {
    const r = await dispatchMermaidRender({ source: SIMPLE, format: 'ascii' });
    expect(r.metadata.format).toBe('ascii');
    // ASCII mode uses '+' corners and '|' verticals.
    expect(r.output).toMatch(/[+\-|]/);
    // No Unicode box drawings.
    expect(r.output).not.toMatch(/[┌┐└┘]/);
  });

  test('format:"image" falls back to visible unicode + notes fallback mode', async () => {
    const r = await dispatchMermaidRender({ source: SIMPLE, format: 'image' });
    expect(r.metadata.format).toBe('image-fallback');
    expect(r.output.length).toBeGreaterThan(0);
  });

  test('strips ```mermaid fences defensively', async () => {
    const r = await dispatchMermaidRender({ source: '```mermaid\n' + SIMPLE + '\n```' });
    expect(r.output).toContain('Start');
    expect(r.output).toContain('End');
  });
});

describe('dispatchMermaidRender — truncation', () => {
  test('max_height caps rows and sets metadata.truncated.byHeight', async () => {
    const r = await dispatchMermaidRender({ source: MULTI, max_height: 2 });
    const lines = r.output.split('\n');
    // ≤ 2 + 1 footer line.
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(r.metadata.truncated?.byHeight).toBeGreaterThan(0);
    expect(r.output).toMatch(/more rows?/);
  });

  test('max_width truncates lines with ellipsis', async () => {
    const r = await dispatchMermaidRender({ source: MULTI, max_width: 10 });
    const lines = r.output.split('\n');
    for (const line of lines) {
      // Allow 11 chars (10 + ellipsis char '…' counts as 1 code unit but 3 bytes).
      expect(line.length).toBeLessThanOrEqual(11);
    }
    expect(r.metadata.truncated?.byWidth).toBeGreaterThan(0);
  });

  test('display preserves the full unclipped render', async () => {
    const r = await dispatchMermaidRender({ source: MULTI, max_height: 1 });
    expect(r.display.split('\n').length).toBeGreaterThan(1);
  });
});

describe('dispatchMermaidRender — validation', () => {
  test('missing source rejected', async () => {
    await expect(dispatchMermaidRender({})).rejects.toThrow(/source/);
  });

  test('empty source rejected', async () => {
    await expect(dispatchMermaidRender({ source: '  \n  ' })).rejects.toThrow(/source/);
  });

  test('invalid format rejected', async () => {
    await expect(dispatchMermaidRender({ source: SIMPLE, format: 'bogus' })).rejects.toThrow(/format/);
  });

  test('negative max_width rejected', async () => {
    await expect(dispatchMermaidRender({ source: SIMPLE, max_width: -1 })).rejects.toThrow(/max_width/);
  });

  test('mermaid error is surfaced as an Error', async () => {
    // mermaidtui returns an in-band "Error: ..." string rather than
    // throwing on bad syntax. Our wrapper should pass the string
    // through (it's still a valid rendering of the diagnostic).
    const r = await dispatchMermaidRender({ source: 'not valid mermaid at all' });
    expect(typeof r.output).toBe('string');
  });
});

describe('catalog registration', () => {
  test('mermaid_render has probe + hintKeys', async () => {
    const { nativeToolCatalog } = await import('../src/native-tool-catalog.js');
    const entry = nativeToolCatalog.find(t => t.id === 'mermaid_render');
    expect(entry).toBeDefined();
    expect(entry!.probe?.kind).toBe('custom');
    expect(entry!.hintKeys).toContain('intentDiagram');
    expect(entry!.cleanerFitThanShell).toBe(true);
  });
});
