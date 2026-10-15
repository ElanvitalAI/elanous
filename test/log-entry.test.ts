// ── Log-entry renderer tests (Phase F1a) ──
//
// LogEntry replaces the free-form strings skill-runner.ts used to push
// into chatLines ("$ cmd", "[Read] path"). Each entry renders to one or
// more ANSI-styled lines via `renderLogEntry`. These tests lock the
// visual contract — glyph presence, tool-name shape, truncation — so
// future renderer tweaks don't silently regress the log pane.
//
// We strip ANSI for assertion: chalk emits ESC[...m sequences and we
// don't want those in the fixture strings. The only ASCII form we
// assert against is the underlying glyph + text layout.

import { describe, test, expect } from 'bun:test';
import {
  renderLogEntry, renderLogEntryAsString, summarizeToolCall, G,
  formatCompactNumber, formatDuration, formatAgentDone,
  renderAgentChildBlock, TOOL_BODY_MAX_LINES, formatAgentBatchStatus, agentBatchScanner,
  countFoldedItems, FOLD_LIMITS,
} from '../src/log-entry';
import { toolHeader } from '../src/render';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, '');

describe('summarizeToolCall', () => {
  test('RunShell heredoc renders one visible header row with newline markers', () => {
    const summary = summarizeToolCall('RunShell', {
      command: ['cat <<\'EOF\'\nfirst\r\nsecond\rEOF'], cwd: '/tmp',
    });
    expect(summary).toBe("cat <<'EOF' ↵ first ↵ second ↵ EOF cwd=/tmp");
    expect(summary).not.toMatch(/[\r\n]/);
  });

  test('toolHeader keeps a multiline description on one physical row', () => {
    const header = strip(toolHeader('RunShell', 'cat <<EOF\nline 1\nEOF'));
    expect(header).toContain('cat <<EOF ↵ line 1 ↵ EOF');
    expect(header).not.toMatch(/[\r\n]/);
  });

  test('structured tool-header also marks embedded command newlines', () => {
    const header = strip(renderLogEntryAsString({
      kind: 'tool-header', toolName: 'RunShell', summary: 'cat <<EOF\nline 1\nEOF',
    }));
    expect(header).toContain('cat <<EOF ↵ line 1 ↵ EOF');
    expect(header).not.toMatch(/[\r\n]/);
  });

  test('Bash: command, trims whitespace, handles empty', () => {
    expect(summarizeToolCall('Bash', { command: '  ls -la  ' })).toBe('ls -la');
    expect(summarizeToolCall('Bash', { command: '' })).toBe('(empty command)');
    expect(summarizeToolCall('Bash', {})).toBe('(empty command)');
  });

  test('Read: path, with optional offset/limit', () => {
    expect(summarizeToolCall('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeToolCall('Read', { file_path: '/a/b.ts', offset: 10, limit: 50 }))
      .toBe('/a/b.ts offset=10 limit=50');
  });

  test('Edit: path, replace_all flag', () => {
    expect(summarizeToolCall('Edit', { file_path: '/x.md' })).toBe('/x.md');
    expect(summarizeToolCall('Edit', { file_path: '/x.md', replace_all: true }))
      .toBe('/x.md (replace_all)');
  });

  test('Grep: pattern, optional path/glob/mode', () => {
    expect(summarizeToolCall('Grep', { pattern: 'foo' })).toBe('"foo"');
    expect(summarizeToolCall('Grep', { pattern: 'foo', path: '/src', glob: '*.ts', output_mode: 'content' }))
      .toBe('"foo" in /src glob=*.ts mode=content');
  });

  test('WebFetch: url', () => {
    expect(summarizeToolCall('WebFetch', { url: 'https://example.com' }))
      .toBe('https://example.com');
  });

  test('Agent: description, fallback when missing', () => {
    expect(summarizeToolCall('Agent', { description: 'Do the thing' }))
      .toBe('Do the thing');
    expect(summarizeToolCall('Agent', {})).toBe('(no description)');
  });

  test('Unknown tool: JSON-stringified args', () => {
    expect(summarizeToolCall('Mystery', { x: 1 })).toBe('{"x":1}');
  });

  test('Lsp hover / goToDefinition / findReferences → "op path:line:col"', () => {
    expect(summarizeToolCall('Lsp', {
      operation: 'hover', filePath: 'src/llm.ts', line: 10, character: 20,
    })).toBe('hover src/llm.ts:10:20');
    expect(summarizeToolCall('Lsp', {
      operation: 'goToDefinition', filePath: 'src/llm.ts', line: 1251, character: 15,
    })).toBe('goToDefinition src/llm.ts:1251:15');
    expect(summarizeToolCall('Lsp', {
      operation: 'findReferences', filePath: 'src/llm.ts', line: 5, character: 3,
    })).toBe('findReferences src/llm.ts:5:3');
  });

  test('Lsp documentSymbol → "documentSymbol path"', () => {
    expect(summarizeToolCall('Lsp', {
      operation: 'documentSymbol', filePath: 'src/llm.ts',
    })).toBe('documentSymbol src/llm.ts');
  });

  test('Lsp workspaceSymbol → `workspaceSymbol "query"`', () => {
    expect(summarizeToolCall('Lsp', {
      operation: 'workspaceSymbol', query: 'streamLLM',
    })).toBe('workspaceSymbol "streamLLM"');
  });
});

describe('renderLogEntry — text entries', () => {
  test('text: returns lines split on newline, preserves empty as one blank', () => {
    expect(renderLogEntry({ kind: 'text', text: '' })).toEqual(['']);
    expect(renderLogEntry({ kind: 'text', text: 'hello' })).toEqual(['hello']);
    expect(renderLogEntry({ kind: 'text', text: 'a\nb\nc' })).toEqual(['a', 'b', 'c']);
  });

  test('section: single styled line containing the label', () => {
    const out = renderLogEntry({ kind: 'section', label: 'Panel' });
    expect(out).toHaveLength(1);
    expect(strip(out[0]!)).toBe('Panel');
  });
});

describe('renderLogEntry — tool-header', () => {
  test('contains ⏺ glyph + tool name + summary', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'tool-header', toolName: 'Bash', summary: 'python3 script.py',
    }));
    expect(line).toContain(G.CIRCLE);      // ⏺
    expect(line).toContain('Bash');
    expect(line).toContain('python3 script.py');
    // Shape: "⏺ Bash(summary)"
    expect(line).toMatch(/^\S+ Bash\(/);
  });

  test('truncates oversize summary with ellipsis', () => {
    const longCmd = 'x'.repeat(200);
    const line = strip(renderLogEntryAsString({
      kind: 'tool-header', toolName: 'Bash', summary: longCmd,
    }));
    expect(line.length).toBeLessThan(longCmd.length);
    expect(line).toContain('\u2026');  // …
  });
});

