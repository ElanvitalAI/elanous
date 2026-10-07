/** LOOP-INTERACT D — `/loops` 의 보기 갈래. 기본은 «루프 현황»(표) · `?view=interact` 만 루프 상호작용 지도. */
export const LOOPS_INTERACT_HREF = '/loops?view=interact';

export type LoopsViewId = 'status' | 'interact';

export function loopsView(search: { get(name: string): string | null } | null | undefined): LoopsViewId {
  return search?.get('view') === 'interact' ? 'interact' : 'status';
}
