import { debug } from '../debug/log.js';
import { SidebarTabSurface } from '../ui/widgets/sidebar-tab-surface.js';
import { resolveIulSidebarShellPresentation } from '../ui/chrome/sidebar-shell-presentation.js';
import { buildIulSidebarItems, IUL_SIDEBAR_TAB_IDS } from './sidebar-shell-catalog.js';

export interface IulSidebarShellViewOptions {
  title?: string;
  footerHint?: string;
  themePreviewControl?: {
    getActiveThemeName: () => string;
    previewTheme: (name: string) => void;
    revertPreview: () => void;
    commitTheme: (name: string) => void;
  };
}

export function createIulSidebarShellView(
  opts: IulSidebarShellViewOptions = {},
): SidebarTabSurface {
  const chrome = resolveIulSidebarShellPresentation();
  if (debug.enabled) {
    debug.log('iul.shell', 'view-build', {
      title: opts.title ?? chrome.title,
      tabs: [...IUL_SIDEBAR_TAB_IDS],
    });
  }
  return new SidebarTabSurface({
    title: opts.title ?? chrome.title,
    compactTitle: chrome.compactTitle,
    railTitle: chrome.railTitle,
    footerHint: opts.footerHint ?? chrome.footerHint,
    compactFooterHint: chrome.compactFooterHint,
    emptyState: chrome.emptyState,
    debugCategory: 'iul.shell',
    badgeMaxWidth: chrome.badgeMaxWidth,
    items: buildIulSidebarItems({
      themePreviewControl: opts.themePreviewControl,
    }),
  });
}