describe('renderLogEntry — agent-start', () => {
  test('default subagent_type (general-purpose) — no type tag shown', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-start',
      description: 'Data collector Samsung',
      subagentType: 'general-purpose',
    }));
    expect(line).toContain(G.CIRCLE);
    expect(line).toContain('Agent');
    expect(line).toContain('Data collector Samsung');
    expect(line).not.toContain('[general-purpose]');
  });

  test('non-default subagent_type — rendered as dim [type] tag', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-start',
      description: 'Flow analysis',
      subagentType: 'explorer',
    }));
    expect(line).toContain('Agent(');
    expect(line).toContain('Flow analysis');
    expect(line).toContain('[explorer]');
  });

  test('empty description falls back to placeholder', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-start', description: '', subagentType: 'general-purpose',
    }));
    expect(line).toContain('(no description)');
  });
});

describe('renderLogEntry — agent-child', () => {
  test('variant=tool uses fn-call form with ⎿', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'tool',
      label: 'Bash', summary: 'python3 script.py',
    }));
    expect(line).toContain(G.BRACKET);     // ⎿
    expect(line).toMatch(/Bash\(python3 script\.py\)/);
  });

  test('variant=prompt/response uses "Label: summary" form', () => {
    const prompt = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'prompt',
      label: 'Prompt', summary: 'Analyze the X',
    }));
    expect(prompt).toContain(G.BRACKET);
    expect(prompt).toMatch(/Prompt: Analyze the X/);

    const response = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'response',
      label: 'Response', summary: 'Result ready',
    }));
    expect(response).toMatch(/Response: Result ready/);
  });

  test('variant=done: label without colon/summary when summary empty', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'done', label: 'Done', summary: '',
    }));
    expect(line).toContain(G.BRACKET);
    expect(line).toContain('Done');
    expect(line).not.toContain(':');
  });

  test('variant=done with stats: "Done: 2 tool uses · 26.2k tokens · 9s"', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'done',
      label: 'Done', summary: '2 tool uses · 26.2k tokens · 9s',
    }));
    expect(line).toContain('Done');
    expect(line).toContain('2 tool uses');
    expect(line).toContain('26.2k tokens');
  });

  test('indentation puts ⎿ under the parent’s character after ⏺', () => {
    const line = renderLogEntryAsString({
      kind: 'agent-child', variant: 'tool',
      label: 'Bash', summary: 'cmd',
    });
    // Default indent = two spaces before the glyph.
    expect(line.startsWith('  ')).toBe(true);
  });
});

