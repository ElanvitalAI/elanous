// MX5 — Status-bar pill popup factories.
//
// R1.3 policy lock: status-bar transient popups are popup-tier modal
// surfaces, not overlay-host sprites.
//
// When the user clicks on the model pill or sessionCwd pill in the
// status bar, this module produces a SelectView-backed modal
// mounted via mountViewAsModalSurface. The dashboard picks up the
// ViewSurfaceHandle, registers the surface, and wires key + mouse
// routing into its existing dispatch.
//
// The factories do not reach into dashboard state directly — they
// take minimal dependencies (list + onPick callback + bounds
// resolver) so they're unit-testable and reusable.

import type { RotationEntry } from '../user-config/types.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { ViewSurfaceHandle } from '../ui/modal-adapter.js';
import {
  createModelPickerRecipe,
  createWdPickerRecipe,
  type ModelPickerRecipeOpts,
  type WdPickerRecipeOpts,
} from '../mouse-action-recipes.js';
import {
  computePopupBounds,
  type PopupPlacement,
} from '../ui/chrome/picker-popup-placement.js';

export { computePopupBounds };
export type { PopupPlacement };

export interface ModelPickerPopupSpec {
  id?: string;
  entries: RotationEntry[];
  placement: PopupPlacement;
  theme?: ThemeTokens;
  /** Invoked when the user picks a rotation entry. */
  onPick: (entry: RotationEntry) => void;
  /** Invoked on Esc / click-outside / explicit dispose. */
  onCancel?: () => void;
}

export function createModelPickerPopup(spec: ModelPickerPopupSpec): ViewSurfaceHandle {
  const recipe: ModelPickerRecipeOpts = {
    entries: spec.entries,
    placement: spec.placement,
    onSwitch: spec.onPick,
    onCancel: spec.onCancel,
    theme: spec.theme,
  };
  return createModelPickerRecipe(recipe);
}

export interface WdPickerPopupSpec {
  id?: string;
  recentPaths: string[];
  placement: PopupPlacement;
  theme?: ThemeTokens;
  onPick: (path: string) => void;
  onCancel?: () => void;
}

export function createWdPickerPopup(spec: WdPickerPopupSpec): ViewSurfaceHandle {
  const recipe: WdPickerRecipeOpts = {
    recentPaths: spec.recentPaths,
    placement: spec.placement,
    onSwitch: spec.onPick,
    onCancel: spec.onCancel,
    theme: spec.theme,
  };
  return createWdPickerRecipe(recipe);
}
