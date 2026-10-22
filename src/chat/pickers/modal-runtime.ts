import { debug } from '../../debug/log.js';
import type { Key } from '../../tui.js';
import { createChatPickerModalFamily, type ChatPickerFamilySources, type ChatPickerModalBindings, type ChatPickerModalFamily, type PickerOnKey, type PickerOnRowClick } from './modals.js';
import { CHAT_PICKER_KINDS, type ChatPickerKind } from './kinds.js';
import type { ModalSink } from '../index.js';
import type { PickerBufferView, PickerState } from './state.js';
import type { ModalSurface } from '../../display/modal-stack.js';

export interface ChatPickerModalRuntimeDeps {
  modalSink?: ModalSink;
  picker: PickerState;
  getBufferView: () => PickerBufferView;
  getBounds: () => { row: number; col: number; width: number; height: number };
  getInputZoneHeight: () => number;
  onDispatchResult: (
    dispatched: Awaited<ReturnType<PickerState['dispatch']>> | Awaited<ReturnType<PickerState['submitAt']>>,
  ) => Promise<boolean>;
}

interface PickerHandle {
  id: string;
  dispose: () => void;
}

interface SyncPickerModalSpec {
  kind: ChatPickerKind;
  active: boolean;
  createSurface: () => ModalSurface;
}

interface SyncPickerFamilySpec {
  activeKind: ChatPickerKind | null;
  debugLayout?: { row: number; col: number; width: number };
  family: ChatPickerModalFamily;
}