describe('tool-body truncation (iter: Read JSON flood fix)', () => {
  test('short body passes through unchanged', () => {
    const out = renderLogEntry({ kind: 'tool-body', text: 'line1\nline2\nline3' });
    expect(out).toHaveLength(3);
    expect(strip(out[0]!)).toBe('line1');
    expect(strip(out[2]!)).toBe('line3');
  });

  test('empty body → zero lines emitted', () => {
    expect(renderLogEntry({ kind: 'tool-body', text: '' })).toEqual([]);
  });

  test('body past TOOL_BODY_MAX_LINES → capped + "N more lines" marker', () => {
    const lines = Array.from({ length: TOOL_BODY_MAX_LINES + 100 }, (_, i) => `line ${i}`);
    const out = renderLogEntry({ kind: 'tool-body', text: lines.join('\n') });
    // TOOL_BODY_MAX_LINES content + 1 marker
    expect(out).toHaveLength(TOOL_BODY_MAX_LINES + 1);
    expect(strip(out[out.length - 1]!)).toContain('100 more lines');
    expect(strip(out[out.length - 1]!)).not.toContain('press f');
    const rich = renderLogEntry({ kind: 'tool-body', text: lines.join('\n') }, { expandHint: true });
    expect(strip(rich[rich.length - 1]!)).toContain('press f to expand');
  });

  test('exactly TOOL_BODY_MAX_LINES → no marker (equality is not past)', () => {
    const lines = Array.from({ length: TOOL_BODY_MAX_LINES }, (_, i) => `x${i}`);
    const out = renderLogEntry({ kind: 'tool-body', text: lines.join('\n') });
    expect(out).toHaveLength(TOOL_BODY_MAX_LINES);
    expect(strip(out[out.length - 1]!)).toBe(`x${TOOL_BODY_MAX_LINES - 1}`);
  });

  test('isError flag passes through text content unchanged (styling optional)', () => {
    // Chalk may render colorless in non-TTY test envs; assert that the
    // path runs and the text content survives the color wrapper.
    const out = renderLogEntry({ kind: 'tool-body', text: 'boom', isError: true });
    expect(out).toHaveLength(1);
    expect(strip(out[0]!)).toBe('boom');
  });

  test('singular "1 more line" when exactly one line is hidden', () => {
    const lines = Array.from({ length: TOOL_BODY_MAX_LINES + 1 }, (_, i) => `l${i}`);
    const out = renderLogEntry({ kind: 'tool-body', text: lines.join('\n') });
    const marker = strip(out[out.length - 1]!);
    expect(marker).toContain('1 more line');
    expect(marker).not.toContain('1 more lines');
  });

  test('custom maxLines override via RenderOpts.maxLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const out = renderLogEntry({ kind: 'tool-body', text: lines.join('\n') }, { maxLines: 5 });
    expect(out).toHaveLength(6);   // 5 body + 1 marker
    expect(strip(out[5]!)).toContain('15 more lines');
  });
});

