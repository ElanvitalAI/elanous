// els `subscribe` op — the server side of the sidetab's push feed (ELS-DESKTOP-SIDETAB-SUBSCRIBE). One long connection:
// the current `ls` answer at once, then a new one whenever the list changes. Read-only like `ls` (the door does not
// judge it as mutating); closing the connection is the whole unsubscribe and never touches a pane.

import type { Socket } from 'node:net';
import type { ElsCore } from './core.js';

// 출처: a burst of journal writes (a `new` saves several times) becomes one event; short enough to stay «live».
const COALESCE_MS = 25;
// 출처: same bound as attach — a subscriber that does not read stops getting events once this much is queued.
const SUBSCRIBE_MAX_QUEUED_BYTES = 1_048_576;

export function serveSubscribe(core: ElsCore, socket: Socket): void {
  if (socket.destroyed) return;
  let closed = false;
  let last: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = (): void => {
    timer = undefined;
    if (closed || socket.destroyed || socket.writableLength > SUBSCRIBE_MAX_QUEUED_BYTES) return;
    let listed;
    try { listed = core.list(); } catch { return; }
    if (listed.exitCode !== 0 || listed.message === last) return;
    last = listed.message;
    socket.write(`${JSON.stringify({ type: 'list', exitCode: 0, message: listed.message })}\n`);
  };
  const schedule = (): void => { if (!closed && timer === undefined) { timer = setTimeout(push, COALESCE_MS); timer.unref?.(); } };
  const sub = core.onChange(schedule);
  const stop = (): void => { closed = true; if (timer) clearTimeout(timer); sub.dispose(); };
  socket.on('close', stop);
  socket.on('error', stop);
  push();
}
