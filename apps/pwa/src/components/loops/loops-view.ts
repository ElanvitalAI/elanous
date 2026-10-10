/** `/loops` 기본은 «루프 현황»(표); 상호작용과 자원 지도는 명시적으로 선택한다. */
export const LOOPS_INTERACT_HREF = '/loops?view=interact';

export type LoopsViewId = 'status' | 'interact' | 'resources';

export function loopsView(search: { get(name: string): string | null } | null | undefined): LoopsViewId {
  return search?.get('view') === 'resources' ? 'resources' : search?.get('view') === 'interact' ? 'interact' : 'status';
}
