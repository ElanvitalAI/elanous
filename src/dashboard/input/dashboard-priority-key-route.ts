import type { Key } from '../../tui.js';
import { debug } from '../../debug/log.js';
import type { InputOwner } from './input-owner.js';

export type DashboardPriorityKeyRouteResult =
  | { type: 'handled' }
  | { type: 'quit' }
  | { type: 'passthrough' };

/** Key.trace.* helper — emits a per-step entry showing whether the
 *  step claimed the key. Gated on the explicit keytrace flag so the
 *  baseline diag mode stays unchanged. */
function trace(step: string, key: Key, claimed: boolean | string): void {
  if (!debug.isKeyTraceEnabled()) return;
  const rawHex = (key as { raw?: string }).raw
    ? Array.from((key as { raw: string }).raw, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    : '(none)';
  debug.log('key.trace.dispatch', step, {
    name: key.name,
    ctrl: !!key.ctrl,
    shift: !!key.shift,
    alt: !!key.alt,
    meta: !!(key as { meta?: boolean }).meta,
    kind: (key as { kind?: string }).kind ?? 'press',
    rawHex,
    claimed,
  });
}

export interface DashboardPriorityKeyRouteDeps<Action> {
  /** Classic-dashboard Ctrl+\\ is a recoverable guidance action, not
   *  a process quit. Claim it before the global force-quit matcher. */
  routeClassicSigquitChord?: (key: Key) => boolean;
  /** Step 0 — global force-quit chord that fires from ANYWHERE,
   *  including inside popup terminals + bell modal + dashboard
   *  scenes. Plain Ctrl+Q has too many child-app bindings (e.g.
   *  emacs quoted-insert), so Ctrl+Shift+Q is the force-quit escape
   *  hatch. Ctrl+\\ is reserved by the classic dashboard for guidance.
   *  Returns true when the matcher
   *  fires; the route then short-circuits to `{type:'quit'}`
   *  regardless of any other state. */
  isForceQuitChord: (key: Key) => boolean;
  routeBellKey: (key: Key) => boolean | Promise<boolean>;
  /** Classic sidetab prefix keys must be seen before an exclusive shell modal. */
  routeSidetabKey?: (key: Key) => boolean;
  inputOwner?: InputOwner;
  dispatchPreKey: (key: Key, targetHandlerName?: string) => boolean | Promise<boolean>;
  routeExclusiveTerminalModalKey: (key: Key) => boolean | Promise<boolean>;
  routeArmedChordKey: (key: Key) => boolean | Promise<boolean>;
  armPrefixChord: (key: Key) => boolean;
  isHardQuitKey: (key: Key) => boolean;
  matchGlobalAction: (key: Key) => Action | null;
  runGlobalAction: (action: Action) => void | Promise<void>;
  routeLayoutModalKey: (key: Key) => boolean | Promise<boolean>;
}

export async function routeDashboardPriorityKey<Action>(
  key: Key,
  deps: DashboardPriorityKeyRouteDeps<Action>,
): Promise<DashboardPriorityKeyRouteResult> {
  // Step 0: global force-quit. Wins over EVERYTHING — bell modal,
  // popup terminal, drag interceptors. Bound to Ctrl+Shift+Q;
  // Ctrl+\\ has already been claimed by the classic guidance route.
  // This preserves the
  // "elanous escape hatch" concept the user explicitly wanted to keep:
  //   "ctrl+q 전체 강제 종료 컨셉은 남았으면 좋겠습니다.
  //    터미널모드에서는 잘 사용하지 않을 복잡 패턴으로 리 어사인 해도 됩니다."
  // Plain Ctrl+Q remains usable OUTSIDE popup terminals (step 6
  // isHardQuitKey), so dashboard-mode users don't lose the muscle
  // memory.
  // key.trace.* firehose — emits one entry per dispatch step + final
  // outcome when debug.isKeyTraceEnabled() is true. Cheap when off
  // (single boolean check), all-or-nothing per call (no per-step
  // micro-cost when disabled).
  const tracing = debug.isKeyTraceEnabled();
  if (tracing) trace('begin', key, 'pending');

  if (deps.routeClassicSigquitChord?.(key)) {
    if (tracing) trace('routeClassicSigquitChord', key, true);
    return { type: 'handled' };
  }

  if (deps.isForceQuitChord(key)) {
    if (tracing) trace('isForceQuitChord', key, 'quit');
    return { type: 'quit' };
  }

  // Step 1: notification bell modal — when open, claims keys above
  // every other surface (it's a TOAST-priority overlay).
  if (await deps.routeBellKey(key)) {
    if (tracing) trace('routeBellKey', key, true);
    return { type: 'handled' };
  }

  if (deps.routeSidetabKey?.(key)) {
    if (tracing) trace('routeSidetabKey', key, true);
    return { type: 'handled' };
  }

  // Step 2: popup terminal modal — when active, the user is interacting
  // with a child PTY (plain shell, /claude, /codex). The router forwards
  // every key except Ctrl+G + typed `exit\n`, which are intentional
  // close shortcuts. Running this BEFORE dispatchPreKey means
  //   - input-core user/chord bindings (e.g. Ctrl+B s/c/g) DON'T fire
  //     while the user is inside a child app — the child sees Ctrl+A,
  //     Ctrl+B, Ctrl+R, Ctrl+T, etc. as the app expects.
  //   - DragSession A-8 ESC guard also skips, but a drag can't really
  //     be active inside a popup terminal context, so the conflict is
  //     hypothetical.
  // Per user feedback: "터미널 모드에서는 최대한 엘라누스의 키 파이어링을
  // 줄이는 것 검토 필요. 터미널 안의 ctrl+a, ctrl+b 등 특수 처리키가
  // 많이 보이므로."
  if (await deps.routeExclusiveTerminalModalKey(key)) {
    if (tracing) trace('routeExclusiveTerminalModalKey', key, true);
    return { type: 'handled' };
  }

  // Step 3: input-core dispatch — user bindings, drag ESC abort, mouse.
  const targetHandlerName = deps.inputOwner === 'question-view' ? 'question-view' : undefined;
  if (await deps.dispatchPreKey(key, targetHandlerName)) {
    if (tracing) trace('dispatchPreKey', key, true);
    return { type: 'handled' };
  }

  if (await deps.routeArmedChordKey(key)) {
    if (tracing) trace('routeArmedChordKey', key, true);
    return { type: 'handled' };
  }
  if (deps.armPrefixChord(key)) {
    if (tracing) trace('armPrefixChord', key, true);
    return { type: 'handled' };
  }
  if (deps.isHardQuitKey(key)) {
    if (tracing) trace('isHardQuitKey', key, 'quit');
    return { type: 'quit' };
  }

  const globalAction = deps.matchGlobalAction(key);
  if (globalAction) {
    if (tracing) trace('matchGlobalAction', key, 'globalAction');
    await deps.runGlobalAction(globalAction);
    return { type: 'handled' };
  }

  if (await deps.routeLayoutModalKey(key)) {
    if (tracing) trace('routeLayoutModalKey', key, true);
    return { type: 'handled' };
  }
  if (tracing) trace('end', key, 'passthrough');
  return { type: 'passthrough' };
}
