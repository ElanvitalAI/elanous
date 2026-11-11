export type PwaProvenanceBadgeProjection =
  | { readonly kind: 'badge'; readonly source: 'sim' | 'replay' | 'injected' | 'shadow'; readonly icon: string; readonly label: string }
  | { readonly kind: 'unbadged'; readonly source: 'real' | 'synthetic-probe' }
  | { readonly kind: 'unknown'; readonly source: string; readonly icon: '?'; readonly label: '출처 미상' };

const VISIBLE_BADGES = {
  sim: { icon: '🧪', label: '시뮬' },
  replay: { icon: '🎞', label: '재생' },
  injected: { icon: '💉', label: '주입' },
  shadow: { icon: '👻', label: '그림자' },
} as const;

/** Project RFC-hybrid-sim-real §3 source provenance into the PWA's visible badge contract. */
export function projectPwaProvenanceBadge(source: unknown): PwaProvenanceBadgeProjection {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { kind: 'unknown', source: 'unknown', icon: '?', label: '출처 미상' };
  }

  if (Object.hasOwn(VISIBLE_BADGES, source)) {
    const visibleSource = source as keyof typeof VISIBLE_BADGES;
    return { kind: 'badge', source: visibleSource, ...VISIBLE_BADGES[visibleSource] };
  }

  if (source === 'real' || source === 'synthetic-probe') return { kind: 'unbadged', source };
  return { kind: 'unknown', source, icon: '?', label: '출처 미상' };
}