describe('formatCompactNumber (Phase F1c)', () => {
  test('below 1000 → raw integer', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });
  test('thousands → "X.Yk" or "XYk" past 10k', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(1500)).toBe('1.5k');
    expect(formatCompactNumber(26234)).toBe('26k');
    expect(formatCompactNumber(9500)).toBe('9.5k');
  });
  test('millions → "X.YM" or "XYM"', () => {
    expect(formatCompactNumber(1_500_000)).toBe('1.5M');
    expect(formatCompactNumber(12_000_000)).toBe('12M');
  });
});

describe('formatDuration (Phase F1c)', () => {
  test('sub-minute → "Ns"', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(9_000)).toBe('9s');
    expect(formatDuration(59_999)).toBe('59s');
  });
  test('minutes → "Nm Ss" (s omitted when exact)', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(112_000)).toBe('1m 52s');
  });
  test('hours → "Hh Mm" (m omitted when exact)', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
  test('negative clamps to 0s', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });
});

describe('formatAgentDone (Phase F1c)', () => {
  test('full form: tools + tokens + duration', () => {
    const s = formatAgentDone({
      toolCount: 2, durationMs: 9000,
      outputChars: 400, promptChars: 800,
    });
    // 1200 chars / 4 = 300 tokens → "300 tokens"
    expect(s).toBe('2 tool uses \u00B7 300 tokens \u00B7 9s');
  });
  test('singular tool use', () => {
    const s = formatAgentDone({
      toolCount: 1, durationMs: 5000,
      outputChars: 100, promptChars: 100,
    });
    expect(s).toContain('1 tool use');
    expect(s).not.toContain('1 tool uses');
  });
  test('toolCount=0 → no tool segment', () => {
    const s = formatAgentDone({
      toolCount: 0, durationMs: 3000,
      outputChars: 40, promptChars: 40,
    });
    expect(s).not.toContain('tool');
    expect(s).toMatch(/tokens.*3s|3s$/);
  });
  test('zero chars → no tokens segment', () => {
    const s = formatAgentDone({
      toolCount: 0, durationMs: 1000,
      outputChars: 0, promptChars: 0,
    });
    expect(s).toBe('1s');
  });
});

describe('agent-child block introducers (Phase F2) — prompt/response always end with ":"', () => {
  test('variant=prompt with empty summary still includes ":"', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'prompt', label: 'Prompt', summary: '',
    }));
    expect(line).toContain('Prompt:');
  });

  test('variant=response with empty summary still includes ":"', () => {
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'response', label: 'Response', summary: '',
    }));
    expect(line).toContain('Response:');
  });

  test('variant=done with empty summary does NOT include ":"', () => {
    // done is a card closer, not a block introducer — no trailing colon
    // when no summary is present.
    const line = strip(renderLogEntryAsString({
      kind: 'agent-child', variant: 'done', label: 'Done', summary: '',
    }));
    expect(line).not.toContain(':');
  });
});

