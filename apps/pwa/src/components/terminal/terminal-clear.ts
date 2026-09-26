export function shouldClear(prev: number | undefined, next: number): boolean {
  return prev !== undefined && prev !== next;
}
