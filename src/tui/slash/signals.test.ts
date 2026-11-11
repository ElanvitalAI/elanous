import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetDefaultControlSignalObserverForTesting,
  defaultControlSignalObserver,
} from '../../input/control-signal-observer.js';
import {
  _resetDefaultControlSignalBusForTesting,
  defaultControlSignalBus,
} from '../../input/control-signal.js';
import { handleSignalsSlash, type SignalsSlashContext } from './signals.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';

function createContext(): SignalsSlashContext & { rendered: string[] } {
  const rendered: string[] = [];
  return {
    rendered,
    chatLines: rendered,
    setChatScrollOffset: () => {},
    muted: (value) => value,
    accent: (value) => value,
    text: (value) => value,
    error: (value) => value,
    warning: (value) => value,
    info: (value) => value,
  };
}

describe('Next TUI /signals slash handler', () => {
  beforeEach(() => {
    _resetDefaultControlSignalBusForTesting();
    _resetDefaultControlSignalObserverForTesting();
    defaultControlSignalObserver();
  });

  afterEach(() => {
    _resetDefaultControlSignalBusForTesting();
    _resetDefaultControlSignalObserverForTesting();
  });

  test('registry routes /signals and status/latest/list read the shared observer', async () => {
    expect(resolveNextTuiRoute('/signals', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('signals');
    defaultControlSignalBus().emit({
      kind: 'handoff-ready',
      urgency: 'normal',
      source: 'system',
      createdAt: '2026-11-11T09:30:00.000Z',
      scope: { sessionId: 'sim-run' },
    });
    defaultControlSignalBus().emit({
      kind: 'approval-needed',
      urgency: 'priority',
      source: 'system',
      createdAt: '2026-11-11T09:31:00.000Z',
      scope: { sessionId: 'sim-run' },
    });

    const status = createContext();
    await handleSignalsSlash(['status'], status);
    expect(status.rendered.join('\n')).toContain('handoff-ready');

    const latest = createContext();
    await handleSignalsSlash(['latest'], latest);
    expect(latest.rendered.join('\n')).toContain('session sim-run');

    const list = createContext();
    await handleSignalsSlash(['list', 'handoff-ready'], list);
    expect(list.rendered.join('\n')).toContain('handoff-ready');
    expect(list.rendered.join('\n')).not.toContain('approval-needed');
  });

  test('clear and emit stay out of scope and do not mutate observed signals', async () => {
    defaultControlSignalBus().emit({
      kind: 'handoff-ready',
      urgency: 'normal',
      source: 'system',
      createdAt: '2026-11-11T09:30:00.000Z',
      scope: { sessionId: 'sim-run' },
    });

    const clear = createContext();
    const beforeClear = defaultControlSignalObserver().list();
    await handleSignalsSlash(['clear'], clear);
    expect(clear.rendered.join('\n')).toContain('out of scope');
    expect(defaultControlSignalObserver().list()).toEqual(beforeClear);

    const emit = createContext();
    const beforeEmit = defaultControlSignalObserver().list();
    await handleSignalsSlash(['emit', 'handoff-ready'], emit);
    expect(emit.rendered.join('\n')).toContain('out of scope');
    expect(defaultControlSignalObserver().list()).toEqual(beforeEmit);

    const list = createContext();
    await handleSignalsSlash(['list'], list);
    expect(list.rendered.join('\n')).toContain('handoff-ready');
  });
});
