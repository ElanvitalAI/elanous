import type { Key } from '../../tui.js';
import type { InlinePanelSpec } from './inline-panel.js';

/**
 * NEXT-TUI-PROVIDER-PICKER-PLACEMENT (OP P0, 11-16): `/provider` opens a popup above the composer,
 * like the @ picker, instead of printing the list into the chat stream. Ready providers (current,
 * configured rotation, or with a usable credential) come first; the rest fold under «더 보기».
 * Nothing here reads or prints a credential value; callers pass only availability flags.
 */
export interface ProviderPickerEntry {
  readonly provider: string;
  readonly model: string;
  readonly current: boolean;
  readonly ready: boolean;
}

export interface ProviderPickerInput {
  readonly current: string;
  readonly currentModel?: string;
  readonly defaults: Readonly<Record<string, string>>;
  readonly rotation?: readonly string[];
  /** Providers whose credential is present (env, auth store or OAuth), from provider detection. */
  readonly credentialed: ReadonlySet<string>;
}

export function providerPickerEntries(input: ProviderPickerInput): ProviderPickerEntry[] {
  const rotation = new Set(input.rotation ?? []);
  const entries = Object.entries(input.defaults)
    .filter(([provider]) => provider !== 'auto')
    .map(([provider, model]) => ({
      provider,
      model: provider === input.current && input.currentModel ? input.currentModel : model || '기본 모델',
      current: provider === input.current,
      ready: provider === input.current || rotation.has(provider) || input.credentialed.has(provider),
    }));
  // Current first, then ready providers in catalog order, then the folded rest.
  return [...entries.filter((entry) => entry.current), ...entries.filter((entry) => !entry.current && entry.ready),
    ...entries.filter((entry) => !entry.ready)];
}

export type ProviderPickerAction =
  | { readonly kind: 'moved' | 'dismissed' | 'expanded' }
  | { readonly kind: 'selected'; readonly provider: string };

const MORE = '더 보기';

export function createProviderPickerPanel(entries: readonly ProviderPickerEntry[]) {
  let open = true;
  let expanded = !entries.some((entry) => !entry.ready);
  let selected = 0;
  const visible = (): readonly ProviderPickerEntry[] => expanded ? entries : entries.filter((entry) => entry.ready);
  const hidden = (): number => entries.length - visible().length;
  const rowCount = (): number => visible().length + (hidden() > 0 ? 1 : 0);
  return {
    get isOpen(): boolean { return open; },
    get panel(): InlinePanelSpec | null {
      if (!open) return null;
      return {
        title: 'Provider',
        rows: [
          ...visible().map((entry) => ({
            label: `${entry.current ? '●' : '○'} ${entry.provider}`,
            description: `${entry.model}${entry.current ? ' · 현재' : entry.ready ? '' : ' · 자격 없음'}`,
          })),
          ...(hidden() > 0 ? [{ label: `${MORE} (${hidden()})`, description: '자격·구성 없는 provider' }] : []),
        ],
        selected,
        hint: 'Enter 이 세션에 적용 · Esc 닫기',
      };
    },
    close(): void { open = false; },
    handleKey(key: Pick<Key, 'name' | 'shift' | 'alt' | 'ctrl'>): ProviderPickerAction | null {
      if (!open) return null;
      if (key.name === 'escape') { open = false; return { kind: 'dismissed' }; }
      if (key.name === 'up' || key.name === 'down') {
        const count = rowCount();
        if (count > 0) selected = (selected + (key.name === 'up' ? -1 : 1) + count) % count;
        return { kind: 'moved' };
      }
      if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl) {
        const entry = visible()[selected];
        if (!entry) {
          // The «더 보기» row unfolds in place and keeps the cursor on the first newly shown provider.
          const before = visible().length;
          expanded = true;
          selected = Math.min(before, Math.max(0, entries.length - 1));
          return { kind: 'expanded' };
        }
        open = false;
        return { kind: 'selected', provider: entry.provider };
      }
      return null;
    },
  };
}
