import { addDefaultBinding, registerAction } from '../../input-core/index.js';

export const LOG_FOLD_TOGGLE_ALL_ACTION = 'log.fold.toggle-all';

/**
 * #19 — `Ctrl+X f` from the input. Input focus never reaches the main-loop
 * chord (`matchDashboardChordAction`); the textarea arms the input-core
 * `ctrl+x` leader instead, so the binding lives here next to `ctrl+x s/c/g`.
 */
export function registerLogFoldInputBinding(toggleAll: () => void): void {
  registerAction({
    id: LOG_FOLD_TOGGLE_ALL_ACTION,
    description: 'Toggle every folded log block (same as log-pane F).',
    handler: () => { toggleAll(); },
    allowOverwrite: true,
  });
  addDefaultBinding({ matcher: 'ctrl+x f', actionId: LOG_FOLD_TOGGLE_ALL_ACTION });
}
