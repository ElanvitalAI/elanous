/** Surface selection includes the answer-only L0 setting. MessageBlock.detail
 * records prepared L1-L3 data and therefore has no L0 value. */
export type SurfaceDetailLevel = 0 | 1 | 2 | 3;

/** R-SURFACE declares only the visible ceiling and initial detail. Fold state,
 * transport limits, and raw storage belong to their existing owners. */
export interface SurfaceDetailDeclaration {
  readonly maxDetail: SurfaceDetailLevel;
  readonly defaultDetail: SurfaceDetailLevel;
}

export type ChatSurface = 'tui' | 'pwa' | 'discord' | 'telegram';

export const CHAT_SURFACE_DETAIL = {
  tui: { maxDetail: 3, defaultDetail: 0 },
  pwa: { maxDetail: 2, defaultDetail: 0 },
  discord: { maxDetail: 1, defaultDetail: 0 },
  telegram: { maxDetail: 1, defaultDetail: 0 },
} as const satisfies Record<ChatSurface, SurfaceDetailDeclaration>;