describe('renderAgentChildBlock (Phase F2)', () => {
  test('empty body → single header line', () => {
    const lines = renderAgentChildBlock('prompt', 'Prompt', '');
    expect(lines).toHaveLength(1);
    expect(strip(lines[0]!)).toContain('Prompt:');
  });

  test('short body → header + indented body lines', () => {
    const lines = renderAgentChildBlock('prompt', 'Prompt', 'line 1\nline 2\nline 3');
    expect(lines).toHaveLength(4);
    expect(strip(lines[0]!)).toContain('Prompt:');
    // Body lines are indented (7 spaces by default).
    for (const ln of lines.slice(1)) {
      expect(strip(ln).startsWith('       ')).toBe(true);
    }
    expect(strip(lines[1]!)).toContain('line 1');
    expect(strip(lines[3]!)).toContain('line 3');
  });

  test('body exceeding maxLines → tail replaced with "… (N more lines)"', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const lines = renderAgentChildBlock('prompt', 'Prompt', body, { maxLines: 5 });
    // 1 header + 5 body + 1 ellipsis marker = 7
    expect(lines).toHaveLength(7);
    expect(strip(lines[6]!)).toContain('15 more lines');
    expect(strip(lines[6]!)).toContain('\u2026');
  });

  test('response variant uses Response: label', () => {
    const lines = renderAgentChildBlock('response', 'Response', 'answer');
    expect(strip(lines[0]!)).toContain('Response:');
    expect(strip(lines[1]!)).toContain('answer');
  });

  test('trailing whitespace in body is collapsed before truncation check', () => {
    // Ensures a body like "line1\n\n\n\n" doesn't inflate line count past maxLines
    const lines = renderAgentChildBlock('prompt', 'Prompt', 'line1\n\n\n\n', { maxLines: 2 });
    // 1 header + 1 body line; no ellipsis since body fits after strip.
    expect(lines).toHaveLength(2);
    expect(strip(lines[1]!)).toContain('line1');
  });

  test('custom bodyIndent overrides default', () => {
    const lines = renderAgentChildBlock('prompt', 'Prompt', 'x', { bodyIndent: '>> ' });
    expect(lines[1]!.startsWith('>> ')).toBe(true);
  });

  test('singular line count in ellipsis message', () => {
    const body = ['a', 'b', 'c', 'd'].join('\n');
    const lines = renderAgentChildBlock('prompt', 'Prompt', body, { maxLines: 3 });
    expect(strip(lines[4]!)).toContain('1 more line');
    expect(strip(lines[4]!)).not.toContain('1 more lines');
  });
});

describe('bg-batch-launch (Phase F5) — launch banner', () => {
  test('single-agent batch (n=1): "1 background agent launched"', () => {
    const lines = renderLogEntry({
      kind: 'bg-batch-launch', descriptions: ['Solo worker'],
    });
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toContain('1 background agent launched');
    // Last-and-only row uses └─
    expect(strip(lines[1]!)).toContain(G.TREE_LAST);
    expect(strip(lines[1]!)).toContain('Solo worker');
  });

  test('multi-agent batch (n=5): plural header + ├─/└─ tree', () => {
    const descs = ['A', 'B', 'C', 'D', 'E'];
    const lines = renderLogEntry({ kind: 'bg-batch-launch', descriptions: descs });
    expect(lines).toHaveLength(6);   // 1 header + 5 rows
    expect(strip(lines[0]!)).toContain('5 background agents launched');
    // First four rows use ├─, last uses └─.
    for (let i = 1; i <= 4; i++) {
      expect(strip(lines[i]!)).toContain(G.TREE_MID);
      expect(strip(lines[i]!)).toContain(descs[i - 1]!);
    }
    expect(strip(lines[5]!)).toContain(G.TREE_LAST);
    expect(strip(lines[5]!)).toContain('E');
  });

  test('long batch launch folds descriptions after the visible budget', () => {
    const lines = renderLogEntry({
      kind: 'bg-batch-launch',
      descriptions: ['A', 'B', 'C', 'D', 'E'],
    }, { maxBatchItems: 3 }).map(strip);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('├─ A');
    expect(lines[3]).toContain('├─ C');
    expect(lines[4]).toContain('└─');
    expect(lines[4]).toContain('2 more agents folded');
    expect(lines[4]).not.toContain('press f');
    const rich = renderLogEntry({
      kind: 'bg-batch-launch',
      descriptions: ['A', 'B', 'C', 'D', 'E'],
    }, { maxBatchItems: 3, expandHint: true }).map(strip);
    expect(rich[4]).toContain('press f to expand');
  });

  test('empty descriptions → header only, no tree', () => {
    const lines = renderLogEntry({ kind: 'bg-batch-launch', descriptions: [] });
    expect(lines).toHaveLength(1);
    expect(strip(lines[0]!)).toContain('0 background agents launched');
  });

  test('blank description falls back to placeholder', () => {
    const lines = renderLogEntry({ kind: 'bg-batch-launch', descriptions: ['', 'other'] });
    expect(strip(lines[1]!)).toContain('(no description)');
  });
});

