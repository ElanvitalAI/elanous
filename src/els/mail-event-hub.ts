// OP P0 2단계 ELS-SERVER-EVENT-HUB-NO-DB-POLL — reader side.
// els 서버는 우편 원장을 주기적으로 읽지 않는다: 원장 옆 부수 이벤트 파일(<ledger>.events)의 추가 줄만 지켜보고,
// 완전한 새 줄이 보일 때만 revision 을 올려 구독자(배지 상태·CEO 스캔·#39546 Worker 캐시 등)를 깨운다.
// 오프셋 기반 꼬리읽기: 이미 소비한 바이트는 다시 읽지 않고, 노이즈(내용 없는 watch 콜백)는 revision 을 올리지 않는다.
import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs';

/** Start watching `eventsPath`; call `onChange` when (possibly) new bytes arrived. Return a stop handle. */
export type MailEventHubWatch = (eventsPath: string, onChange: () => void) => () => void;

/** Default adapter: the stat watch (fs.watchFile). Probed on this host (bun 1.4.2 · macOS): fs.watch stays silent
 *  here — no callback for a file append, none for a directory arrival — while the stat watch fires on creation and
 *  on every append, and works before the file exists. With `persistent: false` it never holds the process open.
 *  Every fire (including the immediate one on start) is offered to the hub, whose offset guard drops no-new-bytes
 *  noise. The stop removes every listener for this path in this process (bun's two-argument unwatchFile throws). */
const defaultWatch: MailEventHubWatch = (eventsPath, onChange) => {
  watchFile(eventsPath, { interval: 200, persistent: false }, () => onChange());
  return () => { unwatchFile(eventsPath); };
};

export interface MailEventHub {
  /** Idempotent. After start, new complete event lines wake subscribers. */
  start(): void;
  /** Detaches the watcher and keeps subscribers (they can be attached to a next hub). */
  stop(): void;
  /** How many event batches this hub has seen so far. */
  revision(): number;
  /** Subscribe to revision bumps; returns the unsubscribe. Subscriber errors never break the hub. */
  subscribe(listener: (rev: number) => void): () => void;
}

export function createMailEventHub(opts: { eventsPath: string; watch?: MailEventHubWatch; lossWatch?: MailEventHubWatch }): MailEventHub {
  const watch = opts.watch ?? defaultWatch;
  // judb-39675-864417dcf533 ① — the loss marker gets the stat watch by default, NOT the injected events seam
  // (that one stays events-only), so a marker watch never couples to the events adapter tests inject.
  const lossWatch = opts.lossWatch ?? defaultWatch;
  const listeners = new Set<(rev: number) => void>();
  let offset = 0;              // bytes of the events file already consumed
  let revision = 0;
  let stopWatch: (() => void) | null = null;
  let stopLossWatch: (() => void) | null = null;

  const onChange = (): void => {
    let size: number;
    try { size = statSync(opts.eventsPath).size; } catch { return; }   // absent — nothing new
    if (size <= offset) return;                                        // watcher noise — no new bytes
    let consumed = '';
    const fd = openSync(opts.eventsPath, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      const text = buffer.subarray(0, read).toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;                                     // a partial line — wait for its tail
      offset += lastNewline + 1;                                       // consume only complete lines
      consumed = text.slice(0, lastNewline);
    } finally { closeSync(fd); }
    if (!consumed.trim()) return;                                      // blank noise — no bump
    revision += 1;
    for (const listener of [...listeners]) {
      try { listener(revision); } catch { /* a subscriber never breaks the hub */ }
    }
  };

  // judb-39675-864417dcf533 ① — a sidecar loss is an event, not a timer: the writer's best-effort marker
  // (<events>.lost — see ledger-events.ts) wakes the same subscribers an event line would, so a lost line heals
  // with zero follow-up mail and zero periodic ledger reads. An absent marker is watcher noise — no bump.
  const onLossMarker = (): void => {
    try { statSync(`${opts.eventsPath}.lost`); } catch { return; }   // absent — nothing to heal
    revision += 1;
    for (const listener of [...listeners]) {
      try { listener(revision); } catch { /* a subscriber never breaks the hub */ }
    }
  };

  return {
    start(): void {
      if (stopWatch) return;                                           // idempotent
      offset = 0;
      try { offset = statSync(opts.eventsPath).size; } catch { /* absent now — the first line will start from 0 */ }
      stopWatch = watch(opts.eventsPath, onChange);
      stopLossWatch = lossWatch(`${opts.eventsPath}.lost`, onLossMarker);   // watches before the marker exists — an unhealed loss at boot resyncs once
    },
    stop(): void {
      stopWatch?.();
      stopWatch = null;
      stopLossWatch?.();
      stopLossWatch = null;
    },
    revision(): number { return revision; },
    subscribe(listener: (rev: number) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
