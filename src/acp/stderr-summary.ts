export interface AcpStderrSummary {
  kind: string;
  count: number;
}

const MAX_KINDS_PER_WINDOW = 8;
const OTHER_KIND = 'other stderr messages';

function classify(line: string): string {
  const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (/Skipping MCP tool\b/i.test(clean)) {
    return clean
      .replace(/\bserver=\S+/gi, 'server=*')
      .replace(/\btool=\S+/gi, 'tool=*')
      .replace(/tool name .+? is invalid/i, 'tool name <name> is invalid')
      .slice(0, 240);
  }
  return clean.slice(0, 240);
}

/** Collect stderr into bounded, one-second UI summaries while callers retain raw lines in debug logs. */
export function createAcpStderrSummarizer(
  report: (summary: AcpStderrSummary) => void,
  intervalMs = 1_000,
): { push(line: string): void; flush(): void } {
  const pending = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const [kind, count] of pending) report({ kind, count });
    pending.clear();
  };

  return {
    push(line): void {
      const kind = classify(line);
      if (!kind) return;
      const key = pending.has(kind) || pending.size < MAX_KINDS_PER_WINDOW ? kind : OTHER_KIND;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      if (!timer) {
        timer = setTimeout(flush, intervalMs);
        timer.unref?.();
      }
    },
    flush,
  };
}
