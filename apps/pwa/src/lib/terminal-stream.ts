// PWA 웹 터미널 실시간 — `GET /v1/terminals/:id/stream`(SSE) 파서(순수 · 시험 대상).
// 이벤트: `mode {mode:'bytes'|'screen', pollMs?}` · `reset {screen}` · `data "<바이트>"` · `screen {screen}` · `status {status}` · `end {reason}`.

export type TerminalStreamEvent =
  | { type: 'mode'; mode: 'bytes' | 'screen'; pollMs?: number }
  | { type: 'reset'; screen: string }
  | { type: 'data'; chunk: string }
  | { type: 'screen'; screen: string }
  | { type: 'status'; status: string }
  | { type: 'end'; reason: string };

/** SSE 조각을 이벤트로 — 끝나지 않은 꼬리는 `rest` 로 돌려준다(다음 조각과 붙인다). 주석(`: hb`)은 버린다. */
export function parseTerminalSse(buffer: string): { events: TerminalStreamEvent[]; rest: string } {
  const events: TerminalStreamEvent[] = [];
  let rest = buffer;
  let i: number;
  while ((i = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) continue;
    let data: unknown;
    try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
    const d = (data ?? {}) as Record<string, unknown>;
    if (name === 'mode' && (d.mode === 'bytes' || d.mode === 'screen')) events.push({ type: 'mode', mode: d.mode, ...(typeof d.pollMs === 'number' ? { pollMs: d.pollMs } : {}) });
    else if (name === 'reset' && typeof d.screen === 'string') events.push({ type: 'reset', screen: d.screen });
    else if (name === 'data' && typeof data === 'string') events.push({ type: 'data', chunk: data });
    else if (name === 'screen' && typeof d.screen === 'string') events.push({ type: 'screen', screen: d.screen });
    else if (name === 'status' && typeof d.status === 'string') events.push({ type: 'status', status: d.status });
    else if (name === 'end') events.push({ type: 'end', reason: typeof d.reason === 'string' ? d.reason : 'end' });
  }
  return { events, rest };
}
