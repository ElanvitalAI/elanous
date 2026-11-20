/** ELS-MOUSE-RELEASE (JUD FU on #39232): the view's undo bytes (mouse reporting off · alt screen off) are written exactly once —
 *  on the normal finish, and also when the process dies under the view (SIGHUP/SIGTERM/SIGINT or an uncaught exception, which
 *  still ends in the process 'exit' event). Without it a dead els leaves the user's terminal reporting mouse clicks as garbage. */

export interface LeaveProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  exit(code?: number): unknown;
}

/** The real process, seen through the narrow interface (Process's overloaded on/off do not fit it directly). */
export const realProcess: LeaveProcess = {
  on: (event, listener) => process.on(event, listener as never),
  off: (event, listener) => process.off(event, listener as never),
  exit: (code) => process.exit(code),
};

const SIGNALS: readonly [string, number][] = [['SIGHUP', 1], ['SIGINT', 2], ['SIGTERM', 15]];

export interface LeaveGuard {
  /** Write the undo bytes unless they were already written, and stop listening. Safe to call any number of times. */
  leave(): void;
}

export function guardLeave(deps: { proc: LeaveProcess; write: (text: string) => void; bytes: string }): LeaveGuard {
  let left = false;
  const handlers: [string, () => void][] = [];
  const leave = (): void => {
    if (left) return;
    left = true;
    for (const [event, handler] of handlers) deps.proc.off(event, handler);
    deps.write(deps.bytes);
  };
  // A signal's default action would end the process without 'exit' — so leave, then exit the way the shell expects (128 + n).
  for (const [name, number] of SIGNALS) handlers.push([name, () => { leave(); deps.proc.exit(128 + number); }]);
  handlers.push(['exit', leave]);                                  // uncaught exception, process.exit() elsewhere
  for (const [event, handler] of handlers) deps.proc.on(event, handler);
  return { leave };
}
