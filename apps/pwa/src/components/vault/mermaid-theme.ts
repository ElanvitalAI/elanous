export const MERMAID_THEME_PREFERENCES = ['auto', 'default', 'neutral', 'dark', 'forest'] as const;
export type MermaidThemePreference = (typeof MERMAID_THEME_PREFERENCES)[number];
export type MermaidTheme = Exclude<MermaidThemePreference, 'auto'> | 'base';

export const MERMAID_THEME_STORAGE_KEY = 'elanous.mermaid.theme';
export const MERMAID_THEME_CHANGE_EVENT = 'elanous:mermaid-theme-change';
let sessionPreference: MermaidThemePreference | null = null;
let preferenceWindow: Window | null = null;

export function readMermaidThemePreference(): MermaidThemePreference {
  if (typeof window === 'undefined') return 'auto';
  if (preferenceWindow !== window) sessionPreference = null;
  if (sessionPreference !== null) return sessionPreference;
  try {
    const value = window.localStorage.getItem(MERMAID_THEME_STORAGE_KEY);
    return MERMAID_THEME_PREFERENCES.find((theme) => theme === value) ?? 'auto';
  } catch {
    return 'auto';
  }
}

export function writeMermaidThemePreference(preference: MermaidThemePreference): void {
  if (typeof window === 'undefined') return;
  preferenceWindow = window;
  try {
    window.localStorage.setItem(MERMAID_THEME_STORAGE_KEY, preference);
    sessionPreference = null;
  } catch {
    // Keep the choice for this session even when persistent storage is unavailable.
    sessionPreference = preference;
  }
  window.dispatchEvent(new Event(MERMAID_THEME_CHANGE_EVENT));
}

/** Mermaid's own init directive is kept in the source passed to render; this only selects the matching card/theme. */
export function selectMermaidTheme(source: string, preference: MermaidThemePreference): MermaidTheme {
  for (const directive of source.matchAll(/%%\{\s*init\s*:\s*\{([\s\S]*?)\}\s*\}%%/gi)) {
    const match = directive[1]?.match(/(?:^|,)\s*['"]?theme['"]?\s*:\s*['"]?(default|neutral|dark|forest|base)\b/i);
    if (match) return match[1]!.toLowerCase() as MermaidTheme;
  }
  return preference === 'auto' ? 'default' : preference;
}
