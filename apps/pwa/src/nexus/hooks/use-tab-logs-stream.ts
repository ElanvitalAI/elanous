// PWA · Per-tab log SSE consumer hook (Phase N-4 PR ρ)
//
// Wraps client.subscribeLogs · keeps a bounded ring buffer · supports
// pause (don't drop incoming · just don't render new) and clear.

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNexusClient } from './use-nexus-context';

export interface LogLineEntry {
  /** Monotonic sequence number for keys / scroll-anchoring. */
  seq: number;
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

export function appendLogLine(lines: LogLineEntry[], entry: LogLineEntry, maxLines: number): LogLineEntry[] {
  const next = [...lines, entry];
  if (next.length > maxLines) next.splice(0, next.length - maxLines);
  return next;
}

export interface UseTabLogsStreamOpts {
  /** Max lines to keep in memory. Default 1000. */
  maxLines?: number;
  /** Skip subscribing when false. Default true. */
  enabled?: boolean;
}

export interface UseTabLogsStreamResult {
  lines: LogLineEntry[];
  paused: boolean;
  setPaused: (p: boolean) => void;
  clear: () => void;
  /** True while the SSE stream is open. */
  connected: boolean;
}

export function useTabLogsStream(id: string, opts: UseTabLogsStreamOpts = {}): UseTabLogsStreamResult {
  const client = useNexusClient();
  const maxLines = opts.maxLines ?? 1000;
  const enabled = opts.enabled ?? true;

  const seqRef = useRef(0);
  const bufferRef = useRef<LogLineEntry[]>([]);
  const [lines, setLines] = useState<LogLineEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const flush = useCallback(() => {
    setLines([...bufferRef.current]);
  }, []);

  const clear = useCallback(() => {
    bufferRef.current = [];
    seqRef.current = 0;
    setLines([]);
  }, []);

  useEffect(() => {
    if (!enabled || !id) return;
    setConnected(true);
    const off = client.subscribeLogs(id, {
      onLine: ({ stream, line }) => {
        seqRef.current += 1;
        const entry: LogLineEntry = { seq: seqRef.current, stream, line, ts: Date.now() };
        bufferRef.current = appendLogLine(bufferRef.current, entry, maxLines);
        if (!pausedRef.current) flush();
      },
      onError: () => setConnected(false),
    });
    return () => {
      off();
      setConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, maxLines, enabled]);

  // When user un-pauses, flush whatever accumulated.
  useEffect(() => {
    if (!paused) flush();
  }, [paused, flush]);

  return { lines, paused, setPaused, clear, connected };
}
