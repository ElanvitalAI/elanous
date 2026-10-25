import { afterEach, describe, expect, test } from 'bun:test';
import { createAcpStderrSummarizer, type AcpStderrSummary } from './stderr-summary.js';

describe('ACP stderr summaries', () => {
  let summarizer: ReturnType<typeof createAcpStderrSummarizer> | undefined;

  afterEach(() => summarizer?.flush());

  test('groups invalid MCP tool names and keeps distinct errors separate', () => {
    const summaries: AcpStderrSummary[] = [];
    summarizer = createAcpStderrSummarizer(summary => summaries.push(summary));
    summarizer.push('ERROR Skipping MCP tool server=elanous tool=higgsfield.bl_a reason=tool name higgsfield.bl_a is invalid');
    summarizer.push('ERROR Skipping MCP tool server=elanous tool=higgsfield.bl_b reason=tool name higgsfield.bl_b is invalid');
    summarizer.push('connection refused');
    summarizer.flush();

    expect(summaries).toEqual([
      { kind: 'ERROR Skipping MCP tool server=* tool=* reason=tool name <name> is invalid', count: 2 },
      { kind: 'connection refused', count: 1 },
    ]);
  });

  test('bounds unique kinds in a summary window', () => {
    const summaries: AcpStderrSummary[] = [];
    summarizer = createAcpStderrSummarizer(summary => summaries.push(summary));
    for (let index = 0; index < 10; index += 1) summarizer.push(`error ${index}`);
    summarizer.flush();

    expect(summaries).toHaveLength(9);
    expect(summaries.at(-1)).toEqual({ kind: 'other stderr messages', count: 2 });
  });

  test('flushes a live window and ignores ANSI-only lines', async () => {
    const summaries: AcpStderrSummary[] = [];
    summarizer = createAcpStderrSummarizer(summary => summaries.push(summary), 10);
    summarizer.push('\u001b[31m\u001b[0m');
    summarizer.push('network error');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(summaries).toEqual([{ kind: 'network error', count: 1 }]);
  });
});