export function createChatPickerModalRuntime(deps: ChatPickerModalRuntimeDeps): {
  dispatchKey: (input: { key: Key; source: 'onKey' | 'input-loop'; label: string }) => Promise<boolean>;
  makePickerOnKey: (label: string) => PickerOnKey;
  makePickerOnRowClick: (label: string) => PickerOnRowClick;
  createBindings: (kind: ChatPickerKind, spec: { maxVisible: number }) => ChatPickerModalBindings;
  createFamily: (spec: {
    bounds: { row: number; col: number; width: number; height: number };
    sources: ChatPickerFamilySources;
    maxVisible: number;
  }) => ChatPickerModalFamily;
  syncModal: (spec: SyncPickerModalSpec) => void;
  syncFamily: (spec: SyncPickerFamilySpec) => void;
  clearAll: () => void;
} {
  const handles = new Map<ChatPickerKind, PickerHandle>();

  const dispatchPickerKey = async (input: {
    key?: Key;
    source: 'onKey' | 'input-loop' | 'onRowClick';
    label: string;
    filtIdx?: number;
  }): Promise<boolean> => {
    const buf = deps.getBufferView();
    await deps.picker.refresh(buf);
    const dispatched = input.source === 'onRowClick' && typeof input.filtIdx === 'number'
      ? await deps.picker.submitAt(input.filtIdx, buf)
      : await deps.picker.dispatch(input.key!, buf);
    if (debug.enabled) {
      debug.log('chat.picker.dispatch', input.source === 'onRowClick' ? '(mouse-click)' : input.key?.name || '(empty)', {
        source: input.source,
        label: input.label,
        mode: deps.picker.mode(buf),
        ...(typeof input.filtIdx === 'number' ? { filtIdx: input.filtIdx } : {}),
        consumed: dispatched.consumed,
        action: dispatched.consumed && dispatched.action ? dispatched.action.kind : null,
        selIdx: deps.picker._snapshot().cmdPickerIdx,
        bufLine0: (buf.lines[0] ?? '').slice(0, 40),
      });
    }
    return await deps.onDispatchResult(dispatched);
  };

  const dispatchKey = async (input: { key: Key; source: 'onKey' | 'input-loop'; label: string }): Promise<boolean> =>
    dispatchPickerKey(input);

  const makePickerOnKey = (label: string): PickerOnKey => async (ev) => {
    return (await dispatchKey({
      key: ev as unknown as Key,
      source: 'onKey',
      label,
    })) ? 'consumed' : 'passthrough';
  };

  const makePickerOnRowClick = (label: string): PickerOnRowClick => async (filtIdx: number) => {
    await dispatchPickerKey({
      key: { name: 'enter' } as Key,
      source: 'onRowClick',
      label,
      filtIdx,
    });
  };

  // TUI-DIRECT-WRITE-ROWS — no direct terminal clear here. The sink is the
  // display coordinator, whose popModal marks every row dirty and forces the
  // next frame (Q7 / F9), so the picker rows repaint through the frame cache.
  // The old CUP+EL clear bypassed that cache and was off by one row: it
  // erased the row above the picker band (ChatLog header) and left it blank
  // until the forced repaint arrived.
  const clearHandle = (kind: ChatPickerKind): void => {
    const handle = handles.get(kind);
    if (!handle) return;
    handle.dispose();
    handles.delete(kind);
  };

  const syncModal = (spec: SyncPickerModalSpec): void => {
    if (!deps.modalSink) return;
    const handle = handles.get(spec.kind);
    if (spec.active && !handle) {
      handles.set(spec.kind, deps.modalSink.pushModal(spec.createSurface()));
      return;
    }
    if (!spec.active && handle) {
      clearHandle(spec.kind);
    }
  };

  const createBindings = (
    kind: ChatPickerKind,
    spec: { maxVisible: number },
  ): ChatPickerModalBindings => ({
    selectedIdx: () => deps.picker.selectedIdx(),
    maxVisible: spec.maxVisible,
    getInputZoneHeight: deps.getInputZoneHeight,
    width: deps.getBounds().width,
    getWidth: () => deps.getBounds().width,
    // TUI-PICKER-RESIZE-SHRINK — follow the live prompt row, not the
    // row captured when the family was created (stale after resize).
    getAnchor: () => {
      const b = deps.getBounds();
      return { row: b.row, col: b.col };
    },
    onKey: makePickerOnKey(kind),
    onRowClick: makePickerOnRowClick(kind),
  });

  const createFamilyBindings = (spec: { maxVisible: number }): Record<ChatPickerKind, ChatPickerModalBindings> =>
    Object.fromEntries(
      CHAT_PICKER_KINDS.map((kind) => [kind, createBindings(kind, spec)]),
    ) as Record<ChatPickerKind, ChatPickerModalBindings>;

  const createFamily = (spec: {
    bounds: { row: number; col: number; width: number; height: number };
    sources: ChatPickerFamilySources;
    maxVisible: number;
  }): ChatPickerModalFamily =>
    createChatPickerModalFamily({
      bounds: spec.bounds,
      sources: spec.sources,
      bindings: createFamilyBindings({ maxVisible: spec.maxVisible }),
    });

  const syncFamily = (input: SyncPickerFamilySpec): void => {
    for (const kind of CHAT_PICKER_KINDS) {
      const source = input.family.sources[kind];
      const itemCount = source.getItems().length;
      if (debug.enabled) {
        debug.log(`chat.update${kind[0]!.toUpperCase()}${kind.slice(1)}Picker`, kind === input.activeKind ? 'active' : 'inactive', {
          active: kind === input.activeKind && itemCount > 0,
          itemCount,
          row: input.debugLayout?.row,
          col: input.debugLayout?.col,
          width: input.debugLayout?.width,
        });
      }
      syncModal({
        kind,
        active: kind === input.activeKind && itemCount > 0,
        createSurface: () => input.family.createSurface(kind),
      });
    }
  };

  const clearAll = (): void => {
    for (const kind of [...handles.keys()]) {
      clearHandle(kind);
    }
  };

  return {
    dispatchKey,
    makePickerOnKey,
    makePickerOnRowClick,
    createBindings,
    createFamily,
    syncModal,
    syncFamily,
    clearAll,
  };
}
