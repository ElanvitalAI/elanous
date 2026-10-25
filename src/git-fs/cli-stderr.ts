import { debug } from '../debug/log.js';

export type CliStderrRecord = {
  readonly source: 'git' | 'gh';
  readonly exitCode: number;
  readonly raw: Buffer;
};

export type CliStderrSink = (record: CliStderrRecord) => void;

let activeSink: CliStderrSink | null = null;

export function hasCliStderrSink(): boolean {
  return activeSink !== null;
}

/** Install a surface-specific sink; without one, CLI stderr keeps its process contract. */
export function setCliStderrSink(sink: CliStderrSink | null): () => void {
  const previous = activeSink;
  activeSink = sink;
  return () => {
    if (activeSink === sink) activeSink = previous;
  };
}

/** Preserve raw bytes for the caller and keep ordinary CLI invocations on process.stderr. */
export function writeCliStderr(record: CliStderrRecord): void {
  const sink = activeSink;
  if (!sink) {
    process.stderr.write(record.raw);
    return;
  }
  // A failed screen redraw must not fall through to the physical TTY and overwrite its prompt.
  try { sink(record); } catch (error) {
    // Keep the prompt isolated, but leave a forensic breadcrumb for a failed presentation path.
    try {
      debug.log('tui.cli-stderr', 'sink-failed', {
        source: record.source,
        exitCode: record.exitCode,
        byteLength: record.raw.length,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    } catch { /* never fall through to the physical TTY */ }
  }
}