describe('bg-agent-complete (Phase F5) — completion toast', () => {
  test('renders toast + bake counter with remaining > 0', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'Foreign Flow Specialist',
      elapsedMs: 45_000,
      remaining: 3,
      batchElapsedMs: 60_000,
    });
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toContain('Agent');
    expect(strip(lines[0]!)).toContain('Foreign Flow Specialist');
    expect(strip(lines[0]!)).toContain('completed');
    expect(strip(lines[0]!)).toContain('45s');
    expect(strip(lines[1]!)).toContain('Baked for 1m');
    expect(strip(lines[1]!)).toContain('3 agents still running');
  });

  test('remaining=1 uses singular "agent still running"', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'X', elapsedMs: 1000, remaining: 1, batchElapsedMs: 3000,
    });
    expect(strip(lines[1]!)).toContain('1 agent still running');
    expect(strip(lines[1]!)).not.toContain('1 agents');
  });

  test('remaining=0 renders "all agents finished"', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'Last One', elapsedMs: 2000, remaining: 0, batchElapsedMs: 10000,
    });
    expect(strip(lines[1]!)).toContain('all agents finished');
    expect(strip(lines[1]!)).not.toContain('still running');
  });

  test('blank description falls back to placeholder', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: '', elapsedMs: 100, remaining: 0, batchElapsedMs: 500,
    });
    expect(strip(lines[0]!)).toContain('(no description)');
  });

  test('runningDescriptions present → bake tail names them inline', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'Foreign Flow',
      elapsedMs: 45_000,
      remaining: 3,
      batchElapsedMs: 60_000,
      runningDescriptions: ['Semi Analyst', 'Quant', 'Value Investor'],
    });
    // Bake line should read "3 still running: Semi Analyst, Quant, Value Investor"
    // — no "agents" noun since we're listing them.
    expect(strip(lines[1]!)).toContain('3 still running');
    expect(strip(lines[1]!)).toContain('Semi Analyst');
    expect(strip(lines[1]!)).toContain('Quant');
    expect(strip(lines[1]!)).toContain('Value Investor');
  });

  test('runningDescriptions empty array → still uses "N agent(s) still running" form', () => {
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'X',
      elapsedMs: 1000,
      remaining: 2,
      batchElapsedMs: 3000,
      runningDescriptions: [],
    });
    expect(strip(lines[1]!)).toContain('2 agents still running');
  });

  test('runningDescriptions with long list is truncated with ellipsis', () => {
    // 10 long names would overflow default width (100 chars).
    const longNames = Array.from({ length: 10 }, (_, i) => `VeryLongPersonaName${i}`);
    const lines = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'done-one',
      elapsedMs: 1000,
      remaining: 10,
      batchElapsedMs: 5000,
      runningDescriptions: longNames,
    });
    expect(strip(lines[1]!)).toContain('\u2026');   // ellipsis
  });
});

describe('bg-batch-summary (Phase F5 iter) — panel-complete closer', () => {
  test('full form: agents + duration + tool uses + tokens', () => {
    const lines = renderLogEntry({
      kind: 'bg-batch-summary',
      totalCount: 5,
      batchElapsedMs: 112_000,
      totalToolCount: 127,
      totalTokens: 8200,
    });
    expect(lines).toHaveLength(1);
    const s = strip(lines[0]!);
    expect(s).toContain('Panel complete:');
    expect(s).toContain('5 agents');
    expect(s).toContain('1m 52s');
    expect(s).toContain('127 tool uses');
    expect(s).toContain('8.2k tokens');
  });

  test('singular grammar: 1 agent + 1 tool use', () => {
    const s = strip(renderLogEntry({
      kind: 'bg-batch-summary',
      totalCount: 1, batchElapsedMs: 5000, totalToolCount: 1, totalTokens: 50,
    })[0]!);
    expect(s).toContain('1 agent');
    expect(s).not.toContain('1 agents');
    expect(s).toContain('1 tool use');
    expect(s).not.toContain('1 tool uses');
  });

  test('zero tool count / tokens → segments omitted', () => {
    const s = strip(renderLogEntry({
      kind: 'bg-batch-summary',
      totalCount: 2, batchElapsedMs: 2000, totalToolCount: 0, totalTokens: 0,
    })[0]!);
    expect(s).toContain('2 agents');
    expect(s).toContain('2s');
    expect(s).not.toContain('tool');
    expect(s).not.toContain('tokens');
  });
});

