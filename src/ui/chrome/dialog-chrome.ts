import type { WidgetChromeSpec } from '../declarative/spec.js';
import type { ThemeTokens } from '../../theme/tokens.js';

export interface DialogChromeSpec {
  title: string;
  chromeSpec?: WidgetChromeSpec;
  defaultVariant?: WidgetChromeSpec['variant'];
  defaultTitleAlign?: WidgetChromeSpec['titleAlign'];
  defaultShowClose?: boolean;
}

export function resolveDialogChromeSpec(spec: DialogChromeSpec): WidgetChromeSpec {
  return {
    variant: spec.defaultVariant ?? 'dialog',
    title: spec.title,
    titleAlign: spec.defaultTitleAlign ?? 'left',
    showClose: spec.defaultShowClose ?? true,
    ...spec.chromeSpec,
  };
}

export function resolveModalDialogChromeSpec(
  title: string,
  chromeSpec?: WidgetChromeSpec,
  titleAlign?: WidgetChromeSpec['titleAlign'],
): WidgetChromeSpec {
  return resolveDialogChromeSpec({
    title,
    chromeSpec,
    ...(titleAlign ? { defaultTitleAlign: titleAlign } : {}),
  });
}

export function resolveEmbeddedDialogChromeSpec(
  title: string,
  chromeSpec?: WidgetChromeSpec,
  titleAlign?: WidgetChromeSpec['titleAlign'],
): WidgetChromeSpec {
  return resolveDialogChromeSpec({
    title,
    defaultShowClose: false,
    chromeSpec,
    ...(titleAlign ? { defaultTitleAlign: titleAlign } : {}),
  });
}

/** The yes/no confirm popup's chrome (approval-modal): theme tokens, the static modalChrome rail and the centred
 *  modal-dialog chromeSpec (double frame, ✕ close). Any boxed popup that should look like it spreads this into Dialog. */
export function confirmPopupDialogChrome(title: string, theme: ThemeTokens | undefined): {
  theme: ThemeTokens | undefined;
  chrome: 'static' | 'legacy';
  chromeSpec: WidgetChromeSpec;
} {
  return { theme, chrome: theme ? 'static' : 'legacy', chromeSpec: resolveModalDialogChromeSpec(title, undefined, 'center') };
}
