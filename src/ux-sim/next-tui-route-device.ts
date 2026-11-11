import {
  buildNextTuiHelpLines,
  NEXT_TUI_INPUT_CONTEXT,
  resolveNextTuiRoute,
  type NextTuiRoute,
  type NextTuiRouteContext,
} from '../tui/core/registry.js';

/** Routes fake submissions through the production next TUI route table. */
export function simulateNextTuiRoute(input: string, context: NextTuiRouteContext = NEXT_TUI_INPUT_CONTEXT) {
  return resolveNextTuiRoute(input, context);
}

/** Render the production /help projection for this user and route set. */
export function simulateNextTuiHelp(
  context: NextTuiRouteContext = NEXT_TUI_INPUT_CONTEXT,
  routes?: readonly NextTuiRoute[],
) {
  return buildNextTuiHelpLines(context, routes);
}