describe('formatAgentBatchStatus — live footer indicator', () => {
  test('names running agents without appending transcript lines', () => {
    const s = formatAgentBatchStatus({
      phase: 'tick',
      batchElapsedMs: 12000,
      total: 5,
      done: 1,
      remaining: 4,
      runningDescriptions: ['Explorer', 'Reviewer', 'Tester', 'Docs'],
    }, { frame: 0 });
    expect(s).toContain('◆◇');
    expect(s).toContain('Agents 1/5');
    expect(s).toContain('4 running');
    expect(s).toContain('Explorer, Reviewer, Tester +1');
    expect(s).toContain('12s');
  });

  test('completion phase includes the just-completed agent', () => {
    const s = formatAgentBatchStatus({
      phase: 'complete',
      batchElapsedMs: 3000,
      total: 3,
      done: 2,
      remaining: 1,
      runningDescriptions: ['Finalizer'],
      completedDescription: 'Very long completed agent name that must be shortened',
    });
    expect(s).toContain('Agents 2/3');
    expect(s).toContain('1 running: Finalizer');
    expect(s).toContain('completed:');
    expect(s).toContain('\u2026');
  });

  test('end phase collapses to complete summary', () => {
    expect(formatAgentBatchStatus({
      phase: 'end',
      batchElapsedMs: 4000,
      total: 4,
      done: 4,
      remaining: 0,
      runningDescriptions: [],
    })).toBe('Agents 4/4 complete');
  });

  test('expanded mode shows all running agent names', () => {
    const s = formatAgentBatchStatus({
      phase: 'tick',
      total: 5,
      done: 1,
      remaining: 4,
      runningDescriptions: ['Explorer', 'Reviewer', 'Tester', 'Docs'],
    }, { expanded: true, frame: 2 });
    expect(s).toContain('Explorer, Reviewer, Tester, Docs');
    expect(s).not.toContain('+1');
    expect(s).toContain('expanded');
  });

  test('agentBatchScanner moves bidirectionally', () => {
    expect(agentBatchScanner(0, 4)).toBe('◆◇··');
    expect(agentBatchScanner(1, 4)).toBe('◇◆◇·');
    expect(agentBatchScanner(3, 4)).toBe('··◇◆');
    expect(agentBatchScanner(4, 4)).toBe('·◇◆◇');
    expect(agentBatchScanner(5, 4)).toBe('◇◆◇·');
  });
});

describe('countFoldedItems — unified fold-hidden counter', () => {
  test('bg-batch-launch past BATCH_TREE reports hidden count', () => {
    const entry = {
      kind: 'bg-batch-launch' as const,
      descriptions: Array.from({ length: 10 }, (_, i) => `A${i}`),
    };
    expect(countFoldedItems(entry)).toBe(10 - FOLD_LIMITS.BATCH_TREE);
    expect(countFoldedItems(entry, { maxBatchItems: 3 })).toBe(7);
    expect(countFoldedItems(entry, { maxBatchItems: Infinity })).toBe(0);
  });

  test('tool-body past TOOL_BODY reports hidden lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
    expect(countFoldedItems({ kind: 'tool-body', text }))
      .toBe(50 - FOLD_LIMITS.TOOL_BODY);
    expect(countFoldedItems({ kind: 'tool-body', text }, { maxLines: Infinity }))
      .toBe(0);
  });

  test('agent-child-block past BLOCK_BODY reports hidden body lines', () => {
    const body = Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n');
    expect(countFoldedItems({
      kind: 'agent-child-block',
      variant: 'response',
      label: 'Response',
      body,
    })).toBe(20 - FOLD_LIMITS.BLOCK_BODY);
  });

  test('empty or short entries report 0 (nothing to fold)', () => {
    expect(countFoldedItems({
      kind: 'bg-batch-launch', descriptions: ['A'],
    })).toBe(0);
    expect(countFoldedItems({ kind: 'tool-body', text: 'hi' })).toBe(0);
    expect(countFoldedItems({
      kind: 'agent-child-block', variant: 'prompt', label: 'P', body: '',
    })).toBe(0);
  });

  test('kinds with no fold support return 0', () => {
    expect(countFoldedItems({ kind: 'text', text: 'foo' })).toBe(0);
    expect(countFoldedItems({
      kind: 'agent-start', description: 'x', subagentType: 'general-purpose',
    })).toBe(0);
  });
});

