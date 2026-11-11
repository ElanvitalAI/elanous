import { debug } from '../../debug/log.js';
import type { InputSourceRef } from '../../input/input-source-kind.js';
import type { ControlTurnIntent, SubmitTurnIntent } from '../../input/input-intent.js';

export type DashboardChatMainSubmitRoute =
  | { kind: 'sticky-acp'; backend: string; message: string }
  | { kind: 'slash'; commandText: string }
  | { kind: 'plain'; message: string };

export function resolveDashboardChatMainSubmitIntent(
  inputText: string,
  deps: {
    stickyBackend: string | null;
    source?: InputSourceRef;
  },
): SubmitTurnIntent | ControlTurnIntent {
  const commandText = inputText.trim();
  const source = deps.source ?? { kind: 'keyboard', surface: 'dashboard-chat-main' };
  const textBytes = Buffer.byteLength(commandText, 'utf8');
  if (deps.stickyBackend && commandText.length > 0 && !commandText.startsWith('/')) {
    const intent = {
      kind: 'submit-turn',
      source,
      text: commandText,
      route: 'sticky-acp',
      backend: deps.stickyBackend,
    } satisfies SubmitTurnIntent;
    if (debug.enabled) {
      debug.log('input.intent', 'resolve', {
        route: intent.route,
        sourceKind: source.kind,
        sticky: true,
        textBytes,
      });
    }
    return intent;
  }
  if (commandText.startsWith('/')) {
    const intent = {
      kind: 'control-turn',
      source,
      command: 'slash-command',
      commandText,
    } satisfies ControlTurnIntent;
    if (debug.enabled) {
      debug.log('input.intent', 'resolve', {
        route: intent.command,
        sourceKind: source.kind,
        slash: true,
        textBytes,
      });
    }
    return intent;
  }
  const intent = {
    kind: 'submit-turn',
    source,
    text: commandText,
    route: 'plain',
  } satisfies SubmitTurnIntent;
  if (debug.enabled) {
    debug.log('input.intent', 'resolve', {
      route: intent.route,
      sourceKind: source.kind,
      sticky: false,
      textBytes,
    });
  }
  return intent;
}

export function resolveDashboardChatMainSubmitRoute(
  inputText: string,
  deps: {
    stickyBackend: string | null;
    source?: InputSourceRef;
  },
): DashboardChatMainSubmitRoute {
  const intent = resolveDashboardChatMainSubmitIntent(inputText, deps);
  if (intent.kind === 'control-turn') {
    return {
      kind: 'slash',
      commandText: intent.commandText ?? '',
    };
  }
  if (intent.route === 'sticky-acp') {
    return {
      kind: 'sticky-acp',
      backend: intent.backend ?? '',
      message: intent.text,
    };
  }
  return {
    kind: 'plain',
    message: intent.text,
  };
}
