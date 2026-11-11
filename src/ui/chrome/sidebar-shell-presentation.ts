export interface SidebarShellPresentation {
  title: string;
  compactTitle: string;
  railTitle: string;
  footerHint: string;
  compactFooterHint: string;
  emptyState: string;
  badgeMaxWidth?: number;
}

const ACP_CHANNEL_SIDEBAR_PRESENTATION = {
  title: 'ACP Channels',
  compactTitle: 'ACP',
  pluralLabel: 'channels',
  singularLabel: 'channel',
  emptyState: 'No ACP sessions yet. Live ACP lanes and saved history will appear here.',
  footerHint: '↑↓ switch channel · Enter detail · Right-click menu · Ctrl+Enter/Double-click action · Tab focus swap',
  compactFooterHint: '↑↓ channel · ↵ detail · rc menu · ^↵/dbl action',
} as const;

export function resolveAcpSidebarShellPresentation(): SidebarShellPresentation {
  return {
    title: ACP_CHANNEL_SIDEBAR_PRESENTATION.title,
    compactTitle: ACP_CHANNEL_SIDEBAR_PRESENTATION.compactTitle,
    ...resolveSidebarShellVocabulary(ACP_CHANNEL_SIDEBAR_PRESENTATION),
    footerHint: ACP_CHANNEL_SIDEBAR_PRESENTATION.footerHint,
    compactFooterHint: ACP_CHANNEL_SIDEBAR_PRESENTATION.compactFooterHint,
    badgeMaxWidth: 6,
  };
}

function resolveSidebarShellVocabulary(opts: {
  pluralLabel: string;
  singularLabel: string;
  emptyState: string;
}): Pick<SidebarShellPresentation, 'railTitle' | 'footerHint' | 'compactFooterHint' | 'emptyState'> {
  return {
    railTitle: toTitleCase(opts.pluralLabel),
    footerHint: `↑↓ switch ${opts.singularLabel} · Enter detail · Tab focus swap`,
    compactFooterHint: `↑↓ ${opts.singularLabel} · ↵ detail · Tab swap`,
    emptyState: opts.emptyState,
  };
}

function toTitleCase(label: string): string {
  return label.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-US'));
}