describe('per-agent color identity', () => {
  // Note: chalk strips ANSI when stdout isn't a TTY (bun test), so
  // we can't assert on the raw escape sequences here. The color-map
  // module has its own direct tests for index stability. These tests
  // verify the integration point: the renderer pulls from agentColor
  // (not a fixed subtext color) when colorByAgent is true.

  test('colorByAgent default=true still renders the description text', () => {
    const lines = renderLogEntry({
      kind: 'bg-batch-launch', descriptions: ['Explorer'],
    });
    expect(strip(lines[1]!)).toContain('Explorer');
  });

  test('colorByAgent:false also renders the description text', () => {
    const lines = renderLogEntry({
      kind: 'bg-batch-launch', descriptions: ['Explorer'],
    }, { colorByAgent: false });
    expect(strip(lines[1]!)).toContain('Explorer');
  });

  test('bg-agent-complete toast honors colorByAgent for the description', () => {
    const colored = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'Explorer',
      elapsedMs: 1000, remaining: 1, batchElapsedMs: 1200,
    });
    const neutral = renderLogEntry({
      kind: 'bg-agent-complete',
      description: 'Explorer',
      elapsedMs: 1000, remaining: 1, batchElapsedMs: 1200,
    }, { colorByAgent: false });
    // Both paths should produce the same human-visible text.
    expect(strip(colored[0]!)).toBe(strip(neutral[0]!));
    expect(strip(colored[0]!)).toContain('Explorer');
    expect(strip(colored[0]!)).toContain('completed');
  });
});

describe('agent-child-block — new entry kind routes through block renderer', () => {
  test('renders identically to renderAgentChildBlock helper', () => {
    const body = 'line 1\nline 2\nline 3';
    const viaEntry = renderLogEntry({
      kind: 'agent-child-block',
      variant: 'response',
      label: 'Response',
      body,
    });
    const viaHelper = renderAgentChildBlock('response', 'Response', body);
    expect(viaEntry).toEqual(viaHelper);
  });

  test('maxLines:Infinity bypasses the body fold cap', () => {
    const body = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n');
    const short = renderLogEntry({
      kind: 'agent-child-block', variant: 'response', label: 'Response', body,
    });
    const full = renderLogEntry({
      kind: 'agent-child-block', variant: 'response', label: 'Response', body,
    }, { maxLines: Infinity });
    expect(short.length).toBeLessThan(full.length);
    expect(full.length).toBe(51); // header + 50 body rows, no sentinel
    expect(strip(short[short.length - 1]!)).not.toContain('press f');
    const richShort = renderLogEntry({
      kind: 'agent-child-block', variant: 'response', label: 'Response', body,
    }, { expandHint: true });
    expect(strip(richShort[richShort.length - 1]!)).toContain('press f to expand');
  });
});

describe('renderLogEntry — custom opts', () => {
  test('childIndent override widens the gutter', () => {
    const line = renderLogEntryAsString(
      { kind: 'agent-child', variant: 'tool', label: 'Bash', summary: 'cmd' },
      { childIndent: '      ' },
    );
    expect(line.startsWith('      ')).toBe(true);
  });

  test('maxSummaryWidth forces earlier truncation', () => {
    const line = strip(renderLogEntryAsString(
      { kind: 'tool-header', toolName: 'Bash', summary: 'abcdefghijklmnop' },
      { maxSummaryWidth: 20 },
    ));
    expect(line).toContain('\u2026');
  });
});
