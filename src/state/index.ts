// ── Presentation track P1 · State store public API ──
//
// Single entry point for the Zustand-shape vanilla store + memoized
// selectors. Import from `@/state` (or relative path). React dep 0 ·
// framework-free · designed for synchronous TUI runtime.
//
// Usage:
//   import { createStore, createSelector, shallowEqual } from '@/state';
//   const store = createStore<MyState>({ count: 0 });
//   const select = createSelector(
//     (s: MyState) => s.count,
//     (n) => n * 2,
//   );
//   const unsub = store.subscribe(select, (next) => console.log(next));

export {
  createStore,
  installPluginSlice,
  uninstallPluginSlice,
} from './store.js';

export {
  createSelector,
  shallowEqual,
  deepEqual,
  type InputSelector,
  type MemoizedSelector,
  type Combiner1,
  type Combiner2,
  type Combiner3,
  type Combiner4,
} from './selectors.js';

export {
  type ElanousState,
  type UISlice,
  type WidgetSlice,
  type Store,
  type Setter,
  type Getter,
  type Selector,
  type Listener,
  type Unsubscribe,
  type StatePatch,
  type StateUpdater,
  type StoreInitializer,
  type SubscribeOptions,
  type EqualityFn,
  defaultElanousState,
} from './types.js';

export {
  bridgeContextKeysToStore,
  bridgePluginHostToStore,
} from './bridges/index.js';
