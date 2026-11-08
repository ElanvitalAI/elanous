import type { ActionItem, ActionPickerViewFactory } from '../mouse-action-recipes.js';
import type { ModalShadowSpec } from './modal-adapter.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { View } from './view.js';

export type SubmenuPopupMenuContract =
  | 'single-click-browse'
  | 'single-click-activate';

export interface CreateSubmenuPopupMenuViewSpec<T> {
  id: string;
  title: string;
  items: ActionItem<T>[];
  contract: SubmenuPopupMenuContract;
  onPick: (value: T) => void | Promise<void>;
  onCancel?: () => void;
  initialIndex?: number;
  onSelectionChange?: (index: number) => void;
  visibleRows?: number;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

/** The renderer is injected by callers so this UI contract stays below the recipe module at runtime. */
export function createSubmenuPopupMenuView<T>(
  spec: CreateSubmenuPopupMenuViewSpec<T>,
  createActionPickerView: ActionPickerViewFactory,
): View {
  return createActionPickerView({
    id: spec.id,
    title: spec.title,
    items: spec.items,
    browseMode: spec.contract === 'single-click-browse',
    filterable: false,
    actionButtons: false,
    initialIndex: spec.initialIndex,
    onSelectionChange: spec.onSelectionChange == null
      ? undefined
      : (index, _value) => spec.onSelectionChange?.(index),
    onPick: spec.onPick,
    onCancel: spec.onCancel,
    visibleRows: spec.visibleRows,
    theme: spec.theme,
    shadow: spec.shadow,
  });
}
